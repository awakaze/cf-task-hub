# 安全与资源控制（v0.1.0）

本文件描述已实现的代码边界和部署者仍需配置的边界。升级操作见 README。

## 认证、权限与数据

生产认证只允许 APP_ORIGIN 指定的 HTTPS origin。只有明确的 localhost / 127.0.0.1 开发地址可用 HTTP。会话和写请求继续检查当前活跃用户、未撤销会话、CSRF、Origin；readiness 缓存不缓存用户权限或会话有效性。

登录密码采用标准 PBKDF2-HMAC-SHA256 600,000 次，使用 @noble/hashes，在内部 PasswordHasher Durable Object 中计算。旧50,000次格式成功验证后自动升级。RPC有签名、大小与时间检查；不持久化或记录明文密码。按IP和规范化用户名限速，失败渐进退避，保留Passkey恢复途径。

凭据采用AES-GCM随机IV，并绑定owner/resource附加认证数据。运营者同时拥有数据库和根密钥时能解密，本系统不是零知识托管。最小化Cloudflare管理权限/API Token权限，保护备份和根密钥。不要将真实Cookie、通知Token、生产数据库或本地Secret文件提交到仓库。

恢复码只可消费一次，恢复会话的免旧密码重设授权有效10分钟且只可使用一次；更新密码后撤销其他会话。普通会话不能自行声明获得该授权。前端退出与身份变化会清空敏感表单、恢复码、用户数据并中止旧请求，旧请求结果不能覆盖新用户界面。

## 请求与自动化滥用

| 控制 | 当前默认 |
| --- | --- |
| API请求体 | 按实际流读取最多64KiB，传输最多10秒 |
| JSON复杂度 | 单集合最多100项、深度12、总节点2000 |
| 验证错误响应 | 最多10项，路径和错误文案有长度限制 |
| 廉价入口保护 | 每isolate每IP 120请求/分钟，键总数有界；未知API先404且不查D1/DO |
| 用户通用写请求 | 60次/分钟、500次/日；全站通用写请求1200次/日 |
| QR创建 | 每用户10次/小时 |
| QR轮询 | 每用户120次/3分钟、每challenge最多60次、至少2秒间隔、单进行中租约 |
| 手动运行 | 默认每用户5次/滚动24小时 |
| 自动运行 | 默认每用户10次/UTC日 |
| 未结运行 | 每账号最多3个 |
| 平台单次批量 | 最多20个功能任务，预算/运行/队列意图/请求幂等同事务 |
| 通知 | 用户默认20次/UTC日；平台默认500次/UTC日；另有测试和重试频率限制 |
| 平台运行预算 | 默认500次/UTC日 |

日窗口按UTC边界处理；手动运行另保持滚动24小时语义。限流、任务额度和资源数量不是同一概念。QR poll使用专用限额，不消耗通用配置写预算；认证路由有独立限额。被拒绝的请求仍可能消耗已经发生的Worker或DO调用。

每isolate的IP限制是便宜的补充保护，重启、多区域或分布式来源可以绕过其全局效果。**不能拿它替代边缘Access/WAF。**持久用量触发器和DO限制保护应用预算，也不能保证Cloudflare账户总账单绝不增加。

## Cloudflare部署边界

本次没有登录或修改部署者的Cloudflare账户。必须自己核对Workers Free/Workers Paid，不能只看域名Free标识。付费预算告警不是硬封顶；免费额度耗尽主要导致拒绝服务。

自用/熟人使用优先把整个Worker放到Access白名单后面；自定义域、workers.dev和预览入口必须同时覆盖。不用的入口应关闭并在部署配置中保留关闭状态。公开服务应在进入Worker之前配置可用的WAF/限速规则；如接入Turnstile，必须服务端验证，不能只加前端按钮。项目没有假装已经替你启用这些账户级设置。

观察实际Worker CPU、D1 rows_read/rows_written/存储、DO请求/CPU/时长/存储、Queue操作与积压。应用心跳和任务次数不等于Cloudflare计费指标。密码KDF移到DO是为了避免免费HTTP的CPU瓶颈，但仍消耗DO资源。

官方资料：

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/queues/platform/pricing/
- https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

## 上游网络与未知结果

百度二维码只允许显式官方HTTPS主机，每跳检查目标和端口。图片按流限制200KB，并限制图片类型和签名。Cookie按Domain/Path/Secure/过期时间隔离，Passport的host-only STOKEN不作为网盘STOKEN；不会把Cookie转发给任意上游redirect。

Webhook要求管理员批准的HTTPS域名，限制请求头，DNS预检查并禁止自动跳转。DNS预检查不是连接地址固定；只批准可信且受控的域名，不批准任意用户可改DNS的目标。通知内容也不得包含原始Cookie或根密钥。

上游错误响应取消正文，不把原始响应片段写入业务日志；结构化报告做敏感字段和长度处理。真实平台可能改变接口、风控、凭据和资产单位，mock成功不能替代受控账号验收。

兑换默认关闭。提交前保存检查点，未知结果保持锁定并只读复核；需要人工结案时由近期认证的管理员明确声明实际核对结果，不自动重发交易。人工结案证据保留至少365天；跨存储收尾未完成时不清理其证明。

## 长期数据保留

维护从活动任务反查outbox，不反复扫描所有sent历史。自动维护通常在终态outbox满7天、普通终态运行满90天、兑换历史和安全审计满365天后分页清理。未决状态、未完成收尾的人工证据和对应DO锁继续保留。DO限流键按到期索引清理，不被新流量不断推迟。

上述天数是自动维护保留周期，不代表普通历史记录绝对不能提前删除。用户显式删除已结账号时，可以级联删除其运行历史和普通DO报告；独立的人工结案证据、审计及近期用量账本不会因该账号删除而一并清除。需要长期留存普通历史时，应先导出再删除账号。

安全清理保留未知证据，可能因此暂时占用空间。每账号3个未结运行限制可避免无限增加新的未知记录；运营者需要及时复核，不能以删除证据代替恢复。定期监控存储容量并按保留期导出需要长期保管的记录。

## 依赖与发布

使用package-lock.json固定依赖。Zod已升级到4.6.7；开发工具链undici覆盖到7.30.1；全量审计结果随本包附上。不得为消除审计输出直接执行不加审查的audit fix --force。

OWASP密码存储依据：https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
Zod公告：https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
Undici公告：https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c

任何未来依赖升级或新增模块都应重新运行类型检查、回归、构建、workerd smoke和依赖审计。发布材料只描述实际已执行的验证，不承诺永远没有漏洞。
