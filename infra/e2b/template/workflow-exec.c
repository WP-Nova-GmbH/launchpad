#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <netinet/in.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define COORDINATOR_ID 1000
#define WORKFLOW_ID 10001
#define WORKFLOW_HOME "/home/launchpad-workflow"
#define WORKFLOW_MARKER "/etc/launchpad/workflow-guest"
#define WORKLOAD_HELPER "/opt/launchpad/bin/launchpad-workload"
#define CHECKPOINT_PYTHON "/opt/launchpad/bin/launchpad-workflow-reader-python"
#define CHECKPOINT_READER "/opt/launchpad/bin/launchpad-workflow-checkpoint-reader.py"
#define WORKFLOW_GIT "/opt/launchpad/bin/launchpad-workflow-git"
#define SETUP_OWNER "/opt/launchpad/bin/launchpad-workflow-setup-owner"

enum workload_kind { ordinary, provider, checkpoint_reader, workflow_git, setup_owner };

static int workflow_enabled(void) {
    struct stat info;
    int marker = open(WORKFLOW_MARKER, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (marker < 0) return 0;
    int valid = fstat(marker, &info) == 0 && S_ISREG(info.st_mode) &&
        info.st_uid == 0 && info.st_nlink == 1 && !(info.st_mode & 0022);
    close(marker);
    return valid;
}

static int prepare_workspace(void) {
    struct stat info;
    int workspace = open("/workspace", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (workspace < 0) return -1;
    int result = -1;
    if (fstat(workspace, &info) == 0 && info.st_uid == COORDINATOR_ID &&
        info.st_gid == COORDINATOR_ID && (info.st_mode & 07777) == 0755 &&
        mkdirat(workspace, "project", 0700) == 0) {
        int project = openat(workspace, "project", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (project >= 0) {
            if (fchown(project, WORKFLOW_ID, COORDINATOR_ID) == 0 && fchmod(project, 02770) == 0)
                result = 0;
            close(project);
        }
    }
    close(workspace);
    return result;
}

static int open_setup_script(const char *path) {
    const char prefix[] = "/tmp/launchpad-workflow-setup-";
    const size_t prefix_length = sizeof(prefix) - 1;
    if (strlen(path) != prefix_length + 32 + 3 ||
        strncmp(path, prefix, prefix_length) != 0 ||
        strspn(path + prefix_length, "0123456789abcdef") != 32 ||
        strcmp(path + prefix_length + 32, ".sh") != 0)
        return -1;

    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) return -1;
    struct stat info;
    int valid = fstat(fd, &info) == 0 && S_ISREG(info.st_mode) &&
        info.st_uid == COORDINATOR_ID && info.st_gid == COORDINATOR_ID &&
        info.st_nlink == 1 && (info.st_mode & 07777) == 0600;
    // Consume the coordinator-owned name before granting the workflow shell
    // read access via the inherited descriptor. Its inode stays nonwritable.
    if (!valid || unlink(path) != 0 || fstat(fd, &info) != 0 || info.st_nlink != 0 ||
        fchmod(fd, 0444) != 0) {
        close(fd);
        return -1;
    }
    int installed = fd == 3 ? fcntl(fd, F_SETFD, 0) : dup3(fd, 3, 0);
    if (fd != 3 || installed < 0) close(fd);
    return installed < 0 ? -1 : 0;
}

static int protect_dumpability(void) {
#if defined(__aarch64__)
    const unsigned int architecture = AUDIT_ARCH_AARCH64;
#elif defined(__x86_64__)
    const unsigned int architecture = AUDIT_ARCH_X86_64;
#else
#error Unsupported workflow guest architecture
#endif
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, architecture, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
        /* The x32 ABI uses the x86-64 arch identifier with different syscall numbers. */
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, __X32_SYSCALL_BIT, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_prctl, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PR_SET_DUMPABLE, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
        .filter = filter,
    };
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

static int exec_workload(const char *cwd, char **command, enum workload_kind kind) {
    int protected = kind != ordinary;
    if (setgroups(0, NULL) != 0 ||
        setresgid(WORKFLOW_ID, WORKFLOW_ID, WORKFLOW_ID) != 0 ||
        setresuid(WORKFLOW_ID, WORKFLOW_ID, WORKFLOW_ID) != 0 ||
        (protected && prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L) != 0) ||
        prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) != 0 ||
        (protected && protect_dumpability() != 0) ||
        close_range(kind == setup_owner ? 4 : 3, UINT_MAX, 0) != 0)
        return -1;
    // Resolve and enter the requested directory with only workload privileges.
    if (*cwd && (*cwd != '/' || chdir(cwd) != 0 || setenv("PWD", cwd, 1) != 0))
        return -1;
    if (setenv("HOME", WORKFLOW_HOME, 1) != 0 ||
        setenv("CODEX_HOME", WORKFLOW_HOME "/.codex", 1) != 0 ||
        setenv("USER", "launchpad-workflow", 1) != 0 ||
        setenv("LOGNAME", "launchpad-workflow", 1) != 0 ||
        unsetenv("T3CODE_HOME") != 0 || unsetenv("LAUNCHPAD_WORKFLOW_GUEST") != 0 ||
        unsetenv("LAUNCHPAD_COORDINATOR_SCOPE") != 0)
        return -1;
    if (kind == provider) {
        if (command[0][0] != '/' ||
            setenv("CODEX_MANAGED_PACKAGE_ROOT", "/opt/launchpad/node/lib/node_modules/@openai/codex", 1) != 0 ||
            setenv("CODEX_MANAGED_BY_NPM", "1", 1) != 0 ||
            unsetenv("CODEX_MANAGED_BY_BUN") != 0 ||
            unsetenv("CODEX_MANAGED_BY_PNPM") != 0 ||
            unsetenv("CODEX_MANAGED_BY_VITE_PLUS") != 0)
            return -1;
    }
    if (kind == workflow_git && setenv("GIT_EXEC_PATH", "/usr/lib/git-core", 1) != 0)
        return -1;
    if (protected) execv(command[0], command);
    else execvp(command[0], command);
    return -1;
}

static int exec_control(int count, char **args) {
    char *const environment[] = {"PATH=/usr/bin:/bin", "LC_ALL=C", NULL};
    char *command[10] = {"/usr/bin/python3", "-IS", WORKLOAD_HELPER};
    for (int i = 0; i < count; i++)
        command[i + 3] = args[i];
    if (setgroups(0, NULL) != 0 || setresgid(0, 0, 0) != 0 || setresuid(0, 0, 0) != 0 ||
        close_range(3, UINT_MAX, 0) != 0)
        return -1;
    execve(command[0], command, environment);
    return -1;
}

static int number(const char *text, int min, int max) {
    if (*text < '0' || *text > '9') return -1;
    char *end;
    errno = 0;
    long result = strtol(text, &end, 10);
    return errno || *end || result < min || result > max ? -1 : (int)result;
}

static int duplicate_fd(int pidfd, int fd) {
    return (int)syscall(SYS_pidfd_getfd, pidfd, fd, 0);
}

static int endpoint_matches(const struct sockaddr_in *address, socklen_t length, int port) {
    return length == sizeof(*address) && address->sin_family == AF_INET &&
        address->sin_addr.s_addr == htonl(INADDR_LOOPBACK) && address->sin_port == htons((uint16_t)port);
}

static int socket_matches(int fd, int listener_port, int client_port) {
    struct sockaddr_in client, listener;
    socklen_t client_length = sizeof(client), listener_length = sizeof(listener);
    int protocol;
    socklen_t length = sizeof(protocol);
    return getsockopt(fd, SOL_SOCKET, SO_PROTOCOL, &protocol, &length) == 0 &&
        length == sizeof(protocol) && protocol == IPPROTO_TCP &&
        getsockname(fd, (struct sockaddr *)&client, &client_length) == 0 &&
        endpoint_matches(&client, client_length, client_port) &&
        getpeername(fd, (struct sockaddr *)&listener, &listener_length) == 0 &&
        endpoint_matches(&listener, listener_length, listener_port);
}

/* Called only by the root control action after it validates the current
 * cgroup record and opens the original process's pidfd. A raced FD number is
 * duplicated from that pinned process, never from a reused numeric PID. */
static int inspect_provider_peer(char **args) {
    int pidfd = number(args[0], 3, INT_MAX);
    int pid = number(args[1], 2, INT_MAX);
    int listener_port = number(args[2], 1, UINT16_MAX);
    int client_port = number(args[3], 1, UINT16_MAX);
    if (pidfd < 0 || pid < 0 || listener_port < 0 || client_port < 0 || listener_port == client_port)
        return -1;
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/fd", pid);
    DIR *fds = opendir(path);
    if (!fds) return errno == ENOENT ? 1 : -1;
    int result = 1;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(fds);
        if (!entry) {
            if (errno) result = -1;
            break;
        }
        int fd = number(entry->d_name, 0, INT_MAX);
        if (fd < 0) continue;
        char target[32];
        ssize_t size = readlinkat(dirfd(fds), entry->d_name, target, sizeof(target));
        if (size < 0) {
            if (errno == ENOENT) continue;
            result = -1;
            break;
        }
        if (size < 8 || memcmp(target, "socket:[", 8) != 0) continue;
        int duplicate = duplicate_fd(pidfd, fd);
        if (duplicate < 0) {
            if (errno == EBADF) continue;
            if (errno != ESRCH) result = -1;
            break;
        }
        int matches = socket_matches(duplicate, listener_port, client_port);
        close(duplicate);
        if (matches) {
            result = 0;
            break;
        }
    }
    closedir(fds);
    return result;
}

int main(int argc, char **argv) {
    if (getuid() == 0 && geteuid() == 0) {
        if (argc == 6 && strcmp(argv[1], "inspect-workflow-provider-socket") == 0) {
            int result = inspect_provider_peer(argv + 2);
            if (result >= 0) return result;
        }
        if (argc == 3 && strcmp(argv[1], "probe-workflow-provider-pidfd") == 0) {
            int pidfd = number(argv[2], 3, INT_MAX);
            int duplicate = pidfd < 0 ? -1 : duplicate_fd(pidfd, STDIN_FILENO);
            if (duplicate >= 0) {
                close(duplicate);
                return 0;
            }
        }
    } else if (getuid() == COORDINATOR_ID && geteuid() == 0 && workflow_enabled()) {
        if (argc == 2 && strcmp(argv[1], "prepare-workspace") == 0 && prepare_workspace() == 0)
            return 0;
        if (argc >= 5 && strcmp(argv[3], "--") == 0) {
            if (strcmp(argv[1], "exec") == 0) exec_workload(argv[2], argv + 4, ordinary);
            if (strcmp(argv[1], "exec-provider") == 0) exec_workload(argv[2], argv + 4, provider);
        }
        if (argc == 4 && strcmp(argv[1], "exec-checkpoint-reader") == 0 &&
            (strcmp(argv[3], "capture") == 0 || strcmp(argv[3], "exclude") == 0)) {
            char *command[] = {CHECKPOINT_PYTHON, "-IS", CHECKPOINT_READER, argv[3], NULL};
            exec_workload(argv[2], command, checkpoint_reader);
        }
        if (argc >= 4 && strcmp(argv[1], "exec-git") == 0 && strcmp(argv[3], "--") == 0) {
            argv[3] = WORKFLOW_GIT;
            exec_workload(argv[2], argv + 3, workflow_git);
        }
        if (argc == 4 && strcmp(argv[1], "exec-setup-owner") == 0 && open_setup_script(argv[3]) == 0) {
            char *command[] = {SETUP_OWNER, "--workflow-setup-owner-v4", "--script-fd-v1", NULL};
            exec_workload(argv[2], command, setup_owner);
        }
        if ((argc == 4 && strcmp(argv[1], "provider-identity") == 0) ||
            (argc == 5 && (strcmp(argv[1], "stop-idle-provider") == 0 ||
                           strcmp(argv[1], "signal-workflow") == 0)) ||
            (argc >= 3 && argc <= 5 && strcmp(argv[1], "workflow-setup-control") == 0) ||
            (argc == 7 && strcmp(argv[1], "verify-workflow-provider-peer") == 0))
            exec_control(argc - 1, argv + 1);
    }
    fputs("Launchpad workflow command could not be authorized.\n", stderr);
    return 74;
}
