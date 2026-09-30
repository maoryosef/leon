import Foundation
import SQLite3

struct AgentBinding: Equatable {
    let terminalId: String
    let workspaceId: String
    let sessionId: String?
    let eventType: String
    let lastEventAt: Int64
    let title: String
    let project: String
}

enum AlertKind {
    case needsYou, failed, finished

    init?(eventType: String) {
        switch eventType {
        case "PermissionRequest": self = .needsYou
        case "Failed": self = .failed
        case "Stop": self = .finished
        default: return nil
        }
    }
}

struct Changes {
    var raised: [AgentBinding] = []
    var cleared: [String] = []
}

/// Turns polled agent states into alerts. Superset also maps auto-approved
/// PreToolUse events to "PermissionRequest", so a request only counts once it
/// has been waiting for `attentionDelayMs`.
struct Tracker {
    static let attentionDelayMs: Int64 = 2500

    private var handled: [String: Int64] = [:]
    private var primed = false

    mutating func update(_ bindings: [AgentBinding], nowMs: Int64) -> Changes {
        var changes = Changes()
        let live = Set(bindings.map(\.terminalId))
        for gone in handled.keys where !live.contains(gone) {
            handled[gone] = nil
            changes.cleared.append(gone)
        }
        for binding in bindings where handled[binding.terminalId] != binding.lastEventAt {
            switch AlertKind(eventType: binding.eventType) {
            case .needsYou:
                guard nowMs - binding.lastEventAt >= Self.attentionDelayMs else { continue }
                changes.raised.append(binding)
            case .finished, .failed:
                if primed { changes.raised.append(binding) }
            case nil:
                changes.cleared.append(binding.terminalId)
            }
            handled[binding.terminalId] = binding.lastEventAt
        }
        primed = true
        return changes
    }
}

enum SupersetDB {
    private static let query = """
        select b.terminal_id, b.workspace_id, b.agent_session_id, b.last_event_type, b.last_event_at,
               case when coalesce(w.name, '') in ('', 'local') then coalesce(w.branch, '') else w.name end,
               coalesce(nullif(p.name, ''), p.repo_name, '')
        from terminal_agent_bindings b
        left join workspaces w on w.id = b.workspace_id
        left join projects p on p.id = w.project_id
        where b.ended_at is null
        """

    /// One host DB per Superset organization lives under ~/.superset/host/<orgId>/.
    /// Nil when any read fails, so a busy DB never looks like every agent quit.
    static func bindings() -> [AgentBinding]? {
        let hostRoot = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".superset/host")
        let orgs = (try? FileManager.default.contentsOfDirectory(atPath: hostRoot.path)) ?? []
        var all: [AgentBinding] = []
        for org in orgs {
            let path = hostRoot.appendingPathComponent("\(org)/host.db").path
            guard FileManager.default.fileExists(atPath: path) else { continue }
            guard let rows = read(path) else { return nil }
            all += rows
        }
        return all
    }

    private static func read(_ path: String) -> [AgentBinding]? {
        var db: OpaquePointer?
        defer { sqlite3_close(db) }
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { return nil }
        sqlite3_busy_timeout(db, 1000)
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, query, -1, &statement, nil) == SQLITE_OK else { return nil }
        var rows: [AgentBinding] = []
        var status = sqlite3_step(statement)
        while status == SQLITE_ROW {
            func text(_ column: Int32) -> String? {
                sqlite3_column_text(statement, column).map { String(cString: $0) }
            }
            rows.append(AgentBinding(
                terminalId: text(0) ?? "",
                workspaceId: text(1) ?? "",
                sessionId: text(2),
                eventType: text(3) ?? "",
                lastEventAt: sqlite3_column_int64(statement, 4),
                title: text(5) ?? "",
                project: text(6) ?? ""
            ))
            status = sqlite3_step(statement)
        }
        return status == SQLITE_DONE ? rows : nil
    }
}

enum Transcript {
    /// The agent's last words from its Claude Code transcript. A pending tool
    /// call is only written once it resolves, so a waiting agent shows what it
    /// said before asking.
    static func preview(sessionId: String?) -> String? {
        guard let sessionId, let file = find(sessionId), let tail = readTail(file) else { return nil }
        for line in tail.split(separator: "\n").reversed() {
            guard let entry = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  entry["type"] as? String == "assistant",
                  let message = entry["message"] as? [String: Any],
                  let blocks = message["content"] as? [[String: Any]]
            else { continue }
            if let text = lastText(blocks) { return tidy(text) }
        }
        return nil
    }

    private static func find(_ sessionId: String) -> URL? {
        let projects = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/projects")
        let dirs = (try? FileManager.default.contentsOfDirectory(atPath: projects.path)) ?? []
        return dirs.lazy
            .map { projects.appendingPathComponent("\($0)/\(sessionId).jsonl") }
            .first { FileManager.default.fileExists(atPath: $0.path) }
    }

    private static func readTail(_ file: URL, bytes: UInt64 = 256 * 1024) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: size > bytes ? size - bytes : 0)
        return (try? handle.readToEnd()).flatMap { String(decoding: $0, as: UTF8.self) }
    }

    private static func lastText(_ blocks: [[String: Any]]) -> String? {
        let text = blocks.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }
            .joined(separator: " ")
        return text.isEmpty ? nil : text
    }

    private static func tidy(_ text: String) -> String {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return flat.count > 220 ? String(flat.prefix(219)) + "…" : flat
    }
}

func trackerSelfTest() {
    func binding(_ type: String, at: Int64, id: String = "t1") -> AgentBinding {
        AgentBinding(terminalId: id, workspaceId: "w", sessionId: nil, eventType: type, lastEventAt: at, title: "", project: "")
    }
    var tracker = Tracker()
    precondition(tracker.update([binding("Stop", at: 1000)], nowMs: 5000).raised.isEmpty, "startup Stop is baseline")
    precondition(tracker.update([binding("Start", at: 6000)], nowMs: 6100).cleared == ["t1"], "Start clears")
    precondition(tracker.update([binding("Stop", at: 7000)], nowMs: 7100).raised.count == 1, "Stop after start raises")
    precondition(tracker.update([binding("PermissionRequest", at: 8000)], nowMs: 8100).raised.isEmpty, "fresh request waits")
    precondition(tracker.update([binding("PermissionRequest", at: 8000)], nowMs: 10600).raised.count == 1, "held request raises")
    precondition(tracker.update([binding("PermissionRequest", at: 8000)], nowMs: 12000).raised.isEmpty, "raised once")
    precondition(tracker.update([], nowMs: 13000).cleared == ["t1"], "gone terminal clears")

    var fresh = Tracker()
    precondition(fresh.update([binding("PermissionRequest", at: 0)], nowMs: 5000).raised.count == 1, "waiting at startup raises")
    print("tracker self-test passed")
}
