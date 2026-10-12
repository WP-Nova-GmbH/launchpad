#![cfg(target_os = "windows")]
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
const HELPER: &str = env!("CARGO_BIN_EXE_t3-resource-monitor");
struct Captured(Child);
impl Drop for Captured {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(Some(_))) {
            return;
        }
        if let Ok(output) = Command::new(HELPER)
            .args(["--setup-process", "inspect", &self.0.id().to_string()])
            .output()
        {
            if let Ok(state) = serde_json::from_slice::<Value>(&output.stdout) {
                if let Some(birth) = state["identity"]
                    .as_str()
                    .filter(|_| state["owned"] == true)
                {
                    let _ = Command::new(HELPER)
                        .args(["--setup-process", "stop", &self.0.id().to_string(), birth])
                        .output();
                }
            }
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
fn missing_pwsh_falls_back_and_failed_launch_retains_the_recorded_job() {
    for fail_all in [false, true] {
        let powershell = format!(
            "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())
        );
        let request = serde_json::json!({"protocol": 1, "token": "0123456789abcdef0123456789abcdef", "candidates": if fail_all {
            vec![serde_json::json!({"shell": "C:\\definitely-missing\\pwsh.exe"}), serde_json::json!({"shell": "C:\\definitely-missing\\powershell.exe"})]
        } else {
            vec![serde_json::json!({"shell": "C:\\definitely-missing\\pwsh.exe"}), serde_json::json!({"shell": powershell, "args": ["-NoLogo", "-NoProfile", "-Command", "[Console]::Write('STARTED'); exit 7"]})]
        }});
        let mut root = Captured(
            Command::new(HELPER)
                .args(["--setup-owner-v4", "--launch-v1", &request.to_string()])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let capture = Command::new(HELPER)
            .args(["--setup-process", "capture", &root.0.id().to_string()])
            .output()
            .unwrap();
        assert!(
            capture.status.success(),
            "{}",
            String::from_utf8_lossy(&capture.stderr)
        );
        let state: Value = serde_json::from_slice(&capture.stdout).unwrap();
        let birth = state["identity"].as_str().unwrap();
        let armed = Command::new(HELPER)
            .args(["--setup-process", "arm", &root.0.id().to_string(), birth])
            .output()
            .unwrap();
        assert!(
            armed.status.success(),
            "{}",
            String::from_utf8_lossy(&armed.stderr)
        );
        let launched: Value = serde_json::from_slice(&armed.stdout).unwrap();
        if fail_all {
            assert!(launched["launch"]["error"].is_string());
            assert!(launched["launch"]["selectedShell"].is_null());
        } else {
            assert_eq!(launched["launch"]["selectedShell"], powershell);
            let mut output = Vec::new();
            BufReader::new(root.0.stdout.take().unwrap())
                .read_until(7, &mut output)
                .unwrap();
            let output = String::from_utf8(output).unwrap();
            assert!(output.contains("STARTED"));
            assert!(output.contains("T3_SETUP_EXIT;0123456789abcdef0123456789abcdef;7"));
        }
        assert!(root.0.try_wait().unwrap().is_none());
        let stop = Command::new(HELPER)
            .args(["--setup-process", "stop", &root.0.id().to_string(), birth])
            .output()
            .unwrap();
        assert!(
            stop.status.success(),
            "{}",
            String::from_utf8_lossy(&stop.stderr)
        );
        let receipt: Value = serde_json::from_slice(&stop.stdout).unwrap();
        assert_eq!(receipt["fullStop"], true);
        root.0.wait().unwrap();
    }
}
