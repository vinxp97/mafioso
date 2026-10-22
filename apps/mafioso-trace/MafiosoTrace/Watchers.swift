import CoreServices
import Darwin
import Foundation

/// Watches the logs root with FSEvents, and pulses so a quiet game drops its LIVE mark.
/// Callbacks are delivered on the main queue. Attribute-only events are ignored, and bursts share one wake.
final class RootWatcher {
    var onChange: () -> Void = {}
    private var stream: FSEventStreamRef?
    private var watchedPath: String?
    private var timer: DispatchSourceTimer?
    private var debounce: DispatchWorkItem?
    private let queue = DispatchQueue(label: "mafioso.trace.fsevents")

    /// Content and structural changes. Inode metadata alone (access time) is not a reload.
    private static let reloadFlags = FSEventStreamEventFlags(
        kFSEventStreamEventFlagItemCreated
            | kFSEventStreamEventFlagItemRemoved
            | kFSEventStreamEventFlagItemRenamed
            | kFSEventStreamEventFlagItemModified
            | kFSEventStreamEventFlagMustScanSubDirs
            | kFSEventStreamEventFlagUserDropped
            | kFSEventStreamEventFlagKernelDropped
            | kFSEventStreamEventFlagRootChanged
            | kFSEventStreamEventFlagMount
            | kFSEventStreamEventFlagUnmount
    )

    func start(path: String) {
        startTimerIfNeeded()
        if path == watchedPath, stream != nil { return }
        stopStream()
        watchedPath = path
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
            return
        }
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        let flags = FSEventStreamCreateFlags(
            kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer
        )
        stream = FSEventStreamCreate(
            nil,
            { _, info, numEvents, _, eventFlags, _ in
                guard let info else { return }
                let watcher = Unmanaged<RootWatcher>.fromOpaque(info).takeUnretainedValue()
                guard RootWatcher.shouldReload(eventFlags, count: numEvents) else { return }
                watcher.schedule()
            },
            &context,
            [path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.2,
            flags
        )
        guard let stream else { return }
        FSEventStreamSetDispatchQueue(stream, queue)
        FSEventStreamStart(stream)
    }

    func stop() {
        stopStream()
        timer?.cancel()
        timer = nil
        watchedPath = nil
        queue.sync {
            debounce?.cancel()
            debounce = nil
        }
    }

    deinit { stop() }

    /// A pointer of either optional or non-optional flags can be passed here.
    private static func shouldReload(_ flags: UnsafePointer<FSEventStreamEventFlags>?, count: Int) -> Bool {
        guard let flags, count > 0 else { return true }
        for index in 0 ..< count {
            let flag = flags[index]
            if flag == 0 || flag & reloadFlags != 0 { return true }
        }
        return false
    }

    /// Coalesce the half-second LIVE pulse with a burst of directory events.
    private func schedule() {
        debounce?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.deliver()
        }
        debounce = work
        queue.asyncAfter(deadline: .now() + 0.2, execute: work)
    }

    private func deliver() {
        let callback = onChange
        DispatchQueue.main.async {
            callback()
        }
    }

    private func startTimerIfNeeded() {
        if timer != nil { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in
            self?.schedule()
        }
        timer.resume()
        self.timer = timer
    }

    private func stopStream() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }
}

/// Watches one open JSONL file with a vnode DispatchSource.
/// The callback runs on the main queue. Access-time (`attrib`) updates from reading the file are not reloads.
final class SeatWatcher {
    var onChange: () -> Void = {}
    private var source: DispatchSourceFileSystemObject?
    private var pending: DispatchSource.FileSystemEvent = []
    private var debounce: DispatchWorkItem?
    private let queue = DispatchQueue(label: "mafioso.trace.vnode")

    /// Writes, truncation, and the file going away. `.attrib` is an access-time update from our own read.
    private static let content: DispatchSource.FileSystemEvent = [.write, .extend, .delete, .rename]

    func start(path: String) {
        stop()
        let fd = open(path, O_EVTONLY)
        if fd < 0 { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .extend, .delete, .rename, .attrib],
            queue: queue
        )
        source.setEventHandler { [weak self] in
            self?.handle(source)
        }
        source.setCancelHandler {
            close(fd)
        }
        source.resume()
        self.source = source
    }

    func stop() {
        source?.cancel()
        source = nil
        queue.sync {
            debounce?.cancel()
            debounce = nil
            pending = []
        }
    }

    deinit { stop() }

    private func handle(_ source: DispatchSourceFileSystemObject) {
        pending.formUnion(source.data)
        guard !pending.isDisjoint(with: Self.content) else {
            pending = []
            return
        }
        debounce?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.fireIfNeeded()
        }
        debounce = work
        queue.asyncAfter(deadline: .now() + 0.1, execute: work)
    }

    private func fireIfNeeded() {
        let ready = pending.intersection(Self.content)
        pending = []
        guard !ready.isEmpty else { return }
        let callback = onChange
        DispatchQueue.main.async {
            callback()
        }
    }
}
