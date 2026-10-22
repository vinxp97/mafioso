import XCTest
@testable import MafiosoTraceCore

final class RunShutdownTests: XCTestCase {
    func testQuitAsksOnlyWhileARunIsActive() {
        XCTAssertFalse(RunShutdown.asksToStop(runActive: false))
        XCTAssertTrue(RunShutdown.asksToStop(runActive: true))
        XCTAssertEqual(RunShutdown.quitPrompt, "Stop the running game and quit?")
        XCTAssertEqual(RunShutdown.stopAndQuitTitle, "Stop & Quit")
        XCTAssertEqual(RunShutdown.cancelTitle, "Cancel")
        XCTAssertEqual(RunShutdown.grace, 5)
    }

    func testTerminateIsEnoughWhenTheGroupExits() {
        let terminator = ScriptedTerminator(exitsAfterTerminate: true)
        RunShutdown.perform(
            ShutdownRequest(pid: 4321, stopContainer: false, containerName: "mafioso-mac"),
            using: terminator
        )
        XCTAssertEqual(terminator.events, [
            "signal terminate 4321",
            "wait \(RunShutdown.grace)",
        ])
    }

    func testKillFollowsWhenTheGroupSurvivesAndTheContainerStops() {
        let terminator = ScriptedTerminator(exitsAfterTerminate: false)
        RunShutdown.perform(
            ShutdownRequest(pid: 4321, stopContainer: true, containerName: "mafioso-mac"),
            using: terminator
        )
        XCTAssertEqual(terminator.events, [
            "signal terminate 4321",
            "wait \(RunShutdown.grace)",
            "signal kill 4321",
            "wait \(RunShutdown.killGrace)",
            "container stop mafioso-mac",
        ])
    }

    func testUnsafeContainerNameFallsBack() {
        XCTAssertEqual(RunShutdown.containerName(environment: [:]), "mafioso-mac")
        XCTAssertEqual(RunShutdown.containerName(environment: ["MAFIOSO_CONTAINER_NAME": "table-2"]), "table-2")
        XCTAssertEqual(RunShutdown.safeContainerName("-rf"), "mafioso-mac")
        XCTAssertEqual(RunShutdown.safeContainerName("name;rm"), "mafioso-mac")
        let terminator = ScriptedTerminator(exitsAfterTerminate: true)
        RunShutdown.perform(
            ShutdownRequest(pid: 0, stopContainer: true, containerName: "-n"),
            using: terminator
        )
        XCTAssertEqual(terminator.events, ["container stop mafioso-mac"])
    }
}

private final class ScriptedTerminator: RunTerminating {
    var events: [String] = []
    var exitsAfterTerminate: Bool

    init(exitsAfterTerminate: Bool) {
        self.exitsAfterTerminate = exitsAfterTerminate
    }

    func signalGroup(pid: Int32, _ signal: ShutdownSignal) {
        events.append("signal \(signal.rawValue) \(pid)")
        if signal == .kill { exitsAfterTerminate = true }
    }

    func waitForExit(pid: Int32, timeout: TimeInterval) -> Bool {
        events.append("wait \(timeout)")
        return exitsAfterTerminate
    }

    func stopContainer(name: String) {
        events.append("container stop \(name)")
    }
}
