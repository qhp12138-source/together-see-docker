# 第三方组件声明

项目自身代码使用 MIT；第三方组件不因进入本仓库而被重新许可。

## 浏览器播放器

- assets/js/hls.js：hls.js 1.6.15，Apache-2.0。上游 https://github.com/video-dev/hls.js/tree/v1.6.15 。原声明包含 Dailymotion 与 Brightcove 版权，见 assets/licenses/hls.js-LICENSE.txt 和 Apache-2.0.txt。
- 其分发依赖 eventemitter3 5.0.1、url-toolkit 2.2.5、@svta/common-media-library 0.17.1 的原许可证/NOTICE 见 assets/licenses/ 对应文件。
- CEA-608 实现源自 DASH Industry Forum，原 BSD 声明见 cea-608-NOTICE.txt。WebVTT 实现源自 Mozilla vtt.js（Apache-2.0）：https://github.com/mozilla/vtt.js 。

本次不改动 hls.js 字节或播放实现。许可证随 assets 一同进入 Web Docker 镜像。

## 服务端及工具

锁定版本和完整性信息见 server/package-lock.json；生产依赖及基础镜像清单见 SBOM.cdx.json。npm 安装包和容器基础镜像保留各自许可证，不能把项目 MIT 解释为对所有依赖的统一授权。

## 测试媒体和外部平台

server/e2e/fixtures/together-see-e2e.webm 是项目生成的测试夹具，不包含用户视频。第三方测试链接仅用于兼容性测试，不表示平台授权、合作或背书。Bilibili 和其他服务的商标、内容和访问规则仍属于其权利人。
