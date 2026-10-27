use serde::{Deserialize, Serialize};
use std::io;
use std::time::{Duration, Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Boot {
    host: String,
    session: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    protocol: u8,
    identity: Option<String>,
    owned: bool,
    full_stop: bool,
    boot: Option<Boot>,
    setup_launch_protocol: u8,
    command_launch_protocol: u8,
    launch: Option<LaunchResult>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ShellCandidate {
    shell: String,
    #[serde(default)]
    args: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LaunchRequest {
    protocol: u8,
    token: String,
    candidates: Vec<ShellCandidate>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchResult {
    selected_shell: Option<String>,
    error: Option<String>,
}
const LAUNCH_LIMIT: usize = 4096;
fn launch_result_bytes(result: &LaunchResult) -> Vec<u8> {
    let encoded = serde_json::to_vec(result).expect("Launch result consists of strings");
    if encoded.len() <= LAUNCH_LIMIT {
        return encoded;
    }
    serde_json::to_vec(&LaunchResult {
        selected_shell: None,
        error: Some("Setup launch result exceeded the limit".into()),
    })
    .unwrap()
}

/// One-shot ownership operations are independent of telemetry and never accept root absence.
pub fn run(args: &[String]) -> io::Result<()> {
    let operation = args.first().map(String::as_str);
    if operation == Some("host") {
        return output(None, false, false);
    }
    let pid = args
        .get(1)
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|pid| *pid > 0)
        .ok_or_else(|| io::Error::other("Expected an owned PID"))?;
    match operation {
        Some("capture") => {
            let birth = identity(pid)?
                .ok_or_else(|| io::Error::other("Setup owner exited before capture"))?;
            let started = Instant::now();
            loop {
                if is_owner(pid, &birth)? && ready(pid, &birth)? {
                    return output(Some(birth), true, false);
                }
                if identity(pid)?.as_deref() != Some(birth.as_str())
                    || started.elapsed() >= Duration::from_secs(2)
                {
                    return Err(io::Error::other(
                        "Setup ownership was not established before delivery",
                    ));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        Some("inspect") => {
            let birth = identity(pid)?;
            let owned = birth
                .as_deref()
                .map(|value| is_owner(pid, value))
                .transpose()?
                .unwrap_or(false);
            output(birth, owned, false)
        }
        Some("arm") => {
            let expected = args
                .get(2)
                .ok_or_else(|| io::Error::other("Missing process identity"))?;
            if !is_owner(pid, expected)? {
                return Err(io::Error::other("Setup ownership was lost before delivery"));
            }
            let result = arm(pid, expected)?;
            output_launch(Some(expected.to_owned()), true, false, Some(result))
        }
        Some("stop") => {
            let expected = args
                .get(2)
                .ok_or_else(|| io::Error::other("Missing process identity"))?;
            stop(pid, expected)?;
            output(None, true, true)
        }
        _ => Err(io::Error::other("Unknown setup process operation")),
    }
}
fn output(identity: Option<String>, owned: bool, full_stop: bool) -> io::Result<()> {
    output_launch(identity, owned, full_stop, None)
}
fn output_launch(
    identity: Option<String>,
    owned: bool,
    full_stop: bool,
    launch: Option<LaunchResult>,
) -> io::Result<()> {
    println!(
        "{}",
        serde_json::to_string(&State {
            protocol: 4,
            identity,
            owned,
            full_stop,
            boot: boot()?,
            setup_launch_protocol: 1,
            command_launch_protocol: if cfg!(unix) { 1 } else { 0 },
            launch
        })?
    );
    Ok(())
}

/// Keep the ownership anchor alive when the shell or PTY parent exits. Deliberately
/// detached services have their own lifecycle; ordinary descendants remain in this session/job.
pub fn launch(args: &[String]) -> io::Result<()> {
    launch_mode(args, false)
}

pub fn launch_command(args: &[String]) -> io::Result<()> {
    if !cfg!(unix) {
        return Err(io::Error::other(
            "Owned headless commands are unavailable on this platform",
        ));
    }
    launch_mode(args, true)
}

fn launch_mode(args: &[String], command_mode: bool) -> io::Result<()> {
    #[cfg(unix)]
    let mut control = if command_mode {
        use std::os::fd::FromRawFd;
        unsafe {
            if getsid(0) != getpid() && setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            // The command receives stdout/stderr, never the owner's result channel.
            if fcntl(3, 2, 1) < 0 {
                return Err(io::Error::last_os_error());
            }
            Some(std::fs::File::from_raw_fd(3))
        }
    } else {
        None
    };
    let request = if args.first().map(String::as_str) == Some("--launch-v1") {
        let payload = args
            .get(1)
            .filter(|payload| payload.len() <= 16384)
            .ok_or_else(|| io::Error::other("Missing or oversized setup launch request"))?;
        let request: LaunchRequest = serde_json::from_str(payload)?;
        if request.protocol != 1
            || request.candidates.is_empty()
            || request.candidates.len() > 16
            || request.token.len() != 32
            || !request.token.bytes().all(|c| c.is_ascii_hexdigit())
            || request
                .candidates
                .iter()
                .any(|c| c.shell.is_empty() || c.shell.len() > 1024)
        {
            return Err(io::Error::other("Invalid setup launch request"));
        }
        request
    } else {
        LaunchRequest {
            protocol: 1,
            token: String::new(),
            candidates: vec![ShellCandidate {
                shell: args
                    .first()
                    .ok_or_else(|| io::Error::other("Missing setup shell"))?
                    .clone(),
                args: args[1..].to_vec(),
            }],
        }
    };
    #[cfg(unix)]
    {
        unsafe {
            if getsid(0) != std::process::id() as i32 {
                return Err(io::Error::other(
                    "Setup owner needs a dedicated PTY session",
                ));
            }
            // The anchor must survive PTY closure/server restart and cannot fork while cleanup runs.
            signal_handler(1, 1);
            signal_handler(2, 1);
            signal_handler(15, 1);
            signal_handler(SIGTTOU, 1);
        }
    }
    #[cfg(target_os = "windows")]
    let _job = windows::Job::create_owner()?;
    // Until the journal saves this PID/birth and arms it, no shell or startup script runs.
    // An unrecorded owner times out without children rather than surviving a launch crash forever.
    let child = await_arm(|| {
        let mut errors = Vec::new();
        for candidate in &request.candidates {
            let mut command = std::process::Command::new(&candidate.shell);
            command.args(&candidate.args);
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                unsafe {
                    command.pre_exec(move || {
                        if command_mode {
                            close(3);
                        }
                        if setpgid(0, 0) < 0 {
                            return Err(io::Error::last_os_error());
                        }
                        // On a test pipe there is no controlling tty. A real PTY transfers foreground input.
                        if isatty(0) != 0 && tcsetpgrp(0, getpid()) < 0 {
                            return Err(io::Error::last_os_error());
                        }
                        signal_handler(1, 0);
                        signal_handler(2, 0);
                        signal_handler(15, 0);
                        signal_handler(SIGTTOU, 0);
                        Ok(())
                    });
                }
            }
            match command.spawn() {
                Ok(child) => {
                    return (
                        Some(child),
                        LaunchResult {
                            selected_shell: Some(candidate.shell.clone()),
                            error: None,
                        },
                    );
                }
                Err(error) => errors.push(format!("{}: {}", candidate.shell, error)),
            }
        }
        (
            None,
            LaunchResult {
                selected_shell: None,
                error: Some({
                    let mut detail = errors.join("; ");
                    let mut end = detail.len().min(2048);
                    while !detail.is_char_boundary(end) {
                        end -= 1;
                    }
                    detail.truncate(end);
                    detail
                }),
            },
        )
    })?;
    if let Some(mut child) = child {
        let code = child
            .wait()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(-1);
        #[cfg(unix)]
        if let Some(mut channel) = control.take() {
            report_command_result(&mut channel, code, &mut io::stderr());
        }
        if !command_mode && !request.token.is_empty() {
            use std::io::Write;
            // Private, bounded launch frame. Shell exit settles completion, never ownership.
            let _ = write!(
                io::stdout(),
                "\x1b]T3_SETUP_EXIT;{};{}\x07",
                request.token,
                code
            );
            let _ = io::stdout().flush();
        }
    }
    // Retaining this anchor prevents session identity reuse after the shell exits.
    loop {
        std::thread::park();
    }
}

// Result delivery can disappear with the server; ownership must outlive every pipe.
#[cfg(unix)]
fn report_command_result(mut channel: impl io::Write, code: i32, mut diagnostic: impl io::Write) {
    if writeln!(channel, "{{\"protocol\":1,\"code\":{code}}}")
        .and_then(|_| channel.flush())
        .is_err()
    {
        let _ = writeln!(
            diagnostic,
            "Workflow command result delivery failed; ownership retained."
        );
    }
}

#[cfg(all(test, unix))]
#[test]
fn command_result_survives_disconnected_result_and_diagnostic_readers() {
    let (mut result, result_reader) = std::os::unix::net::UnixStream::pair().unwrap();
    let (mut diagnostic, diagnostic_reader) = std::os::unix::net::UnixStream::pair().unwrap();
    drop(result_reader);
    drop(diagnostic_reader);
    report_command_result(&mut result, 37, &mut diagnostic);
}

#[cfg(unix)]
fn owner_socket(pid: u32, birth: &str) -> std::path::PathBuf {
    std::path::PathBuf::from("/tmp").join(format!("t3-setup-v4-{pid}-{birth}"))
}
#[cfg(unix)]
fn request_arm(pid: u32, birth: &str, request: u8) -> io::Result<bool> {
    use std::io::{Read, Write};
    let mut stream = match std::os::unix::net::UnixStream::connect(owner_socket(pid, birth)) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    stream.set_read_timeout(Some(Duration::from_secs(1)))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    stream.write_all(&[request])?;
    let mut ack = [0u8];
    stream.read_exact(&mut ack)?;
    Ok(ack[0] == 4)
}
#[cfg(unix)]
fn ready(pid: u32, birth: &str) -> io::Result<bool> {
    request_arm(pid, birth, b'C')
}
#[cfg(unix)]
fn arm(pid: u32, birth: &str) -> io::Result<LaunchResult> {
    use std::io::{Read, Write};
    let mut stream = std::os::unix::net::UnixStream::connect(owner_socket(pid, birth))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    stream.write_all(b"A")?;
    let mut response = Vec::new();
    stream
        .take((LAUNCH_LIMIT + 1) as u64)
        .read_to_end(&mut response)?;
    if response.len() > LAUNCH_LIMIT {
        return Err(io::Error::other("Oversized setup launch result"));
    }
    Ok(serde_json::from_slice(&response)?)
}
#[cfg(unix)]
fn await_arm(
    spawn: impl FnOnce() -> (Option<std::process::Child>, LaunchResult),
) -> io::Result<Option<std::process::Child>> {
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;
    let pid = std::process::id();
    let birth = identity(pid)?.ok_or_else(|| io::Error::other("Missing setup owner identity"))?;
    let path = owner_socket(pid, &birth);
    let listener = std::os::unix::net::UnixListener::bind(&path)?;
    struct SocketPath(std::path::PathBuf);
    impl Drop for SocketPath {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _path = SocketPath(path.clone());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    let started = Instant::now();
    let mut spawn = Some(spawn);
    while started.elapsed() < Duration::from_secs(30) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_read_timeout(Some(Duration::from_secs(1)))?;
                let mut request = [0u8];
                if stream.read_exact(&mut request).is_ok() && matches!(request[0], b'A' | b'C') {
                    if request[0] == b'C' {
                        let _ = stream.write_all(&[4]);
                    } else {
                        // Launch only after capture was saved. Keep the anchor even if ACK is lost.
                        let (child, result) = spawn.take().unwrap()();
                        let response = launch_result_bytes(&result);
                        let _ = stream.write_all(&response);
                        return Ok(child);
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::other(
        "Setup owner was never armed; no setup was delivered",
    ))
}
#[cfg(target_os = "windows")]
fn ready(pid: u32, birth: &str) -> io::Result<bool> {
    Ok(windows::LaunchEvent::open(pid, birth).is_ok())
}
#[cfg(target_os = "windows")]
fn arm(pid: u32, birth: &str) -> io::Result<LaunchResult> {
    windows::LaunchEvent::open(pid, birth)?.arm(pid, birth)
}
#[cfg(target_os = "windows")]
fn await_arm(
    spawn: impl FnOnce() -> (Option<std::process::Child>, LaunchResult),
) -> io::Result<Option<std::process::Child>> {
    windows::LaunchEvent::wait(spawn)
}

#[cfg(unix)]
unsafe extern "C" {
    fn close(fd: i32) -> i32;
    fn getsid(pid: i32) -> i32;
    fn setsid() -> i32;
    fn fcntl(fd: i32, command: i32, value: i32) -> i32;
    fn getpid() -> i32;
    fn setpgid(pid: i32, pgid: i32) -> i32;
    fn isatty(fd: i32) -> i32;
    fn tcsetpgrp(fd: i32, pgid: i32) -> i32;
    #[link_name = "signal"]
    fn signal_handler(number: i32, handler: usize) -> usize;
}
#[cfg(target_os = "macos")]
const SIGSTOP: i32 = 17;
#[cfg(target_os = "linux")]
const SIGSTOP: i32 = 19;
#[cfg(target_os = "macos")]
const SIGTTOU: i32 = 22;
#[cfg(target_os = "linux")]
const SIGTTOU: i32 = 22;

#[cfg(unix)]
fn is_owner(pid: u32, expected: &str) -> io::Result<bool> {
    if identity(pid)?.as_deref() != Some(expected) || unsafe { getsid(pid as i32) } != pid as i32 {
        return Ok(false);
    }
    // Validate the captured PID, never discover/signal processes by matching their command.
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
        true,
        sysinfo::ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::Always),
    );
    Ok(system
        .process(sysinfo::Pid::from_u32(pid))
        .is_some_and(|p| {
            p.cmd()
                .get(1)
                .is_some_and(|arg| arg == "--setup-owner-v4" || arg == "--command-owner-v1")
        })
        && identity(pid)?.as_deref() == Some(expected))
}
#[cfg(unix)]
fn stop(pid: u32, expected: &str) -> io::Result<()> {
    if !is_owner(pid, expected)? {
        return Err(io::Error::other(
            "Setup ownership is unavailable; cleanup cannot be confirmed",
        ));
    }
    let started = Instant::now();
    // Freeze the anchor too: cleanup can race its initial shell spawn. Keep its
    // identity reserved until every member has stopped, so neither SID reuse nor late forks escape.
    while !stopped(pid)? {
        if !is_owner(pid, expected)? {
            return Err(io::Error::other("Setup ownership was lost during cleanup"));
        }
        signal(pid, expected, SIGSTOP)?;
        if started.elapsed() >= Duration::from_secs(1) {
            return Err(io::Error::other("Setup anchor did not freeze"));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    loop {
        if !is_owner(pid, expected)? {
            return Err(io::Error::other("Setup ownership was lost during cleanup"));
        }
        let members = session_members(pid)?;
        let mut frozen = true;
        for (member, birth, stopped) in &members {
            if !stopped {
                signal(*member, birth, SIGSTOP)?;
                frozen = false;
            }
        }
        if frozen {
            // No member or anchor can fork now. Session membership survives reparenting.
            for (member, birth, _) in members {
                signal(member, &birth, 9)?;
            }
            if session_members(pid)?.is_empty() {
                if !is_owner(pid, expected)? {
                    return Err(io::Error::other(
                        "Setup ownership was lost before confirmation",
                    ));
                }
                signal(pid, expected, 9)?;
                let confirmed = wait_exit(pid, expected);
                if confirmed.is_ok() {
                    let _ = std::fs::remove_file(owner_socket(pid, expected));
                }
                return confirmed;
            }
        }
        if started.elapsed() >= Duration::from_secs(7) {
            return Err(io::Error::other("Owned setup session did not stop"));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[cfg(unix)]
fn session_members(owner: u32) -> io::Result<Vec<(u32, String, bool)>> {
    let mut members = Vec::new();
    for pid in process_ids()? {
        if pid == owner {
            continue;
        }
        let sid = unsafe { getsid(pid as i32) };
        if sid < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(3) {
                continue;
            }
            return Err(error);
        }
        if sid != owner as i32 {
            continue;
        }
        if let Some(birth) = identity(pid)? {
            members.push((pid, birth, stopped(pid)?));
        }
    }
    Ok(members)
}
#[cfg(target_os = "linux")]
fn process_ids() -> io::Result<Vec<u32>> {
    let mut pids = Vec::new();
    for entry in std::fs::read_dir("/proc")? {
        if let Ok(pid) = entry?.file_name().to_string_lossy().parse::<u32>() {
            pids.push(pid);
        }
    }
    Ok(pids)
}
#[cfg(target_os = "macos")]
fn process_ids() -> io::Result<Vec<u32>> {
    unsafe extern "C" {
        fn proc_listallpids(buffer: *mut std::ffi::c_void, size: i32) -> i32;
    }
    let count = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Err(io::Error::last_os_error());
    }
    let mut ids = vec![0u32; count as usize + 1024];
    let length = unsafe { proc_listallpids(ids.as_mut_ptr().cast(), (ids.len() * 4) as i32) };
    if length <= 0 || length as usize >= ids.len() {
        return Err(io::Error::other("Incomplete OS process table"));
    }
    ids.truncate(length as usize);
    Ok(ids.into_iter().filter(|pid| *pid > 0).collect())
}
#[cfg(target_os = "linux")]
fn stopped(pid: u32) -> io::Result<bool> {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => Ok(stat
            .rsplit_once(')')
            .is_some_and(|(_, tail)| matches!(tail.split_whitespace().next(), Some("T" | "t")))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error),
    }
}
#[cfg(target_os = "macos")]
fn stopped(pid: u32) -> io::Result<bool> {
    Ok(bsd_info(pid)?.is_none_or(|info| info.status == 4 || info.status == 5))
}

fn wait_exit(pid: u32, expected: &str) -> io::Result<()> {
    let started = Instant::now();
    while identity(pid)?.as_deref() == Some(expected) {
        if started.elapsed() >= Duration::from_secs(1) {
            return Err(io::Error::other("Owned setup anchor did not exit"));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn boot() -> io::Result<Option<Boot>> {
    Ok(
        match (
            std::fs::read_to_string("/etc/machine-id"),
            std::fs::read_to_string("/proc/sys/kernel/random/boot_id"),
        ) {
            (Ok(host), Ok(session)) if !host.trim().is_empty() && !session.trim().is_empty() => {
                Some(Boot {
                    host: host.trim().to_owned(),
                    session: session.trim().to_owned(),
                })
            }
            _ => None,
        },
    )
}
#[cfg(target_os = "macos")]
fn boot() -> io::Result<Option<Boot>> {
    #[repr(C)]
    struct Timespec {
        seconds: i64,
        nanos: i64,
    }
    unsafe extern "C" {
        fn sysctlbyname(
            name: *const std::ffi::c_char,
            value: *mut std::ffi::c_void,
            size: *mut usize,
            new: *mut std::ffi::c_void,
            new_size: usize,
        ) -> i32;
        fn gethostuuid(id: *mut u8, timeout: *const Timespec) -> i32;
    }
    let mut session = [0u8; 128];
    let mut size = session.len();
    let mut host = [0u8; 16];
    if unsafe {
        sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            session.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || size == 0
        || size > session.len()
        || unsafe {
            gethostuuid(
                host.as_mut_ptr(),
                &Timespec {
                    seconds: 1,
                    nanos: 0,
                },
            )
        } != 0
    {
        return Ok(None);
    }
    let session = std::str::from_utf8(&session[..size - 1])
        .map_err(io::Error::other)?
        .to_owned();
    Ok(Some(Boot {
        host: host.iter().map(|byte| format!("{byte:02x}")).collect(),
        session,
    }))
}
// No documented stable boot-session identifier is available here. Never infer reboot from wall time.
#[cfg(target_os = "windows")]
fn boot() -> io::Result<Option<Boot>> {
    Ok(None)
}
#[cfg(target_os = "linux")]
fn identity(pid: u32) -> io::Result<Option<String>> {
    let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let fields: Vec<_> = stat
        .rsplit_once(')')
        .ok_or_else(|| io::Error::other("Invalid process stat"))?
        .1
        .split_whitespace()
        .collect();
    if matches!(fields.first(), Some(&"Z") | Some(&"X")) {
        return Ok(None);
    }
    let ticks = fields
        .get(19)
        .ok_or_else(|| io::Error::other("Missing process birth identity"))?;
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    Ok(Some(format!("{}:{ticks}", boot.trim())))
}

#[cfg(target_os = "linux")]
fn signal(pid: u32, expected: &str, number: i32) -> io::Result<()> {
    use std::ffi::{c_int, c_long};
    unsafe extern "C" {
        fn syscall(number: c_long, ...) -> c_long;
        fn close(fd: c_int) -> c_int;
    }
    // pidfd pins the process instance across the identity check and signal.
    let fd = unsafe { syscall(434, pid as c_int, 0 as c_int) } as c_int;
    if fd < 0 {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(3) {
            Ok(())
        } else {
            Err(error)
        };
    }
    let result = (|| {
        if identity(pid)?.as_deref() != Some(expected) {
            return Ok(());
        }
        let result = unsafe {
            syscall(
                424,
                fd,
                number as c_int,
                std::ptr::null::<std::ffi::c_void>(),
                0 as c_int,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(3) {
                return Err(error);
            }
        }
        Ok(())
    })();
    unsafe {
        close(fd);
    }
    result
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Default)]
struct BsdInfo {
    flags: u32,
    status: u32,
    xstatus: u32,
    pid: u32,
    ppid: u32,
    uid: u32,
    gid: u32,
    ruid: u32,
    rgid: u32,
    svuid: u32,
    svgid: u32,
    rfu: u32,
    comm: [u8; 16],
    name: [u8; 32],
    nfiles: u32,
    pgid: u32,
    pjobc: u32,
    tdev: u32,
    tpgid: u32,
    nice: i32,
    start_sec: u64,
    start_usec: u64,
}
#[cfg(target_os = "macos")]
fn bsd_info(pid: u32) -> io::Result<Option<BsdInfo>> {
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut std::ffi::c_void,
            size: i32,
        ) -> i32;
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let mut info = BsdInfo::default();
    let length = unsafe {
        proc_pidinfo(
            pid as i32,
            3,
            0,
            (&mut info as *mut BsdInfo).cast(),
            std::mem::size_of::<BsdInfo>() as i32,
        )
    };
    if length != std::mem::size_of::<BsdInfo>() as i32 {
        // libproc reports ESRCH for an exited but unreaped child; kill(0) can still see its zombie.
        if length == 0 && io::Error::last_os_error().raw_os_error() == Some(3) {
            return Ok(None);
        }
        if unsafe { kill(pid as i32, 0) } < 0
            && io::Error::last_os_error().raw_os_error() == Some(3)
        {
            return Ok(None);
        }
        return Err(io::Error::other(
            "Cannot inspect owned process birth identity",
        ));
    }
    Ok(Some(info))
}
#[cfg(target_os = "macos")]
fn identity(pid: u32) -> io::Result<Option<String>> {
    Ok(bsd_info(pid)?
        .filter(|info| info.status != 5)
        .map(|info| format!("{}:{}", info.start_sec, info.start_usec)))
}
#[cfg(target_os = "macos")]
fn signal(pid: u32, expected: &str, number: i32) -> io::Result<()> {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    if identity(pid)?.as_deref() != Some(expected) {
        return Ok(());
    }
    if unsafe { kill(pid as i32, number) } < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(3) {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
mod windows {
    use std::{ffi::c_void, io};
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetProcessTimes(
            handle: *mut c_void,
            created: *mut FileTime,
            exited: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
        fn TerminateProcess(handle: *mut c_void, code: u32) -> i32;
    }
    #[repr(C)]
    #[derive(Default)]
    struct Accounting {
        user: i64,
        kernel: i64,
        period_user: i64,
        period_kernel: i64,
        faults: u32,
        total: u32,
        active: u32,
        terminated: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
        fn OpenJobObjectW(access: u32, inherit: i32, name: *const u16) -> *mut c_void;
        fn GetCurrentProcess() -> *mut c_void;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn IsProcessInJob(process: *mut c_void, job: *mut c_void, result: *mut i32) -> i32;
        fn TerminateJobObject(job: *mut c_void, code: u32) -> i32;
        fn QueryInformationJobObject(
            job: *mut c_void,
            class: i32,
            value: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
        fn SetLastError(error: u32);
        fn GetLastError() -> u32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateEventW(
            attributes: *mut c_void,
            manual: i32,
            initial: i32,
            name: *const u16,
        ) -> *mut c_void;
        fn OpenEventW(access: u32, inherit: i32, name: *const u16) -> *mut c_void;
        fn SetEvent(event: *mut c_void) -> i32;
        fn WaitForSingleObject(handle: *mut c_void, timeout: u32) -> u32;
    }
    pub struct LaunchEvent(*mut c_void);
    impl Drop for LaunchEvent {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    impl LaunchEvent {
        fn name(pid: u32, birth: &str) -> Vec<u16> {
            format!("Local\\T3SetupLaunchV4-{pid}-{birth}\0")
                .encode_utf16()
                .collect()
        }
        pub fn open(pid: u32, birth: &str) -> io::Result<Self> {
            let handle = unsafe { OpenEventW(2, 0, Self::name(pid, birth).as_ptr()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(handle))
        }
        fn result_name(pid: u32, birth: &str) -> Vec<u16> {
            format!("Local\\T3SetupResultV1-{pid}-{birth}\0")
                .encode_utf16()
                .collect()
        }
        pub fn arm(&self, pid: u32, birth: &str) -> io::Result<super::LaunchResult> {
            let name = Self::result_name(pid, birth);
            let result = Self(unsafe { OpenEventW(0x100000, 0, name.as_ptr()) });
            if result.0.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mapping = LaunchMapping::open(pid, birth)?;
            if unsafe { SetEvent(self.0) } == 0 {
                return Err(io::Error::last_os_error());
            }
            if unsafe { WaitForSingleObject(result.0, 5000) } != 0 {
                return Err(io::Error::other("Setup launch result timed out"));
            }
            mapping.read()
        }
        pub fn wait(
            spawn: impl FnOnce() -> (Option<std::process::Child>, super::LaunchResult),
        ) -> io::Result<Option<std::process::Child>> {
            let pid = std::process::id();
            let birth = super::identity(pid)?
                .ok_or_else(|| io::Error::other("Missing setup owner identity"))?;
            let result = Self(unsafe {
                CreateEventW(
                    std::ptr::null_mut(),
                    1,
                    0,
                    Self::result_name(pid, &birth).as_ptr(),
                )
            });
            if result.0.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mapping = LaunchMapping::create(pid, &birth)?;
            // Publish the capture-ready event last, after the result channel exists.
            let event = Self(unsafe {
                CreateEventW(std::ptr::null_mut(), 0, 0, Self::name(pid, &birth).as_ptr())
            });
            if event.0.is_null() {
                return Err(io::Error::last_os_error());
            }
            if unsafe { WaitForSingleObject(event.0, 30_000) } != 0 {
                return Err(io::Error::other(
                    "Setup owner was never armed; no setup was delivered",
                ));
            }
            let (child, launched) = spawn();
            mapping.write(&launched);
            // A lost acknowledgement must retain the owner, just like the Unix socket path.
            let _ = unsafe { SetEvent(result.0) };
            Ok(child)
        }
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileMappingW(
            file: *mut c_void,
            attributes: *mut c_void,
            protect: u32,
            high: u32,
            low: u32,
            name: *const u16,
        ) -> *mut c_void;
        fn OpenFileMappingW(access: u32, inherit: i32, name: *const u16) -> *mut c_void;
        fn MapViewOfFile(
            mapping: *mut c_void,
            access: u32,
            high: u32,
            low: u32,
            bytes: usize,
        ) -> *mut c_void;
        fn UnmapViewOfFile(view: *const c_void) -> i32;
    }
    struct LaunchMapping {
        handle: *mut c_void,
        view: *mut u8,
    }
    impl Drop for LaunchMapping {
        fn drop(&mut self) {
            unsafe {
                UnmapViewOfFile(self.view.cast());
                CloseHandle(self.handle);
            }
        }
    }
    impl LaunchMapping {
        fn name(pid: u32, birth: &str) -> Vec<u16> {
            format!("Local\\T3SetupResultDataV1-{pid}-{birth}\0")
                .encode_utf16()
                .collect()
        }
        fn view(handle: *mut c_void, access: u32) -> io::Result<Self> {
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let view = unsafe { MapViewOfFile(handle, access, 0, 0, super::LAUNCH_LIMIT + 4) };
            if view.is_null() {
                let error = io::Error::last_os_error();
                unsafe {
                    CloseHandle(handle);
                }
                return Err(error);
            }
            Ok(Self {
                handle,
                view: view.cast(),
            })
        }
        fn create(pid: u32, birth: &str) -> io::Result<Self> {
            Self::view(
                unsafe {
                    CreateFileMappingW(
                        -1isize as *mut c_void,
                        std::ptr::null_mut(),
                        4,
                        0,
                        (super::LAUNCH_LIMIT + 4) as u32,
                        Self::name(pid, birth).as_ptr(),
                    )
                },
                2,
            )
        }
        fn open(pid: u32, birth: &str) -> io::Result<Self> {
            Self::view(
                unsafe { OpenFileMappingW(4, 0, Self::name(pid, birth).as_ptr()) },
                4,
            )
        }
        fn write(&self, result: &super::LaunchResult) {
            let bytes = super::launch_result_bytes(result);
            unsafe {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.view.add(4), bytes.len());
                std::ptr::copy_nonoverlapping(
                    (bytes.len() as u32).to_le_bytes().as_ptr(),
                    self.view,
                    4,
                );
            }
        }
        fn read(&self) -> io::Result<super::LaunchResult> {
            let mut length = [0u8; 4];
            unsafe {
                std::ptr::copy_nonoverlapping(self.view, length.as_mut_ptr(), 4);
            }
            let length = u32::from_le_bytes(length) as usize;
            if length == 0 || length > super::LAUNCH_LIMIT {
                return Err(io::Error::other("Invalid setup launch result size"));
            }
            Ok(serde_json::from_slice(unsafe {
                std::slice::from_raw_parts(self.view.add(4), length)
            })?)
        }
    }

    // No breakaway flags and no kill-on-handle-close: ordinary descendants stay owned
    // across shell/server exit. The named object lives while its processes live.
    pub struct Job(*mut c_void);
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    impl Job {
        fn name(pid: u32, birth: &str) -> Vec<u16> {
            format!("Local\\T3SetupV4-{pid}-{birth}\0")
                .encode_utf16()
                .collect()
        }
        pub fn create_owner() -> io::Result<Self> {
            let pid = std::process::id();
            let birth =
                super::identity(pid)?.ok_or_else(|| io::Error::other("Missing owner identity"))?;
            unsafe {
                SetLastError(0);
            }
            let job =
                unsafe { CreateJobObjectW(std::ptr::null_mut(), Self::name(pid, &birth).as_ptr()) };
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let owner = Self(job);
            if unsafe { GetLastError() } == 183 {
                return Err(io::Error::other("Setup job identity already exists"));
            }
            if unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(owner)
        }
        pub fn open(pid: u32, birth: &str) -> io::Result<Self> {
            let handle =
                unsafe { OpenJobObjectW(0x0004 | 0x0008, 0, Self::name(pid, birth).as_ptr()) };
            if handle.is_null() {
                return Err(io::Error::other("Setup job ownership is unavailable"));
            }
            Ok(Self(handle))
        }
        pub fn contains(&self, process: &Process) -> io::Result<bool> {
            let mut contained = 0;
            if unsafe { IsProcessInJob(process.0, self.0, &mut contained) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(contained != 0)
        }
        pub fn stop(&self) -> io::Result<()> {
            if unsafe { TerminateJobObject(self.0, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let started = std::time::Instant::now();
            loop {
                let mut info = Accounting::default();
                if unsafe {
                    QueryInformationJobObject(
                        self.0,
                        1,
                        (&mut info as *mut Accounting).cast(),
                        std::mem::size_of::<Accounting>() as u32,
                        std::ptr::null_mut(),
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                if info.active == 0 {
                    return Ok(());
                }
                if started.elapsed() >= std::time::Duration::from_secs(7) {
                    return Err(io::Error::other("Owned setup job did not stop"));
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }
    pub struct Process(*mut c_void);
    impl Drop for Process {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    impl Process {
        pub fn open(pid: u32, terminate: bool) -> io::Result<Option<Self>> {
            let handle = unsafe { OpenProcess(0x1000 | if terminate { 1 } else { 0 }, 0, pid) };
            if handle.is_null() {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(87) {
                    Ok(None)
                } else {
                    Err(error)
                };
            }
            Ok(Some(Self(handle)))
        }
        pub fn identity(&self) -> io::Result<Option<String>> {
            let mut code = 0;
            if unsafe { GetExitCodeProcess(self.0, &mut code) } == 0 {
                return Err(io::Error::last_os_error());
            }
            if code != 259 {
                return Ok(None);
            }
            let (mut created, mut exited, mut kernel, mut user) = (
                FileTime::default(),
                FileTime::default(),
                FileTime::default(),
                FileTime::default(),
            );
            if unsafe { GetProcessTimes(self.0, &mut created, &mut exited, &mut kernel, &mut user) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Some(format!(
                "{}",
                (u64::from(created.high) << 32) | u64::from(created.low)
            )))
        }
        pub fn terminate(&self) -> io::Result<()> {
            if unsafe { TerminateProcess(self.0, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }
}
#[cfg(target_os = "windows")]
fn identity(pid: u32) -> io::Result<Option<String>> {
    windows::Process::open(pid, false)?.map_or(Ok(None), |process| process.identity())
}
#[cfg(target_os = "windows")]
fn signal(pid: u32, expected: &str, _number: i32) -> io::Result<()> {
    if let Some(process) = windows::Process::open(pid, true)? {
        if process.identity()?.as_deref() == Some(expected) {
            process.terminate()?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn is_owner(pid: u32, expected: &str) -> io::Result<bool> {
    let Some(process) = windows::Process::open(pid, false)? else {
        return Ok(false);
    };
    if process.identity()?.as_deref() != Some(expected) {
        return Ok(false);
    }
    match windows::Job::open(pid, expected) {
        Ok(job) => job.contains(&process),
        Err(_) => Ok(false),
    }
}
#[cfg(target_os = "windows")]
fn stop(pid: u32, expected: &str) -> io::Result<()> {
    windows::Job::open(pid, expected)?.stop()
}
