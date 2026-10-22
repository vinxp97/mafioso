import AppKit
import MafiosoTraceCore
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: GameStore
    @AppStorage(LogsRoot.storageKey) private var logsRoot = LogsRoot.defaultPath
    @FocusState private var focusedRow: TraceEvent.ID?

    var body: some View {
        NavigationSplitView {
            sidebar
        } content: {
            seatColumn
        } detail: {
            detail
        }
        .onAppear {
            store.start(arguments: CommandLine.arguments)
            store.setLogsRoot(logsRoot)
        }
        .onChange(of: logsRoot) { _, path in
            store.setLogsRoot(path)
        }
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
            TracePath(path: store.sidebarPath)
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
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(store.visible.enumerated()), id: \.element.id) { index, row in
                            Button {
                                store.selectRow(row.id)
                            } label: {
                                timelineRow(
                                    seq: "\(row.seq)",
                                    time: Self.clock(row.ts),
                                    seat: row.seat,
                                    phase: TimelineState.phaseLabel(row.phase),
                                    type: row.type,
                                    summary: TraceLink.summary(row),
                                    header: false
                                )
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(rowBackground(index: index, selected: store.selection.contains(row.id)))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .focused($focusedRow, equals: row.id)
                            .accessibilityLabel("\(row.seq), \(row.type), \(TraceLink.summary(row))")
                            .accessibilityAddTraits(store.selection.contains(row.id) ? .isSelected : AccessibilityTraits())
                            .help(TraceLink.summary(row))
                            .id(row.id)
                        }
                    }
                }
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
                .modifier(FullTextTip(text: header ? nil : summary))
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

private struct FullTextTip: ViewModifier {
    var text: String?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let text, !text.isEmpty {
            content.help(text)
        } else {
            content
        }
    }
}

/// A path cut in the middle. The tooltip is the full path. The menu can show it in Finder.
struct TracePath: View {
    let path: String

    var body: some View {
        Text(path)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .help(path)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contextMenu {
                Button("Reveal in Finder") {
                    TracePath.reveal(path)
                }
            }
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
