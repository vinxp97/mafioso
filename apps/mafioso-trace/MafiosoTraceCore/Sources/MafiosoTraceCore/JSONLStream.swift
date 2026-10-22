import Foundation

/// Bytes in, complete lines out. A trailing partial line stays here until its newline arrives.
public struct LineBuffer: Equatable, Sendable {
    private var remainder = Data()

    public init() {}

    public var hasPartial: Bool { !remainder.isEmpty }

    public mutating func append(_ chunk: Data) -> [String] {
        if chunk.isEmpty { return [] }
        remainder.append(chunk)
        var lines: [String] = []
        while let newline = remainder.firstIndex(of: 0x0A) {
            var slice = remainder.prefix(upTo: newline)
            if slice.last == 0x0D {
                slice = slice.dropLast()
            }
            lines.append(String(decoding: slice, as: UTF8.self))
            remainder.removeSubrange(remainder.startIndex ... newline)
        }
        return lines
    }
}

/// Read newly appended bytes from one JSONL file. Each call reads a bounded number of chunks.
public struct FileTail: Sendable {
    public let url: URL
    public let chunkSize: Int
    public private(set) var offset: UInt64
    private var buffer = LineBuffer()

    public init(url: URL, chunkSize: Int = 65_536, offset: UInt64 = 0) {
        self.url = url
        self.chunkSize = max(1, chunkSize)
        self.offset = offset
    }

    /// Complete lines only. A line that has not been finished with a newline stays buffered.
    /// `reachedEnd` is false when `maxChunks` stopped the read before the current end of the file.
    public mutating func readNewLines(maxChunks: Int = 64) -> (lines: [String], reachedEnd: Bool) {
        guard maxChunks > 0 else { return ([], false) }
        guard let handle = try? FileHandle(forReadingFrom: url) else { return ([], true) }
        defer { try? handle.close() }
        let end = handle.seekToEndOfFile()
        if end < offset {
            offset = 0
            buffer = LineBuffer()
        }
        var lines: [String] = []
        var chunks = 0
        while offset < end, chunks < maxChunks {
            do {
                try handle.seek(toOffset: offset)
            } catch {
                break
            }
            let count = min(chunkSize, Int(end - offset))
            guard let data = try? handle.read(upToCount: count), !data.isEmpty else { break }
            offset += UInt64(data.count)
            lines.append(contentsOf: buffer.append(data))
            chunks += 1
        }
        return (lines, offset >= end)
    }
}

/// One poll of the open seat files. `pending` means a file still has bytes past the chunk cap.
public struct TraceBatch: Equatable, Sendable {
    public var events: [TraceEvent]
    public var pending: Bool

    public init(events: [TraceEvent], pending: Bool) {
        self.events = events
        self.pending = pending
    }
}

/// Tails a set of seat files on a background actor. Poll returns only new parsed events.
public actor LinePump {
    private var tails: [String: FileTail] = [:]
    private let chunkSize: Int
    private var epoch = 0

    public init(chunkSize: Int = 65_536) {
        self.chunkSize = max(1, chunkSize)
    }

    public func setFiles(_ urls: [URL]) {
        var next: [String: FileTail] = [:]
        for url in urls {
            let key = url.path
            next[key] = tails[key] ?? FileTail(url: url, chunkSize: chunkSize)
        }
        tails = next
    }

    public func reset() {
        let urls = tails.values.map(\.url)
        tails = [:]
        setFiles(urls)
    }

    /// Drop every tail back to byte 0 and ignore polls that still hold the previous epoch.
    public func bump() -> Int {
        epoch += 1
        reset()
        return epoch
    }

    public func poll(maxChunks: Int = 8, epoch expected: Int? = nil) -> TraceBatch {
        if let expected, expected != epoch {
            return TraceBatch(events: [], pending: false)
        }
        var out: [TraceEvent] = []
        var pending = false
        for key in tails.keys.sorted() {
            if let expected, expected != epoch {
                return TraceBatch(events: [], pending: false)
            }
            guard var tail = tails[key] else { continue }
            let read = tail.readNewLines(maxChunks: maxChunks)
            if let expected, expected != epoch {
                return TraceBatch(events: [], pending: false)
            }
            tails[key] = tail
            if !read.reachedEnd { pending = true }
            for line in read.lines {
                if let event = TraceEvent.parse(line: line) {
                    out.append(event)
                }
            }
        }
        out.sort { lhs, rhs in
            if lhs.seq != rhs.seq { return lhs.seq < rhs.seq }
            return lhs.seat < rhs.seat
        }
        return TraceBatch(events: out, pending: pending)
    }
}
