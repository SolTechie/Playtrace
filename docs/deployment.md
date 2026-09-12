# 部署与管理

## Supabase

1. 创建项目，保存项目 URL、publishable key 与服务端 secret key。数据库密码只用于建表，不放入网页或 Worker。
2. 在 SQL Editor 运行 `supabase/migrations/202609110001_initial.sql`，或使用 Supabase CLI 应用迁移。初始迁移只能运行一次，后续变化应新增迁移。
3. 将 `.dev.vars.example` 复制为 `.dev.vars`，填入 URL 和两种 API key，用于本地 Worker。
4. 在 Supabase Authentication 中建立自己的用户，记录 UUID；将该 UUID 插入 `public.admin_users(user_id)`，即可使用邮箱和密码管理网站。普通认证用户不会自动成为管理员。
5. 如需导入本地资料，将 `.env.local.example` 复制为 `.env.local`，填入服务端配置，并运行：

```sh
npm run data:prepare
npm run data:import
```

导入使用稳定 ID，已存在的游戏会跳过，保留网站上的编辑。上传支持重试，失败后可以重新执行。原始文件不会被改写。

`scripts/database.mjs` 是可选的一次性初始化工具：从 Supabase 数据库设置下载根证书，配置 `.env.database` 中的 `SUPABASE_DB_HOST`、`SUPABASE_DB_USER`、`SUPABASE_DB_PASSWORD`，以及 `SUPABASE_DB_CA` 证书路径，再执行 `node --env-file=.env.database scripts/database.mjs --apply`。它验证 TLS 证书并在发现已有 games 表时拒绝重新初始化。

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
