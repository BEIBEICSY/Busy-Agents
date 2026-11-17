import Foundation

enum NodeLookup {
    static let minimumMajor = 20

    static func locate(home: String, environment: [String: String], bundledNode: String?) -> String? {
        locate(
            home: home,
            environment: environment,
            bundledNode: bundledNode,
            isExecutable: { FileManager.default.isExecutableFile(atPath: $0) },
            nodeMajor: majorVersion(at:),
            directoryEntries: {
                (try? FileManager.default.contentsOfDirectory(atPath: $0)) ?? []
            },
            readText: { try? String(contentsOfFile: $0, encoding: .utf8) },
            resolveShell: resolveShell(arguments:)
        )
    }

    static func locate(
        home: String,
        environment: [String: String],
        bundledNode: String?,
        isExecutable: (String) -> Bool,
        nodeMajor: (String) -> Int?,
        directoryEntries: (String) -> [String],
        readText: (String) -> String?,
        resolveShell: ([String]) -> String?
    ) -> String? {
        let fixed = [
            bundledNode,
            environment["AI_TASK_RADAR_NODE"],
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "\(home)/.local/bin/node",
            "\(home)/.volta/bin/node",
            "\(home)/.nvm/current/bin/node",
            "/usr/bin/node"
        ].compactMap { $0 }
        let discovered = versionManagerNodes(
            home: home,
            directoryEntries: directoryEntries,
            readText: readText
        )
        for path in fixed + discovered {
            if let accepted = accept(path, isExecutable: isExecutable, nodeMajor: nodeMajor) {
                return accepted
            }
        }
        let shellAttempts = [
            ["-lc", "command -v node"],
            ["-c", "source \"$HOME/.zshrc\" >/dev/null 2>&1; command -v node"]
        ]
        for arguments in shellAttempts {
            guard let path = resolveShell(arguments) else { continue }
            if let accepted = accept(path, isExecutable: isExecutable, nodeMajor: nodeMajor) {
                return accepted
            }
        }
        return nil
    }

    static func versionManagerNodes(
        home: String,
        directoryEntries: (String) -> [String],
        readText: (String) -> String?
    ) -> [String] {
        var paths: [String] = []
        let fnmRoots = [
            "\(home)/Library/Application Support/fnm",
            "\(home)/.local/share/fnm",
            "\(home)/.fnm"
        ]
        for root in fnmRoots {
            paths.append("\(root)/aliases/default/bin/node")
            let versions = directoryEntries("\(root)/node-versions")
            if let latest = versions.filter(isVersionName).max(by: { compareVersion($0, $1) == .orderedAscending }) {
                paths.append("\(root)/node-versions/\(latest)/installation/bin/node")
            }
        }
        if let nvm = nvmDefaultNode(home: home, directoryEntries: directoryEntries, readText: readText) {
            paths.append(nvm)
        }
        paths.append("\(home)/.asdf/shims/node")
        paths.append("\(home)/.nodenv/shims/node")
        return paths
    }

    private static func nvmDefaultNode(
        home: String,
        directoryEntries: (String) -> [String],
        readText: (String) -> String?
    ) -> String? {
        let aliasDir = "\(home)/.nvm/alias"
        guard let resolved = followAlias(aliasDir: aliasDir, name: "default", readText: readText) else {
            return nil
        }
        let versionRoot = "\(home)/.nvm/versions/node"
        let matches = directoryEntries(versionRoot).filter {
            $0 == resolved || $0.hasPrefix(resolved + ".")
        }
        guard let best = matches.max(by: { compareVersion($0, $1) == .orderedAscending }) else {
            return nil
        }
        return "\(versionRoot)/\(best)/bin/node"
    }

    private static func followAlias(
        aliasDir: String,
        name: String,
        readText: (String) -> String?,
        depth: Int = 0
    ) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || depth > 5 { return nil }
        if let version = normalizedVersion(trimmed) { return version }
        guard let next = readText("\(aliasDir)/\(trimmed)") else { return nil }
        return followAlias(aliasDir: aliasDir, name: next, readText: readText, depth: depth + 1)
    }

    private static func normalizedVersion(_ name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("/"), !trimmed.contains(" ") else { return nil }
        let bare = trimmed.hasPrefix("v") ? String(trimmed.dropFirst()) : trimmed
        let parts = bare.split(separator: ".", omittingEmptySubsequences: false)
        guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) else {
            return nil
        }
        return "v" + bare
    }

    private static func isVersionName(_ name: String) -> Bool {
        normalizedVersion(name) != nil
    }

    private static func compareVersion(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let left = versionNumbers(lhs)
        let right = versionNumbers(rhs)
        let count = max(left.count, right.count)
        for index in 0..<count {
            let l = index < left.count ? left[index] : 0
            let r = index < right.count ? right[index] : 0
            if l < r { return .orderedAscending }
            if l > r { return .orderedDescending }
        }
        return .orderedSame
    }

    private static func versionNumbers(_ name: String) -> [Int] {
        let bare = name.hasPrefix("v") ? String(name.dropFirst()) : name
        return bare.split(separator: ".").map { Int($0) ?? 0 }
    }

    private static func accept(
        _ path: String,
        isExecutable: (String) -> Bool,
        nodeMajor: (String) -> Int?
    ) -> String? {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("\n"), isExecutable(trimmed) else { return nil }
        guard let major = nodeMajor(trimmed), major >= minimumMajor else { return nil }
        return trimmed
    }

    private static func majorVersion(at path: String) -> Int? {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["-p", "process.versions.node.split('.')[0]"]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let deadline = Date().addingTimeInterval(2)
        while process.isRunning && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        if process.isRunning {
            process.terminate()
            return nil
        }
        guard process.terminationStatus == 0 else { return nil }
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Int(text)
    }

    private static func resolveShell(arguments: [String]) -> String? {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let deadline = Date().addingTimeInterval(2)
        while process.isRunning && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        if process.isRunning {
            process.terminate()
            return nil
        }
        guard process.terminationStatus == 0 else { return nil }
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}
