import AppKit
import WebKit
import UniformTypeIdentifiers
import AuthenticationServices

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

@MainActor final class AppAuthentication: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var continuation: CheckedContinuation<URL, Error>?
    private var timeout: Task<Void, Never>?
    private var anchor: NSWindow?
    private var activeID: UUID?

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor!
    }
    func authenticate(_ url: URL) async throws -> URL {
        guard session == nil, let window = NSApp.keyWindow ?? NSApp.mainWindow else {
            throw PlaytraceError("请在玩迹窗口中发起登录。")
        }
        anchor = window
        let requestID = UUID()
        activeID = requestID
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let auth = ASWebAuthenticationSession(url: url, callbackURLScheme: Policy.authCallbackScheme) { [weak self] callback, error in
                Task { @MainActor in
                    guard let self, self.activeID == requestID else { return }
                    if let callback { self.finish(.success(callback)) }
                    else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                        self.finish(.failure(PlaytraceError("已取消登录。")))
                    } else { self.finish(.failure(PlaytraceError("暂时无法完成系统登录，请重试。"))) }
                }
            }
            auth.presentationContextProvider = self
            // Use the OS-owned private authorization window, not a normal browser tab.
            auth.prefersEphemeralWebBrowserSession = true
            session = auth
            guard auth.start() else {
                finish(.failure(PlaytraceError("无法打开系统登录窗口，请重试。")))
                return
            }
            timeout = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 300_000_000_000) } catch { return }
                guard self?.activeID == requestID else { return }
                self?.finish(.failure(PlaytraceError("登录已超时，请重新发起登录。")))
            }
        }
    }
    private func finish(_ result: Result<URL, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        activeID = nil
        timeout?.cancel(); timeout = nil
        let previous = session
        session = nil
        previous?.cancel()
        anchor = nil
        continuation.resume(with: result)
        NSApp.activate(ignoringOtherApps: true)
    }
}

final class NativeAPI: NSObject, WKScriptMessageHandlerWithReply {
    let client = APIClient(account: "desktop")
    private var signingIn = false
    @MainActor private lazy var authentication = AppAuthentication()
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
                    guard !signingIn else { throw PlaytraceError("已有登录正在进行，请在授权窗口完成。") }
                    signingIn = true
                    defer { signingIn = false }
                    try await client.loginWithAppSession { url in
                        try await self.authentication.authenticate(url)
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
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "玩迹 Playtrace", .applicationVersion: "0.4.0",
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
