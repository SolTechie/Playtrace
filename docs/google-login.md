# Google 登录：Cloudflare 直接验证

Google 负责验证用户身份，Cloudflare Worker 负责验证 Google 的登录结果、管理账号授权和签发 Playtrace 会话。Supabase 只保存业务数据、图片和 Playtrace 自己的会话表，不再使用 Supabase Auth。

## Google Cloud 与服务端配置

在 Google Auth Platform 创建网页 OAuth 客户端，申请 `openid email profile`。正式环境的 **Authorized redirect URIs** 必须精确包含：

```text
https://playtrace.liyuqiaolucky.workers.dev/api/access/google/callback
```

本地开发需要另外注册 `http://127.0.0.1:5173/api/access/google/callback`。不使用通配符、不把 state 放入已注册地址。实际授权请求会单独携带随机 state。

在 Cloudflare 的 Worker 加密配置中保存：

- `GOOGLE_CLIENT_ID`：网页 OAuth Client ID。
- `GOOGLE_CLIENT_SECRET`：该客户端的 Secret。
- `GOOGLE_REDIRECT_URI`：上述正式回调完整地址。
- `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`：仅用于数据库与 Storage。

本地 Worker 在被 Git 忽略的 `.dev.vars` 中配置同名变量，维护脚本使用 `.env.local`。生产上传使用独立、被忽略的 `.env.production`，回调必须是正式地址。任何 Secret 都不能进入 `VITE_*`、前端、安装包或 Git。

## 管理账号

确认邮箱后运行 `npm run auth:setup -- --email owner@example.com` 预览；加 `--apply` 关联原档案管理员。脚本只操作 `google_accounts`，不创建 Supabase Auth 用户。不会重启已撤销账号或重置已经绑定的 Google subject。

朋友无需登录即可浏览公开游戏。只有后端名单中的账号能管理；首次成功登录绑定 Google 不可变 subject，之后相同邮箱、不同 subject 也会被拒绝。

## 从 Supabase Auth 切换

1. 在 Google Cloud 添加新的 Worker 回调，暂时保留旧回调。
2. 配置 Worker 的三个 `GOOGLE_*` 变量，保留已有数据库配置。
3. 应用 `20260919191601_direct_google_oauth.sql`。此兼容迁移添加 nonce、固定回调及双参数身份绑定函数，旧 Worker 仍可完成登录。
4. 测试、构建并部署直接 Google Worker；验证网页登录，以及 App/CLI 授权。
5. 应用 `20260919191603_retire_supabase_auth_binding.sql`：删除旧绑定函数、`auth_user_id` 外键列和旧流程临时记录。管理账号 ID、Google subject、档案及现有 Playtrace 会话保留。
6. 在 Supabase 停用 Google、邮箱登录和注册，清除 Google Client ID/Secret、Playtrace 登录返回白名单与 Site URL。通过 Management API 清除凭据时将 `external_google_client_id` 和 `external_google_secret` 设为 `null`；空字符串不会删除配置项。Supabase 不允许空 Site URL 时改为不提供登录功能的保留域名 `https://unused.invalid`。不删除 Supabase 托管的 auth schema，也不级联删除用户或游戏数据。
7. 在 Google Cloud 移除旧 `https://vxlykqbucdefivchzuan.supabase.co/auth/v1/callback` 地址。

已经部署过历史迁移的项目不能修改历史 SQL 来代替新迁移。分阶段发布时，每个实际应用的文件都应记录到 `playtrace_migrations`；新建环境可以按顺序应用全部文件。

## 登录过程

```text
浏览器 → Worker：发起登录
Worker → 数据库：保存 state 摘要、PKCE verifier、nonce、回调（5 分钟）
浏览器 → Google：登录并授权
Google → 浏览器 → Worker：一次性 code + state
Worker → Google：使用 client secret、code 和 verifier 换 ID token
Worker：用 Google 公钥验证签名、issuer、audience、有效期及 nonce
Worker → 数据库：核对授权邮箱和 subject，保存随机会话摘要
Worker → 浏览器：HttpOnly 管理 Cookie
```

状态同时绑定 HttpOnly Cookie，并在数据库原子消费一次，防止登录 CSRF 和重放。Google 公钥由 `jose` 缓存、更新并验证签名；令牌中的 URL 不能改变公钥来源。向 Google 交换令牌的请求不跟随重定向。Google access/refresh/ID token 只短暂存在于当前服务端请求中，不保存到数据库或返回浏览器。

管理 Cookie 使用 Secure、HttpOnly、SameSite=Strict，最长 7 天。OAuth 临时 Cookie 使用 Lax 以接受 Google 返回。登录成功后通过同源「继续使用玩迹」链接进入应用。每次管理请求检查会话有效期和账号撤销状态，退出会删除会话。

Mac 和 CLI 继续使用既有授权接口：原生端生成秘密、只提交摘要，打开系统浏览器让用户核对校验码并主动授权。只有持有原始秘密的客户端才能一次性领取会话，保存到钥匙串。0.3.0 客户端无需重装；不运行常驻服务，也不接收网页 AI 任务。

撤销管理权限：

```sql
update public.google_accounts set revoked_at=now() where email='owner@example.com';
```

参考：[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)、[jose 验证库](https://github.com/panva/jose)。
