# 玩迹 · Playtrace

[打开玩迹](https://playtrace.liyuqiaolucky.workers.dev)

记录玩过的游戏，收藏走过的世界。支持手机和电脑浏览，用一句话让本机 Codex 查找游戏资料，补上自己的游玩记录后保存。

## 已实现

- 游戏库：搜索、平台 / 年份 / 类型 / 开发商筛选、卡片与列表、排序。
- 游戏详情：游玩状态、累计时长、年份、个人评分、笔记、图片、分平台 MC 评分。
- 管理功能：输入数字邀请码后新增、编辑、软删除、图片上传、公开 / 私密记录。
- 游戏足迹：年份、平台、类型等统计；未记录时长与零小时分开处理，跨年累计时长不冒充年度时长。
- 主题收藏：动态筛选、画廊 / 年份时间线、统计图；AI 可以生成主题草稿。
- AI 工作台：网页提交指令、真实进度、自动保存封面与截图、澄清问题、审阅保存、取消、重试、设备连接管理。

## 架构

React + Vite 构建响应式网页。Cloudflare Worker 提供 API，Supabase 提供 PostgreSQL 与 Storage。本机 Node.js 连接服务领取队列任务，使用已登录的 Codex CLI 搜索并生成结构化草稿。

```text
浏览器 → Cloudflare Worker → Supabase
                  ↑              ↓
          本机连接服务 ← 领取 AI 任务
                  ↓
             Codex CLI + 搜索
```

当前是单个档案库、管理员维护、朋友浏览的第一版。未提供社区注册、关注、评论或每人独立游戏库。未来社区版本应拆分公共游戏资料与用户游玩记录，并增加用户级权限。

## 本地运行

使用 Node.js 22.21 或更新的 Node 22 LTS 版本。

```sh
npm ci
cp .dev.vars.example .dev.vars
# 在 .dev.vars 填入 Supabase 配置
npm run dev
```

没有 Supabase 配置时，可把原始资料放在 `resource/<游戏名>/data.md` 和同目录图片中，然后运行 `npm run data:prepare`。生成数据只供本地预览和导入，生产构建不包含原始档案。

```sh
npm test
npm run build
```

运行、部署和管理员开通步骤见 [部署说明](docs/deployment.md)，本机 AI 连接见 [AI 说明](docs/ai-bridge.md)。

## 目录

| 路径                   | 用途                             |
| ---------------------- | -------------------------------- |
| `src/`                 | 页面、组件与样式                 |
| `worker/`              | API、认证、设备验证、图片签名    |
| `shared/`              | 输入校验、筛选统计、主题配置     |
| `supabase/migrations/` | 数据表、RLS、原子领取与保存函数  |
| `bridge/`              | 本机 Codex 连接服务              |
| `scripts/`             | 原始资料解析、导入、数据库初始化 |
| `tests/`               | 数据、权限、任务租约和接口测试   |

## 数据与密钥

`resource/`、生成的游戏 JSON、图片、本地环境文件和 AI 临时文件全部被 Git 忽略。Cloudflare 只收到构建后的程序；游戏记录和上传图片保存在 Supabase。

浏览器只调用同源 Worker API，无需 Supabase key 或邮箱账号。邀请码在后端用 PBKDF2 校验，数据库保存随机盐与哈希，明文不进入前端构建或仓库。管理会话使用 HttpOnly、Secure、SameSite=Strict Cookie，最长 7 天；退出或停用邀请码后服务端权限失效。每个 IP 每 15 分钟最多尝试 10 次。Supabase RLS 禁止浏览器直接读取邀请码、会话与任务或写入档案。服务端密钥仅用于 Worker 与本地维护工具。设备令牌在数据库中只保存 SHA-256 摘要，可以撤销。

AI 会从检索确认的游戏或商店页面提取最多 4 张封面与截图，检查文件格式、尺寸、体积并保存至 Supabase。新游戏记录不收录资料来源列表。

图片桶为私有，Worker 先检查游戏读取权限，再签发 15 分钟链接；已发出的链接在到期前仍可使用。编辑时会去除临时签名，保存稳定的图片引用。删除游戏为软删除，不自动删除图片。
