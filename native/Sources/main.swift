import AppKit
import IOKit.pwr_mgt
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
    static let padding: CGFloat = 14

    @Published var alerts: [Alert] = []
    @Published var minimized = false
    @Published var anchor: Alignment = .bottomTrailing
    var faceSize: CGFloat { minimized ? 34 : 64 }
    @Published var note: String?
    @Published var keepAwake = false {
        didSet { holdSleepAssertion(keepAwake) }
    }
    private var sleepAssertion: IOPMAssertionID = 0
    @Published private(set) var lidAwake = false
    var agents: [AgentBinding] = []
    @Published private(set) var working = 0
    var onOpenCleanup: (() -> Void)?
    var onDrag: ((_ translation: CGSize, _ ended: Bool) -> Void)?
    var onHitRegionsChange: (() -> Void)?
    var hitRegions: [String: CGRect] = [:] {
        didSet { onHitRegionsChange?() }
    }

    func apply(raised: [Alert], cleared: [String], bindings: [AgentBinding]) {
        agents = bindings
        let count = bindings.filter { $0.eventType == "Start" }.count
        if count != working { working = count }
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

    /// Same as `caffeinate -d`: the display stays on, which also keeps the Mac
    /// awake. macOS drops the assertion if Leon quits.
    private func holdSleepAssertion(_ hold: Bool) {
        if hold, sleepAssertion == 0 {
            let result = IOPMAssertionCreateWithName(
                kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn),
                "Leon is keeping the Mac awake" as CFString,
                &sleepAssertion
            )
            if result != kIOReturnSuccess { keepAwake = false }
        } else if !hold, sleepAssertion != 0 {
            IOPMAssertionRelease(sleepAssertion)
            sleepAssertion = 0
        }
    }

    /// `pmset disablesleep` blocks every sleep, lid close included. It needs
    /// root and outlives Leon, so quitting turns it off again.
    func setLidAwake(_ on: Bool) {
        DispatchQueue.global().async { [weak self] in self?.applyLidAwake(on) }
    }

    func applyLidAwake(_ on: Bool) {
        let command = ["/usr/bin/pmset", "-a", "disablesleep", on ? "1" : "0"]
        if run("/usr/bin/sudo", ["-n"] + command).status != 0 {
            let script = "do shell script \"\(command.joined(separator: " "))\" with prompt "
                + "\"Leon needs your password to change sleep settings.\" with administrator privileges"
            run("/usr/bin/osascript", ["-e", script])
        }
        refreshLidAwake()
    }

    func refreshLidAwake() {
        let on = run("/usr/bin/pmset", ["-g"]).output.split(separator: "\n").contains {
            $0.split(whereSeparator: \.isWhitespace) == ["SleepDisabled", "1"]
        }
        DispatchQueue.main.async { self.lidAwake = on }
    }

    func dismiss(_ alert: Alert) {
        withAnimation(.spring(duration: 0.35)) { alerts.removeAll { $0.id == alert.id } }
    }

    func open(_ alert: Alert) {
        if !alert.workspaceId.isEmpty, let url = URL(string: "superset://v2-workspace/\(alert.workspaceId)") {
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
        let full = lidAwake ? "\(text) Sleep is off, even with the lid closed."
            : keepAwake ? "\(text) Keeping the Mac awake." : text
        withAnimation { note = full }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            if self?.note == full { withAnimation { self?.note = nil } }
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
        .help(alert.workspaceId.isEmpty ? "Dismiss" : "Open in Superset")
        .transition(.move(edge: model.anchor.horizontal == .leading ? .leading : .trailing).combined(with: .opacity))
    }
}

struct Face: View {
    @ObservedObject var model: AvatarModel
    @State private var hovering = false
    private static let image = Bundle.main.image(forResource: "leon") ?? NSImage()

    private var size: CGFloat { model.faceSize }
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
                .background {
                    if model.lidAwake {
                        Circle().fill(Color.purple).padding(-4).blur(radius: 6)
                    }
                }
                .background {
                    if model.working > 0 { Aura().frame(width: 2 * size, height: 2 * size) }
                }
                .overlay {
                    if model.lidAwake {
                        Circle()
                            .stroke(Color.purple, style: StrokeStyle(lineWidth: 2, dash: [4, 3]))
                            .padding(model.minimized ? -3 : -5)
                    }
                }
                .scaleEffect(pulse(at: context.date))
        }
            .shadow(color: .black.opacity(0.35), radius: 5, y: 2)
            .overlay(alignment: .topTrailing) { badge }
            .overlay(alignment: .bottomLeading) { awakeIndicator }
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
            .gesture(DragGesture().onChanged { model.onDrag?($0.translation, false) }.onEnded { model.onDrag?($0.translation, true) })
            .onTapGesture {
                if model.minimized { withAnimation(.spring(duration: 0.2)) { model.minimized = false } } else { model.showSummary() }
            }
            .contextMenu {
                Button(model.minimized ? "Restore" : "Minimize") { withAnimation(.spring(duration: 0.2)) { model.minimized.toggle() } }
                Toggle("Keep Mac awake", isOn: $model.keepAwake)
                Toggle("Stay awake with lid closed", isOn: Binding(
                    get: { model.lidAwake },
                    set: { model.setLidAwake($0) }
                ))
                Button("Clean up workspaces…") { model.onOpenCleanup?() }
                Button("Clear alerts") { withAnimation { model.alerts = [] } }.disabled(model.alerts.isEmpty)
                Divider()
                Button("Quit Leon") { NSApp.terminate(nil) }
            }
    }

    private var awakeIndicator: some View {
        HStack(spacing: 2) {
            if model.lidAwake {
                pip("laptopcomputer", .red, help: "Sleep is off, even with the lid closed. Click to turn it off.") {
                    model.setLidAwake(false)
                }
            }
            if model.keepAwake {
                pip("cup.and.saucer.fill", .brown, help: "Keeping the Mac awake. Click to allow sleep.") {
                    model.keepAwake = false
                }
            }
        }
        .offset(x: -4, y: 4)
    }

    private func pip(_ symbol: String, _ color: Color, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: model.minimized ? 7 : 10, weight: .bold))
                .foregroundStyle(.white)
                .padding(model.minimized ? 3 : 5)
                .background(Circle().fill(color))
        }
        .buttonStyle(.plain)
        .help(help)
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

/// A halo that breathes in and out while an agent works. It is laid out at
/// twice the face's size, because a layer drawn past its view's bounds is
/// clipped. Core Animation runs it in the render server: SwiftUI clocks and repeating animations redraw
/// in-process at up to 120 fps and cost 5-11% CPU.
struct Aura: NSViewRepresentable {
    final class HaloView: NSView {
        private let halo = CALayer()

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            let glow = NSColor(red: 0.25, green: 0.85, blue: 1, alpha: 1)
            halo.contents = NSImage(size: NSSize(width: 128, height: 128), flipped: false) { rect in
                let colors = [glow, glow.withAlphaComponent(0.85), glow.withAlphaComponent(0)].map(\.cgColor)
                guard let context = NSGraphicsContext.current?.cgContext,
                      let gradient = CGGradient(colorsSpace: nil, colors: colors as CFArray, locations: [0, 0.55, 1])
                else { return false }
                let center = CGPoint(x: rect.midX, y: rect.midY)
                context.drawRadialGradient(
                    gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: rect.width / 2, options: []
                )
                return true
            }
            halo.contentsGravity = .resize
            halo.transform = CATransform3DMakeScale(0.75, 0.75, 1)
            halo.opacity = 0.65
            layer?.addSublayer(halo)

            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = 0.62
            scale.toValue = 0.88
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0.95
            fade.toValue = 0.35
            let breath = CAAnimationGroup()
            breath.animations = [scale, fade]
            breath.duration = 0.8
            breath.autoreverses = true
            breath.repeatCount = .infinity
            breath.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            breath.isRemovedOnCompletion = false
            halo.add(breath, forKey: "breath")
        }

        required init?(coder: NSCoder) { nil }

        override func setFrameSize(_ newSize: NSSize) {
            super.setFrameSize(newSize)
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            halo.bounds = bounds
            halo.position = CGPoint(x: bounds.midX, y: bounds.midY)
            CATransaction.commit()
        }
    }

    func makeNSView(context: Context) -> HaloView { HaloView() }
    func updateNSView(_ view: HaloView, context: Context) {}
}

struct AvatarView: View {
    @ObservedObject var model: AvatarModel

    var body: some View {
        ZStack(alignment: model.anchor) {
            if !model.minimized {
                VStack(alignment: model.anchor.horizontal, spacing: 8) {
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
                .padding(model.anchor.vertical == .top ? .top : .bottom, model.faceSize + 8)
            }
            Face(model: model)
        }
        .padding(AvatarModel.padding)
        .fixedSize()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: model.anchor)
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
    private let cleanup = CleanupModel()
    private var cleanupWindow: NSWindow?
    private var api: ApiServer?
    private var panel: NSPanel!
    private var dragStart: (mouse: CGPoint, origin: CGPoint)?

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

        model.onOpenCleanup = { [weak self] in self?.openCleanup() }
        model.onDrag = { [weak self] in self?.drag(translation: $0, ended: $1) }
        api = ApiServer(handle: ApiRoutes(model: model, cleanup: cleanup).handle)
        api?.start()
        model.onHitRegionsChange = { [weak self] in self?.passClicksOutsideContent() }
        NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] _ in
            self?.passClicksOutsideContent()
        }
        NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            self?.passClicksOutsideContent()
            return event
        }
        DispatchQueue.global().async { [model] in model.refreshLidAwake() }
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.place() }

        poller.start { [model] raised, cleared, bindings in
            model.apply(raised: raised, cleared: cleared, bindings: bindings)
        }
    }

    /// The panel never resizes: resizing mid-animation makes SwiftUI slide
    /// content from the old top-left corner. Its empty area lets clicks through.
    /// The first screen is the one with the menu bar; `NSScreen.main` follows
    /// the key window and strands Leon on whichever display had focus.
    /// Bubbles open toward the larger free side of the screen, and the panel
    /// ends at the screen edge, so every message stays visible. A saved spot
    /// on a display that is gone falls back to the primary screen.
    private func place(face saved: CGPoint? = nil) {
        let saved = saved ?? UserDefaults.standard.string(forKey: "face").map(NSPointFromString)
        let screen = NSScreen.screens.first { saved.map($0.visibleFrame.contains) ?? false } ?? NSScreen.screens.first
        let inset = faceInset
        guard let bounds = screen?.visibleFrame.insetBy(dx: inset, dy: inset) else { return }
        let face = CGPoint(
            x: min(max(saved?.x ?? bounds.maxX, bounds.minX), bounds.maxX),
            y: min(max(saved?.y ?? bounds.minY, bounds.minY), bounds.maxY)
        )
        let left = face.x < bounds.midX, top = face.y > bounds.midY
        let width: CGFloat = 330
        let height = min(760, (top ? face.y - bounds.minY : bounds.maxY - face.y) + 2 * inset)
        model.anchor = Alignment(horizontal: left ? .leading : .trailing, vertical: top ? .top : .bottom)
        panel.setFrame(NSRect(
            x: left ? face.x - inset : face.x + inset - width,
            y: top ? face.y + inset - height : face.y - inset,
            width: width, height: height
        ), display: true)
        UserDefaults.standard.set(NSStringFromPoint(face), forKey: "face")
    }

    private var faceInset: CGFloat { AvatarModel.padding + model.faceSize / 2 }

    private var faceCenter: CGPoint {
        let frame = panel.frame, inset = faceInset
        return CGPoint(
            x: model.anchor.horizontal == .leading ? frame.minX + inset : frame.maxX - inset,
            y: model.anchor.vertical == .top ? frame.maxY - inset : frame.minY + inset
        )
    }

    /// Tracks the mouse in screen points: the gesture's translation is in
    /// window points, and is right only before the window first moves.
    private func drag(translation: CGSize, ended: Bool) {
        let mouse = NSEvent.mouseLocation
        let start = dragStart ?? (CGPoint(x: mouse.x - translation.width, y: mouse.y + translation.height), panel.frame.origin)
        dragStart = ended ? nil : start
        panel.setFrameOrigin(CGPoint(x: start.origin.x + mouse.x - start.mouse.x, y: start.origin.y + mouse.y - start.mouse.y))
        if ended { place(face: faceCenter) }
    }

    private func openCleanup() {
        if cleanupWindow == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 640, height: 640),
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered,
                defer: false
            )
            window.title = "Clean up workspaces"
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: CleanupView(model: cleanup))
            window.center()
            cleanupWindow = window
        }
        if !cleanup.running { cleanup.load() }
        NSApp.activate(ignoringOtherApps: true)
        cleanupWindow?.makeKeyAndOrderFront(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if model.lidAwake { model.applyLidAwake(false) }
        return .terminateNow
    }

    /// Held still while a button is down: flipping mid-drag sends the rest of
    /// the drag, and its mouse-up, to the app behind Leon.
    private func passClicksOutsideContent() {
        guard NSEvent.pressedMouseButtons == 0 else { return }
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
