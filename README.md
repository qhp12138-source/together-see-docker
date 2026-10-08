# Together See（一起See）

支持 Docker 自部署的多人同步观影项目。将你有权使用的视频链接加入房间，与朋友同步播放、聊天和发送弹幕。

**运行版本：1.3.1；发布验证完成日期：2026-10-08。** 最终干净 Git 归档的 `verify:1.0` 退出码为 0：后端全套通过，Chromium 111 项通过、1 项可选外网实播跳过，约 11.3 分钟。归档中实际执行 `npm ci` 及官方源生产依赖审计，结果为 0 漏洞。此记录不表示已推送 GitHub、完成 Docker 构建/部署、真机或 30 分钟长播验收。公开仓库不包含私人开发历史或运维资料。

1.3.1 保持 1.3 系列正常功能范围，仅增加依赖安全修复：`proxy-addr` 从 2.0.7 升至 2.0.8，对应 Critical 公告 [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)（2026-10-05 收录于 GitHub Advisory Database）。修复后的自动化与生产依赖审计已通过，证据范围见 [验收清单](1.0_ACCEPTANCE.md)。

## 功能

- 创建/加入房间、密码、锁房、昵称、权限恢复及房主/全员播放控制。
- 共享列表、播放/暂停/进度/倍速同步、自动连播；准备与缓冲状态协调、有界恢复和旧源事件隔离。
- 聊天、站内弹幕、Bilibili 匿名公开视频与原弹幕。
- 公网 MP4/HLS 直链验证、有限公开网页静态媒体提取及房间成员绑定的媒体代理。
- 本地文件同步：各端选择相同文件，只同步控制，不上传或分发文件。
- 短时互动：四个 Canvas 预设 `heart`、`fireworks`、`sakura`、`birthday` 和 `question` 精灵；本机可关闭效果或音效。
- JSON 持久化；默认空房 2 小时清理、最多 20 个活动房间、每房最多 100 人。容量上限不等于性能承诺。

## 媒体与安全边界

公网纯媒体直链不要求事先登记域名白名单，但必须通过有限媒体探测和公网安全校验。代理授权还要求有效成员会话，以及 URL、查询参数和媒体类型精确匹配当前房间列表；验证缓存不是房间授权，不能跨房复用。

网页提取不享受纯媒体直链的免域名预登记规则：仅处理匿名静态声明，可信嵌套页面与候选媒体代理继续受现有信任/白名单策略约束。不能把网页地址当成任意主机代理入口。不执行网页脚本，不绕过登录、会员、付费、验证码或 DRM；公开版不提供绕过模式或特殊访问密钥。

## Docker 快速开始

需要 Docker Engine 与 Docker Compose。正式使用应部署同源 HTTPS 反向代理。

```bash
git clone https://github.com/qhp12138-source/together-see-docker.git
cd together-see-docker
cp .env.example .env
```

本机体验将 `.env` 中 `PUBLIC_ORIGIN` 改为 `http://localhost:8080`；正式部署填入运营者自己的 HTTPS 来源。默认只绑定回环地址，不直接开放给其他设备。

```bash
docker compose up -d --build
curl -fsS http://localhost:8080/api/health
```

本机打开 `http://localhost:8080/`。部署前阅读 [部署文档](部署文档.md)，不要把正式来源设为 `*` 或关闭 SSRF、房间授权检查。

## 开发与验证

前端为 HTML/CSS/JavaScript，后端为 Node.js、TypeScript、Express 和 Socket.IO；HLS 使用 hls.js。本轮实际验证环境为 Windows 已安装的 Node.js 25.9.0；Dockerfile 使用 Node.js 24.18.0，但本轮未构建或验证 Docker 运行环境。

```bash
cd server
npm run verify:public-export
npm ci
npx playwright install chromium
npm run verify:1.0
npm audit --omit=dev --registry=https://registry.npmjs.org
```

Windows 可使用 `npm.cmd`/`npx.cmd`。无 Git 元数据的干净归档应在任何测试生成运行数据前，将导出检查命令改为 `npm run verify:public-export -- --archive`；普通 Git 工作区使用上面的默认模式。严格归档检查通过：128 个文件，互动目录仅清单加 question 三个文件，SBOM 109 项。

`npm run dev` 只启动 API/Socket，不提供完整静态站点。`verify:1.0` 不含 30 分钟长播；需要另行执行的 `npm run verify:1.0:full` 包含长播，本轮未执行。

## 限制与文档

单实例匿名使用，不含账号、多实例、上传转码或 P2P 分发。第三方接口、跨域和自动播放策略可能变化，不保证所有媒体可播放。移动视口测试不能替代真机及至少 30 分钟双端长播。

- [部署](部署文档.md) / [排障](DEPLOYMENT_AND_TROUBLESHOOTING.md) / [后端](server/README.md)
- [互动素材](INTERACTION_ASSETS.md) / [公开进度](PROJECT_PROGRESS.md)
- [验收清单](1.0_ACCEPTANCE.md) / [Android 记录模板](ANDROID_1.0_TEST_RECORD.md)
- [贡献指南](CONTRIBUTING.md) / [安全报告](SECURITY.md)
- [第三方声明](THIRD_PARTY_NOTICES.md) / [SBOM](SBOM.cdx.json)

## 许可

项目代码按 [MIT](LICENSE) 开源，第三方组件保留各自许可证。不内置影视资源；仅使用有权访问和传播的内容，并遵守平台规则。学习研究定位不构成对 MIT 另加用途限制，也不替代运营者的版权、隐私和内容治理责任。
