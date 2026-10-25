# CF Task Hub

基于 Cloudflare Workers 的多用户任务面板，用于管理百度网盘签到与 B 站大会员权益任务。前端 Vue 3，后端 Hono / TypeScript，数据存放于 D1，账号执行由 Durable Object 协调，任务通过 Queues 与 Cron 调度。

**在线服务：** <https://task.awakaze.com/>　**邀请码：** `awa`

> 首次部署者需要用自己的 Cloudflare 资源与密钥完成初始化；在线服务仅提供已部署实例的访问入口。

## 功能

### 平台账号与任务

- **百度网盘**：PC 签到、App 签到、累计签到奖励、只读检查；支持手动填写 Cookie 或扫码登录。
  - 手动导入最小凭据为 `BDUSS` + `STOKEN`，缺少 `STOKEN` 时 PC 签到会返回 HTTP 400；`BAIDUCUID` 可选，缺失时自动生成设备号。
- **B 站**：检查并领取可领取的 5B 币券、余额检查；直播电池兑换默认关闭，需管理员与用户分别开启。
- 计划支持每日、每周、每月及五段 cron，**按北京时间**计算；调度器每 5 分钟扫描到期任务，队列可能带来额外延迟。
- 同一账号的任务串行执行；手动「执行一次」会立即入队，不受定时周期影响。
- 平台级统一配置功能、执行时间与通知渠道，新增账号自动同步对应任务。

### 通知

- 支持 **Telegram Bot**、**Server酱 Turbo**、**通用 Webhook**。
- 规则按 用户默认 → 平台 → 账号 → 任务 四级覆盖，覆盖为整条规则替换；成功通知与异常通知互相独立。
- 通知标题为平台名称（百度网盘签到 / B站大会员签到），正文包含签到结果、成长值变化、累计签到与奖励进度。

### 账号安全与管理

- 认证支持账号密码（PBKDF2 50000 次迭代）与可选 Passkey。
- 平台凭据使用 AES-GCM 加密存储，接口不回显 Cookie、通知密钥或密文。
- 管理员可管理邀请码、冻结用户、调整配额、开关模块、查看审计日志与清理积压。
- 模块关闭后，用户端隐藏相关入口，已配置任务停止调度，队列中未执行的任务标记为取消。
- 删除账号需二次校验，并会级联清理该账号的任务、运行记录与待发通知。

## 默认额度

| 项目 | 默认值 |
|---|---|
| 每用户平台账号 | 5 |
| 每用户启用任务 | 10 |
| 每用户通知渠道 | 5 |
| 每用户手动运行 | 滚动 24 小时 5 次 |
| 每用户自动运行 | 每 UTC 自然日 10 次 |
| 每用户通知投递 | 每 UTC 自然日 20 条 |
| 全站每日运行 / 通知 | 500 / 500 |

管理员可对单个用户调整配额，也可设置全站预算。以上为应用内业务限额，不是 Cloudflare 账单的硬上限。

## 技术栈

- Cloudflare Workers + Hono
- D1（SQLite）+ Durable Objects（`AccountCoordinator`、`PasswordHasher`）
- Queues（主队列 + 死信队列）+ Cron Triggers
- Vue 3 + Vite
- Zod 参数校验，PBKDF2 密码哈希，AES-GCM 字段加密

## 快速开始

要求：Node.js ≥ 22.18（推荐 24.x），以及具备 Workers、D1、Queues、Durable Objects 权限的 Cloudflare 账号。

```bash
npm ci
npm run check      # 类型检查 + 单元测试 + HTTP 集成测试 + 前端构建 + 打包检查
```

修改 `wrangler.jsonc`（配置文件请自行调整）：

1. 配置 Worker、D1、主队列与死信队列名称，保留 `ACCOUNTS` / `PASSWORDS` 绑定及 DO 迁移。
2. 填写 `APP_ORIGIN`，例如 `https://tasks.example.com`。必须是实际绑定到该 Worker 的 HTTPS 域名，生产环境不允许为空。
3. 将 `npx wrangler d1 create cf-task-hub-db` 返回的 `database_id` 填入 `DB` 绑定。

创建云端资源：

```bash
npx wrangler login
npx wrangler d1 create cf-task-hub-db
npx wrangler queues create cf-task-hub-queue
npx wrangler queues create cf-task-hub-dlq
```

生成密钥并首次发布：

```bash
npm run secrets:init                  # 生成 DATA_KEY / IDENTITY_KEY / BOOTSTRAP_TOKEN
npm run deploy:first                  # 检查 → 发布 Worker → 应用 D1 迁移
npx wrangler secret bulk secrets.local.json
```

打开 `APP_ORIGIN` 指定的网址，使用 `BOOTSTRAP_TOKEN` 创建管理员；注册成功后该口令立即失效。

**务必离线备份 `secrets.local.json`。** 该文件不应提交到 Git，也不应随代码分发。

后续更新：

```bash
npm run deploy      # 检查 → 远程迁移 → 发布
```

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 构建前端并以本地模式启动 Worker |
| `npm test` | 单元测试（数据库、调度、前端状态等） |
| `npm run test:http` | HTTP 集成测试 |
| `npm run typecheck` | Worker 与 Vue 类型检查 |
| `npm run build` | 构建前端到 `web/dist` |
| `npm run dry-run` | Wrangler 打包检查，不发布 |
| `npm run check` | 完整检查：类型、测试、构建、打包 |
| `npm run smoke:local` | 本地 workerd 冒烟测试 |
| `npm run db:local` / `npm run db:remote` | 本地 / 远程 D1 迁移 |
| `npm run secrets:init` | 生成三个根密钥文件 |
| `npm run deploy:first` | 首次空库安装 |
| `npm run deploy` | 已有安装升级 |

## 目录结构

```
src/
  api/           HTTP 路由（auth、user、admin、platforms 等）
  core/          加密、配额、调度、通知、安全校验
  durable/       Durable Object（账号协调、密码哈希）
  modules/       平台模块（百度网盘、B 站）
  providers/     通知渠道实现
web/             Vue 3 前端
migrations/      D1 迁移（按序号递增）
tests/           单元与 HTTP 集成测试
scripts/         密钥生成、打包检查、本地冒烟
docs/            架构、模块、安全、升级与许可证
```

## 安全说明

- 凭据在数据库中加密保存，但运营者持有 Cloudflare 配置与根密钥时仍可解密，本系统不是端到端零知识托管。
- `APP_ORIGIN` 校验与请求限速不等同于边缘防护或账单硬性上限；建议在 Cloudflare 侧额外配置访问控制与告警。
- 第三方平台接口、风控或登录态变化都可能导致任务失败，请自行评估使用风险。

## 第三方与许可

- 百度网盘模块参考 `awakaze/cf-netdisk-signin`，B 站模块参考 `cf-bilibili-coupon-worker`。
- 相关许可证见 [docs/LICENSE-baidu-netdisk.txt](docs/LICENSE-baidu-netdisk.txt) 与 [docs/LICENSE-bilibili-worker.txt](docs/LICENSE-bilibili-worker.txt)。
- 其余文档：[模块说明](docs/MODULES.md)、[安全说明](docs/SECURITY.md)、[变更记录](CHANGELOG.md)。
