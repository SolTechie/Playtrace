# Google 账号登录

当前仍是单个共享档案：只有预先授权的 Google 账号能管理，访客继续浏览公开游戏。此更新替换数字邀请码，不创建社区或每人独立游戏库。

## 需要项目所有者准备

- 管理现有档案的 Google 邮箱，不从当前浏览器账号或 Git 配置推断。
- 在 Google Cloud 的 Google Auth Platform 建立 Playtrace 项目、External 受众和网页 OAuth 客户端。只申请 openid、email、profile。
- Google 的 Authorized redirect URIs 填写 `https://vxlykqbucdefivchzuan.supabase.co/auth/v1/callback`。
- 将 Client ID 和 Client Secret 直接填入 Supabase → Authentication → Sign In / Providers → Google，启用并保存。Secret 不放在前端、安装包、Git 或聊天里。
- 正式公开时完成适用的品牌/域名验证，提供产品首页、隐私政策、服务条款和支持邮箱。开发与生产使用独立 OAuth 项目。

## Supabase 返回地址

Authentication → URL Configuration：

- Site URL：`https://playtrace.liyuqiaolucky.workers.dev`
- Redirect URLs：`https://playtrace.liyuqiaolucky.workers.dev/api/access/google/callback**`
- 本地联调另外加入 `http://127.0.0.1:5173/api/access/google/callback**`。只用于开发的项目也可加入实际使用的 localhost 地址。

这里的窄范围 `**` 用于匹配回调的随机 state 查询参数。不要放开整个域名、任意端口或任意站点。Google 控制台的回调是 Supabase 的 `/auth/v1/callback`，而 Supabase 返回地址是 Playtrace Worker，两者不同。

## 发布顺序

1. 在 Google 和 Supabase 完成提供商配置及返回地址白名单。
2. `npm run auth:setup` 只读取提供商状态；`npm run auth:setup -- --email owner@example.com` 预览将关联的邮箱与现有管理员 ID。邮箱必须由档案所有者明确提供。
3. 测试和构建通过后，在维护窗口执行 `npm run db:migrate`。新迁移保留全部档案及管理员 ID，同时永久撤销旧邀请码和旧会话。此步会使旧管理登录停止工作。
4. `npm run auth:setup -- --email owner@example.com --apply` 把指定邮箱关联到原档案管理员。脚本拒绝在 Google 未启用时写入；不自动重启被撤销账号，不自动更换既有 subject。
5. `npm run deploy` 更新 Worker 和网页，安装 `0.3.0` Mac App / CLI，分别重新登录。
6. 实际验证 Google 登录、非管理账号拒绝、私密记录读取、编辑及退出；切换设备验证不会共享浏览器会话。新会话最长 7 天。

不要在缺少 OAuth 凭据或所有者邮箱时先迁移生产数据库，以免管理入口暂时不可用。也不要回滚到会重新开放旧远程 AI 通道的版本。

## 实现与边界

浏览器 POST 同源登录接口；Worker 生成 PKCE verifier 和随机 state，临时数据存储在仅 service_role 可读写的表中。Google 通过 Supabase 回调返回一次性授权码，Worker 校验 HttpOnly 状态 Cookie 并原子消费状态，再调用 Supabase 交换、验证身份。身份必须来自 Google 已验证邮箱的 identity，不能依赖可编辑的 user_metadata。

后端只匹配 `google_accounts` 名单；首次关联后还要匹配不可变 Google subject 和 Supabase 用户 ID。随机管理会话使用 `pg_` 前缀，数据库仅存摘要。旧 `ps_` 会话不会被识别。普通 Supabase Auth 用户无管理权限，不能直写档案。

Mac 与 CLI：原生层生成随机秘密，只把哈希提交给服务端，打开固定 Playtrace HTTPS 授权页。用户比较校验码后再选择 Google 账号。浏览器完成授权后，只有持有原始秘密的客户端才能一次性领取管理会话并保存到钥匙串。每次主动登录最多等待 5 分钟，每 2 秒检查一次该登录请求，无常驻连接、远程任务或命令执行能力。Google OAuth 和 Google 令牌不进入 WKWebView；浏览器端也不保留 Google refresh token。

OAuth 临时 Cookie 使用 SameSite=Lax，允许 Google 返回；管理 Cookie 使用 Strict。登录成功后通过同源「继续使用玩迹」页面进入应用，避免浏览器在跨站重定向链中省略 Strict Cookie。没有自动把任意新 Google 用户提升为管理员。

停用账号会撤销该账号的全部管理会话（每次 API 请求重新检查）：

```sql
update public.google_accounts set revoked_at=now() where email='owner@example.com';
```

需要更换 Google 账号时新增授权并验证后再撤销旧账号，不能清空 subject 来隐式转移身份。

参考：[Supabase Google 登录](https://supabase.com/docs/guides/auth/social-login/auth-google)、[PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow)。
