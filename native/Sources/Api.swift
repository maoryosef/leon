import Foundation
import Network

struct ApiRequest {
    let method: String
    let path: [String]
    let headers: [String: String]
    let body: [String: Any]

    /// Nil until the buffer holds the whole request.
    init?(parsing buffer: Data) {
        guard let split = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: buffer[..<split.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let requestLine = head[0].split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in head.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let bodyData = buffer[split.upperBound...]
        guard bodyData.count >= length else { return nil }
        method = String(requestLine[0])
        path = requestLine[1].split(separator: "?")[0].split(separator: "/").map(String.init)
        self.headers = headers
        body = (try? JSONSerialization.jsonObject(with: bodyData.prefix(length))) as? [String: Any] ?? [:]
    }
}

struct ApiResponse {
    let status: Int
    let json: Any

    static func ok(_ json: Any = ["ok": true]) -> ApiResponse { ApiResponse(status: 200, json: json) }
    static func error(_ status: Int, _ message: String) -> ApiResponse { ApiResponse(status: status, json: ["error": message]) }
}

/// Loopback-only HTTP API for the Raycast extension. The port and a token
/// that changes every launch live in ~/.leon/avatar-api.json (mode 0600).
final class ApiServer {
    static let port: UInt16 = 5367
    private let token = UUID().uuidString
    private let queue = DispatchQueue(label: "leon.api")
    private var listener: NWListener?
    private let handle: (ApiRequest) -> ApiResponse

    init(handle: @escaping (ApiRequest) -> ApiResponse) {
        self.handle = handle
    }

    func start() {
        guard let port = NWEndpoint.Port(rawValue: Self.port) else { return }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
        parameters.allowLocalEndpointReuse = true
        guard let listener = try? NWListener(using: parameters) else { return }
        listener.newConnectionHandler = { [weak self] connection in
            connection.start(queue: self?.queue ?? .main)
            self?.read(connection, Data())
        }
        listener.start(queue: queue)
        self.listener = listener
        writeConnectionFile()
    }

    private func writeConnectionFile() {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".leon")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("avatar-api.json").path
        let data = try? JSONSerialization.data(withJSONObject: ["port": Int(Self.port), "token": token])
        FileManager.default.createFile(atPath: file, contents: data, attributes: [.posixPermissions: 0o600])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file)
    }

    private func read(_ connection: NWConnection, _ buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = ApiRequest(parsing: buffer) {
                self.respond(connection, request)
            } else if done || error != nil || buffer.count > 1_000_000 {
                connection.cancel()
            } else {
                self.read(connection, buffer)
            }
        }
    }

    private func respond(_ connection: NWConnection, _ request: ApiRequest) {
        let response = request.headers["authorization"] == "Bearer \(token)"
            ? handle(request)
            : .error(401, "bad token")
        let body = (try? JSONSerialization.data(withJSONObject: response.json)) ?? Data("{}".utf8)
        let head = "HTTP/1.1 \(response.status) \(HTTPURLResponse.localizedString(forStatusCode: response.status))\r\n"
            + "Content-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
    }
}

/// Runs on the API queue. Model state lives on the main thread.
struct ApiRoutes {
    let model: AvatarModel
    let cleanup: CleanupModel

    func handle(_ request: ApiRequest) -> ApiResponse {
        let path = request.path
        if request.method == "POST", path.count == 3, path[0] == "alerts", path[2] == "dismiss" {
            let found: Bool = onMain {
                guard let alert = model.alerts.first(where: { $0.id == path[1] }) else { return false }
                model.dismiss(alert)
                return true
            }
            return found ? .ok() : .error(404, "no such alert")
        }
        switch "\(request.method) /\(path.joined(separator: "/"))" {
        case "GET /state":
            return .ok(onMain { state() })
        case "POST /alerts/clear":
            onMain { model.alerts = [] }
            return .ok()
        case "POST /settings":
            onMain {
                if let on = request.body["keepAwake"] as? Bool { model.keepAwake = on }
                if let on = request.body["minimized"] as? Bool { model.minimized = on }
            }
            if let on = request.body["lidAwake"] as? Bool { model.applyLidAwake(on) }
            return .ok(onMain { state() })
        case "GET /workspaces":
            let items = CleanupModel.fetch()
            return .ok(onMain {
                [
                    "workspaces": items.map(describe),
                    "progress": cleanup.progress,
                    "running": cleanup.running,
                ] as [String: Any]
            })
        case "POST /workspaces/delete":
            let ids = Set(request.body["ids"] as? [String] ?? [])
            let targets = CleanupModel.fetch().filter { ids.contains($0.id) }
            guard !targets.isEmpty else { return .error(400, "no matching worktrees") }
            let started: Bool = onMain {
                guard !cleanup.running else { return false }
                cleanup.delete(targets)
                return true
            }
            return started ? .ok(["deleting": targets.map(\.id)]) : .error(409, "a cleanup is already running")
        default:
            return .error(404, "unknown route")
        }
    }

    private func state() -> [String: Any] {
        [
            "alerts": model.alerts.map { alert in
                [
                    "id": alert.id,
                    "kind": "\(alert.kind)",
                    "workspaceId": alert.workspaceId,
                    "title": alert.title,
                    "project": alert.project,
                    "preview": alert.preview ?? "",
                ]
            },
            "working": model.agents.filter { $0.eventType == "Start" }.map { agent in
                [
                    "terminalId": agent.terminalId,
                    "workspaceId": agent.workspaceId,
                    "title": agent.title,
                    "project": agent.project,
                ]
            },
            "keepAwake": model.keepAwake,
            "lidAwake": model.lidAwake,
            "minimized": model.minimized,
        ]
    }

    private func describe(_ workspace: CleanupWorkspace) -> [String: Any] {
        let agent = workspace.agentEvents.contains("PermissionRequest") ? "needsYou"
            : workspace.agentEvents.contains("Start") ? "working"
            : workspace.agentEvents.isEmpty ? "" : "idle"
        return [
            "id": workspace.id,
            "name": workspace.name,
            "branch": workspace.branch,
            "projectId": workspace.projectId,
            "project": workspace.project,
            "folder": workspace.folder.map { workspace.folderName ?? $0 } ?? "",
            "folderColor": workspace.folderColor ?? "",
            "folderOrder": workspace.folderOrder ?? Int64.max,
            "terminals": workspace.terminals,
            "agent": agent,
            "uncommitted": workspace.uncommitted ?? 0,
            "exists": workspace.exists,
        ]
    }

    private func onMain<T>(_ work: () -> T) -> T {
        DispatchQueue.main.sync(execute: work)
    }
}
