# Google Apps Script 可选 HTTPS 中转：中文部署与修改说明

## 1. 改造目标

本次改造将 Google Apps Script 中转功能作为独立的可选网络适配器接入 CF Task Hub：

- 默认关闭，未设置开关时继续使用 Cloudflare 原生 `fetch()`。
- 不添加公开代理 API，不改变现有用户认证和权限模型。
- 不修改 D1 数据库结构，不增加 SQL migration。
- 不修改 Cron、Queues、Durable Objects、任务调度、账号绑定和业务任务状态机。
- 只在现有平台上游请求调用点注入 fetcher。
- Google 端不把百度 Cookie、B 站 Cookie 或第三方 API Key 保存到 Script Properties；凭据由 Worker 在单次请求中传递。

## 2. 架构

```text
现有 CF Task Hub
  ├─ 登录、用户权限、账号归属、CSRF
  ├─ D1 / Durable Objects / Queue / Cron
  ├─ 百度与 B 站业务逻辑
  └─ upstreamFetch(env)
       ├─ GOOGLE_RELAY_ENABLED != "true" -> 原生 Cloudflare fetch
       └─ GOOGLE_RELAY_ENABLED == "true"
            -> HMAC-SHA256 签名
            -> Google Apps Script Web App
            -> UrlFetchApp.fetch(目标 HTTPS URL)
            -> JSON 封装响应
            -> Worker 还原 Response
```

Google 中转不是全局 `fetch` 替换，也不会拦截通知服务、内部 Cloudflare 服务绑定或静态资源。

## 3. 默认关闭行为

`wrangler.jsonc` 中增加：

```jsonc
"GOOGLE_RELAY_ENABLED": "false"
```

代码中只有当环境变量的值严格等于字符串 `"true"` 时才启用 Google 中转。以下情况都保持原生网络行为：

- 没有配置该变量；
- 值为 `false`；
- 值为 `TRUE`；
- 值为 `1`；
- 其他任何非精确 `true` 的值。

因此，即使已经部署了 Google Web App，只要开关没有明确打开，原项目就不会调用它。

## 4. 哪些请求会经过 Google

开关开启后，以下平台上游请求使用 Google：

- 百度账号身份校验；
- 百度账号只读探测；
- 百度签到任务；
- 百度扫码登录的二维码开始、轮询、Cookie 交换；
- B 站账号身份校验；
- B 站只读探测；
- B 站任务执行与只读复核。

以下内容仍留在 Cloudflare：

- 浏览器访问 Task Hub；
- Worker 内部 API、D1、Durable Objects、Queues；
- Cron 与任务调度；
- Telegram、Server 酱、Webhook 通知；
- 前端静态文件；
- 未经过平台 fetcher 注入点的其他网络调用。

## 5. 修改文件清单

| 文件 | 修改内容 |
|---|---|
| `src/core/google-relay.ts` | 独立 Google HTTPS 中转实现，包含 HMAC、响应还原、请求大小限制 |
| `src/core/upstream-fetch.ts` | 统一开关选择器；默认返回原生 `fetch` |
| `src/core/types.ts` | 增加 3 个可选环境变量类型 |
| `src/api/user.ts` | 创建、更新、探测账号时注入上游 fetcher |
| `src/api/platforms.ts` | 平台身份校验、探测和百度扫码流程注入 fetcher |
| `src/durable/account-coordinator.ts` | 任务执行和只读复核注入 fetcher |
| `src/modules/baidu-netdisk/adapter.ts` | 百度探测函数支持可选 fetcher |
| `src/modules/bilibili/adapter.ts` | B 站探测函数支持可选 fetcher |
| `wrangler.jsonc` | 增加默认关闭的开关 |
| `tests/google-relay-toggle.test.mjs` | 验证默认关闭、配置校验和显式启用 |

新增 `google-apps-script/Code.gs` 是独立部署在 Google 账号里的服务端代码。

## 6. Google Apps Script 部署步骤

### 6.1 创建脚本

1. 打开 https://script.google.com/。
2. 使用自己的 Google 账号登录。
3. 新建项目。
4. 打开 `Code.gs`。
5. 将本项目 `google-apps-script/Code.gs` 的全部内容复制进去。
6. 保存项目。

### 6.2 生成独立 HMAC 密钥

使用密码管理器或密码学安全随机数生成器，生成至少 32 字节熵的随机密钥。建议用 64 个随机十六进制字符表示。

不要：
- 使用普通登录密码；
- 使用 B 站 Cookie 或 API Key 作为 HMAC 密钥；
- 把密钥发到聊天、截图或公开仓库；
- 将密钥写入 `wrangler.jsonc`。

### 6.3 配置 Script Properties

Google Apps Script 左侧「项目设置」→「脚本属性」，添加：

| 属性名 | 属性值 |
|---|---|
| `GOOGLE_RELAY_HMAC_SECRET` | 上一步生成的随机密钥 |

不要在 Google Script Properties 中添加 B 站 Cookie 或百度 Cookie。

### 6.4 部署 Web App

1. 点击「部署」→「新部署」。
2. 类型选择「Web 应用」。
3. 执行身份选择「我」。
4. 访问权限选择「任何人」（如果个人账号或 Workspace 管理策略允许）。
5. 完成授权并部署。
6. 复制以 `/exec` 结尾的部署 URL。

如果组织策略不允许匿名 Web App 调用，不要绕过组织安全策略；当前部署方式需要 Worker 能够无交互地访问 Web App，并由 HMAC 在应用层认证。

修改 Apps Script 代码后，需要进入「部署」→「管理部署」编辑现有部署并发布新版本；只保存编辑器不一定更新线上版本。

## 7. Cloudflare 配置

Cloudflare Dashboard → Workers & Pages → 选择 CF Task Hub Worker → Settings → Variables and Secrets。

添加：

| 名称 | 类型 | 值 |
|---|---|---|
| `GOOGLE_RELAY_ENABLED` | 普通变量 | 先保持 `false` |
| `GOOGLE_RELAY_URL` | 普通变量 | Google Web App 的 `/exec` URL |
| `GOOGLE_RELAY_HMAC_SECRET` | Secret | 与 Script Properties 完全相同的密钥 |

`GOOGLE_RELAY_HMAC_SECRET` 必须设置为 Cloudflare Secret，不能设置为公开普通变量。

原有 `DATA_KEY`、`IDENTITY_KEY`、`BOOTSTRAP_TOKEN`、百度 Cookie、B 站 Cookie 等变量和 Secret 不需要迁移，也不需要删除。

## 8. 启用步骤

先完成 Google 和 Cloudflare 配置，开关仍保持 `false`。

建议顺序：

1. 访问 Google `/exec`，确认健康检查返回 `service: cf-task-hub-google-relay`。
2. 检查两边 HMAC 密钥是否完全一致。
3. 在 Cloudflare 设置 `GOOGLE_RELAY_ENABLED=true`。
4. 重新部署或确认配置已生效。
5. 先执行只读身份校验。
6. 再测试只读 B 站接口。
7. 最后才测试签到等会产生状态变化的任务。

不要第一次就用会兑换、领取或消耗资产的任务验证代理。

## 9. 关闭与回滚

将 `GOOGLE_RELAY_ENABLED` 改为 `false`，即可恢复原生 Cloudflare `fetch()`。

回滚不需要：
- 数据库迁移；
- 清理 D1 数据；
- 重建 Durable Objects；
- 修改 Cron；
- 删除账号；
- 重建任务。

Google Web App 可以保留部署，但关闭开关后 CF Task Hub 不会再调用它。

## 10. 请求认证协议

Worker 发送的签名信封格式：

```text
timestamp
nonce
HMAC-SHA256(timestamp + "\n" + nonce + "\n" + payload)
JSON payload
```

Google 验证：
- 时间戳与当前时间相差不超过 5 分钟；
- nonce 格式正确；
- HMAC 签名一致；
- nonce 未在短期缓存中出现；
- 目标 URL 是 HTTPS；
- 目标端口为 443；
- 方法、请求头和请求体大小符合限制。

nonce 使用 Apps Script CacheService，属于尽力而为的短期防重放保护，不是永久、强一致的 exactly-once 存储。

## 11. 凭据与隐私边界

平台 Cookie 和 API Key 由 Worker 管理，并通过单次请求传递。Google 代码不会将这些凭据写入 Script Properties，也不会写入日志。

但必须理解：Google Apps Script 在发起上游请求时，能够读取请求头中的 Cookie、Authorization 和 API Key。因此，这不是让 Google 完全接触不到凭据，而是避免在 Google 项目中长期保存凭据。

限制 Google Apps Script 项目的编辑权限，只授权可信管理员。

## 12. 功能限制

当前实现是有限大小的 HTTPS API 中转，不是完整网络代理：

- 支持 GET、POST、PUT、PATCH、DELETE；
- 不支持 TCP、UDP、WebSocket；
- 不支持透明实时流；
- 不适合视频、音频和大文件；
- 请求体和响应体当前分别限制为 700,000 字节；
- 请求头总长度限制为 7,000 字符；
- 目标 URL 长度限制为 2,082 字符；
- 部分受限 HTTP 请求头不能由 Apps Script 自定义；
- 多值响应头和 `Set-Cookie` 可能无法在所有上游场景完全透明还原；
- Google UrlFetchApp 没有可靠的单次上游请求取消机制。Worker 侧超时后，Google 端请求仍可能继续完成；对非幂等操作尤其要保留原项目的检查点和只读复核机制。

Google 出口 IP 是共享且可能变化的，不保证固定 IP、指定国家，也不保证 B 站一定不再返回 412。

## 13. 安全边界

代码拒绝非 HTTPS、非 443 端口、IP 字面量、localhost 和常见内网/测试域名后缀。但仅靠字符串校验不能彻底防止 DNS Rebinding，也不能代替完整的 SSRF 防护。

当前项目没有新增公开的任意 URL 代理 API。请保留这个边界，不要让未认证用户自行提交目标 URL。任何未来增加公开代理入口的改动，都需要单独设计授权、目标策略、限流和安全审查。

## 14. 验证记录

本次源码改造完成后执行了：

- 新增开关测试：5 项通过；
- 新增 TypeScript 文件语法检查：通过；
- 全部 `src` 文件 TypeScript transpile 语法诊断：35 个文件，0 个 parser diagnostics；
- Google Apps Script 文件 Node 语法检查：通过。

完整 `npm ci` 在构建环境中超时，未能安装项目依赖。因此本次没有声称完整 `npm run check`、完整集成测试或线上 Google 端到端验证已经通过。部署前请在 Node.js 22.18 或更新版本的环境执行完整项目检查。

## 15. 推荐部署命令

```bash
npm ci
npm run typecheck:worker
npm test
npm run test:http
npm run build
npm run dry-run
```

全部检查通过后，再部署到 Cloudflare。初次上线建议保持 `GOOGLE_RELAY_ENABLED=false`，确认原项目运行正常后再进行可控启用测试。
