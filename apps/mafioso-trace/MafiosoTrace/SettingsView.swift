import SwiftUI

struct SettingsView: View {
    @AppStorage(LogsRoot.storageKey) private var logsRoot = LogsRoot.defaultPath

    var body: some View {
        Form {
            TextField("Logs root", text: $logsRoot)
            Text("Folder of game directories. Each game is a folder of seat JSONL files. The default is ~/mafioso-mac/logs. Point this at logs/traces, or at the directory you set as MAFIOSO_TRACE_DIR.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(width: 520)
    }
}
