# Together See Server

Together See 后端服务（公开测试版），提供：

> 当前版本中，房间名即房间标识。前端分享链接使用 `/room.html?room=房间名`，后端仍沿用部分 `roomCode` 字段名作为内部事件参数。

- `GET /api/health` 健康检查
- `POST /api/parse` 视频链接解析
- `GET /api/bilibili/danmaku?bvid=...&page=...` Bilibili 公开视频原弹幕时间轴
- `GET /api/proxy/hls` HLS 播放列表与分片代理，只接受已入房成员签发的短期随机令牌
- `GET /api/proxy/media` 普通视频直链 Range/Referer 代理，只接受已入房成员签发的短期随机令牌
- `GET /api/rooms/:room` 查询房间是否存在及访问安全摘要，不创建房间、不返回受保护状态
- `POST /api/rooms/:room` 只创建新房间，可预设密码；浏览器请求必须携带预生成的管理 token 和恢复码，同名房间返回 `409 room_exists`
- Socket.IO 房间同步通道

房间必须先通过 `POST /api/rooms/:room` 显式创建。创建者携带管理 token 完成第一次 `join_room` 前，房间处于待接入状态，其他客户端只会收到 `creator_pending`，不会取得 `RoomState`；同一组创建凭据可以幂等重试 POST。`join_room` 不再创建缺失房间，而是返回 `room_not_found` 且不附带 `RoomState`；分享链接只用于加入仍然存在的房间。

## 本地开发

```bash
cd server
npm ci
npm run dev
```

## 回归验收

房间核心流程可以用一条命令做服务层回归检查：

```bash
npm run verify:release

# 也可以分别执行
npm run verify:credentials
npm run verify:client-address
npm run verify:room-flow
npm run verify:room-restart
npm run verify:http-smoke
npm run verify:origin-policy
npm run verify:parser-policy
npm run verify:parser-sniffing
npm run verify:bilibili
npm run verify:proxy-policy
npm run verify:socket-smoke
npm run verify:store-health
```

`verify:release` 会先完成类型检查、前端 JavaScript 语法与状态机静态回归、管理凭据生成契约和一次构建，再顺序运行全部验收脚本，避免并行写入 `dist`。前端回归会验证首页站内创建 / 加入、创建者待接入凭据、加入前存在性查询、无效直链门禁、2.5 秒同步阈值、全屏弹幕、B 站弹幕元数据零换源更新、站内弹幕区别样式、版本化权威播放快照、代理回退意图、B 站媒体代理优先、旧加载世代隔离、只读播放控制、服务端确认管理权限、恢复码自动修复管理身份、添加链接等待服务端 ACK、移动端手势续播、发送 ACK 后清空输入、标签页级成员 / 管理凭据、页面内管理界面、请求取消，以及首页/房间页免责声明内容与响应式页脚样式；它不包含手机真机或外部媒体源验收。`verify:credentials` 会批量生成浏览器恢复码和管理 token，验证格式、长度与样本多样性。`verify:room-flow` 会验证显式创建、创建者待接入、缺失房间拒绝、旧快照兼容、默认控制策略、房间与播放队列上限、断线占位容量、重连令牌轮换、在线身份接管拒绝、房主身份宽限与超时转移、自动接管后的创建者回收、手动转让保持、创建者身份绑定 / 恢复重绑、成员离线系统消息、昵称历史回写、空房过期删除、播放状态、全员控制租约、缓冲和陈旧周期进度拒绝、聊天、scrypt 密码及旧哈希迁移、锁房、踢人、管理审计日志和快照敏感信息不落明文。`verify:room-restart` 会用两个独立 Node 进程验证待接入状态、创建者身份、重连令牌哈希、房主保留期限与分配来源落盘、服务重启后的成员/房主恢复，以及明文令牌不进入快照。

`verify:http-smoke` 会启动构建后的 Node 服务，检查 `/api/health`、房间查询不隐式创建、同名创建 `409`、创建时预设密码、`/socket.io/socket.io.js` 和前端 HTML 引用的本地静态资源是否可用。

`verify:origin-policy` 会启动构建后的 Node 服务，验证 `PUBLIC_ORIGIN` 多来源 CORS 响应和 Socket.IO 握手来源拒绝。

`verify:parser-policy` 会验证解析器对本机、内网、保留地址、凭据 URL、非标准端口和超大 HTML 响应的拒绝，并验证公网 MP4/HLS 必须通过有限媒体字节签名后才可登记为精确直链授权，URL 查询参数和媒体类型不能混用。

`verify:parser-sniffing` 会验证 `<video>/<source>`、Open Graph、JSON-LD `VideoObject`、Twitter Player、JWPlayer/Hls.js 静态配置、Next hydration、可信嵌套页、签名 URL 保真、DASH 回退、DRM 拒绝和 HLS/MP4/WebM 格式识别。

`verify:bilibili` 使用离线伪造的官方响应验证 BV/分P识别、匿名 MP4 清晰度、签名 CDN 域名、付费内容拒绝，以及 XML 弹幕的时间、颜色、字号、滚动/顶部/底部模式转换；发布前另以公开视频做一次真实接口冒烟，但完整回归不依赖外网。

`verify:proxy-policy` 会启动构建后的 Node 服务，验证 HLS 与普通媒体代理入口的 Range/Referer 请求头、DNS 私网/保留 IP 分类、目标主机白名单、已验证公网直链的精确例外授权、房间成员会话注册/重连替换/断线宽限/撤销、内网地址拦截、来源策略、生产空白名单拒绝、旧明文查询拒绝、随机令牌脱敏、独立限流和并发预算。`verify:client-address` 会验证 HTTP 与 Socket.IO 共用的可信代理跳数语义。

`verify:store-health` 会用随机空闲端口和最长 15 秒健康等待启动短生命周期服务，验证损坏快照下 `/api/health` 返回 503，且服务不会用空房间状态覆盖原文件；失败时会带出子进程日志，便于区分启动抖动和真实故障。

`verify:socket-smoke` 会用 Socket.IO polling 协议创建多个客户端，先验证缺失房间返回 `room_not_found`，再通过 HTTP 显式创建并验证加入系统消息、满员 / 密码 / 锁房拒绝不泄露房间状态、入房来源限流、在线身份重放拒绝、重连令牌轮换、断线占位计入容量、媒体代理令牌入房与精确列表门禁、成员被踢后旧媒体令牌立即 401、匿名设备只更换成员 ID 仍被限制、播放/列表突发操作限流、私网拒绝与上游 URL 脱敏、不同代理来源密码额度隔离、管理 token 不能冒充已转让房主、当前房主不能被踢出、创建者恢复进入、自动房主接管后创建者重新取得播放和列表权限、普通成员不能继续写入列表或房间设置、晚加入客机获得当前播放快照、成员改名后历史加入消息同步更新、聊天身份防伪造、聊天与弹幕共用持久消息流、房间控制策略切换、全员模式明确 seek 接管和短租约、缓冲客机周期更新拒绝、成员锁房越权拒绝、锁房与密码生效后的房主/成员短断线恢复，以及房主与客机双向实时聊天和弹幕。

`autoPlayNext` 是服务端持久化并随 `RoomState` 广播的房间设置，通过 `room_autoplay_next_update` 修改，权限与播放列表控制一致：`host_only` 仅房主，`everyone` 允许在线成员。前端“自动同步”仍是单设备偏好；关闭后，完整 `room_state` 和普通 `playback_state` 都继续跟随房间 `activeSourceId`，但不应用远端播放/暂停、进度和倍速，只读成员可本机控制媒体且不会越权提交房间状态。`verify:frontend` 使用可执行 DOM 状态机覆盖普通播放广播路径。

## Docker 部署

项目根目录执行：

```bash
docker compose up -d --build
```


## 解析与媒体代理参数

- `PUBLIC_ORIGIN`：允许访问 API 和 Socket.IO 的浏览器来源，`*` 表示允许所有来源；正式部署建议配置为实际域名，多个来源用英文逗号分隔。
- `TRUST_PROXY_HOPS`：Express 信任的反向代理跳数；宝塔 Nginx + 容器 Nginx 部署保持默认值 2。
- `PARSE_TIMEOUT_MS`：页面解析超时时间，当前建议 12000。
- `PARSE_PROBE_TIMEOUT_MS`：单个媒体候选探测超时，默认 5000；仍受整次解析共享截止时间约束。
- `PARSE_PROBE_MAX_CANDIDATES`：单次解析最多探测的媒体候选数，默认 3，运行时上限 5。
- `PARSE_MAX_CONCURRENT_PER_CLIENT`：单客户端同时占用的解析任务上限，默认 2。
- `PARSE_MAX_CONCURRENT_TOTAL`：单实例解析任务总并发上限，默认 16。
- `PARSE_MAX_RESPONSE_BYTES`：解析普通 HTML 时允许读取的最大响应体，默认 2097152（2 MiB）；直接媒体响应不读入内存。
- `PARSE_CACHE_TTL_MS`：解析结果短期缓存时间，当前建议 600000。
- `PARSE_RATE_LIMIT_PER_MINUTE`：单客户端每分钟解析请求上限，0 表示关闭。
- `BILIBILI_ENABLED`：是否启用 Bilibili 公开视频专用解析和原弹幕，默认 true。
- `BILIBILI_TIMEOUT_MS`：Bilibili 公开接口单次请求超时，默认 12000。
- `BILIBILI_RATE_LIMIT_PER_MINUTE`：单客户端每分钟原弹幕请求上限，默认 20，0 表示关闭。
- `BILIBILI_DANMAKU_MAX_ITEMS`：单次最多返回的原弹幕条数，默认 3000。
- `BILIBILI_DANMAKU_MAX_RESPONSE_BYTES`：弹幕 XML 最大响应体，默认 8388608（8 MiB）。
- `BILIBILI_CACHE_TTL_MS`：Bilibili 弹幕短期缓存时间，默认 600000。
- `HLS_PROXY_TIMEOUT_MS`：HLS 与普通视频媒体代理的上游首包超时时间，当前建议 30000。
- `HLS_PROXY_RATE_LIMIT_PER_MINUTE`：单客户端每分钟媒体代理请求上限，0 表示关闭。
- `HLS_PROXY_MAX_CONCURRENT_PER_CLIENT`：单客户端同时占用的媒体代理请求上限，默认 8。
- `HLS_PROXY_MAX_CONCURRENT_TOTAL`：单实例媒体代理总并发上限，默认 64。
- `HLS_PROXY_ALLOWED_HOSTS`：媒体代理目标主机白名单，逗号分隔，支持 `*.example.com` 子域通配；生产环境留空会拒绝代理请求，开发环境留空才允许所有公网主机。
- `MEDIA_PROXY_TOKEN_TTL_MS`：已入房成员媒体代理随机令牌的绝对上限，默认 21600000（6 小时）；实际根令牌还绑定当前房间成员会话，成功重连会撤销旧 Socket 令牌，被踢立即撤销，普通断线只保留 `ROOM_RECONNECT_GRACE_MS`。
- `MEDIA_PROXY_TOKEN_MAX_ACTIVE`：单实例最多保留的在途代理令牌数，默认 50000；单成员另有每分钟 60 次签发预算。
- `PROXY_USER_AGENT`：后端解析和代理请求使用的 UA，默认模拟常见 Chrome 浏览器，减少第三方源站限速或拒绝。
- `ROOM_MAX_MEMBERS`：普通成员的单房间人数上限，默认 20；短断线宽限期内的成员和创建者恢复不被普通满员阻断。
- `ROOM_MAX_ACTIVE`：单实例允许保留的活动房间上限，默认 500；达到上限时只拒绝新房间，不影响同凭据的创建重试。
- `ROOM_CREATE_RATE_LIMIT_PER_MINUTE`：单客户端每分钟创建房间上限，默认 10，0 表示关闭。
- `ROOM_MAX_PLAYLIST_ITEMS`：单房间播放列表条目上限，默认 200。
- `ROOM_EMPTY_TTL_MS`：最后一位成员离开后的房间保留时间，默认 `7200000`（2 小时）；到期后完整房间快照和聊天一起删除。
- `ROOM_RECONNECT_GRACE_MS`：成员断线后保留加入授权的时间，默认 `120000`（2 分钟）；客户端必须同时提交房间专属重连令牌，服务端只保存令牌哈希，验证通过后才不受新密码、锁房和满员阻断。当前管理员超过该期限仍未恢复时，完整管理权自动转给在线房主。
- `ROOM_HOST_RECONNECT_GRACE_MS`：房主断线后保留房主身份的时间，默认 `60000`（60 秒）且运行时不会超过成员重连宽限；超时才临时转给其他在线成员，创建者带有效管理凭据返回时会回收自动转移的主持权，但不会覆盖手动转让。

`GET /api/health` 会同时返回持久化状态。快照损坏、版本未知或写盘失败时响应为 503；读取失败后 store 会停止覆盖源文件，等待运维备份并修复快照或更换 `ROOM_STORE_FILE`。


## 客机自动重解析

`POST /api/parse` 返回结果中可能包含 `requiresClientParse: true`。当前端判断视频源来自解析站包装链接或动态签名源时，访客端会优先用原始 `pageUrl` 重新请求 `/api/parse`，避免直接复用房主解析出的短时效视频地址。同一权威播放项最多自动重解析一次，本机得到的覆盖地址不写回共享播放列表；解析接口成功只代表取得候选地址，必须等媒体触发 `canplay` 才会提示“视频已就绪”。

`force=1` 或请求体 `force: true` 会绕过解析缓存，适合客机黑屏后的重新解析。

解析器只处理匿名公开页面中的静态声明，不执行脚本、不携带 Cookie/Authorization、不模拟登录，也不处理会员、验证码、DRM/许可证或付费访问。标准标签、Open Graph、JSON-LD、Twitter Player、常见播放器静态配置和序列化 hydration 数据会进入评分队列；最多跟进一层可信播放器页，并对少量高分候选读取前 4 KiB 做格式确认。直接 MP4/M3U8 同样必须通过状态码、逐跳重定向和格式探测；DASH 候选在播放器接入 dash.js 前不会作为成功结果返回。

普通视频直链若在移动端加载失败，会先尝试一次 `/api/proxy/media`。该入口与 `/api/proxy/hls` 共用安全开关、限流和全局白名单，保留上游 `206 Content-Range` / `Accept-Ranges` 响应，并转发浏览器 `Range` 请求。所有根代理申请都必须精确匹配当前房间播放条目的 URL/类型；白名单外公网纯媒体还必须先由 `/api/parse` 以状态码、重定向和最多 4 KiB 媒体签名确认，服务重启丢失内存登记后会对该房间源重新做一次同样的有限探测。HLS 子资源只继承根播放项的会话授权，仍逐跳拒绝内网、保留地址、非标准端口和 DNS 重绑定。随机令牌绑定签发成员的房间 Socket 会话；成功重连替换旧会话、被踢或重连宽限到期都会使旧令牌失效。代理 GET URL 不包含上游地址或 Referer；代理仍失败后前端进入稳定失败状态，不循环重新解析。

`server/package-lock.json` 是发布文件。开发、CI 和 Docker 构建均应使用 `npm ci`，不要删除锁文件；`node_modules`、`dist`、`data` 和 `.env` 仍是本地运行产物。

`v0.2.0-beta.7` 修复创建者管理权与播放房主状态混淆的问题。房间页只根据服务端私有 `room_permissions` 结果启用安全设置，本机存在恢复码但活动 token 丢失时会自动恢复；播放房主自动故障转移后，创建者带有效凭据返回会收回主持权，手动转让继续保持。添加链接改为等待服务端 ACK，越权操作不会留下本地假条目。房主断线默认保护期由 15 秒提高到 60 秒，快照新增向后兼容的 `hostAssignment` 字段。

`v0.2.0-beta.8` 增加两阶段房间自治：60 秒房主宽限到期后只转移播放与队列，`ROOM_RECONNECT_GRACE_MS`（默认 2 分钟）到期后才把完整管理权转给当前在线房主。服务端为接管者轮换活动管理 token，但不发送创建者恢复码；创建者以后可凭恢复码撤销接管 token 并收回权限。入房拒绝拆分为管理身份不匹配、成员仍在线和重连令牌失效，客户端为每次入房携带尝试号，旧错误会被忽略，普通身份降级最多执行一次。快照新增向后兼容的 `adminMemberId`、`adminAssignment` 和 `adminReconnectUntil`。

`v0.2.0-beta.9` 将 Bilibili 原弹幕开关改为纯元数据更新，开关不再触发播放项重建、客机解析、`video.src` 变化或媒体 Range 重开；Bilibili MP4 优先使用已入房授权媒体代理并复用房间解析结果。全员控制的 `playback_update` 增加 `revision`、`baseRevision`、明确 `action`、客户端就绪状态和 10 秒可续租约，拒绝缓冲、seeking、陈旧或明显落后的周期更新；租约停止续期后回到在线房主。旧快照缺少新增字段时自动归一为 `revision=0`、`controlLeaseUntil=null`。固定标签已于 2026-07-31 部署生产，后端版本和页面标识分别为 `0.2.0-beta.9`、`20260731-playback-stability`；没有新增环境变量、端口、Nginx 规则或数据迁移。

`v0.2.0-beta.10` 扩展 Bilibili 匿名播放地址兼容：同时读取 `durl.url`、`backup_url` 和 `backupUrl`，可信协议相对地址及 HTTP CDN 统一升级为 HTTPS，优先选择 `bilivideo.com` 线路并继续拒绝伪造后缀域名。Bilibili 错误改为稳定 `code/recoverable/retryAfterMs`，付费、会员或不支持的复合流不会重试，可恢复失败即使收到 `force` 也遵守短冷却，避免客机重复切换解析状态。前端播放列表增量协调和自动同步退避不改变服务端事件或快照结构；没有新增环境变量、依赖、端口、Nginx 规则或数据迁移。固定标签已于 2026-08-01 部署生产，服务端版本和页面标识为 `0.2.0-beta.10` / `20260731-playback-resilience`，健康、持久化、Bilibili 公开源、媒体 Range 和双客户端协议验收通过。

`v0.2.0-beta.11` 将公网纯媒体与网页提取边界分离：MP4/HLS 直链无需预先加入全局代理白名单，但必须通过有限 Range/格式探测，代理令牌仅对房间中精确匹配的源签发；网页解析和 SSRF 规则不放宽。播放协议只允许 `source` 动作改变 `activeSourceId`，旧源 seek 及不存在的播放项会被服务端拒绝；前端另以 8 秒有界切源世代、断线重置和媒体源一致性门禁抑制迟到事件。自动连播状态随切源权威包同步，开启时可播放后真正调用 `play()`，浏览器拒绝时显示点按继续；关闭时保持暂停。没有新增依赖、环境变量、端口、Nginx 规则或快照迁移。

`v0.2.0-beta.12` 修复 beta.11 候选验收发现的房间授权缺口。`VERIFIED_DIRECT_MEDIA` 只证明精确 URL 的媒体类型与公网安全，`issueMediaProxyGrant` 默认不再将其作为放行依据；Socket 只有先确认 URL、类型和查询参数精确命中当前房间播放列表，才会显式允许使用该记录或重新探测。已验证但未入列表、跨房间复用、路径或查询参数变化均返回 `parse_source_denied`；全局 `HLS_PROXY_ALLOWED_HOSTS` 行为保持不变。beta.11 未切换生产；beta.12 已于 2026-08-01 按固定标签完成候选与生产安全矩阵并上线。

`v0.2.0-beta.6` 修复 Android Chrome / WebView 在 HTTP 创建成功后的页面导航中丢失标签页管理 token，导致房间永久停留 `creatorPending` 的问题。首页先把创建 token 和恢复码写入带 15 分钟 TTL 的 `localStorage` 待确认区，再尝试晋级到 `sessionStorage`；只有房间页收到成功入房状态后才删除待确认副本。房间页会优先恢复待确认凭据，无法自动恢复但仍有管理恢复码时显示恢复门禁，不再无限复用空 token。服务端拒绝入房时只记录 HMAC 房间指纹、`creatorPending`、token 是否存在/有效、拒绝码和粗粒度客户端类型，不记录房间名、token、hash、IP 或完整 User-Agent。

`v0.2.0-beta.5` 修复 Bilibili 播放项经过 Socket.IO 入站清洗时页面地址被 CDN 地址覆盖的问题。远程播放项现在分别保留 `pageUrl` 与 `sourceUrl`，因此 BV、`cid`、分P等元数据能继续通过房间校验，客机重解析与房间共享原弹幕开关均可使用。`verify:room-flow` 覆盖“解析载荷 -> Socket 清洗 -> 房间入库 -> 弹幕开关”，`verify:release-contract` 则确保锁文件不会再次被 `.dockerignore` 排除。


## 2026-05-12 更新：解析播放与智能同步合并版

`/api/parse` 继续支持 `force=1` 或请求体 `force: true` 绕过缓存，用于客机黑屏后的本机重解析。Socket.IO 播放状态现在包含 `playbackRate`，并提供 `ping_latency` ack 校时，用于前端根据服务端时间预测房主进度，实现智能同步阈值、轻微倍速追赶和手动同步。


## HLS/M3U8 客机黑屏与同步抖动优化

本版本对跨设备 HLS/M3U8 播放做了稳定性处理：先尝试浏览器直连，遇到跨域、防盗链或网络错误后再切换 `/api/proxy/hls` 白名单代理；客机切换 HLS 源后等待媒体元数据、可播放状态或首个分片缓冲完成后再同步到房主进度；同步模块对 HLS 增加 seek 冷却和就绪判断，避免在未缓冲完成时反复“定位中 / 轻微校准中 / 网络等待中”循环。
