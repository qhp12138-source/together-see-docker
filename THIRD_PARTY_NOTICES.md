# 第三方组件声明

项目自身代码使用 [MIT](LICENSE)；第三方组件不因进入本仓库而被重新许可。本文适用于 1.3.1，2026-10-08 已完成最终干净归档的依赖、SBOM 与公开导出验证；技术验证不构成对全部第三方版权归属的声明。

## 浏览器播放器

- `assets/js/hls.js`：hls.js 1.6.15，Apache-2.0；[上游源码](https://github.com/video-dev/hls.js/tree/v1.6.15)。原声明包含 Dailymotion 与 Brightcove 版权，见 `assets/licenses/hls.js-LICENSE.txt` 和 `Apache-2.0.txt`。
- 分发依赖 eventemitter3 5.0.1、url-toolkit 2.2.5、@svta/common-media-library 0.17.1 的许可证/NOTICE 保留在 `assets/licenses/`。
- CEA-608 实现源自 DASH Industry Forum，见 `cea-608-NOTICE.txt`；WebVTT 实现源自 [Mozilla vtt.js](https://github.com/mozilla/vtt.js)，使用 Apache-2.0。

播放器许可证随 assets 进入 Web 镜像；修改或重新分发时仍须保留对应声明。

## 界面图标

使用的 [Lucide](https://github.com/lucide-icons/lucide) 图标声明见 `assets/icons/LUCIDE-LICENSE.txt`，包含 ISC 以及源自 Feather 的 MIT 声明。保留原版权与许可文本。

## 互动与测试素材

公开互动清单仅含项目 Canvas 预设 `heart`、`fireworks`、`sakura`、`birthday`，以及经维护者确认纳入本次公开分发的 `question` 精灵 spritesheet、poster 和 audio 文件；详见 [互动素材](INTERACTION_ASSETS.md)。不附带其他素材包或原始个人媒体。该确认不代表项目拥有全部第三方素材版权，项目代码的 MIT 声明也不自动授权或重新许可任意外部素材。

`server/e2e/fixtures/together-see-e2e.webm` 是项目生成的测试夹具，不包含用户视频。外部平台名称、商标和内容属于各自权利人；兼容性支持不表示平台授权、合作或背书。

## 服务端及工具

锁定版本与完整性见 `server/package-lock.json`，生产依赖及基础镜像清单见 [SBOM](SBOM.cdx.json)，清单包含 109 个组件。最终归档实际安装与 SBOM 校验通过，严格隐私导出为 128 文件，互动目录仅 catalog 加 question 三个文件。npm 包和容器基础镜像保留各自许可证，项目 MIT 不是对全部依赖的统一授权。SBOM 列出基础镜像不代表本轮已构建或测试该镜像。

## 1.3.1 依赖安全修复

`proxy-addr` 从 2.0.7 升至 2.0.8，针对 Critical 公告 [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)。GitHub Advisory Database 于 2026-10-05 收录该公告；受影响范围为 `>=1.1.0, <2.0.8`，修复版本为 2.0.8。问题涉及特定 IPv4-mapped IPv6 可信子网配置下的客户端 IP 伪造，不能据此直接断言本项目已遭利用。

本版本仅补充依赖修复，不扩展正常功能或放宽安全边界。2026-10-08 最终归档在 Windows / Node.js 25.9.0 实际执行 `npm ci`，官方源生产依赖审计为 0 漏洞，`verify:1.0` 通过。审计结论限该日期与安装树，不是永久无漏洞保证；本轮未进行 Docker 构建/部署、真机或 30 分钟长播，不声明已推送 GitHub。
