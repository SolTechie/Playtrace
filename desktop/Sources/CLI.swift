import Foundation
import Darwin

let help = """
玩迹 Playtrace CLI 0.3.0 — 在本机主动调用的云端档案工具

playtrace auth login                 在系统浏览器使用 Google 账号登录，会话保存在 macOS 钥匙串
playtrace auth status                查看当前会话
playtrace auth logout                撤销此 CLI 会话
playtrace games list [--search 名称]  JSON 列表（最多 1000 条）
playtrace games get <id>              读取完整记录及 version
playtrace games create --file <json> [--apply]
playtrace games update <id> --file <json> --version <n> [--apply]
playtrace games delete <id> --version <n> [--apply]
playtrace themes list|get|create|update|delete  参数与 games 相同
playtrace images upload --file <jpg/png/webp> [--apply]
playtrace stats                      累计游戏数量、时长与状态分布
playtrace schema [games|themes]       输出可写字段与示例

写入命令默认只预览；--apply 才保存。--dry-run 可显式要求预览。
update 接受局部 JSON，保留其他字段；数组/filters 字段整体替换。
发行时间只写 release_year。图片先 upload，再把 URL 写入 images。
输出 JSON 到 stdout，错误到 stderr。没有后台服务，不读取网页 AI 任务。
服务固定为 https://playtrace.liyuqiaolucky.workers.dev
"""

struct Arguments {
    var positional: [String] = []
    var options: [String: String] = [:]
    var apply = false
    var dryRun = false
    init(_ values: [String]) throws {
        var i = 0
        while i < values.count {
            let value = values[i]
            if value == "--apply" { apply = true }
            else if value == "--dry-run" { dryRun = true }
            else if ["--file", "--search", "--version"].contains(value) {
                guard i + 1 < values.count, options[value] == nil else { throw PlaytraceError("缺少或重复参数 \(value)") }
                i += 1; options[value] = values[i]
            } else if value.hasPrefix("--") { throw PlaytraceError("未知选项 \(value)") }
            else { positional.append(value) }
            i += 1
        }
        if apply && dryRun { throw PlaytraceError("--apply 与 --dry-run 不能同时使用。") }
    }
    func require(_ name: String) throws -> String {
        guard let value = options[name] else { throw PlaytraceError("需要 \(name)") }
        return value
    }
    func validate(count: Int, options allowed: Set<String> = [], mutation: Bool = false) throws {
        guard positional.count == count, Set(options.keys).isSubset(of: allowed), mutation || (!apply && !dryRun) else {
            throw PlaytraceError("参数不适用；运行 playtrace help 查看用法。")
        }
    }
    func version() throws -> Int {
        guard let value = Int(try require("--version")), value > 0 else { throw PlaytraceError("version 必须为正整数。") }
        return value
    }
}
func output(_ value: Any) throws {
    let bytes = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    FileHandle.standardOutput.write(bytes + Data("\n".utf8))
}
func resourceID(_ args: Arguments) throws -> String {
    guard args.positional.count == 3, Policy.isUUID(args.positional[2]) else { throw PlaytraceError("需要有效的游戏或主题 UUID。") }
    return args.positional[2]
}

@main struct CLI {
    static func main() async {
        do { try await run() }
        catch {
            // Never log request headers, session tokens, or OAuth credentials.
            let data = try? JSONSerialization.data(withJSONObject: ["error": error.localizedDescription])
            FileHandle.standardError.write((data ?? Data("操作失败".utf8)) + Data("\n".utf8))
            exit(1)
        }
    }
    static func run() async throws {
        let raw = Array(CommandLine.arguments.dropFirst())
        if raw.isEmpty || raw == ["help"] || raw == ["--help"] { print(help); return }
        if raw == ["--version"] { print("playtrace 0.3.0"); return }
        let args = try Arguments(raw)
        let client = APIClient(account: "cli")
        let command = args.positional.first ?? ""
        if command == "auth" {
            try args.validate(count: 2)
            switch args.positional[1] {
            case "login":
                guard isatty(STDIN_FILENO) == 1 else {
                    throw PlaytraceError("请在自己的终端交互执行 auth login，并在浏览器授权 Google 账号。")
                }
                try await client.loginWithGoogle(client: "cli") { code in
                    FileHandle.standardError.write(Data("请在系统浏览器完成 Google 登录。核对本次校验码：\(code)\n等待最多 5 分钟，按 Ctrl+C 取消。\n".utf8))
                    return true
                }
                try output(await client.json("/me"))
            case "status": try output(await client.json("/me"))
            case "logout": try output(await client.json("/access/exit", method: "POST", body: [:]))
            default: throw PlaytraceError("未知 auth 命令。")
            }
            return
        }
        if command == "schema" {
            guard args.positional.count <= 2 else { throw PlaytraceError("schema 只接受 games 或 themes。") }
            try args.validate(count: args.positional.count)
            let resource = args.positional.count == 2 ? args.positional[1] : "games"
            guard ["games", "themes"].contains(resource) else { throw PlaytraceError("请选择 games 或 themes。") }
            if let url = Bundle.main.url(forResource: "schema", withExtension: "json"),
               let schemas = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
               let schema = schemas[resource] { try output(schema) }
            else {
                // Standalone binary: build embeds the exact same server-derived schema.
                guard let schemas = try JSONSerialization.jsonObject(with: Data(embeddedSchema.utf8)) as? [String: Any],
                      let schema = schemas[resource] else { throw PlaytraceError("无法读取 schema。") }
                try output(schema)
            }
            return
        }
        if command == "stats" {
            try args.validate(count: 1)
            let games = try await client.json("/games") as? [[String: Any]] ?? []
            var statuses: [String: Int] = [:]
            var hours = 0.0; var recorded = 0
            for game in games {
                statuses[game["status"] as? String ?? "未知", default: 0] += 1
                if let value = game["hours"] as? Double { hours += value; recorded += 1 }
            }
            try output(["games": games.count, "hours": hours, "games_with_hours": recorded, "statuses": statuses,
                        "limit": 1000, "may_be_truncated": games.count == 1000])
            return
        }
        if command == "images" {
            try args.validate(count: 2, options: ["--file"], mutation: true)
            guard args.positional[1] == "upload" else { throw PlaytraceError("未知 images 命令。") }
            let path = NSString(string: try args.require("--file")).expandingTildeInPath
            let url = URL(fileURLWithPath: path)
            guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= 10 * 1024 * 1024 else {
                throw PlaytraceError("图片不能超过 10 MB。")
            }
            let bytes = try Data(contentsOf: url)
            let mime: String
            if bytes.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) { mime = "image/png" }
            else if bytes.starts(with: [0xff, 0xd8, 0xff]) { mime = "image/jpeg" }
            else if bytes.count >= 12, String(data: bytes.prefix(4), encoding: .ascii) == "RIFF",
                    String(data: bytes[8..<12], encoding: .ascii) == "WEBP" { mime = "image/webp" }
            else { throw PlaytraceError("文件必须为 JPG、PNG 或 WebP 图片。") }
            if !args.apply { try output(["dry_run": true, "operation": "upload", "file": path, "bytes": bytes.count, "type": mime]); return }
            let boundary = "Playtrace-\(UUID().uuidString)"
            var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image\"\r\nContent-Type: \(mime)\r\n\r\n".utf8)
            body.append(bytes); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
            try output(await client.request("/upload", method: "POST", body: body, contentType: "multipart/form-data; boundary=\(boundary)").checked())
            return
        }
        guard ["games", "themes"].contains(command), args.positional.count >= 2 else { throw PlaytraceError("未知命令；运行 playtrace help。") }
        let action = args.positional[1]
        let base = "/" + command
        switch action {
        case "list":
            try args.validate(count: 2, options: ["--search"])
            var records = try await client.json(base) as? [[String: Any]] ?? []
            if let search = args.options["--search"] {
                records = records.filter { row in
                    ["title", "english_title", "japanese_title"].contains { key in
                        (row[key] as? String ?? "").localizedCaseInsensitiveContains(search)
                    }
                }
            }
            try output(records)
        case "get":
            try args.validate(count: 3)
            try output(await client.json(base + "/" + resourceID(args)))
        case "create", "update":
            try args.validate(count: action == "create" ? 2 : 3,
                              options: action == "create" ? ["--file"] : ["--file", "--version"], mutation: true)
            let patch = try Draft.file(args.require("--file"))
            let path = action == "create" ? base : try base + "/" + resourceID(args)
            let original = action == "create" ? nil : try await client.json(path) as? [String: Any]
            let version = action == "create" ? nil : try args.version()
            let body = try Draft.merge(patch, into: original, resource: command, version: version)
            if args.apply { try output(await client.json(path, method: action == "create" ? "POST" : "PUT", body: body)) }
            else { try output(["dry_run": true, "operation": action, "resource": command, "before": original as Any? ?? NSNull(), "after": body,
                               "validation": "版本、字段名和标题已检查；--apply 时服务器校验完整字段类型与范围。"] as [String: Any]) }
        case "delete":
            try args.validate(count: 3, options: ["--version"], mutation: true)
            let path = try base + "/" + resourceID(args)
            let version = try args.version()
            guard let original = try await client.json(path) as? [String: Any], original["version"] as? Int == version else {
                throw PlaytraceError("版本不匹配；重新读取记录后再操作。")
            }
            if args.apply { try output(await client.json(path + "?version=\(version)", method: "DELETE")) }
            else { try output(["dry_run": true, "operation": "delete", "before": original]) }
        default: throw PlaytraceError("未知 \(command) 命令。")
        }
    }
}
