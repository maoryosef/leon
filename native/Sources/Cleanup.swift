import AppKit
import SwiftUI

struct CleanupWorkspace: Identifiable {
    let id: String
    let name: String
    let branch: String
    let path: String
    let projectId: String
    let project: String
    let folder: String?
    let folderName: String?
    let folderColor: String?
    let folderOrder: Int64?
    let terminals: Int
    let agentEvents: [String]
    var uncommitted: Int?
    var exists = true

    var agentsWorking: Bool { agentEvents.contains("Start") || agentEvents.contains("PermissionRequest") }
}

struct FolderGroup: Identifiable {
    let id: String
    let name: String?
    let color: Color?
    let workspaces: [CleanupWorkspace]
}

struct ProjectGroup: Identifiable {
    let id: String
    let name: String
    let folders: [FolderGroup]

    var workspaceIds: [String] { folders.flatMap { $0.workspaces.map(\.id) } }
}

enum CheckState { case off, mixed, on }

struct FolderKey: Hashable {
    let scope: String
    let tag: String
}

final class CleanupModel: ObservableObject {
    private static let superset = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".superset/bin/superset").path

    private static let workspacesQuery = """
        select w.id,
               case when coalesce(w.name, '') = '' then w.branch else w.name end,
               w.branch, w.worktree_path, coalesce(w.project_id, ''),
               coalesce(nullif(p.name, ''), p.repo_name, '(no project)'),
               t.tag,
               (select nullif(f.display_name, '') from tag_folder_settings f where f.scope = w.project_id and f.tag = t.tag limit 1),
               (select f.color from tag_folder_settings f where f.scope = w.project_id and f.tag = t.tag limit 1),
               (select f.tab_order from tag_folder_settings f where f.scope = w.project_id and f.tag = t.tag limit 1),
               (select count(*) from terminal_sessions s where s.origin_workspace_id = w.id and s.status = 'active'),
               (select group_concat(b.last_event_type) from terminal_agent_bindings b
                  join terminal_sessions s on s.id = b.terminal_id and s.status = 'active'
                  where b.workspace_id = w.id and b.ended_at is null)
        from workspaces w
        left join projects p on p.id = w.project_id
        left join workspace_tags t on t.workspace_id = w.id
        where w.archived_at is null and w.type = 'worktree'
        """

    @Published var workspaces: [CleanupWorkspace] = []
    @Published var selected: Set<String> = []
    @Published var progress: [String: String] = [:]
    @Published var running = false
    @Published var loading = false

    var projects: [ProjectGroup] {
        Dictionary(grouping: workspaces, by: \.projectId)
            .map { projectId, items in
                let folders = Dictionary(grouping: items) { $0.folder ?? "" }
                    .map { tag, items in
                        FolderGroup(
                            id: "\(projectId)/\(tag)",
                            name: tag.isEmpty ? nil : (items[0].folderName ?? tag),
                            color: items[0].folderColor.flatMap(Color.init(hex:)),
                            workspaces: items.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
                        )
                    }
                    .sorted { lhs, rhs in
                        let left = lhs.workspaces[0], right = rhs.workspaces[0]
                        if (lhs.name == nil) != (rhs.name == nil) { return rhs.name == nil }
                        if left.folderOrder != right.folderOrder {
                            return (left.folderOrder ?? .max) < (right.folderOrder ?? .max)
                        }
                        return (lhs.name ?? "").localizedStandardCompare(rhs.name ?? "") == .orderedAscending
                    }
                return ProjectGroup(id: projectId, name: items[0].project, folders: folders)
            }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    var selectedWorkspaces: [CleanupWorkspace] { workspaces.filter { selected.contains($0.id) } }

    var confirmMessage: String {
        let targets = selectedWorkspaces
        var lines = ["Leon sends /exit to each agent, exits each terminal, then deletes the worktrees. Branches are kept."]
        let dirty = targets.filter { ($0.uncommitted ?? 0) > 0 }
        if !dirty.isEmpty {
            lines.append("Uncommitted changes will be lost in: " + dirty.map(\.name).joined(separator: ", ") + ".")
        }
        let working = targets.filter(\.agentsWorking).count
        if working > 0 {
            lines.append(working == 1 ? "1 agent is still working. It will be stopped."
                : "\(working) agents are still working. They will be stopped.")
        }
        let emptied = targets.filter { workspace in
            workspace.folder != nil && workspaces.allSatisfy {
                $0.projectId != workspace.projectId || $0.folder != workspace.folder || selected.contains($0.id)
            }
        }
        let folderNames = Set(emptied.map { $0.folderName ?? $0.folder ?? "" }).sorted()
        if !folderNames.isEmpty {
            lines.append("Folders left empty are removed too: " + folderNames.joined(separator: ", ") + ".")
        }
        return lines.joined(separator: "\n\n")
    }

    func state(of ids: [String]) -> CheckState {
        let count = ids.filter(selected.contains).count
        return count == 0 ? .off : count == ids.count ? .on : .mixed
    }

    func toggle(_ ids: [String]) {
        if state(of: ids) == .on { selected.subtract(ids) } else { selected.formUnion(ids) }
    }

    func load() {
        loading = true
        DispatchQueue.global().async { [weak self] in
            let items = Self.fetch()
            DispatchQueue.main.async {
                guard let self else { return }
                self.workspaces = items
                self.selected.formIntersection(items.map(\.id))
                self.loading = false
            }
        }
    }

    static func fetch() -> [CleanupWorkspace] {
        var items = SupersetDB.select(workspacesQuery) { row in
            CleanupWorkspace(
                id: row.text(0) ?? "",
                name: row.text(1) ?? "",
                branch: row.text(2) ?? "",
                path: row.text(3) ?? "",
                projectId: row.text(4) ?? "",
                project: row.text(5) ?? "",
                folder: row.text(6),
                folderName: row.text(7),
                folderColor: row.text(8),
                folderOrder: row.text(9) == nil ? nil : row.int(9),
                terminals: Int(row.int(10)),
                agentEvents: (row.text(11) ?? "").split(separator: ",").map(String.init)
            )
        } ?? []
        let paths = items.map(\.path)
        var checks = [(exists: Bool, uncommitted: Int?)](repeating: (true, nil), count: paths.count)
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: paths.count) { index in
            let exists = FileManager.default.fileExists(atPath: paths[index])
            let status = exists ? run("/usr/bin/git", ["-C", paths[index], "status", "--porcelain"]) : (status: 1, output: "")
            let count = status.status == 0 ? status.output.split(separator: "\n").count : nil
            lock.lock()
            checks[index] = (exists, count)
            lock.unlock()
        }
        for index in items.indices {
            items[index].exists = checks[index].exists
            items[index].uncommitted = checks[index].uncommitted
        }
        return items
    }

    func deleteSelected() {
        delete(selectedWorkspaces)
    }

    /// Only call with workspaces from `fetch()`: that list holds worktrees only,
    /// never a project's own checkout.
    func delete(_ targets: [CleanupWorkspace]) {
        guard !targets.isEmpty, !running else { return }
        running = true
        DispatchQueue.global().async { [weak self] in
            self?.exitAndDelete(targets)
            DispatchQueue.main.async {
                self?.running = false
                self?.load()
            }
        }
    }

    private func exitAndDelete(_ targets: [CleanupWorkspace]) {
        let ids = Set(targets.map(\.id))
        report(ids, "Exiting agents…")
        let agents = liveAgentTerminals(in: ids)
        for (terminal, workspace) in agents { send("/exit", to: terminal, in: workspace) }
        waitUntil(timeout: 15) { Set(self.liveAgentTerminals(in: ids).keys).isDisjoint(with: agents.keys) }

        report(ids, "Closing terminals…")
        for _ in 0..<3 {
            let shells = liveTerminals(in: ids)
            if shells.isEmpty { break }
            for (terminal, workspace) in shells { send("exit", to: terminal, in: workspace) }
            waitUntil(timeout: 3) { self.liveTerminals(in: ids).isEmpty }
        }
        for (terminal, workspace) in liveTerminals(in: ids) {
            run(Self.superset, ["terminals", "close", "--local", "--workspace", workspace, "--terminal", terminal])
        }

        for workspace in targets {
            report([workspace.id], "Deleting…")
            let result = run(Self.superset, ["workspaces", "delete", workspace.id, "--local", "--json"])
            let warnings = (try? JSONSerialization.jsonObject(with: Data(result.output.utf8)) as? [String: Any])?["warnings"]
                as? [String] ?? []
            if result.status != 0 {
                report([workspace.id], "Failed: " + firstLine(result.output))
            } else {
                report([workspace.id], warnings.isEmpty ? "Deleted" : "Deleted. " + firstLine(warnings[0]))
            }
        }
        removeEmptiedFolders(targets)
    }

    /// A folder that no live workspace uses any more is removed, so a whole
    /// selected folder leaves Superset's sidebar. A failed delete keeps its
    /// workspace live, so its folder stays.
    private func removeEmptiedFolders(_ targets: [CleanupWorkspace]) {
        let touched = Set(targets.compactMap { workspace in
            workspace.folder.map { FolderKey(scope: workspace.projectId, tag: $0) }
        })
        let usedQuery = """
            select w.project_id, t.tag from workspace_tags t
            join workspaces w on w.id = t.workspace_id
            where w.archived_at is null
            """
        guard !touched.isEmpty,
              let used = SupersetDB.select(usedQuery, { FolderKey(scope: $0.text(0) ?? "", tag: $0.text(1) ?? "") })
        else { return }
        for folder in touched.subtracting(used)
        where SupersetHost.mutate("tagFolders.delete", ["scope": folder.scope, "tag": folder.tag]) {
            let members = targets.filter { $0.projectId == folder.scope && $0.folder == folder.tag }
            report(Set(members.map(\.id)), "Deleted. Folder removed.")
        }
    }

    private func liveTerminals(in workspaces: Set<String>) -> [String: String] {
        let rows = SupersetDB.select("select id, origin_workspace_id from terminal_sessions where status = 'active'") {
            ($0.text(0) ?? "", $0.text(1) ?? "")
        } ?? []
        return Dictionary(rows.filter { workspaces.contains($0.1) }, uniquingKeysWith: { first, _ in first })
    }

    private func liveAgentTerminals(in workspaces: Set<String>) -> [String: String] {
        let rows = SupersetDB.select("""
            select b.terminal_id, b.workspace_id from terminal_agent_bindings b
            join terminal_sessions s on s.id = b.terminal_id and s.status = 'active'
            where b.ended_at is null
            """) { ($0.text(0) ?? "", $0.text(1) ?? "") } ?? []
        return Dictionary(rows.filter { workspaces.contains($0.1) }, uniquingKeysWith: { first, _ in first })
    }

    private func send(_ text: String, to terminal: String, in workspace: String) {
        run(Self.superset, ["terminals", "send", "--local", "--workspace", workspace, "--terminal", terminal, "--text", text])
    }

    private func waitUntil(timeout: TimeInterval, _ done: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done() && Date() < deadline { Thread.sleep(forTimeInterval: 0.5) }
    }

    private func report(_ ids: Set<String>, _ text: String) {
        DispatchQueue.main.async { for id in ids { self.progress[id] = text } }
    }

    private func firstLine(_ text: String) -> String {
        String(text.split(separator: "\n").first ?? "").prefix(120).description
    }
}

extension Color {
    init?(hex: String) {
        guard hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16), hex.count == 7 else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

struct Checkbox: View {
    let state: CheckState
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: state == .on ? "checkmark.square.fill" : state == .mixed ? "minus.square.fill" : "square")
                .font(.system(size: 15))
                .foregroundStyle(state == .off ? Color.secondary : Color.accentColor)
        }
        .buttonStyle(.plain)
    }
}

struct CleanupView: View {
    @ObservedObject var model: CleanupModel
    @State private var confirming = false

    var body: some View {
        VStack(spacing: 0) {
            List {
                ForEach(model.projects) { project in
                    Section {
                        ForEach(project.folders) { folder in
                            if let name = folder.name { folderRow(folder, name) }
                            ForEach(folder.workspaces) { workspaceRow($0, indented: folder.name != nil) }
                        }
                    } header: {
                        HStack(spacing: 8) {
                            Checkbox(state: model.state(of: project.workspaceIds)) { model.toggle(project.workspaceIds) }
                            Text(project.name).font(.headline)
                        }
                    }
                }
            }
            .disabled(model.running)
            .overlay {
                if model.workspaces.isEmpty {
                    Text(model.loading ? "Loading…" : "No worktrees to clean up.").foregroundStyle(.secondary)
                }
            }
            Divider()
            HStack {
                Text("\(model.selected.count) selected").foregroundStyle(.secondary)
                if model.running { ProgressView().controlSize(.small) }
                Spacer()
                Button("Refresh") { model.load() }.disabled(model.running || model.loading)
                Button("Exit & delete \(model.selected.count)", role: .destructive) { confirming = true }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .disabled(model.selected.isEmpty || model.running || model.loading)
            }
            .padding(12)
        }
        .frame(minWidth: 560, minHeight: 480)
        .alert("Delete \(model.selected.count) workspace\(model.selected.count == 1 ? "" : "s")?", isPresented: $confirming) {
            Button("Exit & delete", role: .destructive) { model.deleteSelected() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(model.confirmMessage)
        }
    }

    private func folderRow(_ folder: FolderGroup, _ name: String) -> some View {
        let ids = folder.workspaces.map(\.id)
        return HStack(spacing: 8) {
            Checkbox(state: model.state(of: ids)) { model.toggle(ids) }
            Image(systemName: "folder.fill").foregroundStyle(folder.color ?? .secondary)
            Text(name).fontWeight(.medium)
            Text("\(ids.count)").foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .onTapGesture { model.toggle(ids) }
    }

    private func workspaceRow(_ workspace: CleanupWorkspace, indented: Bool) -> some View {
        HStack(spacing: 8) {
            Checkbox(state: model.selected.contains(workspace.id) ? .on : .off) { model.toggle([workspace.id]) }
            VStack(alignment: .leading, spacing: 3) {
                Text(workspace.name).lineLimit(1)
                HStack(spacing: 6) {
                    Text(workspace.branch).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                    if workspace.terminals > 0 {
                        chip("\(workspace.terminals) terminal\(workspace.terminals == 1 ? "" : "s")", .gray)
                    }
                    if workspace.agentEvents.contains("PermissionRequest") {
                        chip("agent needs you", .orange)
                    } else if workspace.agentEvents.contains("Start") {
                        chip("agent working", .green)
                    } else if !workspace.agentEvents.isEmpty {
                        chip("agent idle", .blue)
                    }
                    if let count = workspace.uncommitted, count > 0 {
                        chip("\(count) uncommitted", .red)
                    }
                    if !workspace.exists { chip("missing on disk", .gray) }
                }
            }
            Spacer()
            if let status = model.progress[workspace.id] {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(status.hasPrefix("Failed") ? .red : .secondary)
                    .lineLimit(2)
            }
        }
        .padding(.leading, indented ? 24 : 0)
        .contentShape(Rectangle())
        .onTapGesture { model.toggle([workspace.id]) }
    }

    private func chip(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .foregroundStyle(color)
            .background(color.opacity(0.15), in: Capsule())
    }
}
