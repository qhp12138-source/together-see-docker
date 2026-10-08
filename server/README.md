# Together See Server

Node.js / TypeScript / Express / Socket.IO 后端，运行版本 1.3.1。公开快照候选的测试状态见 [验收清单](../1.0_ACCEPTANCE.md)，不沿用历史部署或测试结论。

本候选保持 1.3 系列正常功能，依赖修复目标为 `proxy-addr` 2.0.8，处理 `GHSA-jqcg-44mw-7w3h`；锁文件、109 项 SBOM、安装树与修复后的审计结果须在最终候选中核对。公告与许可边界见 [第三方声明](../THIRD_PARTY_NOTICES.md)，不表示本轮已部署或完成全量测试。

## 接口与房间语义

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 版本及持久化健康；存储异常可返回 503 |
| `POST /api/parse` | 有限公开媒体解析，不是任意 URL 代理 |
| `GET /api/bilibili/danmaku` | 匿名公开视频原弹幕 |
| `GET /api/interactions` | 经校验的公开互动清单 |
| `GET /api/proxy/hls`、`GET /api/proxy/media` | 仅接受房间成员短期随机令牌的媒体请求 |
| `GET /api/rooms/:room` | 存在性及访问安全摘要，不创建房间或返回受保护状态 |
| `POST /api/rooms/:room` | 显式创建，可设密码；同名冲突返回 409 |
| Socket.IO | 入房、服务端权限、列表、播放、聊天与短时互动 |

创建者完成首次入房前，房间处于待接入状态；`join_room` 不隐式创建缺失房间。播放房主与管理权限分开，由服务端私有 `room_permissions` 决定；重连、接管与恢复必须经过凭据验证。

播放状态通过源身份、版本和控制权校验，协调准备、缓冲冻结/恢复与时间线同步。`autoPlayNext` 是持久化房间设置，权限与列表控制一致；前端自动同步是单设备偏好，关闭后仍跟随换源，本机控制不越权回写。

## 本地开发与验证

从仓库根进入后端目录，使用 Node.js 24 和锁文件：

```bash
cd server
npm ci
npm run dev
```

该命令只提供 API/Socket；完整同源站点使用根目录 Docker Compose。配置参考 [部署文档](../部署文档.md)、根及后端 `.env.example`，不要提交 `.env`、`data`、`dist` 或 `node_modules`。

```bash
npm run verify:release
npx playwright install chromium
npm run verify:1.0:full
```

发布门禁覆盖类型、前端、凭据、协议、解析/代理、存储和互动；完整门禁另含浏览器与长播。命令是复验入口，不表示本候选已执行。Windows 可用 `npm.cmd`/`npx.cmd`，不要并发运行改写 `dist` 的构建。

## 媒体授权

公网 MP4/HLS 纯媒体直链无需事先登记域名白名单，但必须通过有限状态码、重定向、媒体格式与公网校验。代理签发同时要求 URL、查询参数、类型精确命中当前房间列表，以及有效成员会话；解析缓存不授予房间权限。重连替换、踢出和宽限到期会使旧授权失效。

网页静态提取不享有纯媒体免域名预登记规则；可信嵌套页与候选代理保留信任/白名单策略。`HLS_PROXY_ALLOWED_HOSTS` 不是任意网页许可，留空也不是关闭门禁。Range 与 HLS 子资源继承根授权，但继续逐跳校验。

不执行网页脚本、不携带平台登录 Cookie/Authorization，不绕过登录、付费、会员、验证码或 DRM。公开版没有绕过模式或特殊访问密钥。保留解析/代理超时、并发、速率与令牌预算，禁止无限重解析。

## 互动与配置

`interaction_send` 只接受当前在线房间成员，对当前播放源、素材 ID 和归一化坐标进行校验。发送额度为每成员 3 秒 4 次、每房间 3 秒 20 次。`interaction_play` 最长 3 秒，短队列有数量/字节上限；断线、切源、素材修订变化和过期事件会丢弃，不持久化、不进入聊天、不重连补播。

`INTERACTION_ASSET_DIR` 指向部署者的素材目录，Compose 已配置只读挂载；默认目录为仓库 `assets/interactions`。公开分发仅四个 Canvas 预设与 `question`，不提供上传接口。目录校验、文件约束和本机效果/音效设置见 [互动素材](../INTERACTION_ASSETS.md)。

## 持久化与日志

默认房间/人数/列表上限为 20/100/200，空房 TTL 为 2 小时，成员/房主重连宽限为 120/60 秒；存储容量还会约束可用房间数。实际配置以当前环境示例和运行时校验为准，不把上限当作容量测试结果。

损坏、未知格式或写入失败时保护原快照并报告健康异常，不用空库覆盖。关停须等待最终写入；`savedAt` 变化不直接证明丢失。日志、Issue 与公开测试记录不得包含真实房间内容、令牌、恢复码或完整媒体 URL。
