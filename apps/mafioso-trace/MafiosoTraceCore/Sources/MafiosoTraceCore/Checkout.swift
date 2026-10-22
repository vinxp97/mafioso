import Foundation

public enum RepositoryKind: String, Codable, CaseIterable, Hashable, Sendable {
    case localFolder
    case git

    public var displayName: String {
        switch self {
        case .localFolder: return "Local folder"
        case .git: return "Git URL"
        }
    }
}

public struct RepositorySource: Equatable, Sendable {
    public var kind: RepositoryKind
    public var url: String
    public var branch: String
    public var localPath: String

    public init(kind: RepositoryKind, url: String, branch: String, localPath: String) {
        self.kind = kind
        self.url = url
        self.branch = branch
        self.localPath = localPath
    }

    public var branchName: String {
        let trimmed = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "main" : trimmed
    }
}

public struct CommandResult: Equatable, Sendable {
    public var status: Int32
    public var stdout: String
    public var stderr: String

    public init(status: Int32, stdout: String, stderr: String) {
        self.status = status
        self.stdout = stdout
        self.stderr = stderr
    }
}

/// Runs git and npm. The app uses the system binaries and the user's environment, including the credential helper.
public protocol CommandRunning: AnyObject {
    func run(executable: String, arguments: [String], currentDirectory: String?) throws -> CommandResult
}

public protocol CheckoutStorage: AnyObject {
    func fileExists(_ path: String) -> Bool
    func isDirectory(_ path: String) -> Bool
    func read(_ path: String) -> String?
    func write(_ path: String, _ contents: String) throws
    func makeDirectory(_ path: String) throws
}

public struct CheckoutError: Error, Equatable, Sendable {
    public var message: String

    public init(message: String) {
        self.message = message
    }
}

public struct CheckoutRequest: Equatable, Sendable {
    public var source: RepositorySource
    public var cacheRoot: String
    public var stampRoot: String
    /// Local Apple container builds an image from this checkout.
    public var container: Bool

    public init(source: RepositorySource, cacheRoot: String, stampRoot: String, container: Bool) {
        self.source = source
        self.cacheRoot = cacheRoot
        self.stampRoot = stampRoot
        self.container = container
    }
}

public struct PreparedRepository: Equatable, Sendable {
    public var path: String
    public var commit: String
    public var lines: [String]
    /// True when the container image should be built. The stamp is written after that build succeeds.
    public var rebuildImage: Bool
    public var imageStampPath: String

    public init(path: String, commit: String, lines: [String], rebuildImage: Bool, imageStampPath: String) {
        self.path = path
        self.commit = commit
        self.lines = lines
        self.rebuildImage = rebuildImage
        self.imageStampPath = imageStampPath
    }
}

public enum ImageStamp {
    /// A container image is rebuilt when the checkout commit is new or the stamp is missing.
    public static func needsRebuild(commit: String, recorded: String?) -> Bool {
        let current = commit.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !current.isEmpty else { return true }
        let previous = recorded?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return previous != current
    }
}

public enum DepsStamp {
    public static func fingerprint(packageJSON: String, lockfile: String?) -> String {
        var hash = fnv(packageJSON)
        hash = fnv("\n--lock--\n", into: hash)
        hash = fnv(lockfile ?? "", into: hash)
        return String(hash, radix: 16)
    }

    private static func fnv(_ text: String, into seed: UInt64 = 14_695_981_039_346_656_037) -> UInt64 {
        var hash = seed
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return hash
    }
}

public enum RepositoryURL {
    /// https URL with no user or password. A token in the URL is refused.
    public static func accepted(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let host = url.host, !host.isEmpty,
              url.user == nil,
              url.password == nil
        else { return nil }
        let parts = url.path.split(separator: "/").filter { !$0.isEmpty }
        guard parts.count >= 2 else { return nil }
        return trimmed
    }

    public static func cacheKey(_ url: String) -> String {
        var out = ""
        var dash = false
        for scalar in url.unicodeScalars {
            let char = Character(scalar)
            if char.isLetter || char.isNumber {
                out.append(contentsOf: String(char).lowercased())
                dash = false
            } else if !dash && !out.isEmpty {
                out.append("-")
                dash = true
            }
        }
        while out.hasSuffix("-") { out.removeLast() }
        if out.isEmpty { return "repo" }
        return String(out.prefix(120))
    }

    public static func branchIsSafe(_ name: String) -> Bool {
        guard !name.isEmpty, !name.hasPrefix("-"), !name.hasSuffix("/"), !name.contains(".."), !name.contains("//") else {
            return false
        }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/-")
        return name.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}

public enum RepositoryPrep {
    public static func prepare(
        _ request: CheckoutRequest,
        runner: CommandRunning,
        files: CheckoutStorage
    ) throws -> PreparedRepository {
        let source = request.source
        let branch = source.branchName
        let path: String
        var lines: [String] = []
        let commit: String

        switch source.kind {
        case .git:
            guard RepositoryURL.branchIsSafe(branch) else {
                throw CheckoutError(message: "The branch name is not valid.")
            }
            guard let url = RepositoryURL.accepted(source.url) else {
                throw CheckoutError(message: "Set an https repository URL without a token.")
            }
            let root = request.cacheRoot.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !root.isEmpty else { throw CheckoutError(message: "The cache folder is not set.") }
            try files.makeDirectory(root)
            path = join(root, RepositoryURL.cacheKey(url))
            lines.append("fetching…")
            if !files.isDirectory(path) {
                if files.fileExists(path) {
                    throw CheckoutError(message: "The cache folder is not a git checkout.")
                }
                try run(
                    runner,
                    executable: "git",
                    arguments: ["clone", "--branch", branch, "--single-branch", "--", url, path],
                    currentDirectory: nil,
                    failure: "Could not clone the repository."
                )
            } else if !files.fileExists(join(path, ".git")) {
                throw CheckoutError(message: "The cache folder is not a git checkout.")
            }
            try run(
                runner,
                executable: "git",
                arguments: ["fetch", "origin", branch],
                currentDirectory: path,
                failure: "Could not fetch origin."
            )
            let local = try revParse(runner, path, "HEAD")
            let remote = try revParse(runner, path, "origin/\(branch)")
            if local != remote {
                // The cache belongs to the app. A folder the user picked never reaches this branch.
                try run(
                    runner,
                    executable: "git",
                    arguments: ["reset", "--hard", "origin/\(branch)"],
                    currentDirectory: path,
                    failure: "Could not update the checkout."
                )
                lines.append("updated \(local)→\(remote)")
                commit = remote
            } else {
                lines.append("up to date at \(local)")
                commit = local
            }
        case .localFolder:
            let folder = (source.localPath as NSString).expandingTildeInPath
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !folder.isEmpty else {
                throw CheckoutError(message: "Set the repository path in Settings.")
            }
            guard files.isDirectory(folder) else {
                throw CheckoutError(message: "The repository path is missing.")
            }
            path = folder
            commit = readHEAD(runner, path)
        }

        if try installDeps(at: path, stampRoot: request.stampRoot, files: files, runner: runner) {
            lines.append("installing deps")
        }
        let imageStamp = join(join(request.stampRoot, RepositoryURL.cacheKey(path)), "image")
        let recorded = files.read(imageStamp)
        let rebuild = request.container && ImageStamp.needsRebuild(commit: commit, recorded: recorded)
        if rebuild {
            lines.append("rebuilding image")
        }
        return PreparedRepository(
            path: path,
            commit: commit,
            lines: lines,
            rebuildImage: rebuild,
            imageStampPath: imageStamp
        )
    }

    private static func installDeps(
        at path: String,
        stampRoot: String,
        files: CheckoutStorage,
        runner: CommandRunning
    ) throws -> Bool {
        let key = RepositoryURL.cacheKey(path)
        var ran = false
        for name in ["engine", "harness"] {
            let dir = join(path, name)
            let manifest = join(dir, "package.json")
            guard files.fileExists(manifest), let packageJSON = files.read(manifest) else {
                throw CheckoutError(message: "\(name)/package.json is missing.")
            }
            let lockPath = join(dir, "package-lock.json")
            let lock = files.fileExists(lockPath) ? files.read(lockPath) : nil
            let fingerprint = DepsStamp.fingerprint(packageJSON: packageJSON, lockfile: lock)
            let stamp = join(join(stampRoot, key), name)
            let modules = join(dir, "node_modules")
            let recorded = files.read(stamp)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if files.isDirectory(modules) && recorded == fingerprint { continue }
            if !ran {
                ran = true
            }
            let command = files.fileExists(lockPath) ? "ci" : "install"
            try run(
                runner,
                executable: "npm",
                arguments: [command],
                currentDirectory: dir,
                failure: "Could not install dependencies in \(name)."
            )
            try files.makeDirectory(join(stampRoot, key))
            try files.write(stamp, fingerprint)
        }
        return ran
    }

    private static func readHEAD(_ runner: CommandRunning, _ path: String) -> String {
        guard let result = try? runner.run(executable: "git", arguments: ["rev-parse", "HEAD"], currentDirectory: path),
              result.status == 0
        else { return "" }
        return result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func revParse(_ runner: CommandRunning, _ path: String, _ ref: String) throws -> String {
        let result = try run(
            runner,
            executable: "git",
            arguments: ["rev-parse", ref],
            currentDirectory: path,
            failure: "Could not read \(ref)."
        )
        let sha = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sha.isEmpty else { throw CheckoutError(message: "Could not read \(ref).") }
        return sha
    }

    @discardableResult
    private static func run(
        _ runner: CommandRunning,
        executable: String,
        arguments: [String],
        currentDirectory: String?,
        failure: String
    ) throws -> CommandResult {
        let result: CommandResult
        do {
            result = try runner.run(executable: executable, arguments: arguments, currentDirectory: currentDirectory)
        } catch {
            throw CheckoutError(message: failure)
        }
        guard result.status == 0 else {
            let detail = sanitizedDetail(result.stderr)
            if detail.isEmpty { throw CheckoutError(message: failure) }
            throw CheckoutError(message: "\(failure) \(detail)")
        }
        return result
    }

    static func sanitizedDetail(_ text: String) -> String {
        let line = text.split(separator: "\n", omittingEmptySubsequences: true).last.map(String.init) ?? ""
        let stripped = line.replacingOccurrences(
            of: #"(https?://)[^/\s:@]+:[^@\s/]+@"#,
            with: "$1",
            options: .regularExpression
        )
        return String(stripped.trimmingCharacters(in: .whitespacesAndNewlines).prefix(180))
    }

    private static func join(_ base: String, _ name: String) -> String {
        if base.hasSuffix("/") { return base + name }
        return base + "/" + name
    }
}
