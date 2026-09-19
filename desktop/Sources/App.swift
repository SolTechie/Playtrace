import AppKit
import WebKit
import UniformTypeIdentifiers

final class BundleAssets: NSObject, WKURLSchemeHandler {
    let root: URL
    init(root: URL) { self.root = root.resolvingSymlinksInPath() }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.scheme == "playtrace", url.host == "app" else {
            task.didFailWithError(PlaytraceError("无效资源地址。")); return
        }
        let path = url.path == "/" ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(path).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            task.didFailWithError(PlaytraceError("找不到应用资源。")); return
        }
        let types = ["html": "text/html", "js": "application/javascript", "css": "text/css", "svg": "image/svg+xml", "png": "image/png", "json": "application/json", "woff2": "font/woff2"]
        task.didReceive(URLResponse(url: url, mimeType: types[file.pathExtension] ?? "application/octet-stream", expectedContentLength: data.count, textEncodingName: "utf-8"))
        task.didReceive(data)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class NativeAPI: NSObject, WKScriptMessageHandlerWithReply {
    let client = APIClient(account: "desktop")
    private var signingIn = false
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard Policy.trustedFrame(scheme: origin.protocol, host: origin.host, main: message.frameInfo.isMainFrame),
              message.frameInfo.request.url?.scheme == "playtrace", message.frameInfo.request.url?.host == "app",
              let payload = message.body as? [String: Any],
              let path = payload["path"] as? String, let method = payload["method"] as? String,
              Policy.allowsWeb(path, method: method) else { replyHandler(nil, "不允许的请求来源或操作。"); return }
        let encoded = payload["body"] as? String ?? ""
        guard encoded.count <= 16 * 1024 * 1024, let body = Data(base64Encoded: encoded) else {
            replyHandler(nil, "请求内容无效或过大。"); return
        }
        let type = payload["contentType"] as? String ?? "application/json"
        guard type.count < 200, !type.contains("\r"), !type.contains("\n"),
              type == "application/json" || (path == "/upload" && type.hasPrefix("multipart/form-data; boundary=")) else {
            replyHandler(nil, "请求类型无效。"); return
        }
        Task { @MainActor in
            do {
                if path == "/access/google/login" {
                    guard !signingIn else { throw PlaytraceError("已有登录正在进行，请在浏览器完成。") }
                    signingIn = true
                    defer { signingIn = false }
                    try await client.loginWithGoogle(client: "desktop") { code in
                        let alert = NSAlert()
                        alert.messageText = "使用 Google 账号登录玩迹"
                        alert.informativeText = "本次校验码：\(code)\n请确认浏览器显示相同的校验码，再授权此 Mac App。"
                        alert.addButton(withTitle: "打开浏览器登录")
                        alert.addButton(withTitle: "取消")
                        return alert.runModal() == .alertFirstButtonReturn
                    }
                    let response = try await client.request("/me")
                    replyHandler(["status": response.status, "body": response.data.base64EncodedString()], nil)
                    return
                }
                let response = try await client.request(path, method: method, body: body.isEmpty ? nil : body, contentType: type)
                // Credentials and response headers never enter the web content process.
                replyHandler(["status": response.status, "body": response.data.base64EncodedString()], nil)
            } catch { replyHandler(nil, error.localizedDescription) }
        }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let nativeAPI = NativeAPI()
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        configureMenu()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.setURLSchemeHandler(BundleAssets(root: Bundle.main.resourceURL!.appendingPathComponent("Web")), forURLScheme: "playtrace")
        configuration.userContentController.addScriptMessageHandler(nativeAPI, contentWorld: .page, name: "playtrace")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = true
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1260, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "玩迹 Playtrace"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(calibratedRed: 16/255, green: 18/255, blue: 20/255, alpha: 1)
        window.minSize = NSSize(width: 900, height: 640)
        window.contentView = webView
        window.setFrameAutosaveName("Playtrace.MainWindow")
        window.center()
        window.makeKeyAndOrderFront(nil)
        webView.load(URLRequest(url: URL(string: "playtrace://app/index.html")!))
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func configureMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let app = NSMenu(title: "Playtrace")
        appItem.submenu = app
        app.addItem(withTitle: "关于玩迹", action: #selector(about), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "隐藏玩迹", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "退出玩迹", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "编辑"); editItem.submenu = edit
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "浏览"); viewItem.submenu = view
        for (title, action, key) in [("游戏库", #selector(library), "1"), ("游戏足迹", #selector(insights), "2"),
                                     ("主题收藏", #selector(themes), "3"), ("桌面 AI 与 CLI", #selector(guide), "4"),
                                     ("添加游戏", #selector(newGame), "n"), ("刷新档案", #selector(refresh), "r")] {
            let item = view.addItem(withTitle: title, action: action, keyEquivalent: key); item.target = self
        }
        let helpItem = NSMenuItem(); main.addItem(helpItem)
        let helpMenu = NSMenu(title: "帮助"); helpItem.submenu = helpMenu
        helpMenu.addItem(withTitle: "打开 CLI 使用指南", action: #selector(cliHelp), keyEquivalent: "").target = self
        NSApp.mainMenu = main
    }
    func navigate(_ path: String) {
        // Only static application-owned routes are passed here, never record text.
        webView.evaluateJavaScript("location.hash = \(String(data: try! JSONSerialization.data(withJSONObject: path, options: .fragmentsAllowed), encoding: .utf8)!)")
    }
    @objc func library() { navigate("/") }
    @objc func insights() { navigate("/insights") }
    @objc func themes() { navigate("/themes") }
    @objc func guide() { navigate("/studio") }
    @objc func newGame() { navigate("/games/new") }
    @objc func refresh() { webView.reload() }
    @objc func about() {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "玩迹 Playtrace", .applicationVersion: "0.3.0",
                                                    .credits: NSAttributedString(string: "记录每一次游玩。\nMac、手机与本地 CLI，共用你的云端游戏档案。")])
    }
    @objc func cliHelp() {
        if let url = Bundle.main.url(forResource: "CLI-Guide", withExtension: "html") { NSWorkspace.shared.open(url) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "playtrace", url.host == "app", action.targetFrame?.isMainFrame == true {
            decisionHandler(.allow); return
        }
        if action.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard Policy.trustedFrame(scheme: frame.securityOrigin.protocol, host: frame.securityOrigin.host, main: frame.isMainFrame) else {
            completionHandler(nil); return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.jpeg, .png, .webP]
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

@main struct PlaytraceApp {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}
