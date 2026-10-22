import XCTest
@testable import MafiosoTraceCore

final class TraceCoreTests: XCTestCase {
    func testEventShape() throws {
        let line = """
        {"v":1,"seq":4,"ts":"2026-10-22T11:00:00.000Z","gameId":"g-day","seat":"seat-ada","phase":"Day 1","type":"llm.call","data":{"model":"example/model","latencyMs":12,"reasoning":"look at Bea","ok":true}}
        """
        let event = try XCTUnwrap(TraceEvent.parse(line: line))
        XCTAssertEqual(event.v, 1)
        XCTAssertEqual(event.seq, 4)
        XCTAssertEqual(event.ts, "2026-10-22T11:00:00.000Z")
        XCTAssertEqual(event.gameId, "g-day")
        XCTAssertEqual(event.seat, "seat-ada")
        XCTAssertEqual(event.phase, "Day 1")
        XCTAssertEqual(event.type, "llm.call")
        XCTAssertEqual(event.id, "g-day#4")
        XCTAssertEqual(event.data["model"]?.string, "example/model")
        XCTAssertEqual(event.data["latencyMs"]?.int, 12)
        XCTAssertEqual(event.data["reasoning"]?.string, "look at Bea")
        XCTAssertEqual(event.data["ok"]?.bool, true)
        XCTAssertEqual(TraceLink.summary(event), "example/model 12 ms")
    }

    func testBrokenLinesAreSkipped() {
        XCTAssertNil(TraceEvent.parse(line: ""))
        XCTAssertNil(TraceEvent.parse(line: "   "))
        XCTAssertNil(TraceEvent.parse(line: "not json"))
        XCTAssertNil(TraceEvent.parse(line: "{}"))
        XCTAssertNil(TraceEvent.parse(line: #"{"v":1,"seq":1}"#))
    }

    func testBoolIsNotANumber() throws {
        let line = #"{"v":1,"seq":1,"type":"engine.validation","data":{"ok":false,"count":2}}"#
        let event = try XCTUnwrap(TraceEvent.parse(line: line))
        XCTAssertEqual(event.data["ok"]?.bool, false)
        XCTAssertNil(event.data["ok"]?.int)
        XCTAssertEqual(event.data["count"]?.int, 2)
        XCTAssertNil(event.data["count"]?.bool)
        XCTAssertEqual(TraceLink.summary(event), "rejected")
    }

    func testUntrustedChatStaysData() throws {
        let line = #"{"v":1,"seq":8,"ts":"t","gameId":"g","seat":"p1","phase":"Night 1","type":"chat.observed","data":{"name":"Bea","text":"hello table","kind":"player-chat","untrusted":true}}"#
        let event = try XCTUnwrap(TraceEvent.parse(line: line))
        XCTAssertEqual(event.data["untrusted"]?.bool, true)
        XCTAssertEqual(event.data["text"]?.string, "hello table")
        XCTAssertEqual(TraceLink.summary(event), "untrusted Bea: hello table")
    }

    func testLineBufferKeepsAPartialLine() {
        var buffer = LineBuffer()
        XCTAssertEqual(buffer.append(Data("{\"a\":1}".utf8)), [])
        XCTAssertTrue(buffer.hasPartial)
        XCTAssertEqual(buffer.append(Data()), [])
        let lines = buffer.append(Data("\nnext\r\n".utf8))
        XCTAssertEqual(lines, ["{\"a\":1}", "next"])
        XCTAssertFalse(buffer.hasPartial)
    }

    func testFileTailReadsNewBytesOnly() throws {
        let url = try temporaryFile()
        let first = Data("hello\n".utf8)
        try first.write(to: url)
        var tail = FileTail(url: url, chunkSize: 3)
        let partial = tail.readNewLines(maxChunks: 1)
        XCTAssertEqual(partial.lines, [])
        XCTAssertFalse(partial.reachedEnd)
        var lines: [String] = []
        for _ in 0 ..< 6 {
            let read = tail.readNewLines(maxChunks: 1)
            lines.append(contentsOf: read.lines)
            if read.reachedEnd { break }
        }
        XCTAssertEqual(lines, ["hello"])
        XCTAssertEqual(tail.offset, UInt64(first.count))

        let handle = try FileHandle(forWritingTo: url)
        _ = handle.seekToEndOfFile()
        try handle.write(contentsOf: Data("world\n".utf8))
        try handle.close()
        var more: [String] = []
        for _ in 0 ..< 6 {
            let read = tail.readNewLines(maxChunks: 1)
            more.append(contentsOf: read.lines)
            if read.reachedEnd { break }
        }
        XCTAssertEqual(more, ["world"])
        XCTAssertEqual(tail.readNewLines().lines, [])
        XCTAssertTrue(tail.readNewLines().reachedEnd)
    }

    func testPumpMergesSeatsBySeqAndSkipsGarbage() async throws {
        let root = try temporaryDirectory()
        let game = root.appendingPathComponent("g-sample", isDirectory: true)
        try FileManager.default.createDirectory(at: game, withIntermediateDirectories: true)
        let ada = game.appendingPathComponent("p1.jsonl")
        let harness = game.appendingPathComponent("harness.jsonl")
        let adaBody = "not json\n" + line(seq: 2, seat: "p1", type: "phase.change") + line(seq: 3, seat: "p1", type: "chat.sent")
        try Data(adaBody.utf8).write(to: ada)
        try Data(line(seq: 1, seat: "harness", type: "game.start").utf8).write(to: harness)

        let pump = LinePump(chunkSize: 24)
        await pump.setFiles([ada, harness])
        var events: [TraceEvent] = []
        for _ in 0 ..< 20 {
            let batch = await pump.poll(maxChunks: 1)
            events.append(contentsOf: batch.events)
            if !batch.pending { break }
        }
        XCTAssertEqual(events.map(\.seq), [1, 2, 3])
        XCTAssertEqual(events.map(\.seat), ["harness", "p1", "p1"])
        let done = await pump.poll()
        XCTAssertEqual(done.events, [])
        XCTAssertFalse(done.pending)
        let epoch = await pump.bump()
        let stale = await pump.poll(maxChunks: 8, epoch: epoch - 1)
        XCTAssertEqual(stale.events, [])
        XCTAssertFalse(stale.pending)
        var again: [TraceEvent] = []
        for _ in 0 ..< 20 {
            let batch = await pump.poll(maxChunks: 1, epoch: epoch)
            again.append(contentsOf: batch.events)
            if !batch.pending { break }
        }
        XCTAssertEqual(again.map(\.seq), [1, 2, 3])
    }

    func testProposalPairsTheSameSeat() {
        let call = make(seq: 1, seat: "p1", type: "llm.call", data: .object(["raw": .string("vote Bea")]))
        let other = make(seq: 2, seat: "p2", type: "engine.validation", data: .object(["ok": .bool(true)]))
        let verdict = make(seq: 3, seat: "p1", type: "engine.validation", data: .object(["ok": .bool(true)]))
        let events = [call, other, verdict]
        XCTAssertEqual(TraceLink.pair(for: call, in: events).verdict?.seq, 3)
        XCTAssertEqual(TraceLink.pair(for: verdict, in: events).proposal?.seq, 1)
        XCTAssertNil(TraceLink.pair(for: other, in: events).proposal)
        XCTAssertEqual(TraceLink.summary(verdict), "accepted")

        let linked = make(seq: 4, seat: "p1", type: "llm.call", data: .object([
            "callId": .string("c1"),
            "parsed": .object(["event": .string("vote")]),
        ]))
        let nearer = make(seq: 5, seat: "p1", type: "engine.validation", data: .object([
            "ok": .bool(false),
            "callId": .string("c9"),
        ]))
        let matched = make(seq: 6, seat: "p2", type: "engine.validation", data: .object([
            "ok": .bool(true),
            "callId": .string("c1"),
        ]))
        let byId = [linked, nearer, matched]
        XCTAssertEqual(TraceLink.pair(for: linked, in: byId).verdict?.seq, 6)
        XCTAssertEqual(TraceLink.pair(for: matched, in: byId).proposal?.seq, 4)
        XCTAssertNil(TraceLink.callID(make(seq: 7, seat: "p1", type: "llm.call", data: .object(["callId": .string("  ")]))))
    }

    func testTimelineOpensOnAllAndKeepsFiltersWhenARowOrSeatAppears() {
        var state = TimelineState()
        XCTAssertEqual(state.seat, "all")
        XCTAssertEqual(state.phase, "all")
        XCTAssertEqual(TimelineState.phaseLabel(""), "—")
        XCTAssertEqual(TimelineState.phaseLabel("  "), "—")
        XCTAssertEqual(TimelineState.phaseLabel("Night 1"), "Night 1")

        let pregame = TraceEvent(v: 1, seq: 1, ts: "t", gameId: "g", seat: "p2", phase: "", type: "game.start", data: .object([:]))
        let night = TraceEvent(v: 1, seq: 2, ts: "t", gameId: "g", seat: "p1", phase: "Night 1", type: "llm.call", data: .object([:]))
        let day = TraceEvent(v: 1, seq: 3, ts: "t", gameId: "g", seat: "p1", phase: "Day 1", type: "chat.sent", data: .object([:]))
        var events = [pregame]
        state = state.reconcile(events)
        XCTAssertEqual(state.seat, "all")
        XCTAssertEqual(state.phase, "all")
        events.append(night)
        state = state.reconcile(events)
        XCTAssertEqual(state.seat, "all")
        XCTAssertEqual(state.phase, "all")

        state = state.select(id: pregame.id, in: events)
        XCTAssertEqual(state.seat, "all")
        XCTAssertEqual(state.phase, "all")
        XCTAssertEqual(state.selectedIDs, [pregame.id])
        XCTAssertEqual(state.scrub, 0)
        XCTAssertEqual(state.label(in: events), "1 / 2")

        events.append(day)
        state = state.select(id: day.id, in: events)
        XCTAssertEqual(state.seat, "all")
        XCTAssertEqual(state.phase, "all")
        XCTAssertEqual(state.scrub, 2)
        XCTAssertEqual(state.label(in: events), "3 / 3")

        state = state.scrub(to: 1, in: events)
        XCTAssertEqual(state.selectedIDs, [night.id])
        XCTAssertEqual(state.scrub, 1)
        XCTAssertEqual(state.label(in: events), "2 / 3")
        XCTAssertEqual(state.seat, "all")
        XCTAssertEqual(state.phase, "all")

        state = state.chooseSeat("p1", events: events)
        XCTAssertEqual(state.seat, "p1")
        XCTAssertEqual(state.selectedIDs, [night.id])
        XCTAssertEqual(state.label(in: events), "1 / 2")
        state = state.chooseSeat("all", events: events)
        events.append(TraceEvent(v: 1, seq: 4, ts: "t", gameId: "g", seat: "p2", phase: "Day 1", type: "chat.observed", data: .object([:])))
        state = state.reconcile(events)
        XCTAssertEqual(state.seat, "all")
        XCTAssertEqual(state.phase, "all")
        XCTAssertEqual(state.selectedIDs, [night.id])
        XCTAssertEqual(state.label(in: events), "2 / 4")

        state = state.choosePhase("Night 1", events: events)
        state = state.select(id: day.id, in: events)
        XCTAssertEqual(state.phase, "Night 1")
        XCTAssertEqual(state.seat, "all")
        XCTAssertEqual(state.selectedIDs, [night.id])
        state = state.choosePhase("all", events: events)
        state = state.reconcile(events)
        XCTAssertEqual(state.phase, "all")

        state = state.chooseSeat("p2", events: events)
        state = state.chooseSeat("all", events: events)
        XCTAssertEqual(state.seat, "all")
        state = state.chooseSeat("harness", events: events)
        XCTAssertEqual(state.seat, "harness")
        state = state.reconcile(events)
        XCTAssertEqual(state.seat, "harness")

        var early = TimelineState()
        early = early.chooseSeat("p1", events: [], files: ["p1"])
        XCTAssertEqual(early.seat, "p1")
        early = early.reconcile([], files: ["p1", "p2"])
        XCTAssertEqual(early.seat, "p1")
        early = early.chooseSeat("all", events: [], files: ["p1", "p2"])
        early = early.reconcile([], files: ["p1", "p2", "p3"])
        XCTAssertEqual(early.seat, "all")
        XCTAssertEqual(early.phase, "all")
    }

    func testLaunchOptionsReadFixturePath() {
        let options = LaunchOptions(arguments: ["MafiosoTrace", "-nsomething", "-fixture", "Fixtures/sample-game.jsonl"])
        XCTAssertEqual(options.fixturePath, "Fixtures/sample-game.jsonl")
        XCTAssertNil(LaunchOptions(arguments: ["MafiosoTrace"]).fixturePath)
        XCTAssertNil(LaunchOptions(arguments: ["MafiosoTrace", "-fixture"]).fixturePath)
    }

    func testCatalogMarksARecentGameLive() throws {
        let root = try temporaryDirectory()
        let liveDir = root.appendingPathComponent("g-live", isDirectory: true)
        let oldDir = root.appendingPathComponent("g-old", isDirectory: true)
        try FileManager.default.createDirectory(at: liveDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: oldDir, withIntermediateDirectories: true)
        let liveFile = liveDir.appendingPathComponent("p1.jsonl")
        let oldFile = oldDir.appendingPathComponent("harness.jsonl")
        try Data("{}\n".utf8).write(to: liveFile)
        try Data("{}\n".utf8).write(to: oldFile)
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-120)],
            ofItemAtPath: oldFile.path
        )
        let now = Date()
        let games = TraceCatalog.games(in: root, now: now, liveWindow: 15)
        XCTAssertEqual(games.map(\.id), ["g-live", "g-old"])
        XCTAssertEqual(games[0].seats, ["p1"])
        XCTAssertTrue(games[0].isLive)
        XCTAssertFalse(games[1].isLive)
        XCTAssertEqual(TraceCatalog.games(in: root.appendingPathComponent("missing")), [])
        let empty = try temporaryDirectory()
        XCTAssertEqual(TraceCatalog.games(in: empty), [])
        let file = empty.appendingPathComponent("not-a-directory")
        try Data("x".utf8).write(to: file)
        XCTAssertEqual(TraceCatalog.games(in: file), [])
    }

    func testScrubRangeForZeroOneAndMany() throws {
        XCTAssertNil(Scrub.bounds(count: 0))
        XCTAssertNil(Scrub.bounds(count: 1))
        XCTAssertNil(Scrub.bounds(count: -3))
        XCTAssertFalse(Scrub.showsSlider(count: 0))
        XCTAssertFalse(Scrub.showsSlider(count: 1))
        XCTAssertEqual(Scrub.clamp(4, count: 0), 0)
        XCTAssertEqual(Scrub.clamp(.nan, count: 5), 0)
        XCTAssertEqual(Scrub.clamp(.infinity, count: 5), 0)
        XCTAssertNil(Scrub.index(for: 3, count: 0))
        XCTAssertEqual(Scrub.label(position: 9, count: 0), "0 / 0")

        XCTAssertEqual(Scrub.clamp(4, count: 1), 0)
        XCTAssertEqual(Scrub.index(for: 4, count: 1), 0)
        XCTAssertEqual(Scrub.label(position: 4, count: 1), "1 / 1")

        let two = try XCTUnwrap(Scrub.bounds(count: 2))
        XCTAssertEqual(two, 0 ... 1)
        XCTAssertGreaterThan(two.upperBound, two.lowerBound)
        XCTAssertTrue(Scrub.showsSlider(count: 2))
        XCTAssertEqual(Scrub.clamp(5, count: 2), 1)
        XCTAssertEqual(Scrub.clamp(-1, count: 2), 0)
        XCTAssertEqual(Scrub.index(for: 0.4, count: 2), 0)
        XCTAssertEqual(Scrub.index(for: 0.6, count: 2), 1)
        XCTAssertEqual(Scrub.label(position: 5, count: 2), "2 / 2")

        XCTAssertEqual(Scrub.bounds(count: 3), Optional(0 ... 2))
        XCTAssertEqual(Scrub.index(for: 2, count: 3), 2)
        XCTAssertEqual(Scrub.label(position: 0, count: 3), "1 / 3")
    }

    func testSelectionAndFiltersDropMissingValues() {
        XCTAssertEqual(Scrub.selection(Set(["a", "gone"]), available: ["a"]), Set(["a"]))
        XCTAssertEqual(Scrub.selection(Set(["gone"]), available: [String]()), Set())
        XCTAssertEqual(Scrub.choice("Day 1", allowed: ["Night 1"], fallback: "all"), "all")
        XCTAssertEqual(Scrub.choice("all", allowed: [], fallback: "all"), "all")
        XCTAssertEqual(Scrub.choice("p1", allowed: ["p1"], fallback: "all"), "p1")
        XCTAssertEqual(Scrub.choice("harness", allowed: ["p1", "harness"], fallback: "all"), "harness")
    }

    func testMissingAndDeletedFilesDoNotThrow() throws {
        let missing = try temporaryDirectory().appendingPathComponent("gone.jsonl")
        var absent = FileTail(url: missing)
        let unread = absent.readNewLines()
        XCTAssertEqual(unread.lines, [])
        XCTAssertTrue(unread.reachedEnd)
        XCTAssertEqual(absent.offset, 0)

        let url = try temporaryFile()
        try Data("ada\n".utf8).write(to: url)
        var tail = FileTail(url: url)
        XCTAssertEqual(tail.readNewLines().lines, ["ada"])
        let kept = tail.offset
        try FileManager.default.removeItem(at: url)
        let afterDelete = tail.readNewLines()
        XCTAssertEqual(afterDelete.lines, [])
        XCTAssertTrue(afterDelete.reachedEnd)
        XCTAssertEqual(tail.offset, kept)

        try Data("hi\n".utf8).write(to: url)
        var shrunk = FileTail(url: url, chunkSize: 8)
        _ = shrunk.readNewLines()
        try Data("z\n".utf8).write(to: url)
        XCTAssertEqual(shrunk.readNewLines().lines, ["z"])
    }

    func testSampleFixtureStreamsLineByLine() async throws {
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/sample-game.jsonl")
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.path), fixture.path)
        let pump = LinePump()
        await pump.setFiles([fixture])
        var events: [TraceEvent] = []
        for _ in 0 ..< 400 {
            let batch = await pump.poll(maxChunks: 1)
            events.append(contentsOf: batch.events)
            if !batch.pending { break }
        }
        let done = await pump.poll()
        XCTAssertEqual(done.events, [])
        XCTAssertFalse(done.pending)
        XCTAssertEqual(events.map(\.seq), Array(1 ... events.count))
        XCTAssertGreaterThanOrEqual(events.count, 16)
        let types = Set(events.map(\.type))
        for name in [
            "game.start", "game.end", "phase.change", "llm.call", "engine.validation",
            "chat.sent", "chat.suppressed", "chat.observed", "vote.sent", "night.sent",
            "vote.notice", "error", "retry", "rate_limit",
        ] {
            XCTAssertTrue(types.contains(name), name)
        }
        let call = try XCTUnwrap(events.first { $0.type == "llm.call" })
        XCTAssertFalse(call.data["reasoning"]?.string?.isEmpty ?? true)
        let observed = try XCTUnwrap(events.first { $0.type == "chat.observed" })
        XCTAssertEqual(observed.data["untrusted"]?.bool, true)
        let pair = TraceLink.pair(for: call, in: events)
        XCTAssertEqual(pair.verdict?.type, "engine.validation")
        XCTAssertEqual(pair.verdict?.seat, call.seat)
        XCTAssertEqual(call.data["callId"]?.string, "c1")
        XCTAssertEqual(pair.verdict?.data["callId"]?.string, "c1")
        let speech = try XCTUnwrap(events.first { $0.type == "llm.call" && $0.data["purpose"]?.string == "speech" })
        XCTAssertEqual(TraceLink.pair(for: speech, in: events).verdict?.data["callId"]?.string, "c2")
        let pregame = try XCTUnwrap(events.first { $0.type == "game.start" })
        XCTAssertEqual(TimelineState.phaseLabel(pregame.phase), "—")
        let text = try String(contentsOf: fixture, encoding: .utf8)
        XCTAssertFalse(text.contains("sk-"))
        XCTAssertFalse(text.contains("Bearer "))
        XCTAssertTrue(text.contains("Ada"))
        XCTAssertTrue(text.contains("Bea"))
    }

    func testLocalClockUsesTheZoneAbbreviation() throws {
        let newYork = try XCTUnwrap(TimeZone(identifier: "America/New_York"))
        let locale = Locale(identifier: "en_US")
        XCTAssertEqual(
            TraceTime.display("2026-10-22T11:00:05.000Z", in: newYork, locale: locale),
            "07:00:05 EDT"
        )
        XCTAssertEqual(
            TraceTime.display("2026-01-15T11:00:05.000Z", in: newYork, locale: locale),
            "06:00:05 EST"
        )
        let utc = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        XCTAssertEqual(
            TraceTime.display("2026-10-22T11:00:05Z", in: utc, locale: locale),
            "11:00:05 GMT"
        )
        XCTAssertEqual(TraceTime.display("t", in: utc, locale: locale), "t")
    }

    /// Filtering and phase resolution of a full game stay on one pass, not a scan per row.
    func testFilterAndPhaseResolutionOfTenThousandEventsStaysUnderFiftyMilliseconds() {
        let phases = (0 ..< 24).map { "Day \($0)" }
        let files = (0 ..< 12).map { "seat-\($0)" }
        var events: [TraceEvent] = []
        events.reserveCapacity(10_000)
        for index in 0 ..< 10_000 {
            events.append(TraceEvent(
                v: 1,
                seq: index,
                ts: "t",
                gameId: "g",
                seat: files[index % 12],
                phase: phases[index % phases.count],
                type: "chat.sent",
                data: .object([:])
            ))
        }
        let state = TimelineState(seat: files[3], phase: "Day 3")
        let clock = ContinuousClock()
        var snapshot = TimelineSnapshot.empty
        let elapsed = clock.measure {
            snapshot = TimelineSnapshot.make(events: events, files: files, state: state)
        }
        XCTAssertLessThan(elapsed, .milliseconds(50))
        XCTAssertEqual(snapshot.resolvedPhase, "Day 3")
        XCTAssertEqual(snapshot.resolvedSeat, files[3])
        XCTAssertEqual(snapshot.phases, phases)
        XCTAssertEqual(snapshot.playerSeats, files)
        XCTAssertEqual(snapshot.visible.count, 417)
        XCTAssertTrue(snapshot.visible.allSatisfy { $0.seat == files[3] && $0.phase == "Day 3" })

        let index = TimelineIndex(events: events, files: files)
        XCTAssertEqual(index.countsByFile.count, 12)
        XCTAssertEqual(index.countsByFile.values.reduce(0, +), 10_000)
        XCTAssertEqual(index.resolvedPhase("Day 3"), "Day 3")
        XCTAssertEqual(index.resolvedPhase("not-a-phase"), TimelineState.all)
        let missing = TimelineSnapshot.make(
            events: events,
            files: files,
            state: TimelineState(seat: files[3], phase: "not-a-phase"),
            index: index
        )
        XCTAssertEqual(missing.resolvedPhase, TimelineState.all)
        XCTAssertEqual(missing.resolvedSeat, files[3])
        XCTAssertEqual(missing.visible.count, 834)
        XCTAssertTrue(missing.visible.allSatisfy { $0.seat == files[3] })
    }

    private func make(seq: Int, seat: String, type: String, data: JSONValue) -> TraceEvent {
        TraceEvent(
            v: 1,
            seq: seq,
            ts: "2026-10-22T11:00:00.000Z",
            gameId: "g",
            seat: seat,
            phase: "Day 1",
            type: type,
            data: data
        )
    }

    private func line(seq: Int, seat: String, type: String) -> String {
        #"{"v":1,"seq":\#(seq),"ts":"t","gameId":"g-sample","seat":"\#(seat)","phase":"","type":"\#(type)","data":{}}"# + "\n"
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func temporaryFile() throws -> URL {
        try temporaryDirectory().appendingPathComponent("seat.jsonl")
    }
}
