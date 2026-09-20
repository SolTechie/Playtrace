import Foundation

@main struct CoreTests {
    static func main() throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            guard condition() else { fatalError("FAIL: \(name)") }; checks += 1
        }
        let id = "7912d647-7a09-4e19-b9f2-e7b66fd38968"
        for path in ["/bridge/claim", "/jobs", "/agents", "//evil.test/games", "https://evil.test/games", "/games/../jobs", "/games%2f", "/games?redirect=evil", "/games#x", "/games/\(id)?version=1&url=x", "/games/\(id)?version=0", "/games/\(id)/"] {
            for method in ["GET", "POST", "PUT", "DELETE"] { check(!Policy.allows(path, method: method), "deny \(method) \(path)") }
        }
        check(Policy.allows("/games", method: "GET"), "public games")
        check(Policy.allows("/games/\(id)", method: "PUT"), "versioned update route")
        check(Policy.allows("/games/\(id)?version=2", method: "DELETE"), "versioned delete route")
        check(!Policy.allows("/games/\(id)", method: "DELETE"), "delete needs version")
        check(!Policy.allows("/games", method: "PATCH"), "unsupported method")
        check(!Policy.trustedFrame(scheme: "https", host: "app", main: true), "external origin")
        check(!Policy.trustedFrame(scheme: "playtrace", host: "evil", main: true), "external host")
        check(!Policy.trustedFrame(scheme: "playtrace", host: "app", main: false), "iframe")
        check(Policy.trustedFrame(scheme: "playtrace", host: "app", main: true), "bundled main frame")
        check(!Policy.allows("/access/verify", method: "POST"), "old invite route removed")
        check(Policy.allowsWeb("/access/google/login", method: "POST"), "native login action")
        check(!Policy.allows("/access/google/login", method: "POST"), "login action is not an HTTP endpoint")
        for path in ["/access/native/start", "/access/native/claim", "/access/native/cancel"] {
            check(Policy.allows(path, method: "POST"), "native-only auth route")
            check(!Policy.allowsWeb(path, method: "POST"), "web content cannot access auth proofs")
        }
        let login = Policy.origin + "/api/access/native/authorize?id=" + id
        check(Policy.loginURL(login, id: id) != nil, "fixed-origin login URL")
        for value in [login.replacingOccurrences(of: "https:", with: "http:"), login.replacingOccurrences(of: "workers.dev", with: "evil.test"), login + "&next=https://evil.test", login + "#fragment", Policy.origin + "/api/jobs?id=" + id] {
            check(Policy.loginURL(value, id: id) == nil, "reject unsafe browser authorization URL")
        }
        let completion = String(repeating: "a", count: 64)
        let callback = "playtrace-auth://login/complete?id=" + id + "&code=" + completion
        check(Policy.authCompletion(URL(string: callback)!, id: id) == completion, "OS callback proof accepted")
        for value in [callback.replacingOccurrences(of: "playtrace-auth:", with: "https:"), callback.replacingOccurrences(of: "login/complete", with: "evil/complete"), callback + "#fragment", callback + "&code=" + completion, callback.replacingOccurrences(of: id, with: "11111111-1111-4111-a111-111111111111"), callback.replacingOccurrences(of: completion, with: "short")] {
            check(Policy.authCompletion(URL(string: value)!, id: id) == nil, "reject callback substitution")
        }
        let original: [String: Any] = ["id": id, "version": 3, "title": "哈迪斯2", "hours": 42.5, "notes": "保留我的笔记", "is_published": false, "images": [["url": "https://example.com/image.png", "alt": "封面"]]]
        let merged = try Draft.merge(["release_year": 2025], into: original, resource: "games", version: 3)
        check(merged["hours"] as? Double == 42.5, "preserve subjective hours")
        check(merged["notes"] as? String == "保留我的笔记", "preserve notes")
        check(merged["is_published"] as? Bool == false, "preserve private status")
        check((merged["images"] as? [[String: Any]])?.count == 1, "preserve images")
        check(merged["release_year"] as? Int == 2025 && merged["version"] as? Int == 3, "explicit patch and version")
        check(merged["id"] == nil, "readonly id excluded")
        for patch: [String: Any] in [["version": 99], ["sources": []], ["release_date": "2025-09-25"], ["shell": "echo test"]] {
            do { _ = try Draft.merge(patch, into: original, resource: "games", version: 3); fatalError("accepted unknown field") }
            catch { checks += 1 }
        }
        do { _ = try Draft.merge(["title": "changed"], into: original, resource: "games", version: 2); fatalError("accepted stale version") }
        catch { checks += 1 }
        do { _ = try Draft.merge(["title": " "], into: nil, resource: "games", version: nil); fatalError("accepted empty title") }
        catch { checks += 1 }
        let theme = try Draft.merge(["title": "我的专题"], into: nil, resource: "themes", version: nil)
        check(theme["title"] as? String == "我的专题", "theme creation")
        print("Passed \(checks) native policy and partial update checks")
    }
}
