# 部署与管理

## Supabase

1. 创建项目，保存项目 URL 与服务端 secret key。数据库密码只用于迁移，不放入网页或 Worker。
2. 从 Supabase 数据库设置下载根证书，配置被 Git 忽略的 `.env.database`：`SUPABASE_DB_HOST`、`SUPABASE_DB_USER`、`SUPABASE_DB_PASSWORD`、`SUPABASE_DB_CA`（证书路径）。运行 `npm run db:migrate` 按文件顺序应用全部迁移并记录版本。也可通过 Supabase CLI 应用所有迁移。旧版只执行过初始迁移的项目会被识别，后续迁移不会重复导入游戏。
3. 将 `.dev.vars.example` 复制为 `.dev.vars`，`.env.local.example` 复制为 `.env.local`，各填入 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`。前者用于本地 Worker，后者用于本地维护脚本。
4. 执行 `npm run invite:create` 生成一个随机 12 位数字管理邀请码（可能以 0 开头）。数据库仅保存 PBKDF2-SHA256 哈希（100,000 次迭代）和随机 16 字节盐。明文保存在权限 0600、Git 忽略的 `.env.invite`，脚本不会打印或覆盖已有邀请码。无需建立 Supabase Auth 账号，也无需额外的 Worker 签名密钥。
5. 如需导入本地资料，运行：

```sh
npm run data:prepare
npm run data:import
```

导入使用稳定 ID，已存在的游戏会跳过，保留网站上的编辑。上传支持重试，失败后可以重新执行。原始文件不会被改写。

## 邀请码管理

网页点击「管理档案」，输入 `.env.invite` 中的 `PLAYTRACE_INVITE_CODE` 即可编辑游戏、上传图片与使用 AI 工作台。普通访客只浏览公开内容。邀请码是管理凭据，只提供给允许修改整个档案库的人。

验证完全在 Worker 与数据库之间完成，客户端不保存或比对邀请码。每个 IP 在 15 分钟内最多尝试 10 次，格式错误也计数。验证后设置随机 256 位管理会话，数据库仅保存会话 SHA-256 摘要；Cookie 为 HttpOnly、Secure、SameSite=Strict，最长有效 7 天。写入操作还校验请求 Origin。

在 Supabase SQL Editor 中按 `.env.invite` 的 `PLAYTRACE_INVITE_ID` 停用邀请码：

```sql
update public.management_invites
set revoked_at = now()
where id = '<PLAYTRACE_INVITE_ID>';
```

停用后，该邀请码建立的全部网页会话立即无法通过后端校验；也可以用 `expires_at` 设置到期时间。已经签发的图片链接在短期到期前仍有效。已配对电脑使用独立设备令牌，如需停用也应在 AI 工作台撤销该设备。

如需换码，先停用旧码，将 `.env.invite` 移到私密备份，再执行 `npm run invite:create`。目前适用于个人档案，最多同时启用 10 个邀请码；后端超过该数会拒绝验证，应先停用多余邀请码。现有账号权限已移除，原游戏、主题和任务归属由迁移保留。

## Cloudflare Workers

Cloudflare 的代码运行与静态资源托管均由一个名为 `playtrace` 的 Worker 处理，源代码保存在 GitHub。

```sh
npx wrangler login
npm test
npm run build
npx wrangler secret bulk .dev.vars --name playtrace
npx wrangler deploy
```

`secret bulk` 把本地配置保存为 Worker 的加密服务端配置。只应对自己授权的 Cloudflare 账户运行。不要在 `wrangler.jsonc`、`VITE_*` 变量或 GitHub 源码中填写服务端密钥。

部署后检查 `/api/health`、游戏列表和图片。正式网址使用 Wrangler 返回的 HTTPS URL，随后可在 Cloudflare 中绑定自己的域名。

GitHub Actions 会在提交和 PR 时执行测试与构建；当前不自动发布。可以在 Cloudflare Workers Builds 连接 GitHub 仓库，构建命令设为 `npm run build`，部署命令 `npx wrangler deploy`。生产密钥继续保存在 Worker 配置，不作为构建变量传入前端。

## 运维约定

- 本机离线时，普通浏览和手动编辑仍可用；AI 请求排队等待。
- 设备令牌丢失时，在 AI 工作台撤销设备，再建立新的连接。
- 游戏与主题有版本检查，防止多个页面同时编辑时静默覆盖。
- AI 草稿保存是数据库事务，重复点击不会重复添加。
- 私密记录和 AI 队列仅管理员可读。公开图片链接使用短期签名。
- 当前一次载入上限 1,000 条游戏，适合个人档案；社区规模应改为服务端分页与聚合。
- 定期备份 Supabase 数据库与 Storage；源码仓库不包含个人游戏数据。

## 验证范围

自动检查覆盖邀请码慢哈希、限流、会话退出/过期/撤销、跨站防护、输入、统计、PostgreSQL 权限、AI 任务租约与幂等保存、公开 API 配置和图片引用。真实 Codex 搜索可通过 smoke 脚本验证。可选 WebMCP 搜索接口已加入，实际注册和调用仍需在支持该协议的浏览器中验证；它不影响普通页面和 AI 工作台使用。
