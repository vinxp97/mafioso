import CoreServices
import Darwin
import Foundation

/// Watches the logs root with FSEvents, and pulses so a quiet game drops its LIVE mark.
/// Callbacks are delivered on the main queue.
final class RootWatcher {
    var onChange: () -> Void = {}
    private var stream: FSEventStreamRef?
    private var watchedPath: String?
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "mafioso.trace.fsevents")

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
            { _, info, _, _, _, _ in
                guard let info else { return }
                let watcher = Unmanaged<RootWatcher>.fromOpaque(info).takeUnretainedValue()
                watcher.emit()
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
    }

    deinit { stop() }

    private func emit() {
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
            self?.emit()
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
/// The callback runs on the main queue.
final class SeatWatcher {
    var onChange: () -> Void = {}
    private var source: DispatchSourceFileSystemObject?

    func start(path: String) {
        stop()
        let fd = open(path, O_EVTONLY)
        if fd < 0 { return }
        let queue = DispatchQueue(label: "mafioso.trace.vnode")
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .extend, .delete, .rename, .attrib],
            queue: queue
        )
        source.setEventHandler { [weak self] in
            self?.emit()
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
    }

    deinit { stop() }

    private func emit() {
        let callback = onChange
        DispatchQueue.main.async {
            callback()
        }
    }
}
