import AppKit
import Foundation
import SwiftUI

private let expectedBackendSchemaVersion = 2
private let serviceBaseURL = URL(string: "http://127.0.0.1:4178")!

private struct ToolConnection: Decodable, Identifiable {
    let id: String
    let name: String
    let status: String
    let detail: String
    let path: String
    let origin: String
    let needsAttention: Bool
    let canChoosePath: Bool
}

private struct ConnectionSummary: Decodable {
    let show: Bool
    let tone: String
    let title: String
    let emptyDetail: String
    static let hidden = ConnectionSummary(show: false, tone: "ok", title: "", emptyDetail: "")
}

private struct DataRootResponse: Decodable {
    let ok: Bool
    let message: String?
}

private struct SessionPayload: Decodable {
    let sessions: [RadarSession]
    let errors: [String]
    let scannedAt: String?
    let connections: [ToolConnection]?
    let connectionSummary: ConnectionSummary?
}

private struct RadarSession: Decodable, Identifiable {
    struct StatusFacts: Decodable {
        let endReason: String?
        let executionPhase: String?
        let viewState: String?
    }
    struct Jump: Decodable {
        let canActivateApp: Bool?
        let canOpenProject: Bool?
        let canCopyPath: Bool?
    }

    let id: String
    let tool: String
    let appName: String?
    let source: String?
    let title: String?
    let projectName: String?
    let projectPath: String?
    var displayProjectName: String? {
        guard let name = projectName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        let placeholders = ["未知项目", "未知工作区", "未选择项目", "未选择工作区", "unknown project", "unknown workspace"]
        return placeholders.contains(name.lowercased()) ? nil : name
    }
    let status: String
    let statusFacts: StatusFacts?
    var isUserStopped: Bool { status == "ended_abnormally" && statusFacts?.endReason == "user_stopped" }
    var isUsageLimited: Bool { status == "ended_abnormally" && statusFacts?.endReason == "usage_limit" }
    var isAcknowledgedAbnormalEnd: Bool {
        status == "ended_abnormally" && !isUserStopped && statusFacts?.viewState == "seen"
    }
    var isCompletedViewUnknown: Bool { status == "unknown" && statusFacts?.executionPhase == "succeeded" }
    var displayStatus: String {
        if isUserStopped { return "stopped" }
        if isUsageLimited { return "usage_limit" }
        if isCompletedViewUnknown { return "completed_unknown_view" }
        return status
    }
    let statusReason: String?
    let attentionReason: String?
    let lastActivityAt: String?
    let endedAt: String?
    var endedDate: Date? {
        guard let endedAt else { return nil }
        return ISO8601DateFormatter.fractional.date(from: endedAt) ?? ISO8601DateFormatter().date(from: endedAt)
    }
    var timelineDate: Date? {
        for value in [endedAt, lastActivityAt].compactMap({ $0 }) {
            if let date = ISO8601DateFormatter.fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value) { return date }
        }
        return nil
    }
    var isEnded: Bool {
        ["completed_seen", "completed_unseen", "ended_abnormally"].contains(status)
            || (status == "unknown" && ["succeeded", "failed"].contains(statusFacts?.executionPhase ?? ""))
    }
    let jump: Jump?
}

private enum SessionTimeline {
    static func sorted(_ sessions: [RadarSession]) -> [RadarSession] {
        sessions.enumerated().sorted { lhs, rhs in
            switch (lhs.element.timelineDate, rhs.element.timelineDate) {
            case let (left?, right?) where left != right: return left > right
            case (_?, nil): return true
            case (nil, _?): return false
            default: return lhs.offset < rhs.offset
            }
        }.map(\.element)
    }
}

private struct ActionRequest: Encodable {
    let id: String
}

private struct ActionResponse: Decodable {
    let ok: Bool
    let message: String
}

private struct DiagnosticFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@MainActor
private final class RadarModel: ObservableObject {
    @Published private(set) var sessions: [RadarSession] = []
    @Published private(set) var errors: [String] = []
    @Published private(set) var connections: [ToolConnection] = []
    @Published private(set) var connectionSummary = ConnectionSummary.hidden
    @Published private(set) var isRefreshing = false
    @Published private(set) var lastUpdatedAt: Date?
    private var scannedAt = ""
    private var sessionRecords: [String: [String: Any]] = [:]
    @Published var collapsedGroups: Set<SessionFilter> = []
    @Published var actionMessage = ""
    @Published private(set) var actionFeedbackIsError = false
    private var actionFeedbackTask: Task<Void, Never>?

    var onStatusChange: (() -> Void)?
    var onAppOpened: ((String) -> Void)?
    private var pollingTask: Task<Void, Never>?
    private var startupError: String?
    private static let minimumRefreshIndicator: TimeInterval = 0.45

    var runningCount: Int {
        sessions.filter { $0.status == "running" }.count
    }

    var needsResponseCount: Int {
        sessions.filter { $0.status == "needs_response" }.count
    }

    var completedUnseenCount: Int {
        sessions.filter { $0.status == "completed_unseen" }.count
    }

    var actionCount: Int {
        sessions.filter {
            !$0.isUserStopped && !$0.isAcknowledgedAbnormalEnd
                && ["needs_response", "completed_unseen", "ended_abnormally"].contains($0.status)
        }.count
    }

    func start() {
        guard pollingTask == nil else { return }
        refresh(force: true)
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled else { return }
                self?.refresh(force: false)
            }
        }
    }

    func stop() {
        pollingTask?.cancel()
        pollingTask = nil
        actionFeedbackTask?.cancel()
    }

    func reportStartupError(_ message: String) {
        startupError = message
        errors = [message]
        onStatusChange?()
    }

    func refresh(force: Bool) {
        guard !isRefreshing else { return }
        isRefreshing = true
        onStatusChange?()
        let started = Date()

        Task { [weak self] in
            guard let self else { return }
            do {
                var components = URLComponents(
                    url: serviceBaseURL.appendingPathComponent("api/sessions"),
                    resolvingAgainstBaseURL: false
                )!
                if force {
                    components.queryItems = [URLQueryItem(name: "fresh", value: "1")]
                }

                var request = URLRequest(url: components.url!)
                request.cachePolicy = .reloadIgnoringLocalCacheData
                request.timeoutInterval = 8
                let (data, response) = try await URLSession.shared.data(for: request)
                try Self.validate(response)

                let payload = try JSONDecoder().decode(SessionPayload.self, from: data)
                sessions = payload.sessions
                startupError = nil
                errors = payload.errors
                connections = payload.connections ?? []
                connectionSummary = payload.connectionSummary ?? .hidden
                scannedAt = payload.scannedAt ?? ""
                lastUpdatedAt = payload.scannedAt.flatMap { ISO8601DateFormatter.fractional.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) } ?? Date()
                if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let rawSessions = object["sessions"] as? [[String: Any]] {
                    var records: [String: [String: Any]] = [:]
                    for item in rawSessions {
                        if let id = item["id"] as? String { records[id] = item }
                    }
                    sessionRecords = records
                }
            } catch {
                let detail = "读取本机任务失败：\(error.localizedDescription)"
                if let startupError, sessions.isEmpty {
                    errors = [startupError, detail]
                } else {
                    errors = [detail]
                }
            }
            let remaining = Self.minimumRefreshIndicator - Date().timeIntervalSince(started)
            if remaining > 0 {
                try? await Task.sleep(for: .milliseconds(Int(remaining * 1000)))
            }
            isRefreshing = false
            onStatusChange?()
        }
    }

    func saveDataRoot(id: String, path: String) {
        Task { await submitDataRoot(id: id, path: path, clear: false) }
    }

    func clearDataRoot(id: String) {
        Task { await submitDataRoot(id: id, path: "", clear: true) }
    }

    private func submitDataRoot(id: String, path: String, clear: Bool) async {
        do {
            var request = URLRequest(url: serviceBaseURL.appendingPathComponent("api/data-roots"))
            if clear {
                var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
                components.queryItems = [URLQueryItem(name: "id", value: id)]
                request.url = components.url
                request.httpMethod = "DELETE"
            } else {
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["id": id, "path": path])
            }
            request.timeoutInterval = 8
            let (data, response) = try await URLSession.shared.data(for: request)
            let payload = try? JSONDecoder().decode(DataRootResponse.self, from: data)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), payload?.ok == true else {
                actionFeedbackIsError = true
                actionMessage = payload?.message ?? "没有保存数据目录"
                return
            }
            while isRefreshing { try? await Task.sleep(for: .milliseconds(100)) }
            refresh(force: true)
        } catch {
            actionFeedbackIsError = true
            actionMessage = error.localizedDescription
        }
    }

    func runAction(_ action: String, for session: RadarSession) {
        if action == "go-to" {
            actionFeedbackTask?.cancel()
            actionMessage = ""
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                var request = URLRequest(
                    url: serviceBaseURL
                        .appendingPathComponent("api/actions")
                        .appendingPathComponent(action)
                )
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONEncoder().encode(ActionRequest(id: session.id))
                request.timeoutInterval = 5

                let (data, response) = try await URLSession.shared.data(for: request)
                let result = try JSONDecoder().decode(ActionResponse.self, from: data)
                if result.ok {
                    try Self.validate(response)
                    if action == "go-to" {
                        onAppOpened?("已打开 \(Self.openedAppLabel(for: session))")
                    } else {
                        showActionFeedback(result.message, isError: false)
                    }
                } else {
                    showActionFeedback("操作失败：\(result.message)", isError: true)
                }
            } catch {
                showActionFeedback("操作失败：\(error.localizedDescription)", isError: true)
            }
        }
    }

    private static func openedAppLabel(for session: RadarSession) -> String {
        if let name = session.appName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            return name
        }
        let tool = session.tool.components(separatedBy: "·").first?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return tool.isEmpty ? "应用" : tool
    }

    func reportDiagnostic(for session: RadarSession, place: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let text = try await diagnosticText(for: session, place: place)
                NSPasteboard.general.clearContents()
                guard NSPasteboard.general.setString(text, forType: .string) else {
                    showActionFeedback("诊断没有复制到剪贴板", isError: true)
                    return
                }
                NSWorkspace.shared.open(DashboardLayout.feedbackFormURL)
                onAppOpened?("请在打开的表单中粘贴当前数据的排查日志")
            } catch {
                showActionFeedback("诊断没有生成：\(error.localizedDescription)", isError: true)
            }
        }
    }

    private func diagnosticText(for session: RadarSession, place: String) async throws -> String {
        let record = sessionRecords[session.id] ?? [
            "id": session.id,
            "tool": session.tool,
            "title": session.title ?? "",
            "projectName": session.projectName ?? "",
            "projectPath": session.projectPath ?? "",
            "status": session.status,
            "statusReason": session.statusReason ?? "",
            "attentionReason": session.attentionReason ?? "",
            "lastActivityAt": session.lastActivityAt ?? "",
            "endedAt": session.endedAt ?? ""
        ]
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let payload: [String: Any] = [
            "session": record,
            "place": place,
            "appVersion": version,
            "generatedAt": ISO8601DateFormatter.fractional.string(from: Date()),
            "timezone": TimeZone.current.identifier,
            "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
            "scannedAt": scannedAt,
            "errors": errors,
            "connections": connections.map {
                [
                    "id": $0.id,
                    "name": $0.name,
                    "status": $0.status,
                    "detail": $0.detail,
                    "path": $0.path,
                    "origin": $0.origin
                ]
            }
        ]
        var request = URLRequest(url: serviceBaseURL.appendingPathComponent("api/session-diagnostic"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        request.timeoutInterval = 5
        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.validate(response)
        struct DiagnosticResponse: Decodable {
            let ok: Bool
            let text: String?
            let message: String?
        }
        let result = try JSONDecoder().decode(DiagnosticResponse.self, from: data)
        guard result.ok, let text = result.text, !text.isEmpty else {
            throw DiagnosticFailure(message: result.message ?? "没有这条任务的诊断数据")
        }
        return text
    }

    private func showActionFeedback(_ message: String, isError: Bool) {
        actionFeedbackTask?.cancel()
        actionFeedbackIsError = isError
        actionMessage = message
        guard !isError else { return }
        actionFeedbackTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(3)) }
            catch { return }
            guard !Task.isCancelled else { return }
            self?.actionMessage = ""
        }
    }

    private static func validate(_ response: URLResponse) throws {
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }
}

@MainActor
private final class BackendManager {
    private var process: Process?
    private var logHandle: FileHandle?

    func startIfNeeded() async -> String? {
        if await isHealthy() { return nil }

        guard let backendRoot = Bundle.main.resourceURL?.appendingPathComponent("backend"),
              FileManager.default.fileExists(
                atPath: backendRoot.appendingPathComponent("src/server/index.js").path
              ) else {
            return "没有找到内置扫描服务，请重新构建应用。"
        }

        guard let nodePath = locateNode() else {
            return "没有找到 Node.js。请先安装 Node 20 或更高版本，或设置 AI_TASK_RADAR_NODE。"
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: nodePath)
        task.arguments = ["src/server/index.js"]
        task.currentDirectoryURL = backendRoot
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = "4178"
        environment["NODE_ENV"] = "production"
        task.environment = environment

        configureLogging(for: task)

        do {
            try task.run()
            process = task
        } catch {
            return "扫描服务启动失败：\(error.localizedDescription)"
        }

        for _ in 0..<12 {
            try? await Task.sleep(for: .milliseconds(200))
            if await isHealthy() { return nil }
        }

        return "扫描服务已启动，但暂时没有响应；应用会继续自动重试。"
    }

    func stop() {
        if let process, process.isRunning {
            process.terminate()
        }
        process = nil
        try? logHandle?.close()
        logHandle = nil
    }

    private func isHealthy() async -> Bool {
        var request = URLRequest(url: serviceBaseURL.appendingPathComponent("api/health"))
        request.timeoutInterval = 0.8
        request.cachePolicy = .reloadIgnoringLocalCacheData

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else { return false }
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            return object?["ok"] as? Bool == true
                && object?["service"] as? String == "ai-tool-session-dashboard"
                && object?["schemaVersion"] as? Int == expectedBackendSchemaVersion
        } catch {
            return false
        }
    }

    private func configureLogging(for task: Process) {
        let logDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/AITaskRadar", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: logDirectory,
            withIntermediateDirectories: true
        )
        let logURL = logDirectory.appendingPathComponent("backend.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: logURL) else { return }
        _ = try? handle.seekToEnd()
        task.standardOutput = handle
        task.standardError = handle
        logHandle = handle
    }

    private func locateNode() -> String? {
        let environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let bundledNode = Bundle.main.resourceURL?
            .appendingPathComponent("runtime/bin/node")
            .path
        return NodeLookup.locate(home: home, environment: environment, bundledNode: bundledNode)
    }
}

private enum SessionFilter: String, CaseIterable, Identifiable, Hashable {
    case all, running, attention
    case completedUnseen = "completed_unseen"
    case ended
    case endedToday = "ended_today"
    case needsResponse = "needs_response"
    case completedSeen = "completed_seen"
    case endedAbnormally = "ended_abnormally"
    case unknown

    static let primary: [SessionFilter] = [.all, .attention, .completedUnseen, .running, .ended, .unknown]
    static let specific: [SessionFilter] = [.endedToday, .needsResponse, .completedSeen, .endedAbnormally, .unknown]
    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "全部"
        case .running: return "进行中"
        case .attention: return "待你处理"
        case .completedUnseen: return "待查看"
        case .ended: return "已结束"
        case .endedToday: return "今日已结束"
        case .needsResponse: return "需你响应"
        case .completedSeen: return "已完成"
        case .endedAbnormally: return "异常结束"
        case .unknown: return "状态不明"
        }
    }

    func includes(_ session: RadarSession) -> Bool {
        switch self {
        case .all: return true
        case .attention:
            return !session.isUserStopped && !session.isAcknowledgedAbnormalEnd
                && ["needs_response", "ended_abnormally"].contains(session.status)
        case .ended: return ["completed_seen", "ended_abnormally"].contains(session.status) || session.isCompletedViewUnknown
        case .endedToday:
            let belongsToToday = session.status == "completed_seen"
                || session.status == "unknown"
                || session.isUserStopped
                || session.isAcknowledgedAbnormalEnd
            guard belongsToToday, let date = session.endedDate else { return false }
            return Calendar.current.isDateInToday(date) && date <= Date()
        case .unknown: return session.status == rawValue && !session.isCompletedViewUnknown
        case .endedAbnormally: return session.status == rawValue && !session.isUserStopped
        default: return session.status == rawValue
        }
    }
}

@MainActor
private final class PopoverPinState: ObservableObject {
    private static let preferenceKey = "radar-popover-pinned-v1"
    private static let legacyPreferenceKey = "radar-window-pinned-v1"
    private let defaults: UserDefaults
    @Published private(set) var isPinned: Bool
    var onChange: (() -> Void)?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if defaults.object(forKey: Self.preferenceKey) != nil {
            isPinned = defaults.bool(forKey: Self.preferenceKey)
        } else {
            isPinned = defaults.bool(forKey: Self.legacyPreferenceKey)
            defaults.set(isPinned, forKey: Self.preferenceKey)
        }
    }

    func toggle() {
        isPinned.toggle()
        defaults.set(isPinned, forKey: Self.preferenceKey)
        onChange?()
    }
}

private enum DashboardLayout {
    static let width: CGFloat = 400
    static let fixedHeight: CGFloat = 380
    static let feedbackFormURL = URL(string: "https://f.kdocs.cn/g/h09CF9me/")!

    static func height(availableHeight: CGFloat) -> CGFloat {
        min(fixedHeight, max(1, availableHeight))
    }
}

@MainActor
private final class PopoverSizeState: ObservableObject {
    private static let preferenceKey = "radar-popover-height-v1"
    private let defaults: UserDefaults
    private(set) var preferredHeight: CGFloat
    private var availableHeight: CGFloat
    @Published private(set) var height: CGFloat
    var refreshAvailableHeight: (() -> Void)?
    private var dragStart: (y: CGFloat, height: CGFloat)?

    init(defaults: UserDefaults = .standard, availableHeight: CGFloat = 1000) {
        self.defaults = defaults
        let saved = defaults.double(forKey: Self.preferenceKey)
        preferredHeight = saved.isFinite ? max(380, saved) : 380
        self.availableHeight = max(1, availableHeight)
        height = min(preferredHeight, max(1, availableHeight))
    }

    func updateAvailableHeight(_ value: CGFloat) {
        availableHeight = max(1, value)
        height = min(preferredHeight, availableHeight)
    }

    func setHeight(_ value: CGFloat, persist: Bool) {
        guard value.isFinite else { return }
        preferredHeight = max(380, min(value, max(380, availableHeight)))
        height = min(preferredHeight, availableHeight)
        if persist { defaults.set(Double(preferredHeight), forKey: Self.preferenceKey) }
    }

    func beginDrag(screenY: CGFloat) {
        refreshAvailableHeight?()
        dragStart = (screenY, height)
    }
    func drag(screenY: CGFloat) {
        guard let start = dragStart else { return }
        setHeight(start.height + start.y - screenY, persist: false)
    }
    func endDrag() {
        guard dragStart != nil else { return }
        dragStart = nil
        defaults.set(Double(preferredHeight), forKey: Self.preferenceKey)
    }
}

@MainActor
private struct PanelResizeGrip: NSViewRepresentable {
    let sizeState: PopoverSizeState
    func makeNSView(context: Context) -> GripView { GripView(sizeState: sizeState) }
    func updateNSView(_ view: GripView, context: Context) {}

    final class GripView: NSView {
        let sizeState: PopoverSizeState
        init(sizeState: PopoverSizeState) {
            self.sizeState = sizeState
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { nil }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeUpDown) }
        override func mouseDown(with event: NSEvent) { sizeState.beginDrag(screenY: NSEvent.mouseLocation.y) }
        override func mouseDragged(with event: NSEvent) { sizeState.drag(screenY: NSEvent.mouseLocation.y) }
        override func mouseUp(with event: NSEvent) { sizeState.endDrag() }
    }
}

// Scope native scrollbar styling to this popover without changing system preferences.
@MainActor
private struct SubtleScrollbars: NSViewRepresentable {
    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) { view.scheduleConfiguration() }

    final class Probe: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            scheduleConfiguration()
        }
        func scheduleConfiguration() {
            DispatchQueue.main.async { [weak self] in
                guard let root = self?.window?.contentView else { return }
                self?.configure(root)
            }
        }
        private func configure(_ view: NSView) {
            if let scroll = view as? NSScrollView {
                if scroll.scrollerStyle != .overlay { scroll.scrollerStyle = .overlay }
                if !scroll.autohidesScrollers { scroll.autohidesScrollers = true }
                if scroll.verticalScroller?.controlSize != .small { scroll.verticalScroller?.controlSize = .small }
                BottomScrollFade.install(on: scroll)
            }
            for child in view.subviews { configure(child) }
        }
    }
}

@MainActor
private final class BottomScrollFade: NSView {
    private weak var trackedScroll: NSScrollView?
    private weak var trackedDocument: NSView?
    private var observers: [NSObjectProtocol] = []
    static func install(on scroll: NSScrollView) {
        let fade = scroll.subviews.compactMap { $0 as? BottomScrollFade }.first ?? BottomScrollFade()
        if fade.superview == nil { scroll.addSubview(fade, positioned: .above, relativeTo: nil) }
        fade.track(scroll)
    }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        NSGradient(starting: NSColor.windowBackgroundColor.withAlphaComponent(0.9),
                   ending: NSColor.windowBackgroundColor.withAlphaComponent(0))?.draw(in: bounds, angle: 90)
    }
    private func track(_ scroll: NSScrollView) {
        if trackedScroll !== scroll || trackedDocument !== scroll.documentView {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers.removeAll()
            trackedScroll = scroll; trackedDocument = scroll.documentView
            scroll.contentView.postsBoundsChangedNotifications = true
            scroll.contentView.postsFrameChangedNotifications = true
            scroll.documentView?.postsFrameChangedNotifications = true
            let pairs: [(Notification.Name, NSView?)] = [
                (NSView.boundsDidChangeNotification, scroll.contentView),
                (NSView.frameDidChangeNotification, scroll.contentView),
                (NSView.frameDidChangeNotification, scroll.documentView)]
            for (name, object) in pairs {
                guard let object else { continue }
                observers.append(NotificationCenter.default.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
                    Task { @MainActor [weak self] in self?.refresh() }
                })
            }
        }
        refresh()
    }
    func refresh() {
        guard let scroll = trackedScroll, let document = scroll.documentView else { isHidden = true; return }
        let visible = scroll.documentVisibleRect
        let remaining = document.isFlipped ? document.bounds.maxY - visible.maxY : visible.minY - document.bounds.minY
        isHidden = remaining <= 1
        let clip = scroll.contentView.frame
        frame = NSRect(x: clip.minX, y: scroll.isFlipped ? clip.maxY - 12 : clip.minY, width: clip.width, height: 12)
        needsDisplay = true
    }
}

private struct ConnectionPathRow: View {
    let item: ToolConnection
    let onSave: (String) -> Void
    let onClear: () -> Void
    @State private var path = ""

    private var statusLine: String {
        let label: String
        switch item.status {
        case "connected": label = "已连接，有任务"
        case "empty": label = "已连接，最近没有任务"
        case "missing": label = "未找到数据"
        case "unreadable": label = "不可读"
        case "unsupported": label = "格式不支持"
        case "hook_missing": label = "缺少 Hook"
        default: label = item.status
        }
        return item.detail.isEmpty ? label : "\(label)。\(item.detail)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.name).font(.system(size: 11, weight: .medium))
            Text(statusLine).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if item.canChoosePath {
                HStack(spacing: 6) {
                    TextField("数据目录", text: $path)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 11))
                    Button("使用此目录") { onSave(path) }
                        .buttonStyle(.borderless)
                        .font(.system(size: 11))
                    if item.origin == "override" {
                        Button("恢复自动查找") { onClear() }
                            .buttonStyle(.borderless)
                            .font(.system(size: 11))
                    }
                }
            }
        }
        .onAppear { if path.isEmpty { path = item.path } }
    }
}

private struct OverviewGroup: Identifiable {
    let filter: SessionFilter
    let symbol: String
    let color: Color
    var id: String { filter.id }

    static let groups = [
        OverviewGroup(filter: .attention, symbol: "exclamationmark.circle.fill", color: .orange),
        OverviewGroup(filter: .completedUnseen, symbol: "doc.text", color: .blue),
        OverviewGroup(filter: .running, symbol: "circle.dotted", color: .secondary),
        OverviewGroup(filter: .endedToday, symbol: "tray.full", color: .secondary)
    ]
}

private enum HeaderBarMetrics {
    static let textSize: CGFloat = 16
    static let feedbackSize: CGFloat = 12
    static let iconSize: CGFloat = 13
    static let itemSide: CGFloat = 22
    static let itemSpacing: CGFloat = 5
}

private struct HeaderBarButtonStyle: ButtonStyle {
    var cornerRadius: CGFloat = 5

    func makeBody(configuration: Configuration) -> some View {
        HeaderBarButtonLabel(configuration: configuration, cornerRadius: cornerRadius)
    }
}

private struct HeaderBarButtonLabel: View {
    let configuration: ButtonStyleConfiguration
    var cornerRadius: CGFloat
    @State private var hovering = false

    var body: some View {
        configuration.label
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(configuration.isPressed ? Color.primary.opacity(0.12) : (hovering ? Color.primary.opacity(0.06) : Color.clear))
            )
            .onHover { inside in
                hovering = inside
                if inside { NSCursor.pointingHand.set() } else { NSCursor.arrow.set() }
            }
    }
}

private struct RadarDashboardView: View {
    @ObservedObject var model: RadarModel
    @ObservedObject var pinState: PopoverPinState
    @ObservedObject var sizeState: PopoverSizeState

    var onContentHeightChange: ((CGFloat) -> Void)? = nil

    @State private var showingAll = false
    @State private var filter: SessionFilter = .all
    @State private var query = ""
    @State private var showingSearch = false
    @FocusState private var searchFocused: Bool

    private var filteredSessions: [RadarSession] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let items = model.sessions.filter { session in
            filter.includes(session) && (term.isEmpty ||
                [session.title, session.tool, session.projectName, session.projectPath]
                    .compactMap { $0 }.joined(separator: " ").localizedCaseInsensitiveContains(term))
        }
        return SessionTimeline.sorted(items)
    }

    private var dashboardHeight: CGFloat {
        sizeState.height
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if showingAll { Divider().padding(.horizontal, 16) }
            if !model.errors.isEmpty { errorNotice }
            if model.connectionSummary.show { connectionNotice }

            // Keep both scroll views mounted so returning preserves the overview position.
            ZStack(alignment: .top) {
                overview
                    .opacity(showingAll ? 0 : 1)
                    .allowsHitTesting(!showingAll)
                    .accessibilityHidden(showingAll)
                allTasks
                    .opacity(showingAll ? 1 : 0)
                    .allowsHitTesting(showingAll)
                    .accessibilityHidden(!showingAll)
            }
            footer
        }
        .frame(width: DashboardLayout.width, height: dashboardHeight)
        .background(Color(nsColor: .windowBackgroundColor))
        .background(SubtleScrollbars().allowsHitTesting(false).accessibilityHidden(true))
        .tint(.blue)
        .overlay(alignment: .bottom) {
            PanelResizeGrip(sizeState: sizeState)
                .frame(height: 8)
                .overlay { Capsule().fill(Color.secondary.opacity(0.25)).frame(width: 26, height: 3).allowsHitTesting(false) }
                .accessibilityElement()
                .accessibilityLabel("调整面板高度")
                .accessibilityValue("\(Int(sizeState.height))")
                .accessibilityAdjustableAction { direction in
                    sizeState.refreshAvailableHeight?()
                    sizeState.setHeight(sizeState.height + (direction == .increment ? 32 : -32), persist: true)
                }
        }
        .onAppear { onContentHeightChange?(dashboardHeight) }
        .onChange(of: dashboardHeight) { onContentHeightChange?($0) }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: HeaderBarMetrics.itemSpacing) {
            if showingAll {
                Button {
                    showingAll = false
                    searchFocused = false
                } label: {
                    headerSymbol("arrow.left")
                }
                .buttonStyle(HeaderBarButtonStyle())
                .help("返回任务概览")
                .accessibilityLabel("返回任务概览")
            }
            Text(showingAll ? "全部任务" : "Agents 在忙啥")
                .font(.system(size: HeaderBarMetrics.textSize, weight: .medium))
                .frame(height: HeaderBarMetrics.itemSide)
            Button { pinState.toggle() } label: {
                headerSymbol(
                    pinState.isPinned ? "pin.fill" : "pin",
                    tint: pinState.isPinned ? .blue : .secondary
                )
            }
            .buttonStyle(HeaderBarButtonStyle())
            .help(pinState.isPinned ? "取消置顶，点击外部自动收起" : "固定置顶，切换应用时保持显示")
            .accessibilityLabel(pinState.isPinned ? "取消置顶" : "固定置顶")
            .accessibilityValue(pinState.isPinned ? "已开启" : "已关闭")
            .accessibilityAddTraits(pinState.isPinned ? .isSelected : [])
            if showingAll {
                Text("最近 7 天任务记录 · 共 \(filteredSessions.count) 个任务").font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Button {
                NSWorkspace.shared.open(DashboardLayout.feedbackFormURL)
            } label: {
                Text("反馈")
                    .font(.system(size: HeaderBarMetrics.feedbackSize, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(height: HeaderBarMetrics.itemSide)
            }
            .buttonStyle(HeaderBarButtonStyle())
            .help("打开反馈表单")
            .accessibilityLabel("反馈")
            Button { model.refresh(force: true) } label: {
                ZStack {
                    if model.isRefreshing {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: HeaderBarMetrics.iconSize, height: HeaderBarMetrics.iconSize)
                    } else {
                        headerSymbol("arrow.clockwise", tint: .primary)
                    }
                }
                .frame(width: HeaderBarMetrics.itemSide, height: HeaderBarMetrics.itemSide)
            }
            .buttonStyle(HeaderBarButtonStyle())
            .allowsHitTesting(!model.isRefreshing)
            .help(model.isRefreshing ? "正在扫描" : "立即扫描")
            .accessibilityLabel(model.isRefreshing ? "正在扫描" : "立即扫描")
        }
        .padding(.horizontal, 16)
        .padding(.top, showingAll ? 12 : 10)
        .padding(.bottom, 8)
    }

    private func headerSymbol(_ name: String, size: CGFloat = HeaderBarMetrics.iconSize, tint: Color = .primary, shiftY: CGFloat = 0) -> some View {
        Image(systemName: name)
            .font(.system(size: size, weight: .medium))
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(tint)
            .offset(y: shiftY)
            .frame(width: HeaderBarMetrics.itemSide, height: HeaderBarMetrics.itemSide)
    }

    private var syncLabel: String {
        if model.isRefreshing { return "扫描中…" }
        if !model.errors.isEmpty { return model.lastUpdatedAt == nil ? "扫描不可用" : "扫描有异常" }
        guard let date = model.lastUpdatedAt else { return "等待扫描" }
        let seconds = max(0, Date().timeIntervalSince(date))
        if seconds < 60 { return "刚刚扫描" }
        return "\(Int(seconds / 60)) 分钟前扫描"
    }

    private var overview: some View {
        ScrollView {
            VStack(spacing: 0) {
                if model.sessions.isEmpty && model.errors.isEmpty && !model.connectionSummary.show && !model.connectionSummary.emptyDetail.isEmpty {
                    Text(model.connectionSummary.emptyDetail)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8)
                        .padding(.bottom, 4)
                }
                ForEach(OverviewGroup.groups) { group in
                    overviewSection(group)
                }

            }
            .padding(.horizontal, 10)
            .padding(.bottom, 4)
        }
    }

    private func overviewSection(_ group: OverviewGroup) -> some View {
        let matching = model.sessions.filter { group.filter.includes($0) }
        let items = group.filter == .endedToday
            ? matching.sorted { ($0.endedDate ?? .distantPast) > ($1.endedDate ?? .distantPast) } : matching
        let isCollapsed = model.collapsedGroups.contains(group.filter)
        return VStack(spacing: 0) {
            Button {
                if isCollapsed { model.collapsedGroups.remove(group.filter) }
                else { model.collapsedGroups.insert(group.filter) }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 9, weight: .medium))
                        .frame(width: 10)
                    Text(group.filter.label).font(.system(size: 12, weight: .medium))
                    Text("\(items.count)").font(.system(size: 11)).monospacedDigit()
                        .padding(.leading, 2)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 5)
                .frame(maxWidth: .infinity, minHeight: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(HeaderBarButtonStyle(cornerRadius: 6))
            .padding(.horizontal, 4)
            .help("\(isCollapsed ? "展开" : "收起")\(group.filter.label)")
            .accessibilityLabel(group.filter.label)
            .accessibilityValue(isCollapsed ? "已收起" : "已展开")

            if !isCollapsed {
                ForEach(items) { session in
                    SessionRow(model: model, session: session, isOverview: true, place: "概览 / \(group.filter.label)")
                }
            }
        }
        .padding(.bottom, 2)
    }

    private var allTasks: some View {
        VStack(spacing: 0) {
            filterBar.padding(.horizontal, 16).padding(.vertical, 8)
            ScrollView {
                LazyVStack(spacing: 0) {
                    if filteredSessions.isEmpty { emptyState }
                    ForEach(filteredSessions) { session in
                        SessionRow(model: model, session: session, isOverview: true, place: "全部任务 / \(filter.label)")
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 12)
            }
            .id(filter.rawValue + query)
        }
    }

    private var filterBar: some View {
        HStack(spacing: 4) {
            ForEach(SessionFilter.primary) { item in
                Button(item.label) { filter = item }
                    .buttonStyle(.plain)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(filter == item ? Color.white : Color.primary.opacity(0.75))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 5)
                    .background(Capsule().fill(filter == item ? Color.blue : Color.secondary.opacity(0.08)))
                    .accessibilityAddTraits(filter == item ? .isSelected : [])
            }
        }
    }

    private var errorNotice: some View {
        DisclosureGroup {
            Text(model.errors.joined(separator: "\n"))
                .font(.system(size: 11)).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
        } label: {
            Label(model.sessions.isEmpty ? "扫描暂不可用，正在自动重试" : "部分扫描失败，当前列表可能不完整", systemImage: "exclamationmark.triangle")
                .font(.system(size: 11))
        }
        .foregroundStyle(.orange)
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(Color.orange.opacity(0.06))
    }

    private var visibleConnections: [ToolConnection] {
        model.connectionSummary.tone == "quiet"
            ? model.connections
            : model.connections.filter(\.needsAttention)
    }

    private var connectionNotice: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(visibleConnections) { item in
                    ConnectionPathRow(item: item, onSave: { model.saveDataRoot(id: item.id, path: $0) }, onClear: { model.clearDataRoot(id: item.id) })
                }
            }
            .padding(.top, 4)
        } label: {
            Label(model.connectionSummary.title, systemImage: model.connectionSummary.tone == "warning" ? "exclamationmark.triangle" : "externaldrive")
                .font(.system(size: 11))
        }
        .foregroundStyle(model.connectionSummary.tone == "warning" ? Color.orange : Color.secondary)
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(model.connectionSummary.tone == "warning" ? Color.orange.opacity(0.06) : Color.clear)
    }

    private var emptyCopy: (title: String, detail: String) {
        if model.isRefreshing && model.sessions.isEmpty {
            return ("正在查找本机任务", "正在读取最近 7 天的任务记录")
        }
        if !model.errors.isEmpty && model.sessions.isEmpty {
            return ("暂时无法读取任务", "可展开上方提示查看原因，稍后会自动重试")
        }
        if !query.isEmpty {
            return ("没有找到匹配的任务", "换个关键词，或查看全部任务")
        }
        switch filter {
        case .attention: return ("暂时没有需要你处理的任务", "需要你回应或处理异常的任务会显示在这里")
        case .completedUnseen: return ("暂时没有待查看的结果", "任务完成后，尚未查看的结果会显示在这里")
        case .running: return ("暂时没有正在进行的任务", "Agent 开始执行后，任务会显示在这里")
        case .ended: return ("暂时没有已结束的任务", "可在这里回顾已完成、已停止或异常结束的任务")
        case .unknown: return ("暂时没有状态不明的任务", "执行状态暂时无法确认的任务会显示在这里")
        default:
            if model.sessions.isEmpty && model.errors.isEmpty && !model.connectionSummary.emptyDetail.isEmpty {
                return ("暂时没有任务记录", model.connectionSummary.emptyDetail)
            }
            return ("暂时没有任务记录", "在支持的 AI 工具中执行任务后，可在这里查看")
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: query.isEmpty ? "tray" : "magnifyingglass")
                .font(.system(size: 30, weight: .light)).foregroundStyle(.tertiary)
            Text(emptyCopy.title)
                .font(.system(size: 14, weight: .medium))
            Text(emptyCopy.detail)
                .font(.system(size: 12)).foregroundStyle(.secondary)
            if !query.isEmpty || filter != .all {
                Button("查看全部任务") { query = ""; filter = .all }
                    .buttonStyle(.borderless)
            }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 60)
    }

    private var footer: some View {
        VStack(spacing: 0) {
            if !model.actionMessage.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Text(model.actionMessage).font(.system(size: 11)).textSelection(.enabled)
                    Spacer(minLength: 0)
                    Button { model.actionMessage = "" } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).help("关闭操作提示").accessibilityLabel("关闭操作提示")
                }
                .foregroundStyle(model.actionFeedbackIsError ? Color.orange : Color.secondary)
                .padding(.horizontal, 16).padding(.vertical, 7)
                .background((model.actionFeedbackIsError ? Color.orange : Color.blue).opacity(0.06))
            }
            Divider().padding(.horizontal, 16)
            if !showingAll {
                Button { showingAll = true } label: {
                    HStack(spacing: 10) {
                        Text("查看全部任务").font(.system(size: 12)).lineLimit(1)
                        Spacer(minLength: 8)
                        Text("最近 7 天，共 \(model.sessions.count) 任务")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                        Image(systemName: "arrow.right").font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(HeaderBarButtonStyle(cornerRadius: 6))
            } else {
                Text("Agent任务需在本地环境有记录才能查询到")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 10)
            }
        }
    }

    private func openAll(_ target: SessionFilter) {
        filter = target
        query = ""
        showingAll = true
    }
}

@MainActor
private struct SessionRow: View {
    @ObservedObject var model: RadarModel
    let session: RadarSession
    let isOverview: Bool
    var place = ""
    @State private var hovering = false

    private var reason: String? {
        guard ["needs_response", "ended_abnormally", "unknown"].contains(session.status) else { return nil }
        let reason = [session.statusReason, session.attentionReason].compactMap { $0 }.first { !$0.isEmpty }
        return reason ?? (session.status == "unknown" && session.statusFacts?.executionPhase == "succeeded" ? "已完成，查看状态未知" : nil)
    }

    var body: some View {
        HStack(spacing: 2) {
            Button { model.runAction("go-to", for: session) } label: {
                HStack(spacing: 10) {
                    ToolIcon(session: session, size: isOverview ? 26 : 32)
                    VStack(alignment: .leading, spacing: isOverview ? 1 : 4) {
                        HStack(spacing: 10) {
                            Text(session.title?.isEmpty == false ? session.title! : "未知会话")
                                .font(.system(size: isOverview ? 12 : 13, weight: isOverview ? .medium : .semibold))
                                .foregroundStyle(Color(nsColor: .labelColor))
                                .lineLimit(1).truncationMode(.tail)
                                .help(session.title?.isEmpty == false ? session.title! : "未知会话")
                                .frame(maxWidth: .infinity, alignment: .leading)
                            StatusBadge(status: session.displayStatus, compact: isOverview)
                        }
                        HStack(spacing: 5) {
                            Text(session.tool).fixedSize()
                            if let project = session.displayProjectName {
                                Text("·")
                                Text(project)
                                    .lineLimit(1).truncationMode(.middle)
                                    .help(session.projectPath ?? project)
                            }
                            Spacer(minLength: 0)
                            Text(relativeTime(session.endedAt?.isEmpty == false ? session.endedAt : session.lastActivityAt)).fixedSize()
                                .help(session.endedAt?.isEmpty == false ? "结束时间" : "最后活动时间")
                        }
                        .font(.system(size: 11)).foregroundStyle(Color(nsColor: .secondaryLabelColor))
                        if !isOverview, let reason {
                            Text(reason).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    if !isOverview {
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.tertiary)
                            .opacity(hovering ? 1 : 0)
                    }
                }
                .padding(.vertical, isOverview ? 7 : 8).padding(.horizontal, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(session.jump?.canActivateApp != true)
            .help(session.jump?.canActivateApp == true
                ? "前往 \(session.tool)；可能需手动选择会话" + (reason.map { "\n" + $0 } ?? "")
                : "当前任务暂不支持前往")
            .accessibilityLabel("\(session.title ?? "未知会话")，\(StatusBadge.label(for: session.displayStatus))，前往 \(session.tool)")

        }
        .padding(.trailing, isOverview ? 0 : 4)
        .frame(minHeight: isOverview ? 52 : nil)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(hovering ? Color.secondary.opacity(0.08) : Color.clear))
        .onHover { hovering = $0 }
        .contextMenu {
            Button("这条数据不对我要反馈") {
                model.reportDiagnostic(for: session, place: place)
            }
        }
    }

    private func relativeTime(_ value: String?) -> String {
        guard let value,
              let date = ISO8601DateFormatter.fractional.date(from: value)
                ?? ISO8601DateFormatter().date(from: value) else { return "时间未知" }
        let seconds = max(0, Date().timeIntervalSince(date))
        if seconds < 60 { return "刚刚" }
        if seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
        if seconds < 86_400 { return "\(Int(seconds / 3600)) 小时前" }
        return "\(Int(seconds / 86_400)) 天前"
    }
}

@MainActor
private struct ToolIcon: View {
    let session: RadarSession
    var size: CGFloat = 32
    private static var icons: [String: NSImage] = [:]

    var body: some View {
        Group {
            if let icon = appIcon {
                Image(nsImage: icon).resizable().interpolation(.high).scaledToFit().padding(3)
            } else {
                Image(systemName: session.tool.lowercased().contains("cli") ? "terminal" : "sparkles")
                    .font(.system(size: 21)).foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .background(RoundedRectangle(cornerRadius: 9).fill(Color(nsColor: .controlBackgroundColor)))
        .accessibilityHidden(true)
    }

    private var appIcon: NSImage? {
        if let cached = Self.icons[session.tool] { return cached }
        let base = session.tool.components(separatedBy: "·").first ?? session.tool
        let names = session.tool.lowercased().contains("cli") ? ["Terminal"] : [session.appName ?? base, base]
        for name in names {
            let roots = ["/Applications", "/System/Applications", FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path]
            let appURL = roots.map { URL(fileURLWithPath: $0).appendingPathComponent("\(name).app") }
                .first { FileManager.default.fileExists(atPath: $0.path) }
            if let appURL, let identifier = Bundle(url: appURL)?.bundleIdentifier,
               let installed = NSWorkspace.shared.urlForApplication(withBundleIdentifier: identifier) {
                let icon = NSWorkspace.shared.icon(forFile: installed.path)
                Self.icons[session.tool] = icon
                return icon
            }
        }
        return nil
    }
}

private struct StatusBadge: View {
    let status: String
    var compact = false

    var body: some View {
        HStack(spacing: 4) {
            if status == "running" && !compact {
                Image(systemName: "circle.dotted").font(.system(size: 10))
            }
            Text(Self.label(for: status))
        }
        .font(.system(size: compact ? 11 : 10, weight: compact ? .regular : .semibold))
        .foregroundStyle(color)
        .padding(.horizontal, compact ? 0 : 8).padding(.vertical, compact ? 0 : 4)
        .background(Capsule().fill(color.opacity(compact ? 0 : 0.10)))
        .fixedSize()
    }

    static func label(for status: String) -> String {
        switch status {
        case "needs_response": return "需你响应"
        case "running": return "执行中"
        case "completed_unseen": return "待查看"
        case "completed_seen": return "已完成"
        case "completed_unknown_view": return "已完成"
        case "stopped": return "已停止"
        case "usage_limit": return "额度已用完"
        case "ended_abnormally": return "异常结束"
        default: return "状态不明"
        }
    }

    private var color: Color {
        switch status {
        case "running", "completed_unseen": return .blue
        case "needs_response", "usage_limit": return .orange
        case "ended_abnormally": return .red
        default: return .secondary
        }
    }
}

private extension ISO8601DateFormatter {
    static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

@MainActor
private final class StatusPopoverController: NSObject, NSPopoverDelegate {
    private let model: RadarModel
    private var statusItem: NSStatusItem!
    private static let statusAutosaveName = "AgentsBusyMenu"
    private static let statusPositionKey = "NSStatusItem Preferred Position AgentsBusyMenu"
    private static let menuBarImage: NSImage = {
        let pointSize = NSSize(width: 18, height: 18)
        let image = NSImage(size: pointSize)
        for name in ["MenuBarIcon", "MenuBarIcon-64"] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "png"),
                  let data = try? Data(contentsOf: url),
                  let rep = NSBitmapImageRep(data: data) else { continue }
            rep.size = pointSize
            image.addRepresentation(rep)
        }
        if image.representations.isEmpty {
            let fallback = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Agents 在忙啥") ?? NSImage()
            fallback.isTemplate = true
            return fallback
        }
        image.isTemplate = true
        return image
    }()

    /// The old automatic name Item-0 is left off-screen by the menu bar on macOS 26.
    /// A new autosave name gets its own slot. The value is points from the right edge.
    private static func seedStatusItemPosition() {
        if UserDefaults.standard.object(forKey: statusPositionKey) == nil {
            UserDefaults.standard.set(200.0, forKey: statusPositionKey)
        }
    }

    private let popover = NSPopover()

    private let pinState: PopoverPinState
    private let sizeState: PopoverSizeState
    private weak var styledWindow: NSWindow?
    private var originalWindowLevel: NSWindow.Level = .normal
    private var originalCollectionBehavior: NSWindow.CollectionBehavior = []
    private var originalHidesOnDeactivate: Bool?

    private let onOpenBrowser: () -> Void
    private let onQuit: () -> Void
    private var openedToastPanel: NSPanel?
    private var openedToastToken = UUID()

    init(
        model: RadarModel,
        pinState: PopoverPinState? = nil,
        onOpenBrowser: @escaping () -> Void,
        onQuit: @escaping () -> Void
    ) {
        self.model = model
        self.pinState = pinState ?? PopoverPinState()
        self.sizeState = PopoverSizeState(availableHeight: (NSScreen.main?.visibleFrame.height ?? 800) - 100)
        self.onOpenBrowser = onOpenBrowser
        self.onQuit = onQuit
        super.init()
        Self.seedStatusItemPosition()
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.autosaveName = Self.statusAutosaveName
        item.isVisible = true
        statusItem = item

        self.sizeState.refreshAvailableHeight = { [weak self] in self?.updateAvailableHeight() }
        popover.delegate = self
        self.pinState.onChange = { [weak self] in self?.applyPinnedState() }
        applyPinnedState()
        popover.animates = true
        popover.contentSize = NSSize(
            width: DashboardLayout.width,
            height: sizeState.height
        )
        popover.contentViewController = NSHostingController(
            rootView: RadarDashboardView(
                model: model,
                pinState: self.pinState,
                sizeState: self.sizeState,
                onContentHeightChange: { [weak self] height in
                    self?.resizeContent(height: height)
                }
            )
        )

        configureStatusButton()
        placeStatusItemOnMenuBar()
    }

    private func statusButtonFrame() -> (rect: CGRect, onScreen: Bool) {
        guard let button = statusItem.button, let window = button.window else {
            return (.zero, false)
        }
        let rect = window.convertToScreen(button.convert(button.bounds, to: nil))
        let onScreen = NSScreen.screens.contains { screen in
            let barHeight = max(24, screen.frame.maxY - screen.visibleFrame.maxY)
            let menuBar = CGRect(
                x: screen.frame.minX,
                y: screen.frame.maxY - barHeight,
                width: screen.frame.width,
                height: barHeight
            )
            let intersection = menuBar.intersection(rect)
            return intersection.width > 8 && intersection.height > 8 && rect.midX > screen.frame.minX + 72
        }
        return (rect, onScreen)
    }

    private func placeStatusItemOnMenuBar() {
        let before = statusButtonFrame()
        guard !before.onScreen,
              let button = statusItem.button,
              let window = button.window,
              let screen = NSScreen.main else { return }
        let height = max(before.rect.height, 22)
        window.setFrameOrigin(NSPoint(x: screen.frame.maxX - 220, y: screen.frame.maxY - height))
    }

    private func configureStatusButton() {
        guard let button = statusItem.button else { return }
        button.target = self
        button.action = #selector(togglePopover)
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        update()
    }

    private func resizeContent(height: CGFloat) {
        let window = popover.contentViewController?.view.window
        let oldFrame = window?.frame
        popover.contentSize = NSSize(width: DashboardLayout.width, height: height)
        if let window, let oldFrame {
            window.setFrameOrigin(NSPoint(x: oldFrame.minX, y: oldFrame.maxY - window.frame.height))
        }
    }

    private func updateAvailableHeight() {
        guard let window = popover.contentViewController?.view.window,
              let screen = window.screen else { return }
        let chrome = max(0, window.frame.height - popover.contentSize.height)
        sizeState.updateAvailableHeight(window.frame.maxY - screen.visibleFrame.minY - 12 - chrome)
    }

    func showOpenedToast(_ message: String) {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let token = UUID()
        openedToastToken = token

        let font = NSFont.systemFont(ofSize: 13, weight: .medium)
        let label = NSTextField(labelWithString: text)
        label.font = font
        label.textColor = .labelColor
        label.alignment = .center
        label.lineBreakMode = .byClipping
        label.maximumNumberOfLines = 1
        label.sizeToFit()
        let measured = ceil((text as NSString).size(withAttributes: [.font: font]).width)
        let textWidth = max(ceil(label.frame.width), measured) + 20
        let sidePadding: CGFloat = 16
        let width = textWidth + sidePadding * 2
        let height: CGFloat = 34

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false

        let background = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        background.material = .popover
        background.blendingMode = .behindWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = height / 2
        background.layer?.masksToBounds = true
        label.frame = NSRect(x: sidePadding, y: 7, width: textWidth, height: 20)
        background.addSubview(label)
        panel.contentView = background

        if let button = statusItem.button, let window = button.window {
            let screenFrame = window.convertToScreen(button.convert(button.bounds, to: nil))
            var origin = NSPoint(x: screenFrame.midX - width / 2, y: screenFrame.minY - height - 8)
            if let screen = window.screen ?? NSScreen.main {
                let visible = screen.visibleFrame
                origin.x = min(max(origin.x, visible.minX + 8), visible.maxX - width - 8)
                origin.y = max(origin.y, visible.minY + 8)
            }
            panel.setFrameOrigin(origin)
        }

        openedToastPanel?.orderOut(nil)
        openedToastPanel = panel
        panel.orderFrontRegardless()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self, self.openedToastToken == token else { return }
            self.openedToastPanel?.orderOut(nil)
        }
    }

    private func applyPinnedState() {
        // Application-defined popovers stay open when another app becomes active.
        popover.behavior = pinState.isPinned ? .applicationDefined : .transient
        guard let window = popover.contentViewController?.view.window else { return }
        if styledWindow !== window {
            styledWindow = window
            originalWindowLevel = window.level
            originalCollectionBehavior = window.collectionBehavior
            originalHidesOnDeactivate = (window as? NSPanel)?.hidesOnDeactivate
        }
        window.level = pinState.isPinned ? .floating : originalWindowLevel
        window.collectionBehavior = pinState.isPinned
            ? [.canJoinAllSpaces, .fullScreenAuxiliary] : originalCollectionBehavior
        if let panel = window as? NSPanel, let originalHidesOnDeactivate {
            panel.hidesOnDeactivate = pinState.isPinned ? false : originalHidesOnDeactivate
        }
    }

    func popoverDidShow(_ notification: Notification) {
        updateAvailableHeight()
        applyPinnedState()
    }

    func popoverShouldDetach(_ popover: NSPopover) -> Bool { false }

    func update() {
        guard let button = statusItem.button else { return }
        button.image = Self.menuBarImage
        button.imageScaling = .scaleProportionallyDown
        button.imagePosition = .imageLeft

        if model.isRefreshing && model.sessions.isEmpty {
            button.title = " …"
        } else if model.actionCount > 0 {
            button.title = " \(model.actionCount)! · \(model.runningCount)"
        } else {
            button.title = " \(model.runningCount)"
        }

        button.toolTip = "Agents 在忙啥：\(model.actionCount) 个需要跟进，\(model.runningCount) 个运行中"
    }

    @objc private func openBrowser() { onOpenBrowser() }
    @objc private func quitApp() { onQuit() }

    private func showAppMenu(_ event: NSEvent, for button: NSStatusBarButton) {
        let menu = NSMenu(title: "Agents 在忙啥")
        for (title, action) in [
            ("打开浏览器看板", #selector(openBrowser)),
            ("退出", #selector(quitApp))
        ] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        NSMenu.popUpContextMenu(menu, with: event, for: button)
    }

    @objc private func togglePopover() {
        if let event = NSApp.currentEvent, event.type == .rightMouseUp, let button = statusItem.button {
            showAppMenu(event, for: button)
            return
        }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            show()
        }
    }

    func show() {
        if !model.actionFeedbackIsError { model.actionMessage = "" }
        model.refresh(force: false)
        NSApp.activate(ignoringOtherApps: true)
        presentFromStatusItem()
    }

    private func presentFromStatusItem(attempt: Int = 0) {
        guard let button = statusItem.button, button.window != nil else {
            if attempt < 20 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                    self?.presentFromStatusItem(attempt: attempt + 1)
                }
            }
            return
        }
        placeStatusItemOnMenuBar()
        guard statusButtonFrame().onScreen else { return }
        let screen = button.window?.screen ?? NSScreen.main
        sizeState.updateAvailableHeight((screen?.visibleFrame.height ?? 800) - 100)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        updateAvailableHeight()
        applyPinnedState()
        popover.contentViewController?.view.window?.makeKey()
    }
}

@main
@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    private var model: RadarModel!
    private var backend: BackendManager!
    private var statusPopover: StatusPopoverController!

    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        model = RadarModel()
        backend = BackendManager()

        let openBrowser: () -> Void = {
            _ = NSWorkspace.shared.open(serviceBaseURL)
        }
        let quit = {
            NSApp.terminate(nil)
        }

        statusPopover = StatusPopoverController(
            model: model,
            onOpenBrowser: openBrowser,
            onQuit: quit
        )
        model.onStatusChange = { [weak self] in
            self?.statusPopover.update()
        }
        model.onAppOpened = { [weak self] message in
            self?.statusPopover.showOpenedToast(message)
        }

        Task { [weak self] in
            guard let self else { return }
            if let startupError = await backend.startIfNeeded() {
                model.reportStartupError(startupError)
            }
            model.start()
            statusPopover.show()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        model?.stop()
        backend?.stop()
    }
}
