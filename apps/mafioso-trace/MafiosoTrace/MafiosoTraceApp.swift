import SwiftUI

@main
struct MafiosoTraceApp: App {
    @StateObject private var store = GameStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
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
        }
    }
}
