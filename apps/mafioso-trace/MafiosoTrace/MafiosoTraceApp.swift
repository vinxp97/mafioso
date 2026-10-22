import SwiftUI

@main
struct MafiosoTraceApp: App {
    @StateObject private var store = GameStore()
    @StateObject private var config = AppConfigController()
    @StateObject private var run = RunController()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .environmentObject(config)
                .environmentObject(run)
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
