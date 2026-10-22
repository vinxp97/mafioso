import Darwin
import Foundation

/// A harness child started as its own process-group leader, so quit can signal the group without signaling the app.
final class GroupedChild: @unchecked Sendable {
    let pid: pid_t
    let stdout: FileHandle
    let stderr: FileHandle

    private let lock = NSLock()
    private var didExit = false
    private var onExit: ((Int32) -> Void)?

    private init(pid: pid_t, stdout: FileHandle, stderr: FileHandle) {
        self.pid = pid
        self.stdout = stdout
        self.stderr = stderr
    }

    static func spawn(
        executable: String,
        arguments: [String],
        environment: [String: String],
        currentDirectory: String
    ) throws -> GroupedChild {
        var outPipe: [Int32] = [0, 0]
        var errPipe: [Int32] = [0, 0]
        guard pipe(&outPipe) == 0 else { throw GroupedSpawnError() }
        guard pipe(&errPipe) == 0 else {
            close(outPipe[0]); close(outPipe[1])
            throw GroupedSpawnError()
        }
        let devnull = open("/dev/null", O_RDONLY)
        guard devnull >= 0 else {
            close(outPipe[0]); close(outPipe[1]); close(errPipe[0]); close(errPipe[1])
            throw GroupedSpawnError()
        }

        var actions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else {
            close(devnull); close(outPipe[0]); close(outPipe[1]); close(errPipe[0]); close(errPipe[1])
            throw GroupedSpawnError()
        }
        defer { posix_spawn_file_actions_destroy(&actions) }

        var attr: posix_spawnattr_t?
        guard posix_spawnattr_init(&attr) == 0 else {
            close(devnull); close(outPipe[0]); close(outPipe[1]); close(errPipe[0]); close(errPipe[1])
            throw GroupedSpawnError()
        }
        defer { posix_spawnattr_destroy(&attr) }
        // pgroup 0 makes the new pid the process-group leader before main runs.
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attr, 0)

        let chdirOK = currentDirectory.withCString { posix_spawn_file_actions_addchdir_np(&actions, $0) == 0 }
        let actionsOK = chdirOK
            && posix_spawn_file_actions_adddup2(&actions, devnull, STDIN_FILENO) == 0
            && posix_spawn_file_actions_addclose(&actions, devnull) == 0
            && posix_spawn_file_actions_adddup2(&actions, outPipe[1], STDOUT_FILENO) == 0
            && posix_spawn_file_actions_adddup2(&actions, errPipe[1], STDERR_FILENO) == 0
            && posix_spawn_file_actions_addclose(&actions, outPipe[0]) == 0
            && posix_spawn_file_actions_addclose(&actions, outPipe[1]) == 0
            && posix_spawn_file_actions_addclose(&actions, errPipe[0]) == 0
            && posix_spawn_file_actions_addclose(&actions, errPipe[1]) == 0
        guard actionsOK else {
            close(devnull); close(outPipe[0]); close(outPipe[1]); close(errPipe[0]); close(errPipe[1])
            throw GroupedSpawnError()
        }

        var pid: pid_t = 0
        let rc = withCStrings([executable] + arguments) { argv in
            withCStrings(environment.map { "\($0.key)=\($0.value)" }) { envp in
                posix_spawn(&pid, executable, &actions, &attr, argv, envp)
            }
        }
        close(devnull)
        close(outPipe[1])
        close(errPipe[1])
        guard rc == 0, pid > 1 else {
            close(outPipe[0]); close(errPipe[0])
            throw GroupedSpawnError()
        }
        return GroupedChild(
            pid: pid,
            stdout: FileHandle(fileDescriptor: outPipe[0], closeOnDealloc: true),
            stderr: FileHandle(fileDescriptor: errPipe[0], closeOnDealloc: true)
        )
    }

    /// SIGTERM or SIGKILL the group. If the child is still in the app's group, only that pid is signaled.
    func signalGroup(_ signal: Int32) {
        guard pid > 1 else { return }
        let pgid = getpgid(pid)
        let parent = getpgrp()
        if pgid > 1, pgid != parent {
            _ = kill(-pgid, signal)
        } else {
            _ = kill(pid, signal)
        }
    }

    func startWatching(onExit: @escaping (Int32) -> Void) {
        lock.lock()
        self.onExit = onExit
        lock.unlock()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while let self, !self.waitForExit(timeout: 0.25) {}
        }
    }

    /// True when the child has been reaped. Waits up to `timeout` seconds.
    func waitForExit(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if reapIfExited() { return true }
            if Date() >= deadline { return false }
            usleep(50_000)
        }
    }

    private func reapIfExited() -> Bool {
        lock.lock()
        if didExit {
            lock.unlock()
            return true
        }
        lock.unlock()
        var status: Int32 = 0
        let rc = waitpid(pid, &status, WNOHANG)
        if rc == 0 { return false }
        if rc == pid {
            publish(exitCode(status))
            return true
        }
        if rc < 0 && errno == ECHILD {
            lock.lock()
            let already = didExit
            lock.unlock()
            return already
        }
        return false
    }

    private func publish(_ code: Int32) {
        lock.lock()
        let first = !didExit
        didExit = true
        let handler = onExit
        lock.unlock()
        if first { handler?(code) }
    }

    private func exitCode(_ status: Int32) -> Int32 {
        if status & 0x7f == 0 { return (status >> 8) & 0xff }
        return status & 0x7f
    }
}

private struct GroupedSpawnError: Error {}

private func withCStrings<T>(_ values: [String], _ body: (UnsafePointer<UnsafeMutablePointer<CChar>?>) -> T) -> T {
    let pointers = values.map { strdup($0) }
    defer { for pointer in pointers { free(pointer) } }
    let argv = pointers + [nil]
    return argv.withUnsafeBufferPointer { buffer in
        body(buffer.baseAddress!)
    }
}

/// `container stop <name>`, bounded so quit cannot wait on the CLI.
enum ContainerStop {
    static func run(_ name: String) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = ["container", "stop", name]
        var env = ProcessInfo.processInfo.environment
        let prefix = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        if let path = env["PATH"], !path.isEmpty {
            env["PATH"] = prefix + ":" + path
        } else {
            env["PATH"] = prefix
        }
        task.environment = env
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
        } catch {
            return
        }
        let deadline = Date().addingTimeInterval(RunShutdown.grace)
        while task.isRunning && Date() < deadline {
            usleep(50_000)
        }
        if task.isRunning {
            task.terminate()
            let pid = task.processIdentifier
            if pid > 1 { _ = kill(pid, SIGKILL) }
        }
    }
}

final class AppRunTerminator: RunTerminating, @unchecked Sendable {
    private let child: GroupedChild?

    init(child: GroupedChild?) {
        self.child = child
    }

    func signalGroup(pid: Int32, _ signal: ShutdownSignal) {
        let value: Int32 = signal == .kill ? SIGKILL : SIGTERM
        if let child, child.pid == pid {
            child.signalGroup(value)
            return
        }
        guard pid > 1 else { return }
        let pgid = getpgid(pid)
        guard pgid > 1, pgid != getpgrp() else { return }
        _ = kill(-pgid, value)
    }

    func waitForExit(pid: Int32, timeout: TimeInterval) -> Bool {
        guard let child, child.pid == pid else { return true }
        return child.waitForExit(timeout: timeout)
    }

    func stopContainer(name: String) {
        ContainerStop.run(name)
    }
}
