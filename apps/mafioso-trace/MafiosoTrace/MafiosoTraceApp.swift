import AppKit
import MafiosoTraceCore
import SwiftUI

@main
struct MafiosoTraceApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store: GameStore
    @StateObject private var config: AppConfigController
    @StateObject private var run: RunController

    init() {
        let store = GameStore()
        let config = AppConfigController()
        let run = RunController()
        _store = StateObject(wrappedValue: store)
        _config = StateObject(wrappedValue: config)
        _run = StateObject(wrappedValue: run)
        AppDelegate.pendingRun = run
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .environmentObject(config)
                .environmentObject(run)
                .onAppear { AppDelegate.pendingRun = run }
                .frame(minWidth: 960, minHeight: 640)
        }
        .commands {
            CommandGroup(after: .newItem) {
                Button("Reload Trace") {
                    store.reload()
                }
                .keyboardShortcut("r", modifiers: .command)
            }
        }
        Settings {
            SettingsView()
                .environmentObject(config)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    static var pendingRun: RunController?
    private var terminating = false

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        MainActor.assumeIsolated {
            self.terminateOnMain()
        }
    }

    @MainActor
    private func terminateOnMain() -> NSApplication.TerminateReply {
        if terminating { return .terminateLater }
        guard let run = Self.pendingRun, RunShutdown.asksToStop(runActive: run.isRunning) else {
            return .terminateNow
        }
        let alert = NSAlert()
        alert.messageText = RunShutdown.quitPrompt
        alert.addButton(withTitle: RunShutdown.stopAndQuitTitle)
        alert.addButton(withTitle: RunShutdown.cancelTitle)
        alert.buttons.last?.keyEquivalent = "\u{1b}"
        guard alert.runModal() == .alertFirstButtonReturn else { return .terminateCancel }
        terminating = true
        Task { @MainActor in
            await run.stopForQuit()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
