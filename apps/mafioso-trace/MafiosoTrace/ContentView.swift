import AppKit
import MafiosoTraceCore
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: GameStore
    @EnvironmentObject private var config: AppConfigController
    @EnvironmentObject private var run: RunController
    @AppStorage(LogsRoot.storageKey) private var logsRoot = LogsRoot.defaultPath
    @FocusState private var focusedRow: TraceEvent.ID?

    var body: some View {
        VStack(spacing: 0) {
            runBar
            Divider()
            NavigationSplitView {
                sidebar
            } content: {
                seatColumn
            } detail: {
                detail
            }
            if showLog {
                Divider()
                logPane
            }
        }
        .onAppear {
            store.start(arguments: CommandLine.arguments)
            store.setLogsRoot(logsRoot)
        }
        .onChange(of: logsRoot) { _, path in
            store.setLogsRoot(path)
        }
        .sheet(isPresented: confirmPresented) {
            confirmSheet
        }
    }

    private var runBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                Button("Start game") {
                    run.requestStart(config: config, store: store)
                }
                .disabled(startDisabled)
                Picker("Environment", selection: environment) {
                    ForEach(GameEnvironment.allCases) { item in
                        Text(item.displayName).tag(item)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 220)
                Toggle("Trace reasoning", isOn: traceReasoning)
                    .toggleStyle(.switch)
                    .help("On sets MAFIOSO_TRACE_REASONING=1 for the next run.")
                if run.isRunning {
                    Button("Stop") {
                        run.stop()
                    }
                }
                Spacer()
                Text(run.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let banner {
                Text(banner.text)
                    .font(.caption)
                    .foregroundStyle(banner.warning ? Color.orange : Color.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private var logPane: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(run.logText)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                Color.clear.frame(height: 1).id("run-log-end")
            }
            .onChange(of: run.logTick) { _, _ in
                DispatchQueue.main.async {
                    proxy.scrollTo("run-log-end", anchor: .bottom)
                }
            }
        }
        .frame(height: 160)
    }

    private var confirmSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Type \(run.confirmName ?? "") to start.")
                .font(.headline)
            if let warning = run.confirmWarning {
                Text(warning)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            TextField(run.confirmName ?? "", text: Binding(
                get: { run.confirmDraft },
                set: { run.confirmDraft = $0 }
            ))
            HStack {
                Spacer()
                Button("Cancel") {
                    run.cancelConfirm()
                }
                Button("Start") {
                    run.confirm(config: config, store: store)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!confirmMatches)
            }
        }
        .padding(20)
        .frame(width: 440)
    }

    private var showLog: Bool {
        if case .idle = run.phase { return !run.logText.isEmpty }
        return true
    }

    private var startDisabled: Bool {
        if run.isRunning { return true }
        if case .blocked = decision { return true }
        return false
    }

    private var decision: StartDecision {
        let profile = config.selectedProfile
        return StartPolicy.decide(
            profile: profile,
            inference: config.config.inference,
            secrets: config.launchSecrets(environment: profile.id, provider: config.config.inference.provider),
            repository: config.config.repositoryPath
        )
    }

    private var banner: (text: String, warning: Bool)? {
        switch decision {
        case .blocked(let reason):
            return (reason, false)
        case .ready(let warning), .needsConfirmation(_, let warning):
            if let warning { return (warning, true) }
            return nil
        }
    }

    private var confirmMatches: Bool {
        guard let name = run.confirmName else { return false }
        let environment = GameEnvironment.allCases.first { $0.confirmName == name }
        guard let environment else { return false }
        return ProdGate.accepts(environment: environment, typed: run.confirmDraft)
    }

    private var confirmPresented: Binding<Bool> {
        Binding(
            get: { run.confirmName != nil },
            set: { presented in
                if !presented { run.cancelConfirm() }
            }
        )
    }

    private var environment: Binding<GameEnvironment> {
        Binding(
            get: { config.config.selectedEnvironment },
            set: { config.selectEnvironment($0) }
        )
    }

    private var traceReasoning: Binding<Bool> {
        Binding(
            get: { !config.config.inference.excludeReasoning },
            set: { on in config.updateInference { $0.excludeReasoning = !on } }
        )
    }

    private var sidebar: some View {
        List(selection: gameBinding) {
            if store.games.isEmpty {
                Text(emptyTitle)
                    .foregroundStyle(.secondary)
            }
            ForEach(store.games) { game in
                HStack {
                    Text(game.id)
                        .lineLimit(1)
                    Spacer()
                    if store.fixtureName != nil {
                        badge("FIXTURE", color: .orange)
                    } else if game.isLive {
                        badge("LIVE", color: .green)
                    }
                }
                .tag(game.id as String?)
            }
        }
        .navigationTitle("Games")
        .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 320)
        .safeAreaInset(edge: .bottom) {
            TracePath(path: store.sidebarPath, byComponent: true)
                .padding(8)
        }
    }

    private var seatColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            List {
                seatButton("All", id: TimelineState.all)
                seatButton("Harness", id: TimelineState.harness)
                ForEach(store.playerSeats, id: \.self) { seat in
                    seatButton(seat, id: seat)
                }
            }
            .navigationTitle("Seat")
            Divider()
            VStack(alignment: .leading, spacing: 6) {
                Text("Phase")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Menu {
                    Button("All") { store.choosePhase(TimelineState.all) }
                    ForEach(store.phases, id: \.self) { phase in
                        Button(phase) { store.choosePhase(phase) }
                    }
                } label: {
                    Text(store.phase == TimelineState.all ? "All" : store.phase)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .menuStyle(.button)
            }
            .padding(8)
        }
        .navigationSplitViewColumnWidth(min: 160, ideal: 200, max: 280)
    }

    private var detail: some View {
        VStack(spacing: 0) {
            toolbar
            timeline
            Divider()
            DetailPane(event: store.selectedEvent, pair: pair)
                .frame(minHeight: 180)
        }
        .navigationTitle(store.selectedGameID ?? "Trace")
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            Toggle("Follow", isOn: Binding(get: { store.follow }, set: { store.setFollow($0) }))
                .toggleStyle(.switch)
            Button("Reload") {
                store.reload()
            }
            if !store.currentGameIsLive {
                if let bounds = store.scrubBounds, bounds.upperBound > bounds.lowerBound {
                    Slider(
                        value: Binding(
                            get: { Scrub.clamp(store.scrub, count: store.visible.count) },
                            set: { store.userScrubbed(to: $0) }
                        ),
                        in: bounds,
                        step: 1
                    )
                }
                Text(store.scrubLabel)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            } else if store.follow {
                Text("Live")
                    .font(.caption)
                    .foregroundStyle(.green)
            }
            Spacer()
            status
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var status: some View {
        if let path = store.pathLine {
            TracePath(path: path)
        } else {
            Text(store.statusLine)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private var timeline: some View {
        VStack(spacing: 0) {
            timelineRow(seq: "Seq", time: "Time", seat: "Seat", phase: "Phase", type: "Type", summary: "Summary", header: true)
                .foregroundStyle(.secondary)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.background)
                .zIndex(1)
            Divider()
                .zIndex(1)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(store.visible.enumerated()), id: \.element.id) { index, row in
                            let summary = TraceLink.summary(row)
                            timelineRow(
                                seq: "\(row.seq)",
                                time: Self.clock(row.ts),
                                seat: row.seat,
                                phase: TimelineState.phaseLabel(row.phase),
                                type: row.type,
                                summary: summary,
                                header: false
                            )
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(rowBackground(index: index, selected: store.selection.contains(row.id)))
                            .contentShape(Rectangle())
                            .onTapGesture { store.selectRow(row.id) }
                            .focusable()
                            .focused($focusedRow, equals: row.id)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("\(row.seq), \(row.type), \(summary)")
                            .accessibilityAddTraits(
                                store.selection.contains(row.id)
                                    ? AccessibilityTraits.isButton.union(.isSelected)
                                    : .isButton
                            )
                            .accessibilityAction(.default) { store.selectRow(row.id) }
                            .help(summary)
                            .id(row.id)
                        }
                    }
                }
                .clipped()
                .onAppear { revealSelection(proxy) }
                .onChange(of: store.selection) { _, _ in
                    revealSelection(proxy)
                }
            }
        }
        .frame(maxHeight: .infinity)
    }

    /// Focus stays on the selected timeline row, so detail text does not open highlighted.
    /// The scroll runs on the next turn, after this layout pass.
    private func revealSelection(_ proxy: ScrollViewProxy) {
        let id = store.selection.first
        DispatchQueue.main.async {
            guard let id else { return }
            focusedRow = id
            proxy.scrollTo(id, anchor: .top)
        }
    }

    private func timelineRow(seq: String, time: String, seat: String, phase: String, type: String, summary: String, header: Bool) -> some View {
        HStack(spacing: 8) {
            Text(seq)
                .monospacedDigit()
                .frame(width: 44, alignment: .leading)
            Text(time)
                .monospacedDigit()
                .frame(width: 112, alignment: .leading)
            Text(seat)
                .lineLimit(1)
                .frame(width: 72, alignment: .leading)
            Text(phase)
                .lineLimit(1)
                .frame(width: 88, alignment: .leading)
            Text(type)
                .lineLimit(1)
                .frame(width: 140, alignment: .leading)
            Text(summary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func rowBackground(index: Int, selected: Bool) -> Color {
        if selected { return Color.accentColor.opacity(0.35) }
        if index.isMultiple(of: 2) { return Color.primary.opacity(0.04) }
        return Color.clear
    }

    private var pair: ProposalVerdict {
        guard let event = store.selectedEvent else {
            return ProposalVerdict(proposal: nil, verdict: nil)
        }
        return TraceLink.pair(for: event, in: store.events)
    }

    private var emptyTitle: String {
        if store.fixtureMissing { return "Fixture file is missing" }
        if store.missingRoot { return "Logs folder is missing" }
        return "No games"
    }

    private var gameBinding: Binding<String?> {
        Binding(
            get: { store.selectedGameID },
            set: { id in
                guard let id else { return }
                store.select(game: id)
            }
        )
    }

    private func seatButton(_ title: String, id: String) -> some View {
        let selected = store.seat == id
        return Button {
            store.chooseSeat(id)
        } label: {
            Text(title)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 2)
                .padding(.horizontal, 6)
                .background(selected ? Color.accentColor : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                .foregroundStyle(selected ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
    }

    private func badge(_ title: String, color: Color) -> some View {
        Text(title)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.18), in: RoundedRectangle(cornerRadius: 4))
            .foregroundStyle(color)
    }

    private static func clock(_ ts: String) -> String {
        guard let time = ts.split(separator: "T").dropFirst().first else { return ts }
        return String(time.prefix(12))
    }
}

/// Sidebar path shortened on a `/` boundary. The tooltip stays the full path.
private struct ComponentPathText: View {
    let path: String

    var body: some View {
        GeometryReader { geo in
            let available = geo.size.width.isFinite ? geo.size.width : 0
            Text(TracePath.fitting(path, width: available))
                .lineLimit(1)
                .frame(width: available > 0 ? available : nil, height: geo.size.height, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: captionHeight)
    }

    private var captionHeight: CGFloat {
        ceil(NSFont.preferredFont(forTextStyle: .caption1).boundingRectForFont.height)
    }
}

/// A path. The tooltip is the full path. The menu can show it in Finder.
/// `byComponent` shortens at a separator, so the sidebar does not cut a name in half.
struct TracePath: View {
    let path: String
    var byComponent = false

    var body: some View {
        Group {
            if byComponent {
                ComponentPathText(path: path)
            } else {
                Text(path)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .help(path)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            Button("Reveal in Finder") {
                TracePath.reveal(path)
            }
        }
    }

    /// Longest form that fits `width`, dropping whole path components from the middle.
    static func fitting(_ path: String, width: CGFloat) -> String {
        let font = NSFont.preferredFont(forTextStyle: .caption1)
        func widthOf(_ text: String) -> CGFloat {
            (text as NSString).size(withAttributes: [.font: font]).width + 4
        }
        let choices = componentChoices(path)
        guard width.isFinite, width > 0 else { return choices.last ?? path }
        return choices.first { widthOf($0) <= width } ?? choices.last ?? path
    }

    static func componentChoices(_ path: String) -> [String] {
        let expanded = (path as NSString).expandingTildeInPath
        let file = (expanded as NSString).lastPathComponent
        let parts = expanded.split(separator: "/").map(String.init)
        var choices: [String] = []
        func add(_ value: String) {
            if !value.isEmpty, !choices.contains(value) { choices.append(value) }
        }
        add(expanded)
        if parts.count > 2 {
            let root = expanded.hasPrefix("/") ? "/" : ""
            for headCount in stride(from: parts.count - 2, through: 1, by: -1) {
                let head = parts.prefix(headCount).joined(separator: "/")
                add(root + head + "/…/" + file)
            }
            add("…/" + file)
        } else if parts.count == 2 {
            add("…/" + file)
        }
        add(file.isEmpty ? expanded : file)
        return choices
    }

    static func reveal(_ path: String) {
        let expanded = (path as NSString).expandingTildeInPath
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: expanded, isDirectory: &isDirectory) else {
            let parent = (expanded as NSString).deletingLastPathComponent
            guard FileManager.default.fileExists(atPath: parent) else { return }
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: parent)])
            return
        }
        if isDirectory.boolValue {
            NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: expanded)
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: expanded)])
    }
}
