# Together See（一起See）

支持 Docker 自部署的多人同步观影项目。将你有权使用的视频链接加入房间，与朋友同步播放、聊天和发送弹幕。

**当前版本：0.2.0-beta.31，公开测试阶段，不是 1.0 稳定版。** 本仓库包含完整源码、Docker 配置、测试与开发进度，从独立代码快照开始，不包含私有开发历史和运维资料。

## 功能

- 创建/加入房间、密码、锁房、昵称修改、房主管理与全员播放控制。
- 共享播放列表、播放/暂停/进度/倍速同步、房间自动连播设置。
- 聊天与站内弹幕；Bilibili 匿名公开视频、分P与原弹幕。
- 公网 MP4/HLS 直链验证、有限公开网页媒体声明提取，不执行网页脚本。
- 浏览器优先直连，失败时使用有界、房间成员绑定的媒体代理。
- 本地文件同步：各端自行选择相同文件，只同步控制状态，不上传、不推流、不使用 P2P 分发。
- JSON 持久化；默认空房 2 小时清理，最多 20 个活动房间、每房 20 人。

## Docker 快速开始

需要 Docker Engine 与 Docker Compose。正式部署使用 HTTPS 反向代理。

```bash
git clone https://github.com/qhp12138-source/together-see-docker.git
cd together-see-docker
cp .env.example .env
```

编辑 `.env`：本机体验设为 `PUBLIC_ORIGIN=http://localhost:8080`；正式部署填写实际 HTTPS 来源，例如 `https://see.example.com`。默认端口仅绑定回环地址，不能直接从其他设备访问。

```bash
docker compose up -d --build
curl http://localhost:8080/api/health
```

本机打开 `http://localhost:8080/`。不要把正式来源改为 `*`，也不要为了兼容媒体关闭 SSRF 或房间授权检查。完整域名、可信代理、Range 和更新流程见 [部署文档](部署文档.md)。

## 开发与验证

前端为 HTML/CSS/JavaScript；后端为 Node.js、TypeScript、Express 和 Socket.IO；HLS 使用 hls.js。建议使用与 Dockerfile 相同的 Node.js 24 版本。

```bash
cd server
npm ci
npm run verify:release
npx playwright install chromium
npm run verify:1.0
npm run verify:1.0:full
```

Windows 可使用 `npm.cmd`/`npx.cmd`。后端 `npm run dev` 仅启动 API/Socket，不提供完整静态站点。仓库默认使用 npm 镜像源，安装/审计可指定 `--registry=https://registry.npmjs.org`。完整长播至少 30 分钟，短冒烟不能替代。

## 已知限制

- 面向单实例、匿名小范围使用，没有账号、Redis 多实例或上传转码。
- 第三方接口、CDN、跨域和自动播放策略可能变化，不保证所有链接或清晰度可用。
- 不支持登录、会员、付费、验证码或 DRM 绕过。
- 自动化移动视口不是 Android/iOS 真机验收。真实设备、弱网及第三方长播仍是 1.0 前重点。

## 文档

- [开发进度](PROJECT_PROGRESS.md) / [1.0 验收范围](1.0_ACCEPTANCE.md)
- [Android 测试模板](ANDROID_1.0_TEST_RECORD.md) / [故障排查](DEPLOYMENT_AND_TROUBLESHOOTING.md)
- [贡献指南](CONTRIBUTING.md) / [安全报告](SECURITY.md)
- [第三方声明](THIRD_PARTY_NOTICES.md) / [SBOM](SBOM.cdx.json)

## 许可与使用边界

项目代码按 [MIT](LICENSE) 开源，第三方组件保留各自许可证。仅供学习交流与技术研究，不内置视频资源。只使用有权访问和传播的内容，并遵守第三方规则；用途声明不替代实际运营者的版权、隐私和内容治理责任。

学习研究是项目定位，不构成对 MIT 许可证另加的用途限制。
