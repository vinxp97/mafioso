import Foundation
import MafiosoTraceCore

/// `~/Library/Caches/MafiosoTrace`. The clone and the stamps live here, not in a folder the user picked.
enum TraceCaches {
    static var repos: String { directory("repos") }
    static var stamps: String { directory("stamps") }

    private static func directory(_ name: String) -> String {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Caches")
        return base
            .appendingPathComponent("MafiosoTrace", isDirectory: true)
            .appendingPathComponent(name, isDirectory: true)
            .path
    }
}

/// System git and npm. The process inherits the user environment so the credential helper runs. No token is added.
final class ProcessCommandRunner: CommandRunning, @unchecked Sendable {
    private let lock = NSLock()
    private var active: Process?
    private var cancelled = false

    func cancel() {
        lock.lock()
        cancelled = true
        let process = active
        lock.unlock()
        process?.terminate()
    }

    func run(executable: String, arguments: [String], currentDirectory: String?) throws -> CommandResult {
        let program: String
        let args: [String]
        switch executable {
        case "git":
            program = "/usr/bin/git"
            args = arguments
        case "npm":
            program = "/usr/bin/env"
            args = ["npm"] + arguments
        default:
            program = executable
            args = arguments
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: program)
        process.arguments = args
        process.environment = Self.childEnvironment()
        if let currentDirectory, !currentDirectory.isEmpty {
            process.currentDirectoryURL = URL(fileURLWithPath: currentDirectory, isDirectory: true)
        }
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = FileHandle.nullDevice

        lock.lock()
        if cancelled {
            lock.unlock()
            return CommandResult(status: 1, stdout: "", stderr: "")
        }
        active = process
        lock.unlock()
        defer {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            lock.lock()
            if active === process { active = nil }
            lock.unlock()
        }

        let outBox = DataBox()
        let errBox = DataBox()
        let pipes = PipeGate(count: 2)
        stdout.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                pipes.finishOne()
            } else {
                outBox.append(chunk)
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                pipes.finishOne()
            } else {
                errBox.append(chunk)
            }
        }
        try process.run()
        process.waitUntilExit()
        pipes.wait()
        return CommandResult(
            status: process.terminationStatus,
            stdout: String(decoding: outBox.data, as: UTF8.self),
            stderr: String(decoding: errBox.data, as: UTF8.self)
        )
    }

    /// GUI apps do not get the shell PATH. Homebrew stays in front, and the rest of the environment is the user's.
    private static func childEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let prefix = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        if let path = env["PATH"], !path.isEmpty {
            env["PATH"] = prefix + ":" + path
        } else {
            env["PATH"] = prefix
        }
        return env
    }
}

final class FileCheckoutStorage: CheckoutStorage, @unchecked Sendable {
    func fileExists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: path)
    }

    func isDirectory(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
    }

    func read(_ path: String) -> String? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func write(_ path: String, _ contents: String) throws {
        do {
            try contents.write(to: URL(fileURLWithPath: path), atomically: true, encoding: .utf8)
        } catch {
            throw CheckoutError(message: "Could not write the stamp.")
        }
    }

    func makeDirectory(_ path: String) throws {
        do {
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        } catch {
            throw CheckoutError(message: "Could not create a cache folder.")
        }
    }
}

private final class DataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()

    func append(_ chunk: Data) {
        lock.lock()
        storage.append(chunk)
        lock.unlock()
    }

    var data: Data {
        lock.lock()
        let copy = storage
        lock.unlock()
        return copy
    }
}

private final class PipeGate: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var remaining: Int

    init(count: Int) {
        remaining = count
    }

    func finishOne() {
        lock.lock()
        remaining -= 1
        let done = remaining == 0
        lock.unlock()
        if done { semaphore.signal() }
    }

    func wait() {
        semaphore.wait()
    }
}
