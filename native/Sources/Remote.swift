import Foundation

/// Agents on other Superset hosts, read through Superset's relay with the
/// CLI's login. A failed read keeps the last good one, so a slow relay never
/// looks like every remote agent quit.
final class RemoteHosts {
    private(set) var bindings: [AgentBinding] = []
    private(set) var workspaces: [FocusItem] = []
    private var hosts: [(id: String, name: String)] = []
    private var hostsAt = Date.distantPast
    private var readAt = Date.distantPast

    func refresh(now: Date = Date()) {
        if now.timeIntervalSince(hostsAt) > 300, let online = Self.onlineHosts() {
            hosts = online
            hostsAt = now
        }
        guard now.timeIntervalSince(readAt) > 6 else { return }
        readAt = now
        var bindings: [AgentBinding] = [], workspaces: [FocusItem] = []
        for host in hosts {
            guard let rows = Relay.query(host: host.id, "workspace.list"),
                  let agents = Relay.query(host: host.id, "terminalAgents.list")
            else { return }
            let named = rows.compactMap { row -> FocusItem? in
                guard let id = row["id"] as? String, row["archivedAt"] == nil || row["archivedAt"] is NSNull else { return nil }
                let name = row["name"] as? String ?? ""
                return FocusItem(
                    id: id,
                    title: ["", "local"].contains(name) ? row["branch"] as? String ?? "" : name,
                    project: row["projectName"] as? String ?? "",
                    host: host.name
                )
            }
            workspaces += named
            bindings += agents.compactMap { agent in
                guard let terminalId = agent["terminalId"] as? String, let workspaceId = agent["workspaceId"] as? String
                else { return nil }
                let workspace = named.first { $0.id == workspaceId }
                return AgentBinding(
                    terminalId: terminalId,
                    workspaceId: workspaceId,
                    sessionId: agent["agentSessionId"] as? String,
                    eventType: agent["lastEventType"] as? String ?? "",
                    lastEventAt: (agent["lastEventAt"] as? NSNumber)?.int64Value ?? 0,
                    title: workspace?.title ?? "",
                    project: workspace?.project ?? ""
                )
            }
        }
        self.bindings = bindings
        self.workspaces = workspaces
    }

    private static func onlineHosts() -> [(id: String, name: String)]? {
        let cli = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".superset/bin/superset").path
        let output = run(cli, ["hosts", "list", "--json"]).output
        guard let hosts = (try? JSONSerialization.jsonObject(with: Data(output.utf8))) as? [[String: Any]] else { return nil }
        return hosts.compactMap { host in
            guard let id = host["id"] as? String, host["online"] as? String == "yes" else { return nil }
            return (id, host["name"] as? String ?? id)
        }
    }
}

/// A host service's tRPC queries, reached through `relay.superset.sh` with
/// the token the Superset CLI keeps in ~/.superset/config.json. Leon never
/// refreshes that token itself: the server may rotate the refresh token,
/// which would log the CLI out. `superset auth whoami` refreshes it instead.
enum Relay {
    private static let config = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".superset/config.json")

    static func query(host: String, _ procedure: String) -> [[String: Any]]? {
        guard let first = get(host: host, procedure) else { return nil }
        if first.status != 401 { return first.rows }
        let cli = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".superset/bin/superset").path
        run(cli, ["auth", "whoami"])
        return get(host: host, procedure)?.rows
    }

    private static func get(host: String, _ procedure: String) -> (status: Int, rows: [[String: Any]]?)? {
        guard let data = try? Data(contentsOf: config),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let org = config["organizationId"] as? String,
              let token = (config["auth"] as? [String: Any])?["accessToken"] as? String,
              let url = URL(string: "https://relay.superset.sh/hosts/\(org):\(host)/trpc/\(procedure)")
        else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 5)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let done = DispatchSemaphore(value: 0)
        var result: (Int, [[String: Any]]?)?
        URLSession.shared.dataTask(with: request) { body, response, _ in
            if let status = (response as? HTTPURLResponse)?.statusCode {
                let json = body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
                let rows = ((json?["result"] as? [String: Any])?["data"] as? [String: Any])?["json"] as? [[String: Any]]
                result = (status, status == 200 ? rows : nil)
            }
            done.signal()
        }.resume()
        done.wait()
        return result
    }
}
