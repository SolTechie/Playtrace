# 玩迹 · Playtrace

[打开玩迹](https://playtrace.liyuqiaolucky.workers.dev)

记录玩过的游戏，收藏走过的世界。支持 Mac 桌面应用、手机网页与本地 CLI，管理游戏和查看统计。AI 资料整理由用户在自己的电脑上主动发起。

## 已实现

- 游戏库：搜索、平台 / 年份 / 类型 / 开发商筛选、卡片与列表、排序。
- 游戏详情：游玩状态、累计时长、年份、个人评分、笔记、图片、分平台 MC 评分；发行时间只记录年份。
- 管理功能：使用已授权的 Google 账号登录后新增、编辑、软删除、图片上传、公开 / 私密记录。
- 游戏足迹：年份、平台、类型等统计；未记录时长与零小时分开处理，跨年累计时长不冒充年度时长。
- 主题收藏：动态筛选、画廊 / 年份时间线、统计图。
- 桌面 AI 指南：复制资料整理说明，在自己的电脑上主动使用 AI，检查资料后通过本地 CLI 或游戏表单保存。网页远程 AI 任务与设备配对已停用。

## 架构

Swift + AppKit + WKWebView 提供可安装的 Mac 桌面应用，React + Vite 共用界面并分别构建桌面与手机布局。原生 Swift CLI 可独立运行。Cloudflare Worker 提供 API，Supabase 提供 PostgreSQL 与 Storage。网页不派发 AI 任务，本机不运行任务轮询服务。

```text
Mac / 手机 / 本地 CLI → Cloudflare Worker → Supabase

用户在电脑主动使用 Codex → CLI 预览 → 授权范围内保存
```

当前是单个档案库、管理员维护、朋友浏览的第一版。未提供社区注册、关注、评论或每人独立游戏库。未来社区版本应拆分公共游戏资料与用户游玩记录，并增加用户级权限。

## Mac 与 CLI

详见 [安装与 Codex 使用指南](docs/desktop-ai.md)。在 Apple Silicon Mac 上运行 `npm run desktop:build` 生成 `.app`、独立 CLI 和 `.dmg`。支持 macOS 13+；当前包为本机开发签名，公众分发前需完成 Apple Developer ID 签名与公证。

## 本地运行

使用 Node.js 22.21 或更新的 Node 22 LTS 版本。

```sh
npm ci
cp .dev.vars.example .dev.vars
# 在 .dev.vars 填入 Supabase 数据库与 Google OAuth 服务端配置
npm run dev
```

没有 Supabase 配置时，可把原始资料放在 `resource/<游戏名>/data.md` 和同目录图片中，然后运行 `npm run data:prepare`。生成数据只供本地预览和导入，生产构建不包含原始档案。

```sh
npm test
npm run build
```

运行、部署和管理员开通步骤见 [部署说明](docs/deployment.md)，桌面 AI 使用方式见 [操作指南](docs/desktop-ai.md)。

## 目录

| 路径                   | 用途                               |
| ---------------------- | ---------------------------------- |
| `desktop/`             | Mac 窗口、CLI、钥匙串与原生测试    |
| `src/`                 | 页面、组件与样式                   |
| `worker/`              | API、认证、图片签名与旧通道停用    |
| `shared/`              | 输入校验、筛选统计、主题配置       |
| `supabase/migrations/` | 数据表、RLS 与历史迁移             |
| `bridge/`              | 本机资料辅助代码；旧连接入口已停用 |
| `scripts/`             | 原始资料解析、导入、数据库初始化   |
| `tests/`               | 数据、权限、接口与停用边界测试     |

## 数据与密钥

`resource/`、生成的游戏 JSON、图片、本地环境文件和 AI 临时文件全部被 Git 忽略。Cloudflare 只收到构建后的程序；游戏记录和上传图片保存在 Supabase。

浏览器跳转到 Google，Google 直接回调 Cloudflare Worker。Worker 校验一次性状态、PKCE、ID token 签名、issuer、audience、nonce、有效期、已验证邮箱和后端账号名单，然后签发自己的管理会话。首次登录绑定不可变 Google subject，不自动授予新用户管理权限。Google OAuth 密钥保存在 Cloudflare 加密配置中；Supabase 仅提供数据库与图片存储，不参与身份验证。

管理会话使用 HttpOnly、Secure、SameSite=Strict Cookie，最长 7 天；数据库仅保存会话摘要。退出、到期或停用账号立即失效。OAuth 临时 Cookie 使用 SameSite=Lax 以支持跨站返回，5 分钟失效；OAuth 状态只可使用一次。每个 IP 的登录发起每 15 分钟最多 10 次。浏览器不能直接读取管理表或写入档案。数字邀请码、旧会话及兑换接口已停用。

配置步骤见 [Google 登录接入](docs/google-login.md)。从 Supabase Auth 切换时先应用兼容迁移，部署 Worker 后再清理旧配置和身份外键。已有 Playtrace 管理会话和 0.3.0 Mac/CLI 可继续使用。

图片通过游戏表单上传。已保存的 AI 图片和游戏记录继续保留。新游戏记录不收录资料来源列表。

图片桶为私有，Worker 先检查游戏读取权限，再签发 15 分钟链接；已发出的链接在到期前仍可使用。编辑时会去除临时签名，保存稳定的图片引用。删除游戏为软删除，不自动删除图片。

远程 AI 接口在验证凭证与访问数据库之前被统一拒绝，旧浏览器或旧设备凭证不能绕过。数据库历史记录和权限未改变，部署回滚也必须保留该停用逻辑。App 和 CLI 在系统浏览器主动发起 Google 授权，各自会话保存在 macOS 钥匙串。一次登录最多等待 5 分钟，仅检查这次授权结果；没有常驻进程或远程 AI 任务。独立且可限定权限的 API 令牌尚未提供。
