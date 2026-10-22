import XCTest
@testable import MafiosoTraceCore

final class CheckoutTests: XCTestCase {
    func testCloneWhenMissing() throws {
        let root = "/caches/repos/https-github-com-vinxp97-mafioso"
        let json = #"{"name":"mafioso"}"#
        let files = MemoryCheckoutFiles()
        seedPackages(files, root: root, json: json)
        let key = RepositoryURL.cacheKey(root)
        let stamp = DepsStamp.fingerprint(packageJSON: json, lockfile: "lock")
        files.files["/caches/stamps/\(key)/engine"] = stamp
        files.files["/caches/stamps/\(key)/harness"] = stamp
        let runner = ScriptedRunner { call in
            if call.arguments.first == "clone" || call.arguments.first == "fetch" {
                return CommandResult(status: 0, stdout: "", stderr: "")
            }
            if call.arguments == ["rev-parse", "HEAD"] || call.arguments == ["rev-parse", "origin/main"] {
                return CommandResult(status: 0, stdout: "abc123\n", stderr: "")
            }
            return CommandResult(status: 1, stdout: "", stderr: "unexpected \(call.arguments)")
        }
        let prepared = try RepositoryPrep.prepare(gitRequest(container: false), runner: runner, files: files)
        XCTAssertEqual(prepared.path, root)
        XCTAssertEqual(Array(runner.calls.first?.arguments.prefix(2) ?? []), ["clone", "--branch"])
        XCTAssertEqual(runner.calls.first?.arguments.last, prepared.path)
        XCTAssertTrue(runner.calls.contains { $0.arguments == ["fetch", "origin", "main"] })
        XCTAssertFalse(runner.calls.contains { $0.arguments.contains("reset") })
        XCTAssertFalse(runner.calls.contains { $0.executable == "npm" })
        XCTAssertEqual(prepared.lines, ["fetching…", "up to date at abc123"])
    }

    func testNoOpWhenUpToDate() throws {
        let root = "/caches/repos/https-github-com-vinxp97-mafioso"
        let files = readyCheckout(root: root, json: #"{"name":"mafioso"}"#)
        let runner = ScriptedRunner { call in
            if call.arguments.first == "fetch" { return CommandResult(status: 0, stdout: "", stderr: "") }
            if call.arguments.first == "rev-parse" { return CommandResult(status: 0, stdout: "abc123\n", stderr: "") }
            return CommandResult(status: 1, stdout: "", stderr: "unexpected \(call.arguments)")
        }
        let prepared = try RepositoryPrep.prepare(gitRequest(container: false), runner: runner, files: files)
        XCTAssertFalse(runner.calls.contains { $0.arguments.first == "clone" })
        XCTAssertFalse(runner.calls.contains { $0.arguments.contains("reset") })
        XCTAssertFalse(runner.calls.contains { $0.executable == "npm" })
        XCTAssertEqual(prepared.lines, ["fetching…", "up to date at abc123"])
        XCTAssertEqual(prepared.commit, "abc123")
    }

    func testUpdateWhenBehind() throws {
        let root = "/caches/repos/https-github-com-vinxp97-mafioso"
        let files = readyCheckout(root: root, json: #"{"name":"mafioso"}"#)
        let runner = ScriptedRunner { call in
            if call.arguments.first == "fetch" { return CommandResult(status: 0, stdout: "", stderr: "") }
            if call.arguments == ["rev-parse", "HEAD"] { return CommandResult(status: 0, stdout: "oldsha\n", stderr: "") }
            if call.arguments == ["rev-parse", "origin/main"] { return CommandResult(status: 0, stdout: "newsha\n", stderr: "") }
            if call.arguments == ["reset", "--hard", "origin/main"] {
                XCTAssertEqual(call.currentDirectory, root)
                return CommandResult(status: 0, stdout: "", stderr: "")
            }
            return CommandResult(status: 1, stdout: "", stderr: "unexpected \(call.arguments)")
        }
        let prepared = try RepositoryPrep.prepare(gitRequest(container: false), runner: runner, files: files)
        XCTAssertTrue(runner.calls.contains { $0.arguments == ["reset", "--hard", "origin/main"] })
        XCTAssertEqual(prepared.commit, "newsha")
        XCTAssertTrue(prepared.lines.contains("updated oldsha→newsha"))
    }

    func testLocalFolderIsNotReset() throws {
        let files = readyCheckout(root: "/Users/ada/mafioso", json: #"{"name":"mafioso"}"#)
        let runner = ScriptedRunner { call in
            if call.arguments == ["rev-parse", "HEAD"] { return CommandResult(status: 0, stdout: "localsha\n", stderr: "") }
            return CommandResult(status: 1, stdout: "", stderr: "unexpected \(call.arguments)")
        }
        let source = RepositorySource(kind: .localFolder, url: "", branch: "main", localPath: "/Users/ada/mafioso")
        let request = CheckoutRequest(source: source, cacheRoot: "/caches/repos", stampRoot: "/caches/stamps", container: false)
        let prepared = try RepositoryPrep.prepare(request, runner: runner, files: files)
        XCTAssertEqual(prepared.path, "/Users/ada/mafioso")
        XCTAssertFalse(runner.calls.contains { $0.arguments.contains("reset") || $0.arguments.first == "fetch" || $0.arguments.first == "clone" })
        XCTAssertFalse(prepared.lines.contains { $0.hasPrefix("fetching") })
    }

    func testDepsReinstallWhenPackageJSONChanged() throws {
        let root = "/Users/ada/mafioso"
        let files = readyCheckout(root: root, json: #"{"name":"mafioso","version":"2"}"#)
        let previous = DepsStamp.fingerprint(packageJSON: #"{"name":"mafioso","version":"1"}"#, lockfile: "lock")
        let key = RepositoryURL.cacheKey(root)
        files.files["/caches/stamps/\(key)/engine"] = previous
        files.files["/caches/stamps/\(key)/harness"] = previous
        let runner = ScriptedRunner { call in
            if call.executable == "npm" && call.arguments == ["ci"] { return CommandResult(status: 0, stdout: "", stderr: "") }
            if call.arguments == ["rev-parse", "HEAD"] { return CommandResult(status: 0, stdout: "localsha\n", stderr: "") }
            return CommandResult(status: 1, stdout: "", stderr: "unexpected \(call.arguments)")
        }
        let source = RepositorySource(kind: .localFolder, url: "", branch: "main", localPath: root)
        let prepared = try RepositoryPrep.prepare(
            CheckoutRequest(source: source, cacheRoot: "/caches/repos", stampRoot: "/caches/stamps", container: false),
            runner: runner,
            files: files
        )
        let installs = runner.calls.filter { $0.executable == "npm" }
        XCTAssertEqual(installs.map(\.currentDirectory), ["\(root)/engine", "\(root)/harness"])
        XCTAssertTrue(prepared.lines.contains("installing deps"))
        let current = DepsStamp.fingerprint(packageJSON: #"{"name":"mafioso","version":"2"}"#, lockfile: "lock")
        XCTAssertEqual(files.files["/caches/stamps/\(key)/harness"], current)
    }

    func testDepsInstallWhenNodeModulesIsMissing() throws {
        let root = "/Users/ada/mafioso"
        let json = #"{"name":"mafioso"}"#
        let files = readyCheckout(root: root, json: json)
        files.directories.remove("\(root)/harness/node_modules")
        let key = RepositoryURL.cacheKey(root)
        let current = DepsStamp.fingerprint(packageJSON: json, lockfile: "lock")
        files.files["/caches/stamps/\(key)/engine"] = current
        files.files["/caches/stamps/\(key)/harness"] = current
        let runner = ScriptedRunner { call in
            if call.executable == "npm" { return CommandResult(status: 0, stdout: "", stderr: "") }
            if call.arguments == ["rev-parse", "HEAD"] { return CommandResult(status: 0, stdout: "localsha\n", stderr: "") }
            return CommandResult(status: 1, stdout: "", stderr: "unexpected")
        }
        let source = RepositorySource(kind: .localFolder, url: "", branch: "main", localPath: root)
        _ = try RepositoryPrep.prepare(
            CheckoutRequest(source: source, cacheRoot: "/caches/repos", stampRoot: "/caches/stamps", container: false),
            runner: runner,
            files: files
        )
        XCTAssertEqual(runner.calls.filter { $0.executable == "npm" }.map(\.currentDirectory), ["\(root)/harness"])
    }

    func testDepsUseNpmInstallWhenTheLockfileIsMissing() throws {
        let root = "/Users/ada/mafioso"
        let json = #"{"name":"mafioso"}"#
        let files = readyCheckout(root: root, json: json)
        files.files["\(root)/engine/package-lock.json"] = nil
        files.files["\(root)/harness/package-lock.json"] = nil
        let runner = ScriptedRunner { call in
            if call.executable == "npm" && call.arguments == ["install"] {
                return CommandResult(status: 0, stdout: "", stderr: "")
            }
            if call.arguments == ["rev-parse", "HEAD"] { return CommandResult(status: 0, stdout: "localsha\n", stderr: "") }
            return CommandResult(status: 1, stdout: "", stderr: "unexpected \(call.arguments)")
        }
        let source = RepositorySource(kind: .localFolder, url: "", branch: "main", localPath: root)
        let prepared = try RepositoryPrep.prepare(
            CheckoutRequest(source: source, cacheRoot: "/caches/repos", stampRoot: "/caches/stamps", container: false),
            runner: runner,
            files: files
        )
        XCTAssertEqual(runner.calls.filter { $0.executable == "npm" }.map(\.arguments), [["install"], ["install"]])
        XCTAssertTrue(prepared.lines.contains("installing deps"))
        let current = DepsStamp.fingerprint(packageJSON: json, lockfile: nil)
        XCTAssertEqual(files.files["/caches/stamps/\(RepositoryURL.cacheKey(root))/engine"], current)
    }

    func testImageRebuildStamp() throws {
        XCTAssertTrue(ImageStamp.needsRebuild(commit: "abc", recorded: nil))
        XCTAssertTrue(ImageStamp.needsRebuild(commit: "abc", recorded: "old"))
        XCTAssertFalse(ImageStamp.needsRebuild(commit: "abc", recorded: "abc"))
        XCTAssertTrue(ImageStamp.needsRebuild(commit: "", recorded: "abc"))

        let root = "/caches/repos/https-github-com-vinxp97-mafioso"
        let files = readyCheckout(root: root, json: #"{"name":"mafioso"}"#)
        let key = RepositoryURL.cacheKey(root)
        files.files["/caches/stamps/\(key)/image"] = "abc123"
        let runner = ScriptedRunner { call in
            if call.arguments.first == "fetch" || call.arguments.first == "rev-parse" {
                return CommandResult(status: 0, stdout: "abc123\n", stderr: "")
            }
            return CommandResult(status: 1, stdout: "", stderr: "unexpected \(call.arguments)")
        }
        let same = try RepositoryPrep.prepare(gitRequest(container: true), runner: runner, files: files)
        XCTAssertFalse(same.rebuildImage)
        XCTAssertFalse(same.lines.contains("rebuilding image"))

        files.files["/caches/stamps/\(key)/image"] = "oldsha"
        let moved = try RepositoryPrep.prepare(gitRequest(container: true), runner: runner, files: files)
        XCTAssertTrue(moved.rebuildImage)
        XCTAssertTrue(moved.lines.contains("rebuilding image"))
        XCTAssertEqual(moved.imageStampPath, "/caches/stamps/\(key)/image")

        let node = try RepositoryPrep.prepare(gitRequest(container: false), runner: runner, files: files)
        XCTAssertFalse(node.rebuildImage)
    }

    func testTokenURLIsRefused() {
        var source = RepositorySource(kind: .git, url: "https://ada:ghp_secret@github.com/vinxp97/mafioso", branch: "main", localPath: "")
        let files = MemoryCheckoutFiles()
        let runner = ScriptedRunner { _ in CommandResult(status: 0, stdout: "", stderr: "") }
        let request = CheckoutRequest(source: source, cacheRoot: "/caches/repos", stampRoot: "/caches/stamps", container: false)
        XCTAssertThrowsError(try RepositoryPrep.prepare(request, runner: runner, files: files)) { error in
            XCTAssertEqual((error as? CheckoutError)?.message, "Set an https repository URL without a token.")
        }
        XCTAssertTrue(runner.calls.isEmpty)
        source.url = "https://github.com/vinxp97/mafioso"
        XCTAssertEqual(RepositoryURL.cacheKey(source.url), "https-github-com-vinxp97-mafioso")
        XCTAssertEqual(
            RepositoryPrep.sanitizedDetail("fatal: https://ada:ghp_secret@github.com/vinxp97/mafioso/info/refs"),
            "fatal: https://github.com/vinxp97/mafioso/info/refs"
        )
    }

    private func gitRequest(container: Bool) -> CheckoutRequest {
        CheckoutRequest(
            source: RepositorySource(
                kind: .git,
                url: "https://github.com/vinxp97/mafioso",
                branch: "main",
                localPath: ""
            ),
            cacheRoot: "/caches/repos",
            stampRoot: "/caches/stamps",
            container: container
        )
    }

    private func readyCheckout(root: String, json: String) -> MemoryCheckoutFiles {
        let files = MemoryCheckoutFiles()
        files.directories.insert(root)
        files.files["\(root)/.git"] = "git"
        seedPackages(files, root: root, json: json)
        let key = RepositoryURL.cacheKey(root)
        let stamp = DepsStamp.fingerprint(packageJSON: json, lockfile: "lock")
        files.files["/caches/stamps/\(key)/engine"] = stamp
        files.files["/caches/stamps/\(key)/harness"] = stamp
        return files
    }

    private func seedPackages(_ files: MemoryCheckoutFiles, root: String, json: String) {
        for name in ["engine", "harness"] {
            let dir = "\(root)/\(name)"
            files.directories.insert(dir)
            files.directories.insert("\(dir)/node_modules")
            files.files["\(dir)/package.json"] = json
            files.files["\(dir)/package-lock.json"] = "lock"
        }
    }
}

private final class MemoryCheckoutFiles: CheckoutStorage {
    var directories = Set<String>()
    var files: [String: String] = [:]

    func fileExists(_ path: String) -> Bool {
        files[path] != nil || directories.contains(path)
    }

    func isDirectory(_ path: String) -> Bool {
        directories.contains(path)
    }

    func read(_ path: String) -> String? {
        files[path]
    }

    func write(_ path: String, _ contents: String) throws {
        files[path] = contents
    }

    func makeDirectory(_ path: String) throws {
        directories.insert(path)
    }
}

private final class ScriptedRunner: CommandRunning {
    struct Call: Equatable {
        var executable: String
        var arguments: [String]
        var currentDirectory: String?
    }

    var calls: [Call] = []
    var handler: (Call) -> CommandResult

    init(handler: @escaping (Call) -> CommandResult) {
        self.handler = handler
    }

    func run(executable: String, arguments: [String], currentDirectory: String?) throws -> CommandResult {
        let call = Call(executable: executable, arguments: arguments, currentDirectory: currentDirectory)
        calls.append(call)
        return handler(call)
    }
}
