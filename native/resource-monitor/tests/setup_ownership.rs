#![cfg(unix)]
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

const HELPER: &str = env!("CARGO_BIN_EXE_t3-resource-monitor");
unsafe extern "C" {
    fn setsid() -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
}
struct Captured(Child);
impl Drop for Captured {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(Some(_))) {
            return;
        }
        // A failed assertion must clean this captured unit, not just its anchor.
        if let Ok(output) = Command::new(HELPER)
            .args(["--setup-process", "inspect", &self.0.id().to_string()])
            .output()
        {
            if let Ok(state) = serde_json::from_slice::<Value>(&output.stdout) {
                if state["owned"] == true {
                    if let Some(birth) = state["identity"].as_str() {
                        let _ = stop(self.0.id(), birth);
                    }
                }
            }
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn inspect(pid: u32) -> Value {
    let result = Command::new(HELPER)
        .args(["--setup-process", "inspect", &pid.to_string()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}
fn owner(script: &str) -> Captured {
    let mut command = Command::new(HELPER);
    command
        .args(["--setup-owner-v4", "/bin/sh", "-c", script])
        .stdout(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            if setsid() < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let root = Captured(command.spawn().unwrap());
    let captured = Command::new(HELPER)
        .args(["--setup-process", "capture", &root.0.id().to_string()])
        .output()
        .unwrap();
    assert!(
        captured.status.success(),
        "{}",
        String::from_utf8_lossy(&captured.stderr)
    );
    let state: Value = serde_json::from_slice(&captured.stdout).unwrap();
    let armed = Command::new(HELPER)
        .args([
            "--setup-process",
            "arm",
            &root.0.id().to_string(),
            state["identity"].as_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(armed.status.success());
    root
}
fn stop(pid: u32, birth: &str) -> std::process::Output {
    Command::new(HELPER)
        .args(["--setup-process", "stop", &pid.to_string(), birth])
        .output()
        .unwrap()
}
#[test]
fn orphaned_normal_programs_and_bounded_forks_remain_owned() {
    for script in [
        "sleep 60 & echo $!; exit",
        "(sleep 60 & echo $!); exit",
        "(i=0; while [ $i -lt 8 ]; do sleep 60 & echo $!; i=$((i+1)); done; wait) & echo $!; wait",
    ] {
        let mut unrelated = Captured(Command::new("sleep").arg("60").spawn().unwrap());
        let mut root = owner(script);
        let mut line = String::new();
        let mut reader = BufReader::new(root.0.stdout.take().unwrap());
        reader.read_line(&mut line).unwrap();
        let child: u32 = line.trim().parse().unwrap();
        assert!(inspect(child)["identity"].is_string());
        let state = inspect(root.0.id());
        assert_eq!(state["owned"], true);
        let result = stop(root.0.id(), state["identity"].as_str().unwrap());
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let receipt: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(receipt["protocol"], 4);
        assert_eq!(receipt["fullStop"], true);
        assert!(inspect(child)["identity"].is_null());
        assert!(unrelated.0.try_wait().unwrap().is_none());
    }
}
#[test]
fn exited_or_reused_parent_is_not_full_stop_evidence() {
    let mut root = Captured(
        Command::new("sh")
            .args(["-c", "sleep 60 & echo $!; wait"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    BufReader::new(root.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let child: u32 = line.trim().parse().unwrap();
    let child_birth = inspect(child)["identity"].as_str().unwrap().to_owned();
    let birth = inspect(root.0.id())["identity"]
        .as_str()
        .unwrap()
        .to_owned();
    root.0.kill().unwrap();
    root.0.wait().unwrap();
    let result = stop(root.0.id(), &birth);
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert_eq!(inspect(child)["identity"], child_birth);
    // Clean only this fixture's captured child after rechecking its exact birth.
    if inspect(child)["identity"] == child_birth {
        unsafe {
            kill(child as i32, 9);
        }
    }
    let mut retained = owner("sleep 60 & echo $!; wait");
    let mut line = String::new();
    BufReader::new(retained.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let state = inspect(retained.0.id());
    let mismatch = stop(retained.0.id(), "not-this-owner");
    assert!(!mismatch.status.success());
    assert!(retained.0.try_wait().unwrap().is_none());
    assert!(
        stop(retained.0.id(), state["identity"].as_str().unwrap())
            .status
            .success()
    );
}
#[test]
fn host_evidence_is_stable_and_inspect_never_acknowledges_full_stop() {
    let first = Command::new(HELPER)
        .args(["--setup-process", "host"])
        .output()
        .unwrap();
    let second = Command::new(HELPER)
        .args(["--setup-process", "host"])
        .output()
        .unwrap();
    assert!(first.status.success() && second.status.success());
    let first: Value = serde_json::from_slice(&first.stdout).unwrap();
    let second: Value = serde_json::from_slice(&second.stdout).unwrap();
    assert_eq!(first["boot"], second["boot"]);
    #[cfg(target_os = "macos")]
    assert!(first["boot"].is_object());
    assert_eq!(first["fullStop"], false);
    assert_eq!(inspect(std::process::id())["fullStop"], false);
}

#[test]
fn an_unarmed_owner_never_starts_setup() {
    let path = std::env::temp_dir().join(format!(
        "t3-unarmed-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut command = Command::new(HELPER);
    command.args([
        "--setup-owner-v4",
        "/bin/sh",
        "-c",
        &format!("printf launched > '{}'", path.display()),
    ]);
    unsafe {
        command.pre_exec(|| {
            if setsid() < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let root = Captured(command.spawn().unwrap());
    let result = Command::new(HELPER)
        .args(["--setup-process", "capture", &root.0.id().to_string()])
        .output()
        .unwrap();
    assert!(result.status.success());
    let state: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert!(!path.exists());
    let stopped = stop(root.0.id(), state["identity"].as_str().unwrap());
    assert!(stopped.status.success());
    assert!(!path.exists());
}

#[test]
fn fallback_is_captured_before_launch_and_failures_retain_the_owner() {
    for fail_all in [false, true] {
        let request = serde_json::json!({"protocol": 1, "token": "0123456789abcdef0123456789abcdef", "candidates": if fail_all {
            vec![serde_json::json!({"shell": "/definitely/missing-1"}), serde_json::json!({"shell": "/definitely/missing-2"})]
        } else {
            vec![serde_json::json!({"shell": "/definitely/missing-1"}), serde_json::json!({"shell": "/bin/sh", "args": ["-c", "printf STARTED; exit 7"]})]
        }});
        let mut command = Command::new(HELPER);
        command
            .args(["--setup-owner-v4", "--launch-v1", &request.to_string()])
            .stdout(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if setsid() < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut root = Captured(command.spawn().unwrap());
        let capture = Command::new(HELPER)
            .args(["--setup-process", "capture", &root.0.id().to_string()])
            .output()
            .unwrap();
        assert!(capture.status.success());
        let state: Value = serde_json::from_slice(&capture.stdout).unwrap();
        let birth = state["identity"].as_str().unwrap();
        let arm = Command::new(HELPER)
            .args(["--setup-process", "arm", &root.0.id().to_string(), birth])
            .output()
            .unwrap();
        assert!(
            arm.status.success(),
            "{}",
            String::from_utf8_lossy(&arm.stderr)
        );
        let launched: Value = serde_json::from_slice(&arm.stdout).unwrap();
        assert_eq!(launched["setupLaunchProtocol"], 1);
        if fail_all {
            assert!(launched["launch"]["selectedShell"].is_null());
            assert!(
                launched["launch"]["error"]
                    .as_str()
                    .unwrap()
                    .contains("missing-2")
            );
        } else {
            assert_eq!(launched["launch"]["selectedShell"], "/bin/sh");
        }
        if !fail_all {
            let mut output = Vec::new();
            BufReader::new(root.0.stdout.take().unwrap())
                .read_until(7, &mut output)
                .unwrap();
            let output = String::from_utf8(output).unwrap();
            assert!(output.contains("STARTED"));
            assert!(output.contains("T3_SETUP_EXIT;0123456789abcdef0123456789abcdef;7"));
        }
        assert_eq!(inspect(root.0.id())["identity"], birth);
        assert!(stop(root.0.id(), birth).status.success());
    }
}
