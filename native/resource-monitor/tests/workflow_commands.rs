#![cfg(unix)]
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const HELPER: &str = env!("CARGO_BIN_EXE_t3-resource-monitor");
unsafe extern "C" {
    fn dup2(old: i32, new: i32) -> i32;
    fn fcntl(fd: i32, command: i32, value: i32) -> i32;
}
struct Owned(Child, String);
impl Drop for Owned {
    fn drop(&mut self) {
        // EOF also stops the regression's ordinary child if a broken owner already exited.
        drop(self.0.stdin.take());
        let stopped = Command::new(HELPER)
            .args(["--setup-process", "stop", &self.0.id().to_string(), &self.1])
            .output()
            .is_ok_and(|output| output.status.success());
        if !stopped {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
fn call(args: &[&str]) -> Value {
    let output = Command::new(HELPER)
        .arg("--setup-process")
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn launch(script: &str) -> (Owned, UnixStream) {
    let (reader, writer) = UnixStream::pair().unwrap();
    let fd = writer.as_raw_fd();
    let mut command = Command::new(HELPER);
    command
        .args([
            "--command-owner-v1",
            "--launch-v1",
            &json!({
                "protocol":1, "token":"00000000000000000000000000000000",
                "candidates":[{"shell":"/bin/sh", "args":["-c",script]}]
            })
            .to_string(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(move || {
            if dup2(fd, 3) < 0 || fcntl(3, 2, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn().unwrap();
    drop(writer);
    let captured = call(&["capture", &child.id().to_string()]);
    let birth = captured["identity"].as_str().unwrap().to_owned();
    (Owned(child, birth), reader)
}
fn arm(owner: &Owned) {
    let state = call(&["arm", &owner.0.id().to_string(), &owner.1]);
    assert!(state["launch"]["error"].is_null());
}
#[test]
fn command_result_is_private_and_not_parent_exit_proof() {
    let (mut owner, mut control) = launch("printf '{\"protocol\":1,\"code\":0}\\n'; exit 37");
    assert!(owner.0.try_wait().unwrap().is_none());
    arm(&owner);
    let mut result = String::new();
    control.read_to_string(&mut result).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&result).unwrap(),
        json!({"protocol":1,"code":37})
    );
    let state = call(&["inspect", &owner.0.id().to_string()]);
    assert_eq!(state["owned"], true);
    assert_eq!(state["fullStop"], false);
    let receipt = call(&["stop", &owner.0.id().to_string(), &owner.1]);
    assert_eq!(receipt["fullStop"], true);
    let mut stdout = String::new();
    owner
        .0
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    assert_eq!(stdout, "{\"protocol\":1,\"code\":0}\n");
    // Stop was acknowledged; avoid asking the dead PID for another receipt in Drop.
    owner.0.wait().unwrap();
    std::mem::forget(owner);
}
#[test]
fn hook_child_remains_owned_after_command_completion() {
    let (mut owner, mut control) = launch("sleep 60 & echo $!; exit 0");
    arm(&owner);
    let mut line = String::new();
    BufReader::new(owner.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let pid = line.trim();
    let mut result = String::new();
    control.read_to_string(&mut result).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&result).unwrap()["code"], 0);
    assert!(call(&["inspect", pid])["identity"].is_string());
    assert_eq!(
        call(&["stop", &owner.0.id().to_string(), &owner.1])["fullStop"],
        true
    );
    assert!(call(&["inspect", pid])["identity"].is_null());
    owner.0.wait().unwrap();
    std::mem::forget(owner);
}

#[test]
fn disconnected_result_reader_keeps_owner_and_child_recoverable() {
    let (mut owner, control) = launch("exec 4<&0; cat <&4 >/dev/null & echo $!; exit 0");
    // Capture-before-arm lets us disconnect without racing a fast command's result.
    drop(control);
    arm(&owner);
    let mut child_pid = String::new();
    BufReader::new(owner.0.stdout.take().unwrap())
        .read_line(&mut child_pid)
        .unwrap();
    let child_pid = child_pid.trim();
    let stderr = owner.0.stderr.take().unwrap();
    let (sent, received) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stderr).take(512).read_line(&mut line);
        let _ = sent.send(result.map(|_| line));
    });
    let diagnostic = received
        .recv_timeout(Duration::from_secs(5))
        .expect("The owner must acknowledge the failed result write")
        .unwrap();
    assert_eq!(
        diagnostic,
        "Workflow command result delivery failed; ownership retained.\n"
    );
    let state = call(&["inspect", &owner.0.id().to_string()]);
    assert_eq!(state["identity"], owner.1);
    assert_eq!(state["owned"], true);
    assert_eq!(state["fullStop"], false);
    assert!(call(&["inspect", child_pid])["identity"].is_string());
    assert_eq!(
        call(&["stop", &owner.0.id().to_string(), &owner.1])["fullStop"],
        true
    );
    assert!(call(&["inspect", child_pid])["identity"].is_null());
    owner.0.wait().unwrap();
    std::mem::forget(owner);
}
