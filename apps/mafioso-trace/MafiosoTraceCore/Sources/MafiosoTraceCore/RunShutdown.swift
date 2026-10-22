import Foundation

public enum ShutdownSignal: String, Equatable, Sendable {
    case terminate
    case kill
}

public struct ShutdownRequest: Equatable, Sendable {
    public var pid: Int32
    public var stopContainer: Bool
    public var containerName: String

    public init(pid: Int32, stopContainer: Bool, containerName: String) {
        self.pid = pid
        self.stopContainer = stopContainer
        self.containerName = containerName
    }
}

/// What quit does to the harness child. The app supplies the real signals.
public protocol RunTerminating: AnyObject {
    func signalGroup(pid: Int32, _ signal: ShutdownSignal)
    func waitForExit(pid: Int32, timeout: TimeInterval) -> Bool
    func stopContainer(name: String)
}

public enum RunShutdown {
    public static let grace: TimeInterval = 5
    public static let killGrace: TimeInterval = 1
    public static let quitPrompt = "Stop the running game and quit?"
    public static let stopAndQuitTitle = "Stop & Quit"
    public static let cancelTitle = "Cancel"
    /// `MAFIOSO_CONTAINER_NAME` in `scripts/mac-container-run.sh`.
    public static let defaultContainerName = "mafioso-mac"

    public static func asksToStop(runActive: Bool) -> Bool {
        runActive
    }

    public static func containerName(environment: [String: String]) -> String {
        safeContainerName(environment["MAFIOSO_CONTAINER_NAME"] ?? "")
    }

    /// A name that cannot be read as a `container` flag.
    public static func safeContainerName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
        guard !trimmed.isEmpty,
              !trimmed.hasPrefix("-"),
              trimmed.unicodeScalars.allSatisfy({ allowed.contains($0) })
        else { return defaultContainerName }
        return trimmed
    }

    /// SIGTERM the child's process group, wait `grace` seconds, SIGKILL if it is still there.
    /// A local-container run then stops the Apple container, which survives the script when SIGKILL skips its trap.
    public static func perform(_ request: ShutdownRequest, using terminator: RunTerminating) {
        if request.pid > 1 {
            terminator.signalGroup(pid: request.pid, .terminate)
            let exited = terminator.waitForExit(pid: request.pid, timeout: grace)
            if !exited {
                terminator.signalGroup(pid: request.pid, .kill)
                _ = terminator.waitForExit(pid: request.pid, timeout: killGrace)
            }
        }
        if request.stopContainer {
            terminator.stopContainer(name: safeContainerName(request.containerName))
        }
    }
}
