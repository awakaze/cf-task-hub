# 变更记录

## 2026-11-04：平台登录与运行结果说明

### 登录与恢复

- B 站支持 Web 扫码登录、同账号更新及可选 refresh_token 导入，按需自动续期；兼容新旧两组官方扫码地址。
- 续期先保存新凭据再确认，刷新结果未知时不重复提交，硬失效暂停账号与任务并复用异常通知规则。
- 新增 `0009_bilibili_sessions.sql`，数据库版本升至 9；无需新增密钥或替换已有账号凭据。
- 百度扫码全程复用服务端加密 Cookie jar，修正父域 Cookie 误拒绝、回调页面误读和收齐网盘 Cookie 后继续跳转的问题。
- 百度登录交换按跳转链设置 30 秒时限、整体 45 秒时限，兼容中转延迟；仍需真实身份检查后绑定。
- 保留固定分阶段错误码，临时详细诊断与日志持久化当前关闭。百度已完成真实扫码和业务检查；B 站真实续期轮换的验证范围见专项文档。

### 运行结果

- “无需执行”改为“检查完成”，概览、列表和平台页展示具体原因、成长值与奖励进度。
- 详情页分项显示已确认、未启用、未记录或未确认的结果及下一步操作，技术数据默认折叠。
- 登录硬失效、续期暂不可用和未知结果分别说明；新重试记录保存预计处理时间，只读核对优先展示新证据。
- 首页统计更名为“正常完成”，包含执行成功及检查完成；原有状态值、历史记录和通知路由兼容。

### 文档与验证

- 新增百度扫码和运行结果使用说明，同步 B 站续期、升级、安全及模块约定，历史调研标记为当时快照。
- 本地 `cookie` 文件加入忽略规则；密钥、调试产物和真实扫码日志不随代码提交。
- 完整检查通过 211 项测试（160 项单元、51 项接口集成），以及类型检查、构建、发布预检和页面渲染检查。

## v0.1.0（首个发布版本）

首个公开版本，基于 Cloudflare Workers 的多用户任务面板，支持百度网盘签到与 B 站大会员权益任务。

### 平台任务

- 百度网盘：PC 签到、App 签到、累计签到奖励、只读检查；支持手动 Cookie（`BDUSS` + `STOKEN`）与扫码登录。
- B 站：5B 币券检查与领取、余额检查；直播电池兑换默认关闭，需管理员与用户双重开启。
- 同一账号任务串行执行，B 站领取与兑换保持先后依赖。
- 计划支持每日、每周、每月与五段 cron，按北京时间计算；调度器每 5 分钟扫描到期任务。

### 账号与凭据

- 唯一管理员通过首次安装口令创建；普通用户使用邀请码注册。
- 密码使用 PBKDF2 哈希存储；Passkey 为可选登录方式。
- 平台凭据使用 AES-GCM 加密存储，接口不回显 Cookie、通知密钥或密文。
- 二维码登录完成后自动补齐网盘 `STOKEN` 与设备号，缺失时提示改用完整 Cookie 导入。

### 通知

- 支持 Telegram Bot、Server酱 Turbo、通用 Webhook。
- 通知规则按 用户默认 → 平台 → 账号 → 任务 四级覆盖，成功与异常通知可分别配置渠道。
- 通知标题使用平台名称，正文包含签到结果、成长值变化与累计奖励进度。

### 管理后台

- 邀请码管理、用户冻结、按用户配额调整。
- 模块开关：关闭后用户端隐藏入口，已配置任务停止调度，队列中未执行的任务标记取消。
- 审计日志、运行积压查看与日志清理。

### 默认额度

| 项目 | 默认值 |
|---|---|
| 每用户平台账号 | 5 |
| 每用户启用任务 | 10 |
| 每用户通知渠道 | 5 |
| 每用户手动运行 | 滚动 24 小时 5 次 |
| 每用户自动运行 | 每 UTC 自然日 10 次 |
| 每用户通知投递 | 每 UTC 自然日 20 条 |
| 全站每日运行 / 通知 | 500 / 500（管理员可调） |


## Optional Google HTTPS relay

- Added an isolated upstream fetch adapter with an explicit opt-in flag. The default is disabled and retains native Cloudflare fetch behavior.
- Routed platform identity checks, Baidu QR login, Baidu Netdisk API calls, and Bilibili API calls through the selector.
- Added Google Apps Script HMAC-authenticated relay source and deployment documentation.
- No database migration, public relay route, frontend change, Cron change, Queue change, or business-task logic change.
