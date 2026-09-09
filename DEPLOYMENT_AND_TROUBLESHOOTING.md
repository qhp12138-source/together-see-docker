# Together See 故障排查

先记录代码版本、浏览器/系统版本、操作顺序与脱敏错误。不要公开完整媒体签名链接、代理 token、房间密码、恢复码、快照或私人聊天。

## 无法加入 / 权限只读

确认前后端同版本、页面资源未缓存。创建者、播放房主和管理员不是始终同一角色：房主短断线有宽限，管理权在更长离线后才接管。恢复码仅由创建者保留。不要清空服务器房间数据来修复客户端身份；先查脱敏拒绝原因与当前权限事件。

## 解析或兼容失败

- Bilibili 上游可能限流或变更；仅匿名公开视频受支持。不要依赖登录态或关闭可信 CDN 校验。
- 公网 MP4/HLS 与网页不是同一解析路径。网页提取不执行动态脚本；浏览器能看不意味着服务器能匿名提取。
- 直链验证通过不等于可跨房间代理，必须精确匹配当前房间列表。
- `parse_source_denied` 时先检查列表匹配和部署配置，不扩大到任意主机。
- 不反复重解析掩盖失败；记录一次直连和有限回退各自的错误类别。

## 黑屏 / 循环暂停 / 卡顿

先分辨媒体加载失败、浏览器禁止自动播放、主动暂停、同步纠偏与上游缓冲。用户手势限制时需要点击播放；自动化能调用 play 不代表所有浏览器允许自动播放。

记录脱敏的 currentTime、paused、readyState、buffered、playbackRate、loadstart 次数及操作顺序。开关原弹幕、新增非当前条目不应引起媒体重载；旧视频上的 seek 不能把房间换回旧源。

关闭自动同步仅停止本机时间线跟随，仍跟随房间换源；只读成员本机操作不应修改房间权威。

## Range / HLS / 外层代理

内层正常不代表公网正常。使用合法测试媒体从外层验证 206、Content-Range、字节数和 HLS 子资源。固定模板是 `nginx/baota-site.conf`，不要让更优先的通用 API 或缓存规则截获它。

核心规则摘要（完整配置使用模板）：

```nginx
location ~* ^/api/proxy(?:/|$) {
    access_log off;
    error_log /dev/null emerg;
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Range $http_range;
    proxy_set_header If-Range $http_if_range;
    proxy_cache off;
    proxy_buffering off;
    proxy_request_buffering off;
}
```

代理查询含授权信息，不要把浏览器 Network 完整 URL、Nginx request_uri 或未脱敏 HAR 粘贴到 Issue。

## 存储健康异常

健康接口 503 时先保护原快照，检查权限、磁盘容量、格式、容量上限和关停日志。不要用空文件覆盖损坏库。最终写入会更新 savedAt，文件摘要变化不直接说明丢失。默认空房 2 小时清理属于正常生命周期。

## 测试失败

在 `server/` 运行测试；根目录没有 package.json。Windows 可使用 npm.cmd。发布脚本顺序构建 dist，不并发启动多个构建。长播报告看失败原因与实际媒体推进，不只看最后一行。

`npm audit --omit=dev --registry=https://registry.npmjs.org` 使用官方审计接口。历史零漏洞结果不是永久保证。环境性能抖动需单独分析，不通过无限重跑或修改断言放行。

提交普通问题见 [贡献指南](CONTRIBUTING.md)，漏洞见 [安全报告](SECURITY.md)。
