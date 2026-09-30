import AppKit
import SwiftUI

struct Alert: Identifiable, Equatable {
    let id: String
    let kind: AlertKind
    let workspaceId: String
    let title: String
    let project: String
    let preview: String?
}

extension AlertKind {
    var label: String {
        switch self {
        case .needsYou: "Needs you"
        case .failed: "Failed"
        case .finished: "Finished"
        }
    }

    var color: Color {
        switch self {
        case .needsYou: .orange
        case .failed: .red
        case .finished: .green
        }
    }
}

final class AvatarModel: ObservableObject {
    static let maxAlerts = 5

    @Published var alerts: [Alert] = []
    @Published var minimized = false
    @Published var note: String?
    var working = 0
    var onHitRegionsChange: (() -> Void)?
    var hitRegions: [String: CGRect] = [:] {
        didSet { onHitRegionsChange?() }
    }

    func apply(raised: [Alert], cleared: [String], bindings: [AgentBinding]) {
        working = bindings.filter { $0.eventType == "Start" }.count
        let replaced = Set(cleared + raised.map(\.id))
        withAnimation(.spring(duration: 0.35)) {
            alerts = Array((alerts.filter { !replaced.contains($0.id) } + raised).suffix(Self.maxAlerts))
        }
        if raised.contains(where: { $0.kind != .finished }) {
            NSSound(named: "Glass")?.play()
        } else if !raised.isEmpty {
            NSSound(named: "Pop")?.play()
        }
    }

    func dismiss(_ alert: Alert) {
        withAnimation(.spring(duration: 0.35)) { alerts.removeAll { $0.id == alert.id } }
    }

    func open(_ alert: Alert) {
        if let url = URL(string: "superset://v2-workspace/\(alert.workspaceId)") {
            NSWorkspace.shared.open(url)
        }
        dismiss(alert)
    }

    func showSummary() {
        let waiting = alerts.filter { $0.kind == .needsYou }.count
        let text = switch (working, waiting) {
        case (0, 0): "All quiet. No agent is working."
        case (_, 0): "\(working) agent\(working == 1 ? "" : "s") working. Nothing needs you."
        default: "\(waiting) waiting on you, \(working) working."
        }
        withAnimation { note = text }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            if self?.note == text { withAnimation { self?.note = nil } }
        }
    }
}

struct Bubble: View {
    let alert: Alert
    @ObservedObject var model: AvatarModel
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(alert.project.isEmpty ? alert.kind.label : "\(alert.kind.label) · \(alert.project)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(alert.kind.color)
            Text(alert.title).font(.callout.weight(.semibold)).lineLimit(1)
            if let preview = alert.preview ?? (alert.kind == .needsYou ? "Waiting for your answer." : nil) {
                Text(preview).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
        }
        .padding(.vertical, 10)
        .padding(.leading, 18)
        .padding(.trailing, 24)
        .frame(width: 300, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .leading) {
            Capsule().fill(alert.kind.color).frame(width: 4).padding(.vertical, 10).padding(.leading, 7)
        }
        .overlay(alignment: .topTrailing) {
            if hovering {
                Button { model.dismiss(alert) } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .padding(7)
            }
        }
        .shadow(color: .black.opacity(0.25), radius: 6, y: 2)
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .onHover { hovering = $0 }
        .hitRegion(alert.id, model)
        .onTapGesture { model.open(alert) }
        .help("Open in Superset")
        .transition(.move(edge: .trailing).combined(with: .opacity))
    }
}

struct Face: View {
    @ObservedObject var model: AvatarModel
    @State private var hovering = false
    private static let image = Bundle.main.image(forResource: "leon") ?? NSImage()

    private var size: CGFloat { model.minimized ? 34 : 64 }
    private var needsYou: Bool { model.alerts.contains { $0.kind == .needsYou } }
    private var ring: Color {
        if needsYou { return .orange }
        if model.alerts.contains(where: { $0.kind == .failed }) { return .red }
        return model.alerts.isEmpty ? .white.opacity(0.8) : .green
    }

    /// A clock-driven pulse: an animation modifier here would also retime the
    /// face's minimize and restore.
    private func pulse(at date: Date) -> CGFloat {
        needsYou ? 1.04 + 0.04 * sin(date.timeIntervalSinceReferenceDate * .pi / 0.7) : 1
    }

    var body: some View {
        TimelineView(.animation(paused: !needsYou)) { context in
            Image(nsImage: Self.image)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: size, height: size)
                .hitRegion("face", model)
                .clipShape(Circle())
                .overlay(Circle().stroke(ring, lineWidth: model.minimized ? 2 : 3))
                .scaleEffect(pulse(at: context.date))
        }
            .shadow(color: .black.opacity(0.35), radius: 5, y: 2)
            .overlay(alignment: .topTrailing) { badge }
            .overlay(alignment: .topLeading) {
                if hovering && !model.minimized {
                    Button { withAnimation(.spring(duration: 0.2)) { model.minimized = true } } label: {
                        Image(systemName: "minus.circle.fill").font(.system(size: 16))
                            .foregroundStyle(.white, .black.opacity(0.6))
                    }
                    .buttonStyle(.plain)
                    .help("Minimize")
                    .offset(x: -4, y: -4)
                }
            }
            .onHover { hovering = $0 }
            .onTapGesture {
                if model.minimized { withAnimation(.spring(duration: 0.2)) { model.minimized = false } } else { model.showSummary() }
            }
            .contextMenu {
                Button(model.minimized ? "Restore" : "Minimize") { withAnimation(.spring(duration: 0.2)) { model.minimized.toggle() } }
                Button("Clear alerts") { withAnimation { model.alerts = [] } }.disabled(model.alerts.isEmpty)
                Divider()
                Button("Quit Leon") { NSApp.terminate(nil) }
            }
    }

    @ViewBuilder private var badge: some View {
        if !model.alerts.isEmpty {
            Text("\(model.alerts.count)")
                .font(.system(size: model.minimized ? 9 : 11, weight: .bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(Capsule().fill(ring == .white.opacity(0.8) ? .gray : ring))
                .offset(x: 4, y: -4)
        }
    }
}

struct AvatarView: View {
    @ObservedObject var model: AvatarModel

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if !model.minimized {
                ForEach(model.alerts) { Bubble(alert: $0, model: model) }
                if let note = model.note {
                    Text(note)
                        .font(.callout)
                        .padding(10)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                        .shadow(color: .black.opacity(0.25), radius: 6, y: 2)
                        .transition(.opacity)
                }
            }
            Face(model: model)
        }
        .padding(14)
        .fixedSize()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
    }
}

final class Poller {
    private var tracker = Tracker()
    private let queue = DispatchQueue(label: "leon.poller")
    private var timer: DispatchSourceTimer?

    func start(onUpdate: @escaping ([Alert], [String], [AgentBinding]) -> Void) {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: 1.5)
        timer.setEventHandler { [self] in
            guard let bindings = SupersetDB.bindings() else { return }
            let changes = tracker.update(bindings, nowMs: Int64(Date().timeIntervalSince1970 * 1000))
            let raised = changes.raised.compactMap { binding -> Alert? in
                guard let kind = AlertKind(eventType: binding.eventType) else { return nil }
                return Alert(
                    id: binding.terminalId,
                    kind: kind,
                    workspaceId: binding.workspaceId,
                    title: binding.title,
                    project: binding.project,
                    preview: Transcript.preview(sessionId: binding.sessionId)
                )
            }
            DispatchQueue.main.async { onUpdate(raised, changes.cleared, bindings) }
        }
        timer.resume()
        self.timer = timer
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let model = AvatarModel()
    private let poller = Poller()
    private var panel: NSPanel!

    func applicationDidFinishLaunching(_ notification: Notification) {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 100, height: 100),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.acceptsMouseMovedEvents = true

        let hosting = NSHostingView(rootView: AvatarView(model: model))
        hosting.sizingOptions = []
        panel.contentView = hosting
        place()
        panel.orderFrontRegardless()

        model.onHitRegionsChange = { [weak self] in self?.passClicksOutsideContent() }
        NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] _ in
            self?.passClicksOutsideContent()
        }
        NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            self?.passClicksOutsideContent()
            return event
        }
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.place() }

        poller.start { [model] raised, cleared, bindings in
            model.apply(raised: raised, cleared: cleared, bindings: bindings)
        }
    }

    /// The panel never resizes: resizing mid-animation makes SwiftUI slide
    /// content from the old top-left corner. Its empty area lets clicks through.
    private func place() {
        guard let screen = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame else { return }
        let size = CGSize(width: 330, height: min(screen.height, 760))
        panel.setFrame(
            NSRect(x: screen.maxX - size.width, y: screen.minY, width: size.width, height: size.height),
            display: true
        )
    }

    private func passClicksOutsideContent() {
        let mouse = NSEvent.mouseLocation
        let point = CGPoint(x: mouse.x - panel.frame.minX, y: panel.frame.maxY - mouse.y)
        panel.ignoresMouseEvents = !model.hitRegions.values.contains {
            $0.insetBy(dx: -8, dy: -8).contains(point)
        }
    }
}

extension View {
    func hitRegion(_ id: String, _ model: AvatarModel) -> some View {
        onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { model.hitRegions[id] = $0 }
            .onDisappear { model.hitRegions[id] = nil }
    }
}

if CommandLine.arguments.contains("--self-test") {
    trackerSelfTest()
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
