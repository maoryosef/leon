import AppKit
import SwiftUI

struct FocusItem: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let project: String
    var host: String? = nil
    var name: String? = nil
}

/// A focused workspace shows its bubble's state first, so a card turns green,
/// orange or red exactly when Leon raises that bubble, and goes grey once it
/// is opened or dismissed. A merged task outranks the done bubble its agent
/// raises after the merge.
enum FocusStatus: Equatable {
    case alert(AlertKind), merged, working, idle

    init(alerts: [AlertKind], working: Bool, merged: Bool) {
        if let kind = [AlertKind.needsYou, .failed].first(where: alerts.contains) {
            self = .alert(kind)
        } else if merged {
            self = .merged
        } else if alerts.contains(.finished) {
            self = .alert(.finished)
        } else {
            self = working ? .working : .idle
        }
    }

    var label: String {
        switch self {
        case .alert(let kind): kind.label
        case .merged: "Merged"
        case .working: "Working"
        case .idle: "Idle"
        }
    }

    var color: Color {
        switch self {
        case .alert(let kind): kind.color
        case .merged: .purple
        case .working: .cyan
        case .idle: .gray
        }
    }
}

extension AvatarModel {
    static func savedFocus() -> [FocusItem] {
        UserDefaults.standard.data(forKey: "focus").flatMap { try? JSONDecoder().decode([FocusItem].self, from: $0) } ?? []
    }

    func status(of workspaceId: String) -> FocusStatus {
        FocusStatus(
            alerts: alerts.filter { $0.workspaceId == workspaceId }.map(\.kind),
            working: agents.contains { $0.workspaceId == workspaceId && $0.eventType == "Start" },
            merged: merged.contains(workspaceId)
        )
    }

    func open(workspace id: String) {
        if let url = URL(string: "superset://v2-workspace/\(id)") { NSWorkspace.shared.open(url) }
        withAnimation(.spring(duration: 0.35)) { alerts.removeAll { $0.workspaceId == id } }
    }

    var focusCandidates: [FocusItem] {
        var seen = Set(focus.map(\.id))
        return agents
            .filter { !$0.workspaceId.isEmpty && seen.insert($0.workspaceId).inserted }
            .map { FocusItem(id: $0.workspaceId, title: $0.title, project: $0.project) }
            .sorted { $0.title.localizedCompare($1.title) == .orderedAscending }
    }

    var remoteCandidates: [String: [FocusItem]] {
        let focused = Set(focus.map(\.id))
        return Dictionary(grouping: remoteWorkspaces.filter { !focused.contains($0.id) }) { $0.host ?? "" }
    }
}

struct FocusCard: View {
    let item: FocusItem
    @ObservedObject var model: AvatarModel
    @State private var hovering = false

    var body: some View {
        let status = model.status(of: item.id)
        HStack(spacing: 10) {
            ZStack {
                if status == .working { Aura() }
                Circle().fill(status.color).frame(width: 12, height: 12)
            }
            .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name ?? item.title).font(.title3.weight(.semibold)).lineLimit(1)
                HStack(spacing: 6) {
                    if let host = item.host {
                        Label(host, systemImage: "cloud.fill")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(.indigo))
                            .help("On a remote Superset host")
                    }
                    Text(item.project.isEmpty ? status.label : "\(status.label) · \(item.project)")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(status.color)
                }
                .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(status.color.opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(status.color.opacity(0.7), lineWidth: 1.5))
        .overlay(alignment: .topTrailing) {
            if hovering {
                Button { model.focus.removeAll { $0.id == item.id } } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Remove from focus")
                .padding(5)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 10))
        .onHover { hovering = $0 }
        .onTapGesture { model.open(workspace: item.id) }
        .contextMenu {
            Button("Rename…") { DispatchQueue.main.async(execute: rename) }
            Button("Remove from focus") { model.focus.removeAll { $0.id == item.id } }
        }
        .help("Open in Superset. Drag to reorder.")
    }

    private func rename() {
        let field = NSTextField(string: item.name ?? item.title)
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        let alert = NSAlert()
        alert.messageText = "Rename"
        alert.informativeText = "Leave it empty to go back to \(item.title)."
        alert.accessoryView = field
        alert.addButton(withTitle: "Rename")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        NSApp.activate()
        guard alert.runModal() == .alertFirstButtonReturn,
              let index = model.focus.firstIndex(where: { $0.id == item.id })
        else { return }
        let name = field.stringValue.trimmingCharacters(in: .whitespaces)
        model.focus[index].name = name.isEmpty || name == item.title ? nil : name
    }
}

struct FocusView: View {
    @ObservedObject var model: AvatarModel
    @ObservedObject var dock: FocusDock
    @State private var moving: (id: String, offset: CGFloat)?
    @State private var rowHeight: CGFloat = 66

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Focus").font(.headline)
                Spacer()
                Button { dock.showAddMenu() } label: { Image(systemName: "plus") }
                    .help("Add a session")
                Button { dock.visible = false } label: { Image(systemName: "xmark") }
                    .help("Hide")
            }
            .buttonStyle(.borderless)
            if model.focus.isEmpty {
                Text("Press + to add a session.").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(Array(model.focus.enumerated()), id: \.element.id) { index, item in
                let lifted = moving?.id == item.id
                FocusCard(item: item, model: model)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rowHeight = $0 + 8 }
                    .scaleEffect(lifted ? 1.04 : 1)
                    .shadow(color: .black.opacity(lifted ? 0.3 : 0), radius: 8, y: 4)
                    .offset(y: shift(index, item.id))
                    .animation(lifted ? nil : .spring(duration: 0.25), value: slots?.to)
                    .zIndex(lifted ? 1 : 0)
                    .gesture(DragGesture(minimumDistance: 4)
                        .onChanged { moving = (item.id, $0.translation.height) }
                        .onEnded { _ in drop() })
            }
        }
        .padding(12)
        .frame(width: 240)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.25), radius: 6, y: 2)
        .gesture(DragGesture().onChanged { dock.drag(translation: $0.translation, ended: false) }
            .onEnded { dock.drag(translation: $0.translation, ended: true) })
        .padding(10)
    }

    /// The dragged card's slot now and the slot it would drop into.
    private var slots: (from: Int, to: Int)? {
        guard let moving, let from = model.focus.firstIndex(where: { $0.id == moving.id }) else { return nil }
        return (from, min(max(from + Int((moving.offset / rowHeight).rounded()), 0), model.focus.count - 1))
    }

    /// The dragged card follows the mouse; the cards it passes slide one row
    /// the other way to open its slot.
    private func shift(_ index: Int, _ id: String) -> CGFloat {
        guard let moving, let slots else { return 0 }
        if id == moving.id { return moving.offset }
        if slots.from < slots.to, index > slots.from, index <= slots.to { return -rowHeight }
        if slots.to < slots.from, index >= slots.to, index < slots.from { return rowHeight }
        return 0
    }

    private func drop() {
        guard let slots else { return }
        withAnimation(.spring(duration: 0.25)) {
            moving = nil
            model.focus.move(fromOffsets: [slots.from], toOffset: slots.to > slots.from ? slots.to + 1 : slots.to)
        }
    }
}

/// A panel on a screen's left or right edge, at its top, middle or bottom.
/// Until it is dragged, it sits at the middle of Leon's screen away from
/// Leon, so his bubbles never cover it. A drop docks it to the nearest of
/// those spots on the screen under the mouse. The hosting view sizes the panel to its cards, and every resize
/// puts it back in its place.
final class FocusDock: ObservableObject {
    @Published var visible = UserDefaults.standard.object(forKey: "focusVisible") as? Bool ?? true {
        didSet { UserDefaults.standard.set(visible, forKey: "focusVisible"); place() }
    }
    private let panel = NSPanel(
        contentRect: NSRect(x: 0, y: 0, width: 260, height: 100),
        styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered,
        defer: false
    )
    private let model: AvatarModel
    private let screen: () -> NSScreen?
    private var dragging = PanelDrag()

    init(model: AvatarModel, screen: @escaping () -> NSScreen?) {
        self.model = model
        self.screen = screen
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.acceptsMouseMovedEvents = true
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in Self.refreshMerged(model) }.fire()
        panel.contentView = NSHostingView(rootView: FocusView(model: model, dock: self))
        NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: panel, queue: .main) {
            [weak self] _ in self?.place()
        }
        place()
    }

    /// Merged once every pull request linked to the workspace is merged or
    /// closed, and at least one is merged.
    private static func refreshMerged(_ model: AvatarModel) {
        DispatchQueue.global().async {
            let sql = """
                select wp.workspace_id from workspace_pull_requests wp
                join pull_requests p on p.id = wp.pull_request_id
                group by wp.workspace_id
                having sum(p.state = 'merged') > 0 and sum(p.state in ('open', 'draft')) = 0
                """
            guard let ids = SupersetDB.select(sql, { $0.text(0) ?? "" }) else { return }
            let merged = Set(ids)
            DispatchQueue.main.async { if model.merged != merged { model.merged = merged } }
        }
    }

    /// An AppKit menu, built once per click: SwiftUI rebuilds a `Menu` on
    /// every model change, and that closes it while it is open.
    func showAddMenu() {
        let menu = NSMenu()
        let local = model.focusCandidates, remote = model.remoteCandidates
        if local.isEmpty && remote.isEmpty { menu.addItem(withTitle: "No open sessions", action: nil, keyEquivalent: "") }
        local.forEach { menu.addItem(addItem($0)) }
        for host in remote.keys.sorted() {
            let parent = NSMenuItem(title: host, action: nil, keyEquivalent: "")
            parent.submenu = NSMenu()
            remote[host]?.forEach { parent.submenu?.addItem(addItem($0)) }
            menu.addItem(parent)
        }
        menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }

    private func addItem(_ item: FocusItem) -> NSMenuItem {
        ActionMenuItem(item.project.isEmpty ? item.title : "\(item.title) · \(item.project)") { [model] in
            model.focus.append(item)
        }
    }

    func place() {
        let defaults = UserDefaults.standard
        let chosen = NSScreen.screens.first { $0.displayID == defaults.integer(forKey: "focusScreen") }
        guard visible, let area = (chosen ?? screen())?.visibleFrame, let content = panel.contentView else {
            panel.orderOut(nil)
            return
        }
        let size = content.fittingSize
        let left = chosen == nil ? model.anchor.horizontal == .trailing : defaults.bool(forKey: "focusLeft")
        let row = chosen == nil ? 1 : defaults.object(forKey: "focusRow") as? Int ?? 1
        let height = min(size.height, area.height)
        panel.setFrame(NSRect(
            x: left ? area.minX : area.maxX - size.width,
            y: area.minY + (area.height - height) * CGFloat(row) / 2,
            width: size.width, height: height
        ), display: true)
        panel.orderFrontRegardless()
    }

    func drag(translation: CGSize, ended: Bool) {
        dragging.move(panel, translation: translation, ended: ended)
        let mouse = NSEvent.mouseLocation
        guard ended, let dropped = NSScreen.screens.first(where: { $0.frame.contains(mouse) }) else { return }
        UserDefaults.standard.set(dropped.displayID, forKey: "focusScreen")
        UserDefaults.standard.set(mouse.x < dropped.frame.midX, forKey: "focusLeft")
        UserDefaults.standard.set(min(2, Int(3 * (mouse.y - dropped.frame.minY) / dropped.frame.height)), forKey: "focusRow")
        place()
    }
}

final class ActionMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(_ title: String, _ handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(fire), keyEquivalent: "")
        target = self
    }

    required init(coder: NSCoder) { fatalError("not used from nibs") }

    @objc private func fire() { handler() }
}

func focusSelfTest() {
    precondition(FocusStatus(alerts: [.finished, .needsYou], working: true, merged: true) == .alert(.needsYou), "needs you wins")
    precondition(FocusStatus(alerts: [.finished, .failed], working: false, merged: false) == .alert(.failed), "failed beats done")
    precondition(FocusStatus(alerts: [.finished], working: false, merged: true) == .merged, "merged beats done")
    precondition(FocusStatus(alerts: [.finished], working: false, merged: false) == .alert(.finished), "done shows until seen")
    precondition(FocusStatus(alerts: [], working: true, merged: false) == .working, "working without a bubble")
    precondition(FocusStatus(alerts: [], working: false, merged: false) == .idle, "idle when seen and quiet")
}
