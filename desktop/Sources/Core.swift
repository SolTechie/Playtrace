import Foundation
import Security

struct PlaytraceError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

enum Policy {
    static let origin = "https://playtrace.liyuqiaolucky.workers.dev"
    static let cookieName = "__Host-playtrace_session"
    static func isUUID(_ value: String) -> Bool { UUID(uuidString: value) != nil }
    static func allows(_ path: String, method: String) -> Bool {
        // No arbitrary URL, encoded path, task queue, local command, or redirect support.
        if path.contains("%") || path.contains("\\") || path.contains("#") { return false }
        if method == "GET", ["/config", "/health", "/me"].contains(path) { return true }
        if method == "POST", ["/access/verify", "/access/exit", "/upload"].contains(path) { return true }
        let parts = path.split(separator: "?", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { return false }
        let components = parts[0].split(separator: "/", omittingEmptySubsequences: false)
        guard components.count >= 2, components[0].isEmpty,
              ["games", "themes"].contains(String(components[1])) else { return false }
        if components.count == 2 { return parts.count == 1 && ["GET", "POST"].contains(method) }
        guard components.count == 3, isUUID(String(components[2])) else { return false }
        if method == "DELETE", parts.count == 2 {
            let q = parts[1].split(separator: "=", omittingEmptySubsequences: false)
            return q.count == 2 && q[0] == "version" && Int(q[1]).map { $0 > 0 } == true
        }
        return parts.count == 1 && ["GET", "PUT"].contains(method)
    }
    static func trustedFrame(scheme: String, host: String, main: Bool) -> Bool {
        main && scheme == "playtrace" && host == "app"
    }
}

final class SessionStore {
    private let service = "app.playtrace.credentials"
    private let account: String
    init(account: String) { self.account = account }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    func read() throws -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw PlaytraceError("无法读取钥匙串会话（\(status)）。请允许玩迹访问它自己的登录凭据。")
        }
        return String(data: data, encoding: .utf8)
    }
    func write(_ token: String) throws {
        guard token.range(of: "^ps_[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw PlaytraceError("服务器返回了无效会话。")
        }
        let attributes = [kSecValueData as String: Data(token.utf8)]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var q = query.merging(attributes) { _, new in new }
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(q as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw PlaytraceError("无法保存钥匙串会话（\(status)）。") }
    }
    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw PlaytraceError("无法清除钥匙串会话（\(status)）。")
        }
    }
}

final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
struct APIResponse {
    let status: Int
    let data: Data
    func json() throws -> Any { try JSONSerialization.jsonObject(with: data) }
    func checked() throws -> Any {
        let value = try json()
        guard (200..<300).contains(status) else {
            throw PlaytraceError("HTTP \(status): \((value as? [String: Any])?["error"] as? String ?? "请求失败")")
        }
        return value
    }
}
final class APIClient {
    let store: SessionStore
    private let session: URLSession
    init(account: String) {
        store = SessionStore(account: account)
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }
    func request(_ path: String, method: String = "GET", body: Data? = nil,
                 contentType: String = "application/json") async throws -> APIResponse {
        guard Policy.allows(path, method: method), let url = URL(string: Policy.origin + "/api" + path) else {
            throw PlaytraceError("不允许的 API 请求。")
        }
        guard (body?.count ?? 0) <= (path == "/upload" ? 11 * 1024 * 1024 : 100_000) else {
            throw PlaytraceError("请求内容过大。")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue(Policy.origin, forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        if path != "/access/verify", let token = try store.read() {
            request.setValue("\(Policy.cookieName)=\(token)", forHTTPHeaderField: "Cookie")
        }
        let (data, rawResponse) = try await session.data(for: request)
        guard let response = rawResponse as? HTTPURLResponse, response.url?.host == url.host else {
            throw PlaytraceError("无效的服务响应。")
        }
        if (300..<400).contains(response.statusCode) { throw PlaytraceError("服务重定向已拒绝。") }
        if path == "/access/verify", (200..<300).contains(response.statusCode) {
            let headers = response.allHeaderFields.reduce(into: [String: String]()) { dict, pair in
                if let key = pair.key as? String, let value = pair.value as? String { dict[key] = value }
            }
            guard let cookie = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
                .first(where: { $0.name == Policy.cookieName }) else { throw PlaytraceError("未收到登录会话。") }
            try store.write(cookie.value)
        }
        if path == "/access/exit", (200..<300).contains(response.statusCode) { try store.clear() }
        return APIResponse(status: response.statusCode, data: data)
    }
    func json(_ path: String, method: String = "GET", body: Any? = nil) async throws -> Any {
        try await request(path, method: method, body: body.map { try JSONSerialization.data(withJSONObject: $0) }).checked()
    }
}

enum Draft {
    static let gameFields = Set(["title", "english_title", "japanese_title", "developer", "series", "tags", "status", "played_years", "hours", "release_year", "platform", "mc_scores", "wikipedia_url", "images", "notes", "personal_rating", "is_published"])
    static let themeFields = Set(["title", "description", "filters", "layout", "chart", "sort", "is_published"])
    static func merge(_ patch: [String: Any], into original: [String: Any]?, resource: String,
                      version: Int?) throws -> [String: Any] {
        let allowed = resource == "games" ? gameFields : themeFields
        let unknown = Set(patch.keys).subtracting(allowed)
        guard unknown.isEmpty else { throw PlaytraceError("未知或只读字段：\(unknown.sorted().joined(separator: ", "))") }
        var result = original?.filter { allowed.contains($0.key) } ?? [:]
        for (key, value) in patch { result[key] = value }
        guard let title = result["title"] as? String, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw PlaytraceError("title 不能为空。")
        }
        if let original {
            guard let expected = version, expected > 0, original["version"] as? Int == expected else {
                throw PlaytraceError("版本不匹配；重新 get 记录，检查后使用最新 --version。")
            }
            result["version"] = expected
        }
        return result
    }
    static func file(_ path: String) throws -> [String: Any] {
        let url = URL(fileURLWithPath: NSString(string: path).expandingTildeInPath)
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 100_000 else { throw PlaytraceError("JSON 文件不能超过 100 KB。") }
        guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
            throw PlaytraceError("JSON 顶层必须是对象。")
        }
        return value
    }
}
