(function () {
  const params = new URLSearchParams(window.location.search);

  function normalizeRoomName(value) {
    const clean = String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[?#&=\\/:;%]/g, "")
      .slice(0, 64)
      .trim();
    return clean || "默认房间";
  }

  const roomName = normalizeRoomName(params.get("room") || params.get("name") || params.get("code") || "默认房间");
  // 后端事件字段仍沿用 roomCode 命名，但其值已经改为“房间名”。
  const roomCode = roomName;

  const player = window.TogetherSeePlayer;
  const tabs = Array.from(document.querySelectorAll("[data-room-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-room-panel]"));
  const playlistList = document.querySelector(".playlist-list");
  const playlistForm = document.querySelector("[data-playlist-form]");
  const playlistEmpty = document.querySelector("[data-playlist-empty]");
  const chatForm = document.querySelector("[data-message-form]");
  const chatFeed = document.querySelector(".chat-feed");
  const danmakuForm = document.querySelector("[data-danmaku-form]");
  const danmakuInput = document.querySelector("[data-danmaku-input]");
  const memberList = document.querySelector(".member-list");
  const auditLog = document.querySelector("[data-audit-log]");
  const videoStage = document.querySelector(".video-stage");
  const roomSidebar = document.querySelector(".room-sidebar");
  const autoPlayNextInput = document.querySelector("[data-autoplay-next]");
  const localVideoButton = document.querySelector("[data-local-video-button]");
  const localVideoInput = document.querySelector("[data-local-video-input]");
  const pageFullscreenButton = document.querySelector("[data-page-fullscreen]");
  const shareModal = document.querySelector("[data-share-modal]");
  const shareLinkInput = document.querySelector("[data-share-link]");
  const shareCopyButton = document.querySelector("[data-share-copy]");
  const shareNativeButton = document.querySelector("[data-share-native]");
  const shareResult = document.querySelector("[data-share-result]");
  const syncThresholdInput = document.querySelector("[data-sync-threshold-input]");
  const roomLockToggle = document.querySelector("[data-room-lock-toggle]");
  const roomControlPolicyOptions = Array.from(document.querySelectorAll("[data-room-control-policy-option]"));
  const roomControlPolicyLabel = document.querySelector("[data-room-control-policy-label]");
  const roomControlPolicyDescription = document.querySelector("[data-room-control-policy-description]");
  const roomAccessLabel = document.querySelector("[data-room-access-label]");
  const roomAccessDescription = document.querySelector("[data-room-access-description]");
  const roomSecurityPanel = document.querySelector("[data-room-security-panel]");
  const roomSecuritySummary = document.querySelector("[data-room-security-summary]");
  const roomPasswordForm = document.querySelector("[data-room-password-form]");
  const roomPasswordInput = document.querySelector("[data-room-password-input]");
  const roomPasswordStatus = document.querySelector("[data-room-password-status]");
  const roomPasswordClear = document.querySelector("[data-room-password-clear]");
  const roomAdminRecoveryForm = document.querySelector("[data-room-admin-recovery-form]");
  const roomAdminRecoveryInput = document.querySelector("[data-room-admin-recovery-input]");
  const roomAdminStatus = document.querySelector("[data-room-admin-status]");
  const roomAdminStatusDescription = document.querySelector("[data-room-admin-status-description]");
  const adminRecoveryBox = document.querySelector("[data-admin-recovery-box]");
  const adminRecoveryCodeInput = document.querySelector("[data-admin-recovery-code]");
  const adminRecoveryLabel = document.querySelector("[data-admin-recovery-label]");
  const adminRecoveryCopy = document.querySelector("[data-admin-recovery-copy]");
  const confirmModal = document.querySelector("[data-room-confirm-modal]");
  const confirmTitle = document.querySelector("[data-room-confirm-title]");
  const confirmMessage = document.querySelector("[data-room-confirm-message]");
  const confirmAccept = document.querySelector("[data-room-confirm-accept]");
  const passwordModal = document.querySelector("[data-room-password-modal]");
  const roomMain = document.querySelector(".room-main");
  const joinPasswordForm = document.querySelector("[data-room-join-password-form]");
  const joinPasswordInput = document.querySelector("[data-room-join-password-input]");
  const joinPasswordMessage = document.querySelector("[data-room-password-message]");
  const joinPasswordError = document.querySelector("[data-room-password-error]");
  const roomAccessEyebrow = document.querySelector("[data-room-access-eyebrow]");
  const roomAccessTitle = document.querySelector("[data-room-access-title]");
  const roomAccessPasswordFields = document.querySelector("[data-room-password-fields]");
  const roomAccessRecoveryFields = document.querySelector("[data-room-creator-recovery-fields]");
  const roomAccessRecoveryInput = document.querySelector("[data-room-creator-recovery-input]");
  const roomAccessRecoveryError = document.querySelector("[data-room-creator-recovery-error]");
  const roomAccessSubmit = document.querySelector("[data-room-access-submit]");

  const ROOM_PASSWORD_KEY = "together-see:room-password:" + roomCode;
  const MEMBER_RECONNECT_TOKEN_KEY = "together-see:room-member-token:" + roomCode;
  const CLIENT_ID_KEY = "together-see:client-id";
  const roomCredentialStore = window.TogetherSeeCredentials?.createRoomCredentialStore?.(roomCode) || null;
  const createdRoomNavigation = params.get("created") === "1";
  const clientId = getOrCreateClientId();
  let myMemberId = getOrCreateMemberId();
  let myMemberName = getOrCreateMemberName();
  const socket = typeof window.io === "function" ? window.io({
    path: "/socket.io",
    transports: ["polling", "websocket"],
    upgrade: true,
    rememberUpgrade: false,
    timeout: 20000,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
  }) : null;

  let roomState = defaultRoomState();
  let role = "follower";
  let roomAccessGranted = false;
  let roomAccessRetryTimer = null;
  let applyingRemoteState = false;
  let applyingRemotePlayback = false;
  let remotePlaybackGuardTimer = null;
  let lastPlaybackEmitAt = 0;
  let lastPlaylistSignature = "";
  let lastActiveSourceId = null;
  function createSourceIntentGate(options) {
    const now = typeof options?.now === "function" ? options.now : Date.now;
    const pendingTimeoutMs = Math.max(1000, Number(options?.pendingTimeoutMs) || 8000);
    let generation = 0;
    let targetSourceId = "";
    let latestRevision = 0;
    let pending = null;

    function normalizeRevision(value) {
      const revision = Number(value);
      return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
    }

    function expirePending() {
      if (!pending || now() < pending.expiresAt) return false;
      generation += 1;
      targetSourceId = "";
      pending = null;
      return true;
    }

    function begin(sourceId, baseRevision, playing) {
      generation += 1;
      targetSourceId = String(sourceId || "");
      latestRevision = Math.max(latestRevision, normalizeRevision(baseRevision));
      pending = {
        generation: generation,
        targetSourceId: targetSourceId,
        baseRevision: normalizeRevision(baseRevision),
        playing: playing === true,
        expiresAt: now() + pendingTimeoutMs,
      };
      return Object.assign({}, pending);
    }

    function capture(sourceId, baseRevision, action) {
      expirePending();
      return {
        generation: generation,
        sourceId: String(sourceId || targetSourceId || ""),
        baseRevision: normalizeRevision(baseRevision),
        action: String(action || "update"),
      };
    }

    function isCurrent(context) {
      expirePending();
      return Boolean(context
        && context.generation === generation
        && (!context.sourceId || !targetSourceId || context.sourceId === targetSourceId));
    }

    function shouldIgnore(playback, options) {
      if (!playback) return true;
      expirePending();
      const context = options?.requestContext || null;
      if (context && !isCurrent(context)) return true;
      const sourceId = String(playback.activeSourceId || "");
      const revision = normalizeRevision(playback.revision);

      if (pending && sourceId && sourceId !== pending.targetSourceId) {
        const currentSourceAck = options?.allowAuthoritativeConflict === true
          && context?.action === "source"
          && isCurrent(context);
        if (!currentSourceAck) return true;
      }
      if (revision < latestRevision) return true;
      if (!pending && revision === latestRevision && sourceId && targetSourceId && sourceId !== targetSourceId) return true;
      return false;
    }

    function accept(playback) {
      if (!playback) return false;
      const sourceId = String(playback.activeSourceId || "");
      const revision = normalizeRevision(playback.revision);
      if (revision < latestRevision) return false;
      if (sourceId && sourceId !== targetSourceId) generation += 1;
      if (sourceId) targetSourceId = sourceId;
      latestRevision = Math.max(latestRevision, revision);
      pending = null;
      return true;
    }

    function cancel(context) {
      if (!isCurrent(context)) return false;
      generation += 1;
      targetSourceId = "";
      pending = null;
      return true;
    }

    function reset() {
      generation += 1;
      targetSourceId = "";
      pending = null;
    }

    return {
      begin: begin,
      capture: capture,
      isCurrent: isCurrent,
      shouldIgnore: shouldIgnore,
      accept: accept,
      cancel: cancel,
      reset: reset,
      snapshot: function () {
        expirePending();
        return {
          generation: generation,
          targetSourceId: targetSourceId,
          latestRevision: latestRevision,
          pending: pending ? Object.assign({}, pending) : null,
        };
      },
    };
  }
  const sourceIntentGate = createSourceIntentGate();
  let pendingLocalBindItem = null;
  let lastRemotePlayback = null;
  let serverTimeOffsetMs = 0;
  let syncCorrectionTimer = null;
  let syncCorrectionActive = false;
  const localSourceRegistry = new Map();
  const clientParseRecovery = window.TogetherSeeRecovery.createAttemptRegistry({ maxAttempts: 1 });
  const bilibiliSourceRefresh = window.TogetherSeeRecovery.createAttemptRegistry({ maxAttempts: 2 });
  const bilibiliSourceRefreshTimers = new Map();
  const remotePlaybackSnapshots = window.TogetherSeeRecovery.createPlaybackSnapshotQueue();
  const remotePlayOperations = window.TogetherSeeRecovery.createOperationTracker();
  const recentToasts = new Map();
  const bilibiliDanmakuCache = new Map();
  let bilibiliDanmakuLoadGeneration = 0;
  let localBufferingState = false;
  let localBufferingPublished = false;
  let localBufferingPublishTimer = null;

  const SYNC_THRESHOLD_KEY = "together-see:sync-threshold-seconds:v2";
  const DEFAULT_SOFT_SYNC_THRESHOLD = 2.5;
  const MIN_SOFT_SYNC_THRESHOLD = 0.2;
  const MAX_SOFT_SYNC_THRESHOLD = 5;
  const HARD_SYNC_EXTRA_SECONDS = 10;
  const MAX_SYNC_PLAYBACK_RATE = 3;
  const MIN_SYNC_PLAYBACK_RATE = 0.5;
  const SYNC_RATE_WINDOW_MS = 3400;
  const SOFT_SYNC_COOLDOWN_MS = 500;
  const SYNC_UNREADY_TIMEOUT_MS = 30000;
  const SYNC_RECOVERY_STABLE_MS = 15000;
  const SYNC_RECOVERY_PLAY_RETRY_MS = 5000;
  const BUFFERING_PUBLISH_DELAY_MS = 700;
  const BUFFERING_ACK_TIMEOUT_MS = 5000;
  const PLAYBACK_CONTROL_LEASE_GRACE_MS = 250;
  const localBufferingAckFlight = window.TogetherSeeRecovery.createAckSingleFlight({
    timeoutMs: BUFFERING_ACK_TIMEOUT_MS,
  });
  const MANUAL_SYNC_REASON = "manual";
  let softSyncThresholdSeconds = loadSyncThresholdSetting();
  let lastSoftSyncAt = 0;
  let remotePlaybackGesturePending = false;
  let needsAuthoritativePlaybackRestore = true;
  let lastSyncSeekAt = 0;
  let syncUnavailableSince = 0;
  let syncRecoveryActive = false;
  let syncStableSince = 0;
  let lastSyncRecoveryPlayAttemptAt = 0;
  let confirmResolver = null;
  let confirmReturnFocus = null;
  let passwordReturnFocus = null;
  let roomAdminToken = loadRoomAdminToken();
  let roomMemberReconnectToken = loadRoomMemberReconnectToken();
  let roomAdminRecoveryCode = loadRoomAdminRecoveryCode();
  let roomAdminAuthorized = false;
  let roomAdminAuthorizationKnown = false;
  let roomAdminIsCreator = false;
  let automaticAdminRecoveryAttempted = false;
  let identityFallbackAttempted = false;
  let identityFallbackTimer = null;
  let joinAttemptSequence = 0;
  let currentJoinAttemptId = "";
  let joinRequestPending = false;
  let joinRequestTimeout = null;
  let joinTimeoutRetryCount = 0;
  let roomPassword = loadRoomPassword();
  const pendingProxyTokenRequests = new Map();

  function getPublicParseAuthorizationMessage(payload) {
    const messages = {
      parse_option_missing: "未配置解析项",
      parse_option_disabled: "解析项未启用",
      parse_authorization_busy: "授权解析繁忙，请稍后再试",
      parse_source_denied: "当前视频源不在可解析范围",
      parse_authorization_failed: "授权解析失败",
    };
    if (messages[payload?.code]) return messages[payload.code];
    const detail = String(payload?.message || "");
    if (/HLS_PROXY_ALLOWED_HOSTS|生产环境.*配置/.test(detail)) return messages.parse_option_missing;
    if (/未启用/.test(detail)) return messages.parse_option_disabled;
    if (/频繁|繁忙|上限/.test(detail)) return messages.parse_authorization_busy;
    if (/白名单|本机|内网|保留地址|参数无效|不在可解析范围/.test(detail)) return messages.parse_source_denied;
    return messages.parse_authorization_failed;
  }
  stageLoadedAdminCredentials();

  function requestProxyToken(options) {
    return new Promise(function (resolve, reject) {
      if (!socket?.connected || !roomAccessGranted) {
        reject(new Error("请先进入房间后再加载代理视频"));
        return;
      }
      const requestId = window.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2));
      const timeout = window.setTimeout(function () {
        pendingProxyTokenRequests.delete(requestId);
        reject(new Error("授权解析超时"));
      }, 8000);
      pendingProxyTokenRequests.set(requestId, {
        resolve: resolve,
        reject: reject,
        timeout: timeout,
      });
      socket.emit("proxy_token_request", {
        requestId: requestId,
        roomCode: roomCode,
        routeName: options?.routeName,
        url: options?.url,
        refUrl: options?.refUrl,
      });
    });
  }

  socket?.on("proxy_token_created", function (payload) {
    const pending = pendingProxyTokenRequests.get(payload?.requestId);
    if (!pending) return;
    pendingProxyTokenRequests.delete(payload.requestId);
    window.clearTimeout(pending.timeout);
    if (payload?.success && payload.proxyUrl) pending.resolve(payload);
    else pending.reject(new Error(getPublicParseAuthorizationMessage(payload)));
  });

  window.TogetherSeeRoomProxy = { request: requestProxyToken };

  const HLS_SYNC_SEEK_COOLDOWN_MS = 2600;
  const HLS_INITIAL_SYNC_GRACE_MS = 4200;

  const DYNAMIC_PARSE_HOST_KEYWORDS = ["jx.", "jx-", "xmflv", "jsonplayer", "parse", "player"];
  const DEVICE_BOUND_SOURCE_KEYWORDS = ["bilibilidance.com", "aafun.cc", "4kvm.tv", "kvmplay.org", "bilibili", "bilivideo", "upos"];

  function getToastStack() {
    let stack = document.querySelector("[data-toast-stack]");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "toast-stack";
      stack.setAttribute("data-toast-stack", "true");
      document.body.appendChild(stack);
    }
    return stack;
  }

  function showToast(message, type, duration) {
    const toastKey = String(type || "info") + "|" + String(message || "");
    const now = Date.now();
    if (now - Number(recentToasts.get(toastKey) || 0) < 1800) return;
    recentToasts.set(toastKey, now);
    const stack = getToastStack();
    while (stack.children.length >= 4) stack.firstElementChild?.remove();
    const toast = document.createElement("div");
    const kind = type || "info";
    toast.className = "room-toast room-toast-" + kind;
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
    toast.innerHTML = '<span class="room-toast-dot" aria-hidden="true"></span><p></p><button type="button" aria-label="关闭提示">×</button>';
    toast.querySelector("p").textContent = message;
    toast.querySelector("button").addEventListener("click", function () { toast.remove(); });
    stack.appendChild(toast);
    window.setTimeout(function () { toast.classList.add("is-visible"); }, 10);
    window.setTimeout(function () {
      toast.classList.remove("is-visible");
      window.setTimeout(function () { toast.remove(); }, 220);
    }, Number(duration || (kind === "error" ? 5000 : 2800)));
  }

  function closeRoomConfirmation(result) {
    if (confirmModal) confirmModal.hidden = true;
    const resolve = confirmResolver;
    confirmResolver = null;
    const returnFocus = confirmReturnFocus;
    confirmReturnFocus = null;
    if (resolve) resolve(Boolean(result));
    window.setTimeout(function () {
      if (returnFocus?.isConnected) returnFocus.focus();
    }, 0);
  }

  function requestRoomConfirmation(options) {
    if (!confirmModal || !confirmAccept) return Promise.resolve(false);
    if (confirmResolver) closeRoomConfirmation(false);
    if (confirmTitle) confirmTitle.textContent = options?.title || "确认操作";
    if (confirmMessage) confirmMessage.textContent = options?.message || "请确认是否继续。";
    confirmAccept.textContent = options?.confirmLabel || "确认";
    confirmReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmModal.hidden = false;
    window.setTimeout(function () { confirmAccept.focus(); }, 20);
    return new Promise(function (resolve) { confirmResolver = resolve; });
  }

  function showRoomAccessGate(mode, message, invalid) {
    roomAccessGranted = false;
    window.clearTimeout(roomAccessRetryTimer);
    document.body.dataset.roomAccess = mode;
    roomMain?.setAttribute("inert", "");
    if (!passwordModal) return;
    if (passwordModal.hidden) {
      passwordReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    passwordModal.hidden = false;

    const passwordRequired = mode === "password";
    const roomMissing = mode === "missing";
    const creatorRecoveryRequired = mode === "creator_recovery";
    const retryable = mode === "retry";
    if (roomAccessPasswordFields) roomAccessPasswordFields.hidden = !passwordRequired;
    if (roomAccessRecoveryFields) roomAccessRecoveryFields.hidden = !creatorRecoveryRequired;
    if (roomAccessSubmit) {
      roomAccessSubmit.hidden = !passwordRequired && !creatorRecoveryRequired && !retryable;
      roomAccessSubmit.textContent = creatorRecoveryRequired ? "恢复并进入" : (retryable ? "重新尝试" : "验证并加入");
    }
    if (roomAccessEyebrow) {
      roomAccessEyebrow.textContent = passwordRequired ? "受保护房间" : (roomMissing ? "房间不存在" : (creatorRecoveryRequired ? "需要恢复创建者身份" : (mode === "locked" ? "房间已锁定" : (mode === "denied" ? "无法加入" : (retryable ? "连接未确认" : "正在连接")))));
    }
    if (roomAccessTitle) {
      roomAccessTitle.textContent = passwordRequired ? "输入房间密码" : (roomMissing ? "没有找到这个房间" : (creatorRecoveryRequired ? "完成创建者身份恢复" : (mode === "locked" ? "当前房间暂不开放" : (mode === "denied" ? "暂时无法进入房间" : (retryable ? "重新连接房间" : "正在进入房间")))));
    }
    if (joinPasswordMessage) {
      joinPasswordMessage.textContent = message || (passwordRequired ? "该房间需要密码才能加入。" : "正在验证房间访问状态，请稍候。");
    }
    if (joinPasswordError) joinPasswordError.textContent = invalid ? "密码不正确，请重新输入。" : "";

    updateConnectionStatus(passwordRequired ? "等待密码" : (roomMissing ? "房间不存在" : (creatorRecoveryRequired ? "等待恢复" : (mode === "locked" ? "房间已锁定" : (retryable ? "等待重试" : "正在验证")))), false);
    if (passwordRequired) {
      window.setTimeout(function () {
        if (joinPasswordInput) {
          joinPasswordInput.value = "";
          joinPasswordInput.focus();
        }
      }, 20);
    } else if (creatorRecoveryRequired) {
      if (roomAccessRecoveryError) roomAccessRecoveryError.textContent = "";
      if (roomAccessRecoveryInput && !roomAccessRecoveryInput.value && roomAdminRecoveryCode) {
        roomAccessRecoveryInput.value = roomAdminRecoveryCode;
      }
      window.setTimeout(function () { roomAccessRecoveryInput?.focus(); }, 20);
    } else if (mode === "locked" || mode === "creator_pending") {
      roomAccessRetryTimer = window.setTimeout(function () {
        if (document.body.dataset.roomAccess === mode && socket?.connected) joinCurrentRoom();
      }, 6000);
    }
  }

  function clearProtectedRoomUi(message) {
    roomState = defaultRoomState();
    role = "follower";
    lastRemotePlayback = null;
    remotePlaybackSnapshots.clear();
    remotePlayOperations.invalidate();
    remotePlaybackGesturePending = false;
    needsAuthoritativePlaybackRestore = true;
    lastPlaylistSignature = "";
    lastActiveSourceId = null;
    closeActionMenus();
    Array.from(localSourceRegistry.keys()).forEach(revokeLocalSource);
    if (playlistList) playlistList.innerHTML = "";
    if (memberList) memberList.innerHTML = "";
    if (chatFeed) chatFeed.innerHTML = "";
    if (auditLog) auditLog.innerHTML = "";
    player?.clearSource?.(message || "验证房间访问权限后才会加载视频内容。");
    updateCounts();
    updatePlaylistEmpty();
  }

  function revokeRoomAccess(mode, message, invalid) {
    resetLocalBufferingPublishState();
    clearProtectedRoomUi(message);
    showRoomAccessGate(mode, message, invalid);
  }

  function grantRoomAccess() {
    roomAccessGranted = true;
    joinTimeoutRetryCount = 0;
    window.clearTimeout(roomAccessRetryTimer);
    window.clearTimeout(identityFallbackTimer);
    identityFallbackAttempted = false;
    roomCredentialStore?.finalizeCreated(roomAdminToken, roomAdminRecoveryCode);
    document.body.dataset.roomAccess = "granted";
    roomMain?.removeAttribute("inert");
    if (passwordModal) passwordModal.hidden = true;
    if (joinPasswordInput) joinPasswordInput.value = "";
    if (joinPasswordError) joinPasswordError.textContent = "";
    passwordReturnFocus = null;
    updateConnectionStatus("已连接", true);
  }

  function trapModalFocus(event, modal) {
    if (event.key !== "Tab" || !modal || modal.hidden) return false;
    const focusable = Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
      .filter(function (node) { return !node.hidden && node.getClientRects().length > 0; });
    if (!focusable.length) return false;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return true;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
      return true;
    }
    return false;
  }

  function setInterfaceIcon(button, name) {
    if (!button) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", name === "check" ? "m5 12.5 4.2 4.2L19 7" : "m7 7 10 10M17 7 7 17");
    svg.appendChild(path);
    button.replaceChildren(svg);
  }

  async function copyInputValue(input, successMessage) {
    const value = String(input?.value || "");
    if (!value) return false;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        input.focus();
        input.select();
        document.execCommand("copy");
      }
      showToast(successMessage || "已复制", "success", 2200);
      return true;
    } catch (error) {
      input?.focus();
      input?.select();
      showToast("自动复制失败，请手动复制", "warning", 2800);
      return false;
    }
  }

  function isHttpUrlForParse(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (error) {
      return false;
    }
  }

  function containsKeywordUrl(rawUrl, keywords) {
    if (!rawUrl || !isHttpUrlForParse(rawUrl)) return false;
    const lower = String(rawUrl).toLowerCase();
    return keywords.some(function (keyword) { return lower.includes(keyword); });
  }

  function isParserWrapperUrl(rawUrl) {
    if (!rawUrl || !isHttpUrlForParse(rawUrl)) return false;
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.toLowerCase();
      const search = decodeURIComponent(url.search || "").toLowerCase();
      return search.includes("http://")
        || search.includes("https://")
        || DYNAMIC_PARSE_HOST_KEYWORDS.some(function (keyword) { return host.includes(keyword); });
    } catch (error) {
      return containsKeywordUrl(rawUrl, DYNAMIC_PARSE_HOST_KEYWORDS);
    }
  }

  function shouldClientParseSource(pageUrl, sourceUrl, parsed) {
    if (parsed?.bilibili) return false;
    if (parsed && parsed.requiresClientParse === true) return true;
    return isParserWrapperUrl(pageUrl) || containsKeywordUrl(sourceUrl, DEVICE_BOUND_SOURCE_KEYWORDS);
  }

  function getParseTypeLabel(type) {
    if (type === "hls") return "HLS/M3U8";
    if (type === "video") return "直链视频";
    if (type === "dash") return "DASH/MPD";
    if (type === "local") return "本地视频";
    return "页面链接";
  }

  function getPlaylistEntrySignature(item) {
    const localFile = item?.localFile || {};
    const bilibili = item?.bilibili || {};
    return [item?.id, item?.title, item?.pageUrl, item?.refererUrl, item?.sourceUrl, item?.sourceType, item?.requiresClientParse, item?.parseMessage, item?.finalUrl, localFile.name, localFile.size, localFile.lastModified, bilibili.bvid, bilibili.cid, bilibili.page, bilibili.quality, bilibili.qualityLabel, bilibili.danmakuAvailable].join("|");
  }

  function getPlaylistSourceIdentity(item) {
    return [item?.id || "", item?.sourceType || "", item?.sourceUrl || item?.pageUrl || ""].join("|");
  }

  function getPlaylistSignatureFromState(state) {
    const list = Array.isArray(state?.playlist) ? state.playlist : [];
    return list.map(getPlaylistEntrySignature).join("||");
  }

  function getLocalPlaylistSignature() {
    return serializePlaylist().map(getPlaylistEntrySignature).join("||");
  }

  function isPlaybackController() {
    return roomState.hostMemberId === myMemberId;
  }

  function loadRoomMemberReconnectToken() {
    try {
      return window.sessionStorage.getItem(MEMBER_RECONNECT_TOKEN_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function saveRoomMemberReconnectToken(token) {
    roomMemberReconnectToken = token || "";
    try {
      if (roomMemberReconnectToken) window.sessionStorage.setItem(MEMBER_RECONNECT_TOKEN_KEY, roomMemberReconnectToken);
      else window.sessionStorage.removeItem(MEMBER_RECONNECT_TOKEN_KEY);
    } catch (error) {}
  }

  function loadRoomAdminToken() {
    return roomCredentialStore?.loadAdminToken() || "";
  }

  function saveRoomAdminToken(token) {
    roomAdminToken = token || "";
    roomCredentialStore?.saveActiveToken(roomAdminToken);
  }

  function loadRoomAdminRecoveryCode() {
    return roomCredentialStore?.loadRecoveryCode() || "";
  }

  function stageLoadedAdminCredentials() {
    if (!roomAdminToken || !roomAdminRecoveryCode) return;
    roomCredentialStore?.saveActiveToken(roomAdminToken);
    roomCredentialStore?.saveActiveRecovery(roomAdminRecoveryCode);
  }

  function reloadPendingCreationCredentials() {
    const pending = roomCredentialStore?.getPending();
    if (!pending?.adminToken || pending.adminToken === roomAdminToken) return false;
    roomAdminToken = pending.adminToken;
    roomAdminRecoveryCode = pending.recoveryCode || roomAdminRecoveryCode;
    stageLoadedAdminCredentials();
    return true;
  }

  function saveRoomAdminRecoveryCode(code) {
    roomAdminRecoveryCode = code || "";
    roomCredentialStore?.saveActiveRecovery(roomAdminRecoveryCode);
  }

  function showAdminRecoveryCode(code, recovered) {
    if (!code) return;
    if (adminRecoveryCodeInput) adminRecoveryCodeInput.value = code;
    if (adminRecoveryLabel) adminRecoveryLabel.textContent = recovered ? "新恢复码，请重新备份" : "请单独安全备份";
    if (adminRecoveryBox) adminRecoveryBox.hidden = false;
    if (roomSecurityPanel) roomSecurityPanel.open = true;
    showToast(recovered ? "管理身份已恢复，请备份新的恢复码" : "管理恢复码已保存到当前浏览器，请另行备份", "warning", 4200);
  }

  function loadRoomPassword() {
    let password = "";
    try {
      password = window.sessionStorage.getItem(ROOM_PASSWORD_KEY) || "";
    } catch (error) {}
    if (password) {
      try { window.localStorage.removeItem(ROOM_PASSWORD_KEY); } catch (error) {}
      return password;
    }

    try {
      password = window.localStorage.getItem(ROOM_PASSWORD_KEY) || "";
      if (!password) return "";
      window.sessionStorage.setItem(ROOM_PASSWORD_KEY, password);
      window.localStorage.removeItem(ROOM_PASSWORD_KEY);
    } catch (error) {}
    return password;
  }

  function saveRoomPassword(password) {
    roomPassword = password || "";
    try {
      if (roomPassword) window.sessionStorage.setItem(ROOM_PASSWORD_KEY, roomPassword);
      else window.sessionStorage.removeItem(ROOM_PASSWORD_KEY);
    } catch (error) {}
    try { window.localStorage.removeItem(ROOM_PASSWORD_KEY); } catch (error) {}
  }

  function canControlRoom() {
    const policy = roomState.security?.controlPolicy || "host_only";
    return isPlaybackController() || policy === "everyone" || (!socket?.connected && !roomState.hostMemberId);
  }

  function getCurrentPlaybackAuthorityId() {
    const policy = roomState.security?.controlPolicy || "host_only";
    if (policy !== "everyone") return roomState.hostMemberId || "";
    const updatedBy = roomState.playback?.updatedBy || lastRemotePlayback?.updatedBy || "";
    const leaseUntil = Number(roomState.playback?.controlLeaseUntil || lastRemotePlayback?.controlLeaseUntil || 0);
    const buffering = roomState.playback?.buffering === true || lastRemotePlayback?.buffering === true;
    const authorityOnline = Boolean(updatedBy) && Array.isArray(roomState.members)
      && roomState.members.some(function (member) { return member.id === updatedBy; });
    const leaseActive = authorityOnline && (buffering || leaseUntil > getClientEstimatedServerTime() + PLAYBACK_CONTROL_LEASE_GRACE_MS);
    return leaseActive ? updatedBy : (roomState.hostMemberId || "");
  }

  function isCurrentPlaybackAuthority() {
    if (!canControlRoom()) return false;
    return getCurrentPlaybackAuthorityId() === myMemberId;
  }

  function canManageRoom() {
    return roomAdminAuthorizationKnown && roomAdminAuthorized;
  }

  function canEditPlaylistAction(action) {
    return action === "bindLocal" || canControlRoom();
  }

  function ensureRoomControl(message) {
    if (canControlRoom()) return true;
    showToast(message || "只有房主可以执行该操作", "warning", 2800);
    return false;
  }

  function ensureRoomAdmin(message) {
    if (canManageRoom()) return true;
    showToast(message || "只有当前房间管理员可以执行该操作", "warning", 2800);
    return false;
  }

  function handleRoomActionAck(state) {
    if (state) applyRemoteRoomState(state);
  }

  function addRemotePlaylistItem(payload) {
    return new Promise(function (resolve, reject) {
      if (!socket?.connected) {
        reject(new Error("房间连接已断开，请重新连接后再添加"));
        return;
      }
      const timeout = window.setTimeout(function () {
        reject(new Error("房间确认超时，请稍后重试"));
      }, 20000);
      socket.emit("playlist_add", {
        roomCode: roomCode,
        item: payload,
      }, function (state) {
        window.clearTimeout(timeout);
        if (state) handleRoomActionAck(state);
        const accepted = Array.isArray(state?.playlist)
          && state.playlist.some(function (item) { return item.id === payload.id; });
        if (!accepted) {
          reject(new Error("当前成员没有添加权限，播放列表未改变"));
          return;
        }
        resolve(state);
      });
    });
  }

  function getLatestAuditId(state) {
    const audit = Array.isArray(state?.audit) ? state.audit : [];
    return audit[audit.length - 1]?.id || "";
  }

  function hasNewAuditEntry(state, previousAuditId, action, targetId) {
    const audit = Array.isArray(state?.audit) ? state.audit : [];
    const latest = audit[audit.length - 1];
    return Boolean(latest
      && latest.id !== previousAuditId
      && latest.action === action
      && latest.actorId === myMemberId
      && (!targetId || latest.targetId === targetId));
  }

  function clampNumber(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  function loadSyncThresholdSetting() {
    try {
      return clampNumber(window.localStorage.getItem(SYNC_THRESHOLD_KEY) || DEFAULT_SOFT_SYNC_THRESHOLD, MIN_SOFT_SYNC_THRESHOLD, MAX_SOFT_SYNC_THRESHOLD);
    } catch (error) {
      return DEFAULT_SOFT_SYNC_THRESHOLD;
    }
  }

  function saveSyncThresholdSetting(value) {
    const nextValue = clampNumber(value, MIN_SOFT_SYNC_THRESHOLD, MAX_SOFT_SYNC_THRESHOLD);
    softSyncThresholdSeconds = nextValue;
    if (syncThresholdInput) syncThresholdInput.value = nextValue.toFixed(1);
    try {
      window.localStorage.setItem(SYNC_THRESHOLD_KEY, nextValue.toFixed(1));
    } catch (error) {}
    return nextValue;
  }

  function getHardSyncThreshold() {
    return Math.max(5, softSyncThresholdSeconds + HARD_SYNC_EXTRA_SECONDS);
  }

  function getClientEstimatedServerTime() {
    return Date.now() + serverTimeOffsetMs;
  }

  function getHostPlaybackRate(playback) {
    const rate = Number(playback?.playbackRate);
    return Number.isFinite(rate) && rate > 0 ? Math.min(3, Math.max(0.25, rate)) : 1;
  }

  function predictHostTime(playback) {
    if (!playback) return NaN;
    const baseTime = Number(playback.currentTime || 0);
    const updatedAt = Number(playback.updatedAt || 0);
    const rate = getHostPlaybackRate(playback);
    const elapsed = playback.playing && playback.buffering !== true && Number.isFinite(updatedAt)
      ? Math.max(0, (getClientEstimatedServerTime() - updatedAt) / 1000)
      : 0;
    const rawTarget = baseTime + elapsed * rate;
    const duration = Number(playback.duration);
    return Number.isFinite(duration) && duration > 0 ? Math.min(duration, rawTarget) : rawTarget;
  }

  function setPlaybackStatusText(text) {
    if (text && player?.setPlaybackStatus) {
      player.setPlaybackStatus(text);
    }
  }

  function setVideoPlaybackRate(rate, options) {
    if (!player?.video) return;
    if (player.setExternalPlaybackRate) {
      player.setExternalPlaybackRate(rate, options);
      return;
    }
    try { player.video.playbackRate = rate; } catch (error) {}
  }

  function resetSyncCorrectionRate(baseRate) {
    window.clearTimeout(syncCorrectionTimer);
    syncCorrectionTimer = null;
    syncCorrectionActive = false;
    setVideoPlaybackRate(baseRate || 1, { temporary: true });
  }

  function resetSyncRecoveryState() {
    syncUnavailableSince = 0;
    syncRecoveryActive = false;
    syncStableSince = 0;
    lastSyncRecoveryPlayAttemptAt = 0;
  }

  function shouldSuspendAutomaticSync(mediaReady) {
    const now = Date.now();
    if (mediaReady) {
      syncUnavailableSince = 0;
      if (!syncRecoveryActive) return false;
      if (!syncStableSince) syncStableSince = now;
      if (now - syncStableSince >= SYNC_RECOVERY_STABLE_MS) {
        resetSyncRecoveryState();
        setPlaybackStatusText("播放已稳定，自动同步已恢复");
        return false;
      }
      return true;
    }

    syncStableSince = 0;
    if (syncRecoveryActive) return true;
    if (!syncUnavailableSince) syncUnavailableSince = now;
    if (now - syncUnavailableSince < SYNC_UNREADY_TIMEOUT_MS) return false;

    syncRecoveryActive = true;
    remotePlaybackSnapshots.clearPending();
    remotePlayOperations.invalidate();
    resetSyncCorrectionRate(player?.getPreferredPlaybackRate?.() || 1);
    setPlaybackStatusText("网络不稳定，已暂停进度校准并优先恢复播放");
    return true;
  }

  function isCurrentPlaybackHls() {
    const sourceType = player?.getCurrentSourceType?.() || player?.video?.dataset?.sourceType || "";
    return sourceType === "hls";
  }

  function isMediaReadyForSync() {
    if (!player?.video || !player.video.src) return false;
    if (typeof player.isMediaReadyForSync === "function") return player.isMediaReadyForSync();
    return player.video.readyState >= 2 && !player.video.seeking;
  }

  function canSeekForSync(reason) {
    if (reason === MANUAL_SYNC_REASON || reason === "source" || reason === "client-parse") return true;
    if (reason === "hard" && Date.now() - lastSyncSeekAt <= 8000) return false;
    if (!isCurrentPlaybackHls()) return true;
    return Date.now() - lastSyncSeekAt > HLS_SYNC_SEEK_COOLDOWN_MS;
  }

  function getActivePlayerSourceId() {
    return player?.video?.dataset?.sourceId || getCurrentPlaylistItem()?.dataset?.sourceId || "";
  }

  function queueRemotePlaybackUntilReady(snapshot, message, options) {
    if (!snapshot || !remotePlaybackSnapshots.isCurrent(snapshot)) return;
    remotePlaybackSnapshots.queue(snapshot, {
      sourceId: snapshot.playback.activeSourceId || getActivePlayerSourceId(),
      allowAuthority: options?.allowAuthority === true,
    });
    if (message) setPlaybackStatusText(message);
    if (snapshot.playback.playing) {
      tryStartRemotePlayback(snapshot.playback, snapshot);
    }
  }

  function isRemotePlayAttemptCurrent(operation, snapshot, loadToken) {
    if (!remotePlayOperations.isCurrent(operation)) return false;
    if (!remotePlaybackSnapshots.isCurrent(snapshot)) return false;
    if (loadToken && !player?.isLoadTokenCurrent?.(loadToken)) return false;
    const latest = remotePlaybackSnapshots.current();
    const activeSourceId = getActivePlayerSourceId();
    return Boolean(latest?.playback?.playing
      && (!latest.playback.activeSourceId || latest.playback.activeSourceId === activeSourceId));
  }

  function tryStartRemotePlayback(playback, snapshot) {
    const currentSnapshot = snapshot || remotePlaybackSnapshots.current();
    if (!playback?.playing || !player?.video?.src || !currentSnapshot) return;
    const loadToken = player.getLoadToken?.() || null;
    const operation = remotePlayOperations.begin([
      currentSnapshot.revision,
      playback.activeSourceId || getActivePlayerSourceId(),
      loadToken?.generation || 0,
    ].join("|"));
    player.resumeBuffering?.();
    Promise.resolve(player.video.play()).then(function () {
      if (!isRemotePlayAttemptCurrent(operation, currentSnapshot, loadToken)) {
        const latest = remotePlaybackSnapshots.current();
        if (latest && !latest.playback.playing && latest.playback.activeSourceId === getActivePlayerSourceId()) {
          player.video.pause();
        }
        return;
      }
      remotePlaybackGesturePending = false;
      player.setSyncPlaybackPending?.(false);
    }).catch(function () {
      if (!isRemotePlayAttemptCurrent(operation, currentSnapshot, loadToken)) return;
      const firstNotice = !remotePlaybackGesturePending;
      remotePlaybackGesturePending = true;
      player.setSyncPlaybackPending?.(true);
      setPlaybackStatusText("点按播放器中央的播放按钮继续同步");
      if (firstNotice) showToast("浏览器需要你点按一次播放，随后会继续跟随房主", "info", 4200);
    });
  }

  function flushPendingRemotePlayback(event) {
    if (!isMediaReadyForSync()) return;
    const detail = event?.detail || {};
    const loadToken = player?.getLoadToken?.() || null;
    if (detail.generation && loadToken && detail.generation !== loadToken.generation) return;
    const sourceId = detail.source?.id || getActivePlayerSourceId();
    const pending = remotePlaybackSnapshots.peekPending();
    if (!pending) return;
    if (isCurrentPlaybackAuthority() && !pending.allowAuthority) {
      remotePlaybackSnapshots.clearPending(pending.snapshot);
      return;
    }
    const queued = remotePlaybackSnapshots.consume({ sourceId: sourceId });
    if (!queued) return;
    const age = Date.now() - queued.queuedAt;
    seekToHostPlayback(
      queued.snapshot.playback,
      age < HLS_INITIAL_SYNC_GRACE_MS ? "source" : "hls-ready",
      queued.snapshot,
    );
  }

  function applySoftSyncRate(driftSigned, hostRate) {
    if (!player?.video || !player.video.src || player.video.paused) return;
    if (isCurrentPlaybackHls() && !isMediaReadyForSync()) {
      queueRemotePlaybackUntilReady(remotePlaybackSnapshots.current(), "等待 HLS 缓存后同步");
      return;
    }
    const now = Date.now();
    if (now - lastSoftSyncAt < SOFT_SYNC_COOLDOWN_MS && syncCorrectionActive) return;

    const abs = Math.abs(driftSigned);
    const hardThreshold = getHardSyncThreshold();
    const correctionProgress = clampNumber(
      (abs - softSyncThresholdSeconds) / Math.max(0.1, hardThreshold - softSyncThresholdSeconds),
      0.08,
      1,
    );
    const nextRate = driftSigned > 0
      ? Math.min(MAX_SYNC_PLAYBACK_RATE, hostRate + (MAX_SYNC_PLAYBACK_RATE - hostRate) * correctionProgress)
      : Math.max(MIN_SYNC_PLAYBACK_RATE, hostRate - (hostRate - MIN_SYNC_PLAYBACK_RATE) * correctionProgress);

    syncCorrectionActive = true;
    lastSoftSyncAt = now;
    setVideoPlaybackRate(nextRate, { temporary: true });
    setPlaybackStatusText("线性追赶中 · " + nextRate.toFixed(2) + "x");

    window.clearTimeout(syncCorrectionTimer);
    syncCorrectionTimer = window.setTimeout(function () {
      resetSyncCorrectionRate(hostRate);
      setPlaybackStatusText("自动同步校准中");
    }, SYNC_RATE_WINDOW_MS);
  }

  function seekToHostPlayback(playback, reason, snapshot) {
    if (!playback || !player?.video || !player.video.src) return false;
    const targetTime = predictHostTime(playback);
    if (!Number.isFinite(targetTime)) return false;
    const hostRate = getHostPlaybackRate(playback);

    if (isCurrentPlaybackHls() && !isMediaReadyForSync() && reason !== MANUAL_SYNC_REASON) {
      queueRemotePlaybackUntilReady(snapshot || remotePlaybackSnapshots.current(), "等待 HLS 缓存后同步");
      resetSyncCorrectionRate(hostRate);
      return false;
    }

    if (!canSeekForSync(reason)) {
      setPlaybackStatusText("等待播放稳定后再定位进度");
      return false;
    }

    const safeTime = Math.max(0, targetTime);
    resetSyncCorrectionRate(hostRate);
    try { player.video.currentTime = safeTime; } catch (error) { return false; }
    lastSyncSeekAt = Date.now();
    setPlaybackStatusText(reason === MANUAL_SYNC_REASON ? "已手动同步到房主进度" : reason === "source" || reason === "hls-ready" ? "已定位到房主进度" : "误差较大，已跳转同步");
    if (playback.playing && player.video.paused) {
      tryStartRemotePlayback(playback, snapshot || remotePlaybackSnapshots.current());
    }
    return true;
  }

  function handleManualSyncRequest() {
    if (isCurrentPlaybackAuthority()) {
      setPlaybackStatusText("当前控制端无需手动同步");
      showToast("当前控制端无需手动同步", "info", 2200);
      return;
    }
    const playback = lastRemotePlayback || roomState.playback;
    if (!playback) {
      setPlaybackStatusText("暂未收到房主进度");
      showToast("暂未收到房主进度，稍后再试", "warning", 2600);
      return;
    }
    const ok = seekToHostPlayback(playback, MANUAL_SYNC_REASON);
    showToast(ok ? "已手动同步到房主进度" : "当前没有可同步的视频源", ok ? "success" : "warning", 2600);
  }


  function getLocalFileMeta(file) {
    if (!file) return null;
    return {
      name: file.name || "本地视频",
      size: Number(file.size || 0),
      type: file.type || "video/*",
      lastModified: Number(file.lastModified || 0),
    };
  }

  function localPlaceholderUrl(meta) {
    const name = encodeURIComponent(meta?.name || "video");
    const size = encodeURIComponent(String(meta?.size || 0));
    return "local://together-see/" + name + "?size=" + size;
  }

  function getLocalFileMetaFromItem(item) {
    if (!item || item.dataset.sourceType !== "local") return null;
    const name = item.dataset.localName || item.dataset.sourceTitle || "本地视频";
    const size = Number(item.dataset.localSize || 0);
    const lastModified = Number(item.dataset.localLastModified || 0);
    const type = item.dataset.localType || "video/*";
    return { name: name, size: size, type: type, lastModified: lastModified };
  }

  function setLocalFileMetaOnItem(item, meta) {
    if (!item || !meta) return;
    item.dataset.localName = meta.name || "本地视频";
    item.dataset.localSize = String(Number(meta.size || 0));
    item.dataset.localType = meta.type || "video/*";
    item.dataset.localLastModified = String(Number(meta.lastModified || 0));
  }

  function getCurrentPlaylistItem() {
    return document.querySelector(".playlist-list li.is-current");
  }

  function updateLocalItemReady(item) {
    if (!item || item.dataset.sourceType !== "local") return;
    item.dataset.localReady = localSourceRegistry.has(item.dataset.sourceId) ? "true" : "false";
  }

  function updateLocalVideoButtonState(item) {
    if (!localVideoButton) return;
    const current = item || getCurrentPlaylistItem();
    const needsLocalFile = Boolean(current && current.dataset.sourceType === "local" && !localSourceRegistry.has(current.dataset.sourceId));
    const canUseButton = needsLocalFile || canControlRoom();
    localVideoButton.classList.toggle("is-waiting", needsLocalFile);
    localVideoButton.disabled = !canUseButton;
    localVideoButton.textContent = needsLocalFile ? "为当前条目选择本机文件" : "选择本地视频";
    localVideoButton.title = needsLocalFile
      ? "该本地视频条目来自房间同步，需要在本机选择同一个视频文件。"
      : (canUseButton ? "添加本机视频到房间队列。文件不会上传到服务器。" : "只有房主可以添加本机视频到房间队列。");
  }

  function getSharedPayloadFromItem(item) {
    const payload = getItemPayload(item);
    if (payload.sourceType === "local") {
      const meta = payload.localFile || getLocalFileMetaFromItem(item);
      payload.localFile = meta;
      payload.sourceUrl = localPlaceholderUrl(meta);
      payload.pageUrl = payload.sourceUrl;
    } else {
      payload.title = item.dataset.sharedSourceTitle || payload.title;
      payload.sourceUrl = item.dataset.sharedSourceUrl || payload.sourceUrl;
      payload.sourceType = item.dataset.sharedSourceType || payload.sourceType;
      payload.requiresClientParse = item.dataset.sharedRequiresClientParse === "true";
      payload.parseMessage = item.dataset.sharedParseMessage || "";
      payload.finalUrl = item.dataset.sharedFinalUrl || "";
      payload.refererUrl = item.dataset.sharedRefererUrl || payload.pageUrl;
    }
    return payload;
  }

  function getPlayablePayload(item) {
    const payload = getItemPayload(item);
    if (payload.sourceType === "local") {
      const local = localSourceRegistry.get(payload.id);
      if (local?.url) {
        payload.sourceUrl = local.url;
        payload.pageUrl = local.url;
        payload.localFile = local.meta || payload.localFile;
      }
    }
    return payload;
  }

  function isDifferentLocalFile(expected, actual) {
    if (!expected || !actual) return false;
    if (expected.name && actual.name && expected.name !== actual.name) return true;
    if (Number(expected.size || 0) > 0 && Number(actual.size || 0) > 0 && Number(expected.size) !== Number(actual.size)) return true;
    return false;
  }

  function revokeLocalSource(sourceId) {
    const local = localSourceRegistry.get(sourceId);
    if (local?.url) URL.revokeObjectURL(local.url);
    localSourceRegistry.delete(sourceId);
  }

  async function bindLocalFileToItem(item, file, options) {
    if (!item || !file) return false;
    const meta = getLocalFileMeta(file);
    const expected = getLocalFileMetaFromItem(item);
    if (!options?.skipPrompt && isDifferentLocalFile(expected, meta)) {
      const ok = await requestRoomConfirmation({
        title: "文件信息不一致",
        message: "选择的文件与房间条目不完全一致，可能导致各设备时间轴不同。仍然绑定这个文件吗？",
        confirmLabel: "仍然绑定",
      });
      if (!ok || !item.isConnected) return false;
    }

    revokeLocalSource(item.dataset.sourceId);
    localSourceRegistry.set(item.dataset.sourceId, {
      file: file,
      meta: meta,
      url: URL.createObjectURL(file),
    });

    if (!expected?.name || options?.refreshMeta) {
      setLocalFileMetaOnItem(item, meta);
      item.dataset.sourceTitle = item.dataset.sourceTitle || meta.name;
      item.dataset.pageUrl = localPlaceholderUrl(meta);
      item.dataset.sourceUrl = localPlaceholderUrl(meta);
      const titleNode = item.querySelector("[data-playlist-title]");
      if (titleNode) {
        titleNode.textContent = item.dataset.sourceTitle || meta.name;
        titleNode.title = item.dataset.sourceTitle || meta.name;
      }
    }

    updateLocalItemReady(item);
    setPlaylistState(item, item.classList.contains("is-current") ? "已加载" : "本机已选择");
    updateLocalVideoButtonState(item);
    persistPlaylist();

    if (item.classList.contains("is-current") && player?.loadSource) {
      const playback = lastRemotePlayback || roomState.playback;
      const autoSyncEnabled = player.getAutoSyncEnabled?.() !== false;
      const shouldRestorePlayback = autoSyncEnabled && playback?.activeSourceId === item.dataset.sourceId;
      const predictedTime = shouldRestorePlayback ? predictHostTime(playback) : NaN;
      const localShouldPlay = !autoSyncEnabled && item.dataset.localPendingPlaying === "true";
      const pendingLocalRate = Number(item.dataset.localPendingPlaybackRate);
      const localRate = Number.isFinite(pendingLocalRate) && pendingLocalRate > 0
        ? pendingLocalRate
        : (player.getPreferredPlaybackRate?.() || player.video.playbackRate || 1);
      const loaded = player.loadSource(getPlayablePayload(item), {
        startTime: Number.isFinite(predictedTime) ? predictedTime : undefined,
        playWhenReady: shouldRestorePlayback ? playback?.playing === true : localShouldPlay,
        playbackRate: shouldRestorePlayback ? playback?.playbackRate : localRate,
      });
      delete item.dataset.localPendingPlaying;
      delete item.dataset.localPendingPlaybackRate;

      if (loaded && shouldRestorePlayback) {
        const observed = remotePlaybackSnapshots.observe(playback);
        const snapshot = observed.snapshot || remotePlaybackSnapshots.current();
        player.setDesiredPlaybackState?.(playback);
        queueRemotePlaybackUntilReady(snapshot, "本地文件加载中，稍后同步", { allowAuthority: true });
      } else if (!autoSyncEnabled) {
        player.setDesiredPlaybackState?.(null);
        remotePlaybackSnapshots.clearPending();
      }
    }
    return true;
  }

  function openLocalVideoPicker(item) {
    if (!localVideoInput) return;
    pendingLocalBindItem = item || null;
    updateLocalVideoButtonState(item);
    localVideoInput.value = "";
    localVideoInput.click();
  }

  async function addLocalVideoFile(file) {
    if (!file || !playlistList) return;
    if (!ensureRoomControl("只有房主可以把本机视频加入房间队列")) return;
    const meta = getLocalFileMeta(file);
    const sourceId = "local-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 7);
    const payload = {
      id: sourceId,
      title: meta.name,
      pageUrl: localPlaceholderUrl(meta),
      sourceUrl: localPlaceholderUrl(meta),
      sourceType: "local",
      localFile: meta,
    };

    localSourceRegistry.set(sourceId, {
      file: file,
      meta: meta,
      url: URL.createObjectURL(file),
    });

    try {
      await addRemotePlaylistItem(payload);
      const item = playlistList.querySelector('[data-source-id="' + CSS.escape(sourceId) + '"]');
      if (!item) throw new Error("房间列表尚未确认本地视频");
      setLocalFileMetaOnItem(item, meta);
      updateLocalItemReady(item);
      activatePlaylistItem(item);
      return true;
    } catch (error) {
      revokeLocalSource(sourceId);
      const message = error instanceof Error ? error.message : "本地视频加入失败";
      showToast("添加本地视频失败：" + message, "error", 4200);
      return false;
    }
  }

  function getOrCreateMemberId() {
    const key = "together-see:member-id";
    try {
      const saved = window.sessionStorage.getItem(key);
      if (saved) return saved;
      const next = "member-" + (window.crypto?.randomUUID?.() || (Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 12)));
      window.sessionStorage.setItem(key, next);
      return next;
    } catch (error) {
      return "member-" + Date.now().toString(36);
    }
  }

  function createClientId() {
    if (typeof window.crypto?.randomUUID === "function") return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof window.crypto?.getRandomValues === "function") {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, function (value) { return value.toString(16).padStart(2, "0"); }).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }

  function getOrCreateClientId() {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    try {
      const saved = window.localStorage.getItem(CLIENT_ID_KEY);
      if (uuidPattern.test(saved || "")) return saved;
      const next = createClientId();
      window.localStorage.setItem(CLIENT_ID_KEY, next);
      return next;
    } catch (error) {
      return createClientId();
    }
  }

  function replaceMemberId() {
    const next = "member-" + (window.crypto?.randomUUID?.() || (Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 12)));
    try { window.sessionStorage.setItem("together-see:member-id", next); } catch (error) {}
    myMemberId = next;
    return next;
  }

  function scheduleFreshMemberIdentityJoin(message) {
    if (identityFallbackAttempted) {
      revokeRoomAccess(
        "denied",
        "本设备的成员身份无法自动恢复，请返回首页重新加入房间，或由创建者使用恢复码恢复管理身份。",
        false,
      );
      return false;
    }
    identityFallbackAttempted = true;
    window.clearTimeout(identityFallbackTimer);
    saveRoomMemberReconnectToken("");
    saveRoomAdminToken("");
    roomAdminAuthorized = false;
    roomAdminAuthorizationKnown = false;
    roomAdminIsCreator = false;
    replaceMemberId();
    revokeRoomAccess("checking", message || "成员凭据已失效，正在申请新的房间身份。", false);
    showToast("正在使用新的成员身份重新加入", "warning", 3200);
    identityFallbackTimer = window.setTimeout(function () {
      joinCurrentRoom(roomPassword, { force: true });
    }, 260);
    return true;
  }

  function getOrCreateMemberName() {
    const queryName = (params.get("nick") || params.get("nickname") || "").trim();
    if (queryName) return queryName.slice(0, 24);
    const key = "together-see:member-name";
    try {
      const saved = window.localStorage.getItem(key);
      if (saved) return saved;
      const next = "访客" + Math.floor(1000 + Math.random() * 9000);
      window.localStorage.setItem(key, next);
      return next;
    } catch (error) {
      return "访客";
    }
  }

  function saveMemberName(name) {
    const cleanName = String(name || "").replace(/\s+/g, " ").trim().slice(0, 24);
    if (!cleanName) return false;
    myMemberName = cleanName;
    try {
      window.localStorage.setItem("together-see:member-name", cleanName);
    } catch (error) {
      // The current room session can still use the new name when storage is unavailable.
    }
    return true;
  }

  function defaultRoomState() {
    return {
      version: 1,
      savedAt: Date.now(),
      roomCode: roomCode,
      roomName: roomName,
      hostMemberId: null,
      security: { locked: false, hasPassword: false, controlPolicy: "host_only" },
      autoPlayNext: false,
      activeSourceId: null,
      playlist: [],
      members: [],
      chat: [],
      playback: null,
      audit: [],
    };
  }

  function renderRoomName() {
    document.querySelectorAll("[data-room-code]").forEach(function (node) {
      node.textContent = roomCode;
    });

    document.querySelectorAll("[data-room-code-badge]").forEach(function (node) {
      node.textContent = roomName;
    });

    document.querySelectorAll("[data-room-name-display]").forEach(function (node) {
      node.textContent = roomState.roomName || roomName;
    });

    document.title = "一起See房间 · Together See - " + (roomState.roomName || roomName);
  }

  renderRoomName();

  function updateConnectionStatus(text, connected) {
    document.querySelectorAll("[data-room-connection-status]").forEach(function (node) {
      node.textContent = text;
    });
    document.body.dataset.socketConnected = connected ? "true" : "false";
  }

  function updateRoleUi() {
    role = roomState.hostMemberId === myMemberId ? "host" : "follower";

    // 只更新明确的身份文本节点，禁止再使用 [data-room-role] 这种容易误选 body 的选择器。
    document.querySelectorAll("[data-room-role-label]").forEach(function (node) {
      node.textContent = role === "host" ? "房主" : "成员";
    });

    // body 仅保存页面状态，不再使用 data-room-role，避免 body 被当成身份文本节点。
    document.body.dataset.roomUserRole = role;
    document.body.dataset.roomLocked = roomState.security?.locked ? "true" : "false";
    document.body.removeAttribute("data-room-role");

    updatePlaybackAuthorityUi();
    updatePlaylistControlUi();
    updateRoomSecurityUi();
    if (autoPlayNextInput) {
      const canControl = canControlRoom();
      autoPlayNextInput.checked = roomState.autoPlayNext === true;
      autoPlayNextInput.disabled = !canControl;
      autoPlayNextInput.title = canControl
        ? "自动连播设置会同步给房间内所有成员"
        : "当前房间仅房主可以修改自动连播";
    }
  }

  function updatePlaybackAuthorityUi() {
    const localPlaybackAllowed = player?.getAutoSyncEnabled?.() === false;
    player?.setPlaybackControlEnabled?.(canControlRoom() || localPlaybackAllowed);
    document.querySelectorAll("[data-room-control-state]").forEach(function (node) {
      const everyoneControls = roomState.security?.controlPolicy === "everyone";
      const controlling = isCurrentPlaybackAuthority();
      node.textContent = controlling ? "控制中" : (everyoneControls ? "协作中" : "同步中");
      node.classList.toggle("live", controlling || everyoneControls);
    });
    updateMemberHostUi();
  }

  function updateRoomSecurityUi() {
    const canManage = canManageRoom();
    const locked = roomState.security?.locked === true;
    const hasPassword = roomState.security?.hasPassword === true;
    const everyoneControls = roomState.security?.controlPolicy === "everyone";
    if (roomAdminStatus && roomAdminStatusDescription) {
      if (!roomAdminAuthorizationKnown) {
        roomAdminStatus.textContent = "正在验证";
        roomAdminStatusDescription.textContent = "正在向房间服务确认当前设备的管理权限。";
      } else if (canManage) {
        roomAdminStatus.textContent = roomAdminIsCreator ? "创建者管理已启用" : "房间管理已接管";
        roomAdminStatusDescription.textContent = roomAdminIsCreator
          ? "当前设备可修改控制策略、密码、锁房状态和成员权限。"
          : "原管理员长时间离线，当前房主已接管房间设置；创建者仍可凭恢复码收回。";
      } else if (roomAdminRecoveryCode) {
        roomAdminStatus.textContent = "需要恢复";
        roomAdminStatusDescription.textContent = "已找到本机恢复码，系统会尝试恢复；也可在下方重新确认。";
      } else {
        roomAdminStatus.textContent = "只读";
        roomAdminStatusDescription.textContent = "房主先接管播放；原管理员持续离线后，当前房主才会自动接管房间设置。";
      }
    }
    document.body.dataset.roomControlPolicy = everyoneControls ? "everyone" : "host_only";
    if (roomControlPolicyLabel) roomControlPolicyLabel.textContent = everyoneControls ? "全员协作控制" : "仅房主控制";
    if (roomControlPolicyDescription) {
      roomControlPolicyDescription.textContent = everyoneControls
        ? "所有在线成员可播放、拖动和编辑队列；密码、锁房与踢人仍仅限当前管理员。"
        : "只有房主可操作播放、进度和视频队列。";
    }
    roomControlPolicyOptions.forEach(function (button) {
      const active = button.dataset.roomControlPolicyOption === (everyoneControls ? "everyone" : "host_only");
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.disabled = !canManage;
      button.title = canManage ? "切换播放控制权限" : "只有当前房间管理员可以切换控制策略";
    });
    if (roomAccessLabel) roomAccessLabel.textContent = locked ? "已锁定" : (hasPassword ? "密码加入" : "开放加入");
    if (roomAccessDescription) {
      roomAccessDescription.textContent = locked
        ? "新成员暂时无法加入；在线成员短暂断线可在宽限期内恢复，创建者仍可凭管理身份进入。"
        : (hasPassword ? "新成员需要正确密码；在线成员短暂断线可在宽限期内恢复。" : "拥有房间链接的新成员可以直接加入。");
    }
    if (roomSecuritySummary) {
      roomSecuritySummary.textContent = (everyoneControls ? "全员控制" : "房主控制")
        + " · " + (locked ? "已锁房" : (hasPassword ? "密码加入" : "开放加入"));
    }
    if (roomLockToggle) {
      roomLockToggle.disabled = !canManage;
      roomLockToggle.textContent = locked ? "解除锁定" : "锁定加入";
      roomLockToggle.title = canManage
        ? (locked ? "重新允许新成员加入" : "阻止新成员加入，并保留短暂断线重连宽限期")
        : "只有当前房间管理员可以锁定或解锁房间";
      roomLockToggle.classList.toggle("is-locked", locked);
    }
    if (roomPasswordStatus) roomPasswordStatus.textContent = hasPassword ? "已启用" : "未设置";
    if (roomPasswordForm) roomPasswordForm.hidden = !canManage;
    if (roomPasswordInput) {
      roomPasswordInput.disabled = !canManage;
      roomPasswordInput.placeholder = hasPassword ? "输入新密码以替换当前密码" : "输入至少 4 个字符";
    }
    if (roomPasswordClear) roomPasswordClear.disabled = !canManage || !hasPassword;
    if (roomAdminRecoveryForm) roomAdminRecoveryForm.hidden = canManage;
    if (roomAdminRecoveryInput) {
      roomAdminRecoveryInput.disabled = canManage || !socket?.connected;
      if (!canManage && !roomAdminRecoveryInput.value && roomAdminRecoveryCode) {
        roomAdminRecoveryInput.value = roomAdminRecoveryCode;
      }
    }
    if (canManage && roomAdminRecoveryCode) {
      if (adminRecoveryCodeInput) adminRecoveryCodeInput.value = roomAdminRecoveryCode;
      if (adminRecoveryBox) adminRecoveryBox.hidden = false;
    } else if (adminRecoveryBox) {
      adminRecoveryBox.hidden = true;
    }
  }

  function updatePlaylistControlUi() {
    const canControl = canControlRoom();
    if (playlistForm) {
      playlistForm.querySelectorAll("input, button").forEach(function (node) {
        node.disabled = !canControl;
      });
      playlistForm.title = canControl ? "" : "当前房间仅房主可以添加视频链接";
    }

    getPlaylistItems().forEach(updatePlaylistItemControlUi);
    updateLocalVideoButtonState();
  }

  function updatePlaylistItemControlUi(item) {
    if (!item) return;
    item.querySelectorAll("[data-playlist-action]").forEach(function (button) {
      const action = button.getAttribute("data-playlist-action");
      const allowed = canEditPlaylistAction(action);
      button.disabled = !allowed;
      button.title = allowed ? (button.title || button.textContent || "") : "当前房间仅房主可以编辑播放队列";
    });
    const bilibiliToggle = item.querySelector("[data-bilibili-danmaku-toggle]");
    if (bilibiliToggle) {
      bilibiliToggle.disabled = !canControlRoom();
      bilibiliToggle.title = canControlRoom() ? "同步切换当前播放项的B站原弹幕" : "当前房间仅房主可以切换B站弹幕";
    }
  }

  function getPlaylistItems() {
    return Array.from(document.querySelectorAll(".playlist-list li[data-playlist-item]"));
  }

  function updateCounts() {
    const playlistCount = getPlaylistItems().length;
    const chatCount = chatFeed ? chatFeed.querySelectorAll(".chat-line").length : 0;
    const memberCount = memberList ? memberList.querySelectorAll(".member-item").length : 0;

    document.querySelectorAll("[data-playlist-count]").forEach(function (node) {
      node.textContent = playlistCount + " 个条目";
    });

    document.querySelectorAll("[data-chat-count]").forEach(function (node) {
      node.textContent = chatCount + " 条消息";
    });

    document.querySelectorAll("[data-member-count]").forEach(function (node) {
      node.textContent = memberCount + " 人在线";
    });

    document.querySelectorAll("[data-toolbar-member-count]").forEach(function (node) {
      node.textContent = memberCount;
    });
  }

  function syncSidebarHeight() {
    if (!videoStage || !roomSidebar) return;
    const shouldStack = window.matchMedia("(max-width: 1120px)").matches;
    if (shouldStack) {
      roomSidebar.style.height = "";
      roomSidebar.style.maxHeight = "";
      return;
    }
    const stageHeight = Math.ceil(videoStage.getBoundingClientRect().height);
    if (stageHeight > 0) {
      roomSidebar.style.height = stageHeight + "px";
      roomSidebar.style.maxHeight = stageHeight + "px";
    }
  }

  function scheduleSidebarHeightSync() {
    window.requestAnimationFrame(syncSidebarHeight);
  }

  function activateTab(target) {
    tabs.forEach(function (item) {
      item.classList.toggle("active", item.getAttribute("data-room-tab") === target);
    });
    panels.forEach(function (panel) {
      panel.classList.toggle("active", panel.getAttribute("data-room-panel") === target);
    });
    scheduleSidebarHeightSync();
  }

  function scrollToBottom(node) {
    if (node) node.scrollTop = node.scrollHeight;
  }

  function formatChatTime(createdAt) {
    const timestamp = Number(createdAt);
    if (!Number.isFinite(timestamp)) return "刚刚";
    try {
      return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    } catch (error) {
      return "刚刚";
    }
  }

  function getAuditActionLabel(entry) {
    const actor = entry?.actorName || entry?.actorId || "System";
    const target = entry?.targetName || entry?.targetId || "";
    switch (entry?.action) {
      case "host_transferred":
        return actor + " 将房主转让给 " + (target || "新成员");
      case "host_failed_over":
        return "原房主离线，" + (target || "一名成员") + " 临时接管了播放";
      case "host_reclaimed":
        return (target || actor) + " 恢复了房主控制";
      case "admin_failed_over":
        return "原管理员持续离线，" + (target || "当前房主") + " 接管了房间管理";
      case "admin_reclaimed":
        return (target || actor) + " 使用恢复码收回了房间管理";
      case "room_locked":
        return actor + " 锁定了房间";
      case "room_unlocked":
        return actor + " 解锁了房间";
      case "password_set":
        return actor + " 更新了房间密码";
      case "password_cleared":
        return actor + " 清除了房间密码";
      case "member_kicked":
        return actor + " 请出了 " + (target || "一名成员");
      case "admin_token_recovered":
        return actor + " 恢复了房间管理身份";
      case "control_policy_updated":
        return actor + " 更新了房间控制策略";
      case "autoplay_next_updated":
        return actor + " 更新了房间自动连播";
      case "room_created":
        return "房间已创建";
      default:
        return entry?.detail || "房间管理操作";
    }
  }

  function getActionPopover(menu) {
    if (!menu) return null;
    return menu.__actionPopover || menu.querySelector(".action-menu-popover");
  }

  function clearActionMenuPosition(menu) {
    const popover = getActionPopover(menu);
    if (!popover) return;
    popover.style.left = "";
    popover.style.top = "";
    popover.style.right = "";
    popover.classList.remove("is-floating");
    popover.hidden = false;
    delete popover.__ownerMenu;

    // 菜单浮层打开时会临时挂到 body，关闭后再放回原按钮容器，避免被侧栏 overflow 裁切。
    if (popover.parentElement === document.body && menu) {
      menu.appendChild(popover);
    }
  }

  function closeActionMenus(exceptMenu) {
    document.querySelectorAll("[data-action-menu].is-open").forEach(function (menu) {
      if (menu === exceptMenu) return;
      menu.classList.remove("is-open");
      menu.querySelector("[data-menu-toggle]")?.setAttribute("aria-expanded", "false");
      clearActionMenuPosition(menu);
    });
  }

  function positionActionMenu(menu, trigger) {
    const popover = getActionPopover(menu);
    if (!menu || !trigger || !popover) return;

    menu.__actionPopover = popover;
    popover.__ownerMenu = menu;
    popover.hidden = false;
    popover.classList.add("is-floating");
    if (popover.parentElement !== document.body) {
      document.body.appendChild(popover);
    }

    const triggerRect = trigger.getBoundingClientRect();
    const popoverWidth = Math.max(popover.offsetWidth || 128, 128);
    const popoverHeight = Math.max(popover.offsetHeight || 120, 42);
    const gap = 6;
    const viewportPadding = 8;

    let left = triggerRect.right - popoverWidth;
    let top = triggerRect.bottom + gap;

    if (left < viewportPadding) left = viewportPadding;
    if (left + popoverWidth > window.innerWidth - viewportPadding) {
      left = window.innerWidth - popoverWidth - viewportPadding;
    }
    if (top + popoverHeight > window.innerHeight - viewportPadding) {
      top = triggerRect.top - popoverHeight - gap;
    }
    if (top < viewportPadding) top = viewportPadding;

    popover.style.left = left + "px";
    popover.style.top = top + "px";
    popover.style.right = "auto";
  }

  function toggleActionMenu(menu, trigger) {
    const willOpen = !menu?.classList.contains("is-open");
    closeActionMenus(menu);
    menu?.classList.toggle("is-open", willOpen);
    trigger?.setAttribute("aria-expanded", willOpen ? "true" : "false");
    if (willOpen) {
      window.requestAnimationFrame(function () {
        positionActionMenu(menu, trigger);
      });
    } else {
      clearActionMenuPosition(menu);
    }
  }

  function getSourceMeta(sourceType, bilibili) {
    if (bilibili) return "B站公开视频 · " + (bilibili.qualityLabel || "自动清晰度") + " · 动态签名";
    switch (sourceType) {
      case "local": return "本地视频 · 文件不上传 · 各端选择同一文件后同步";
      case "video": return "识别为直接视频源 · 可加载到播放器";
      case "hls": return "识别为 HLS/M3U8 · 兼容播放";
      case "dash": return "识别为 DASH/MPD · 后续接入 dash.js";
      case "page": return "页面链接已加入队列 · 等待后端解析视频源";
      default: return "链接已加入队列 · 等待解析视频源";
    }
  }

  function getItemPayload(item) {
    const payload = {
      id: item.dataset.sourceId,
      title: item.dataset.sourceTitle,
      pageUrl: item.dataset.pageUrl,
      refererUrl: item.dataset.refererUrl || item.dataset.pageUrl,
      sourceUrl: item.dataset.sourceUrl,
      sourceType: item.dataset.sourceType,
      requiresClientParse: item.dataset.requiresClientParse === "true",
      parseMessage: item.dataset.parseMessage || "",
      finalUrl: item.dataset.finalUrl || "",
    };
    const bilibili = getBilibiliMetaFromItem(item);
    if (bilibili) payload.bilibili = bilibili;
    if (payload.sourceType === "local") {
      payload.localFile = getLocalFileMetaFromItem(item);
    }
    return payload;
  }

  function normalizeBilibiliMeta(value) {
    if (!value || typeof value !== "object") return null;
    const bvidMatch = String(value.bvid || "").trim().match(/^bv([0-9a-z]{10})$/i);
    const cid = Number(value.cid);
    const page = Number(value.page);
    if (!bvidMatch || !Number.isSafeInteger(cid) || cid <= 0 || !Number.isSafeInteger(page) || page < 1) return null;
    return {
      bvid: "BV" + bvidMatch[1],
      cid: cid,
      page: page,
      quality: Number.isFinite(Number(value.quality)) ? Math.max(0, Math.trunc(Number(value.quality))) : 0,
      qualityLabel: String(value.qualityLabel || "自动清晰度").replace(/\s+/g, " ").trim().slice(0, 40),
      danmakuAvailable: value.danmakuAvailable !== false,
      danmakuEnabled: value.danmakuEnabled === true,
    };
  }

  function setBilibiliMetaOnItem(item, value) {
    const meta = normalizeBilibiliMeta(value);
    if (!item || !meta) return null;
    item.dataset.bilibiliBvid = meta.bvid;
    item.dataset.bilibiliCid = String(meta.cid);
    item.dataset.bilibiliPage = String(meta.page);
    item.dataset.bilibiliQuality = String(meta.quality);
    item.dataset.bilibiliQualityLabel = meta.qualityLabel;
    item.dataset.bilibiliDanmakuAvailable = meta.danmakuAvailable ? "true" : "false";
    item.dataset.bilibiliDanmakuEnabled = meta.danmakuEnabled ? "true" : "false";
    return meta;
  }

  function getBilibiliMetaFromItem(item) {
    if (!item?.dataset?.bilibiliBvid) return null;
    return normalizeBilibiliMeta({
      bvid: item.dataset.bilibiliBvid,
      cid: Number(item.dataset.bilibiliCid),
      page: Number(item.dataset.bilibiliPage),
      quality: Number(item.dataset.bilibiliQuality),
      qualityLabel: item.dataset.bilibiliQualityLabel,
      danmakuAvailable: item.dataset.bilibiliDanmakuAvailable !== "false",
      danmakuEnabled: item.dataset.bilibiliDanmakuEnabled === "true",
    });
  }

  function serializePlaylist() {
    return getPlaylistItems().map(getSharedPayloadFromItem);
  }

  function persistPlaylist() {
    roomState.playlist = serializePlaylist();
    const current = document.querySelector(".playlist-list li.is-current");
    roomState.activeSourceId = current ? current.dataset.sourceId : null;
    lastPlaylistSignature = getLocalPlaylistSignature();
    lastActiveSourceId = roomState.activeSourceId || null;
  }

  function setPlaylistState(item, label) {
    const state = item.querySelector("[data-playlist-state]");
    if (state) state.textContent = label;
  }

  function renumberPlaylist() {
    getPlaylistItems().forEach(function (item, index) {
      const indexNode = item.querySelector("[data-playlist-index]");
      if (indexNode) indexNode.textContent = String(index + 1).padStart(2, "0");
    });
  }

  function updatePlaylistEmpty() {
    if (playlistEmpty) playlistEmpty.hidden = getPlaylistItems().length > 0;
  }

  function updatePlaylistItemSourceMeta(item) {
    if (!item) return;
    const meta = item.querySelector(".playlist-copy small");
    if (meta) {
      meta.textContent = getSourceMeta(item.dataset.sourceType, getBilibiliMetaFromItem(item)) + (item.dataset.requiresClientParse === "true" ? " · 客机会本机重解" : "");
    }
  }

  function setBilibiliDanmakuStatus(item, text) {
    const status = item?.querySelector("[data-bilibili-danmaku-status]");
    if (status) status.textContent = text || "B站弹幕";
  }

  function getBilibiliDanmakuCacheKey(meta) {
    return meta ? (meta.bvid + ":" + meta.page) : "";
  }

  function fetchBilibiliDanmaku(meta) {
    const key = getBilibiliDanmakuCacheKey(meta);
    if (!key) return Promise.reject(new Error("B站弹幕参数无效"));
    if (bilibiliDanmakuCache.has(key)) return bilibiliDanmakuCache.get(key);
    const task = fetch("/api/bilibili/danmaku?bvid=" + encodeURIComponent(meta.bvid) + "&page=" + encodeURIComponent(meta.page))
      .then(function (response) {
        return response.json().catch(function () { return null; }).then(function (payload) {
          if (!response.ok || payload?.success === false || !Array.isArray(payload?.items)) {
            throw new Error(payload?.message || "B站弹幕加载失败");
          }
          return payload.items;
        });
      })
      .catch(function (error) {
        bilibiliDanmakuCache.delete(key);
        throw error;
      });
    bilibiliDanmakuCache.set(key, task);
    return task;
  }

  async function loadBilibiliTimelineForItem(item) {
    if (!item || getCurrentPlaylistItem() !== item) return;
    const meta = getBilibiliMetaFromItem(item);
    const generation = ++bilibiliDanmakuLoadGeneration;
    if (!meta?.danmakuAvailable || !meta.danmakuEnabled) {
      player?.clearTimelineDanmaku?.();
      if (meta?.danmakuAvailable) setBilibiliDanmakuStatus(item, "B站弹幕");
      return;
    }
    if (player?.isDanmakuVisible?.() === false) player.setDanmakuVisible?.(true);
    setBilibiliDanmakuStatus(item, "B站弹幕 · 加载中");
    try {
      const entries = await fetchBilibiliDanmaku(meta);
      if (generation !== bilibiliDanmakuLoadGeneration || !item.isConnected || getCurrentPlaylistItem() !== item) return;
      const currentMeta = getBilibiliMetaFromItem(item);
      if (!currentMeta?.danmakuEnabled || getBilibiliDanmakuCacheKey(currentMeta) !== getBilibiliDanmakuCacheKey(meta)) return;
      const count = player?.setTimelineDanmaku?.(entries, getBilibiliDanmakuCacheKey(meta)) || 0;
      setBilibiliDanmakuStatus(item, "B站弹幕 · " + count + "条");
    } catch (error) {
      if (generation !== bilibiliDanmakuLoadGeneration || !item.isConnected || getCurrentPlaylistItem() !== item) return;
      player?.clearTimelineDanmaku?.();
      setBilibiliDanmakuStatus(item, "B站弹幕 · 加载失败");
      showToast(error instanceof Error ? error.message : "B站弹幕加载失败", "warning", 4200);
    }
  }

  function updateBilibiliDanmakuSetting(item, enabled) {
    const meta = getBilibiliMetaFromItem(item);
    const input = item?.querySelector("[data-bilibili-danmaku-toggle]");
    if (!item || !meta?.danmakuAvailable || !input) return;
    if (!canControlRoom()) {
      input.checked = meta.danmakuEnabled;
      ensureRoomControl("当前房间仅房主可以切换B站弹幕");
      return;
    }
    if (!socket?.connected) {
      input.checked = meta.danmakuEnabled;
      showToast("服务器未连接，暂时无法同步B站弹幕开关", "warning", 2800);
      return;
    }
    const previous = meta.danmakuEnabled;
    item.dataset.bilibiliDanmakuEnabled = enabled ? "true" : "false";
    input.checked = enabled;
    if (item.classList.contains("is-current")) loadBilibiliTimelineForItem(item);
    socket.emit("playlist_bilibili_danmaku_update", {
      roomCode: roomCode,
      itemId: item.dataset.sourceId,
      enabled: enabled,
    }, function (state) {
      const remoteItem = state?.playlist?.find(function (entry) { return entry.id === item.dataset.sourceId; });
      if (remoteItem?.bilibili?.danmakuEnabled !== enabled && item.isConnected) {
        item.dataset.bilibiliDanmakuEnabled = previous ? "true" : "false";
        input.checked = previous;
        if (item.classList.contains("is-current")) loadBilibiliTimelineForItem(item);
      }
      handleRoomActionAck(state);
    });
  }

  function getClientRecoveryKey(item) {
    if (!item) return "";
    return [
      item.dataset.sourceId || "",
      item.dataset.pageUrl || "",
      item.dataset.sharedSourceUrl || item.dataset.sourceUrl || "",
      item.dataset.sharedSourceType || item.dataset.sourceType || "",
    ].join("|");
  }

  function isCurrentClientParseTarget(item, recoveryKey) {
    return Boolean(item
      && item.isConnected
      && getCurrentPlaylistItem() === item
      && getClientRecoveryKey(item) === recoveryKey);
  }

  function shouldReparseForCurrentDevice(item) {
    if (!item || isPlaybackController()) return false;
    if (item.dataset.sourceType === "local") return false;
    if (getBilibiliMetaFromItem(item)) return false;
    if (item.dataset.requiresClientParse !== "true") return false;
    if (!item.dataset.pageUrl || !isHttpUrlForParse(item.dataset.pageUrl)) return false;
    return clientParseRecovery.canBegin(getClientRecoveryKey(item));
  }

  function requestBilibiliSourceRefresh(item, reason) {
    const meta = getBilibiliMetaFromItem(item);
    if (!item || !meta || item.dataset.sourceType !== "video" || !item.dataset.pageUrl) return false;
    const recoveryKey = getClientRecoveryKey(item);
    if (!socket?.connected) {
      setPlaylistState(item, "等待刷新解析地址");
      showToast("房间服务正在重连，连接恢复后请重试播放", "warning", 3600);
      return false;
    }
    if (!bilibiliSourceRefresh.begin(recoveryKey)) return false;

    const previousSourceUrl = item.dataset.sharedSourceUrl || item.dataset.sourceUrl || "";
    item.dataset.clientParseInFlight = "true";
    setPlaylistState(item, "刷新解析地址中");
    showToast(reason || "B站播放地址可能已过期，正在安全刷新...", "info", 3200);

    const timeout = window.setTimeout(function () {
      bilibiliSourceRefreshTimers.delete(recoveryKey);
      bilibiliSourceRefresh.finish(recoveryKey, { pendingReadyNotice: false });
      if (!item.isConnected) return;
      item.dataset.clientParseInFlight = "false";
      setPlaylistState(item, "刷新解析地址超时");
      showToast("刷新解析地址超时，请稍后重试", "warning", 4200);
    }, 15000);
    bilibiliSourceRefreshTimers.set(recoveryKey, timeout);

    socket.emit("playlist_bilibili_source_refresh", {
      roomCode: roomCode,
      itemId: item.dataset.sourceId,
    }, function (state) {
      const activeTimer = bilibiliSourceRefreshTimers.get(recoveryKey);
      if (activeTimer) window.clearTimeout(activeTimer);
      bilibiliSourceRefreshTimers.delete(recoveryKey);
      bilibiliSourceRefresh.finish(recoveryKey, { pendingReadyNotice: false });
      const refreshed = state?.playlist?.find(function (entry) { return entry.id === item.dataset.sourceId; });
      const changed = Boolean(refreshed?.sourceUrl && refreshed.sourceUrl !== previousSourceUrl);
      if (item.isConnected) item.dataset.clientParseInFlight = "false";
      handleRoomActionAck(state);
      if (changed) {
        showToast("B站播放地址已刷新，正在恢复播放", "success", 3600);
      } else if (item.isConnected) {
        setPlaylistState(item, "等待重新播放");
      }
    });
    return true;
  }

  async function reparsePlaylistItemForClient(item, reason, options) {
    if (!item || !item.dataset.pageUrl) return false;
    const recoveryKey = getClientRecoveryKey(item);
    if (!clientParseRecovery.begin(recoveryKey)) return false;
    const previousPlayable = getPlayablePayload(item);
    const playerAlreadyOnItem = Boolean(
      player?.video?.src
      && player.video.dataset.sourceId === item.dataset.sourceId
    );
    item.dataset.clientParseInFlight = "true";
    setPlaylistState(item, "本机解析中");
    if (!playerAlreadyOnItem) {
      player?.showPending?.(getSharedPayloadFromItem(item), reason || "该视频源可能带有设备或时效签名，正在当前设备重新解析，避免客机黑屏。 ");
    }
    showToast(reason || "正在为当前设备重新解析视频...", "info", 2600);

    try {
      const payload = await parseVideoLink(item.dataset.pageUrl, { force: true });
      if (!isCurrentClientParseTarget(item, recoveryKey)) {
        item.dataset.clientParseInFlight = "false";
        clientParseRecovery.finish(recoveryKey, { pendingReadyNotice: false });
        return false;
      }
      item.dataset.sourceUrl = payload.sourceUrl || item.dataset.sourceUrl;
      item.dataset.sourceType = payload.sourceType || item.dataset.sourceType;
      item.dataset.parseMessage = payload.parseMessage || item.dataset.parseMessage || "";
      item.dataset.finalUrl = payload.finalUrl || item.dataset.finalUrl || "";
      item.dataset.refererUrl = payload.refererUrl || item.dataset.refererUrl || item.dataset.pageUrl;
      item.dataset.clientParsed = "true";
      item.dataset.clientParseInFlight = "false";
      if (payload.bilibili) setBilibiliMetaOnItem(item, payload.bilibili);

      if (payload.title && (!item.dataset.sourceTitle || item.dataset.sourceTitle === item.dataset.pageUrl)) {
        item.dataset.sourceTitle = payload.title;
        const titleNode = item.querySelector("[data-playlist-title]");
        if (titleNode) {
          titleNode.textContent = payload.title;
          titleNode.title = payload.title;
        }
      }

      updatePlaylistItemSourceMeta(item);
      const nextPlayable = getPlayablePayload(item);
      const sourceChanged = previousPlayable.sourceUrl !== nextPlayable.sourceUrl
        || previousPlayable.sourceType !== nextPlayable.sourceType;
      const loaded = player?.loadSource ? player.loadSource(nextPlayable, {
        forceReload: sourceChanged || !playerAlreadyOnItem,
        playWhenReady: options?.playWhenReady === true,
        playbackRate: options?.playbackRate,
      }) : false;
      loadBilibiliTimelineForItem(item);
      clientParseRecovery.finish(recoveryKey, { pendingReadyNotice: loaded });
      setPlaylistState(item, loaded ? "正在加载" : "待播放");
      if (loaded && lastRemotePlayback && !isPlaybackController() && player?.getAutoSyncEnabled?.()) {
        window.setTimeout(function () { seekToHostPlayback(lastRemotePlayback, "client-parse"); }, 300);
      }
      if (!loaded) {
        showToast("本设备解析结果暂不可播放", "warning", 3600);
      }
      return Boolean(loaded);
    } catch (error) {
      item.dataset.clientParseInFlight = "false";
      clientParseRecovery.finish(recoveryKey, { pendingReadyNotice: false });
      if (!isCurrentClientParseTarget(item, recoveryKey)) return false;
      const message = error instanceof Error ? error.message : "本设备解析失败";
      showToast("本设备解析失败：" + message, "error", 5200);
      setPlaylistState(item, "解析失败");
      if (options?.allowFallback && item.dataset.sourceUrl) {
        item.dataset.clientParsed = "true";
        const loaded = player?.loadSource ? player.loadSource(getPlayablePayload(item), {
          playWhenReady: options?.playWhenReady === true,
          playbackRate: options?.playbackRate,
        }) : false;
        loadBilibiliTimelineForItem(item);
        setPlaylistState(item, loaded ? "已加载" : "待播放");
        if (loaded && lastRemotePlayback && !isPlaybackController() && player?.getAutoSyncEnabled?.()) {
          window.setTimeout(function () { seekToHostPlayback(lastRemotePlayback, "client-parse"); }, 300);
        }
        return Boolean(loaded);
      }
      return false;
    }
  }

  function activatePlaylistItem(item, options) {
    if (!item) return;
    if (!options?.silent && !canControlRoom()) {
      if (item.dataset.sourceType === "local" && !localSourceRegistry.has(item.dataset.sourceId)) {
        openLocalVideoPicker(item);
        showToast("请选择本机对应的视频文件，播放进度仍由房主控制", "info", 3000);
      } else {
        showToast("当前房间由房主控制播放队列", "warning", 2800);
      }
      return;
    }

    const targetSourceId = item.dataset.sourceId || "";
    const previousCurrent = getCurrentPlaylistItem();
    const playerSourceId = player?.video?.dataset?.sourceId || "";
    const playerOwnsTarget = playerSourceId === targetSourceId
      && Boolean(player?.video?.src || player?.getLoadToken?.());
    const targetActivationPending = item.dataset.clientParseInFlight === "true";
    const sourceActuallyChanged = previousCurrent !== item || (!playerOwnsTarget && !targetActivationPending);
    const baseRevision = Number(roomState.playback?.revision || 0);
    const desiredPlaying = options?.playing === true || (!options?.silent && roomState.autoPlayNext === true);
    let requestContext = null;

    if (!options?.silent && sourceActuallyChanged) {
      if (socket?.connected) {
        sourceIntentGate.begin(targetSourceId, baseRevision, desiredPlaying);
        requestContext = sourceIntentGate.capture(targetSourceId, baseRevision, "source");
      }
      roomState.activeSourceId = targetSourceId;
      player?.setDesiredPlaybackState?.(Object.assign({}, roomState.playback || {}, {
        activeSourceId: targetSourceId,
        playing: desiredPlaying,
        currentTime: 0,
      }));
      remotePlayOperations.invalidate();
      remotePlaybackSnapshots.clearPending();
    } else if (options?.silent && sourceActuallyChanged && options?.authoritativePlayback) {
      sourceIntentGate.accept(options.authoritativePlayback);
    }

    getPlaylistItems().forEach(function (node) {
      const isCurrent = node === item;
      node.classList.toggle("is-current", isCurrent);
      setPlaylistState(node, isCurrent ? "当前" : "排队中");
    });

    if (player?.loadSource && sourceActuallyChanged) {
      updateLocalItemReady(item);
      const payload = getPlayablePayload(item);
      const localNeedsFile = payload.sourceType === "local" && !localSourceRegistry.has(payload.id);
      let loaded = false;
      if (localNeedsFile) {
        item.dataset.localPendingPlaying = desiredPlaying ? "true" : "false";
        item.dataset.localPendingPlaybackRate = String(Number(options?.playbackRate) || player?.getPreferredPlaybackRate?.() || 1);
        player.showPending(payload, "这是本地视频条目。文件不会上传到服务器，请在本机选择同一个视频文件后再同步播放。");
        setPlaylistState(item, "需选择文件");
        if (!options?.silent) openLocalVideoPicker(item);
      } else if (shouldReparseForCurrentDevice(item)) {
        reparsePlaylistItemForClient(item, "该视频可能带有动态签名，正在当前设备重新解析以避免黑屏。", {
          allowFallback: true,
          playWhenReady: desiredPlaying,
          playbackRate: options?.playbackRate,
        });
      } else {
        loaded = player.loadSource(payload, {
          startTime: Number.isFinite(Number(options?.startTime)) ? Number(options.startTime) : undefined,
          playWhenReady: desiredPlaying,
          playbackRate: options?.playbackRate,
        });
        setPlaylistState(item, loaded ? "已加载" : "待解析");
      }
      updateLocalVideoButtonState(item);
    }

    if (sourceActuallyChanged) loadBilibiliTimelineForItem(item);

    persistPlaylist();
    lastActiveSourceId = targetSourceId || lastActiveSourceId;
    if (!options?.silent && sourceActuallyChanged && socket?.connected) {
      socket.emit("playback_update", {
        roomCode: roomCode,
        action: "source",
        baseRevision: baseRevision,
        client: { ready: true, seeking: false },
        patch: {
          activeSourceId: targetSourceId,
          playing: desiredPlaying,
          currentTime: 0,
          duration: null,
        },
      }, function (state) { handlePlaybackUpdateAck(state, baseRevision, requestContext); });
    }
    scheduleSidebarHeightSync();
  }

  function savePlaylistItemTitle(item, cleanTitle) {
    if (!item || !cleanTitle) return;
    const titleNode = item.querySelector("[data-playlist-title]");
    item.dataset.sourceTitle = cleanTitle;
    item.dataset.sharedSourceTitle = cleanTitle;
    if (titleNode) {
      titleNode.textContent = cleanTitle;
      titleNode.title = cleanTitle;
    }

    if (item.classList.contains("is-current") && player?.loadSource) {
      player.loadSource(getItemPayload(item));
    }

    persistPlaylist();
    if (!applyingRemoteState && socket?.connected) {
      socket.emit("playlist_rename", { roomCode: roomCode, itemId: item.dataset.sourceId, title: cleanTitle }, handleRoomActionAck);
    }
  }

  function startPlaylistRename(item) {
    if (!ensureRoomControl("只有房主可以重命名播放项")) return;
    if (!item || item.querySelector(".inline-rename-form")) return;
    const oldTitle = item.dataset.sourceTitle || item.dataset.pageUrl || "未命名视频";
    const titleNode = item.querySelector("[data-playlist-title]");
    const copy = titleNode?.parentElement;
    if (!titleNode || !copy) return;

    const form = document.createElement("form");
    form.className = "inline-rename-form";
    form.setAttribute("data-inline-playlist-rename", "true");
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 160;
    input.value = oldTitle;
    input.setAttribute("aria-label", "播放项名称");
    const confirm = document.createElement("button");
    confirm.className = "inline-edit-confirm";
    confirm.type = "submit";
    setInterfaceIcon(confirm, "check");
    confirm.title = "保存";
    confirm.setAttribute("aria-label", "保存播放项名称");
    const cancel = document.createElement("button");
    cancel.className = "inline-edit-cancel";
    cancel.type = "button";
    setInterfaceIcon(cancel, "x");
    cancel.title = "取消";
    cancel.setAttribute("aria-label", "取消重命名");

    function closeEditor() {
      form.remove();
      titleNode.hidden = false;
      window.setTimeout(function () { item.querySelector("[data-menu-toggle]")?.focus(); }, 0);
    }

    form.addEventListener("click", function (event) { event.stopPropagation(); });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      event.stopPropagation();
      const cleanTitle = input.value.replace(/\s+/g, " ").trim().slice(0, 160);
      if (!cleanTitle) {
        showToast("片名不能为空", "warning", 2400);
        input.focus();
        return;
      }
      closeEditor();
      if (cleanTitle !== oldTitle) savePlaylistItemTitle(item, cleanTitle);
    });
    form.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
      }
    });
    cancel.addEventListener("click", closeEditor);

    form.appendChild(input);
    form.appendChild(confirm);
    form.appendChild(cancel);
    titleNode.hidden = true;
    copy.insertBefore(form, titleNode.nextSibling);
    input.focus();
    input.select();
  }

  function movePlaylistItem(item, direction) {
    if (!playlistList || !item) return;
    if (!ensureRoomControl("只有房主可以调整播放队列")) return;
    if (direction < 0 && item.previousElementSibling) {
      playlistList.insertBefore(item, item.previousElementSibling);
    }
    if (direction > 0 && item.nextElementSibling) {
      playlistList.insertBefore(item.nextElementSibling, item);
    }
    renumberPlaylist();
    persistPlaylist();
    if (!applyingRemoteState && socket?.connected) {
      socket.emit("playlist_move", { roomCode: roomCode, itemId: item.dataset.sourceId, direction: direction < 0 ? -1 : 1 }, handleRoomActionAck);
    }
  }

  async function deletePlaylistItem(item) {
    if (!item) return;
    if (!ensureRoomControl("只有房主可以删除播放项")) return;
    const itemTitle = item.dataset.sourceTitle || item.dataset.pageUrl || "该播放项";
    const confirmed = await requestRoomConfirmation({
      title: "删除播放项",
      message: "确定要从房间队列删除“" + itemTitle + "”吗？此操作会同步到所有成员。",
      confirmLabel: "确认删除",
    });
    if (!confirmed || !item.isConnected) return;
    const itemId = item.dataset.sourceId;
    const wasCurrent = item.classList.contains("is-current");
    const nextItem = item.nextElementSibling || item.previousElementSibling;
    revokeLocalSource(item.dataset.sourceId);
    item.remove();
    renumberPlaylist();
    updatePlaylistEmpty();
    updateCounts();

    if (wasCurrent) {
      if (nextItem) {
        activatePlaylistItem(nextItem);
      } else if (player?.showPending) {
        roomState.activeSourceId = null;
        player.showPending(null, "播放列表已清空。请从右侧重新添加一个视频链接。");
      }
    }

    persistPlaylist();
    if (!applyingRemoteState && socket?.connected) {
      socket.emit("playlist_delete", { roomCode: roomCode, itemId: itemId }, handleRoomActionAck);
    }
    scheduleSidebarHeightSync();
  }

  function bindPlaylistItem(item) {
    item.addEventListener("click", function (event) {
      const menuToggle = event.target.closest("[data-menu-toggle]");
      if (menuToggle) {
        event.stopPropagation();
        const menu = menuToggle.closest("[data-action-menu]");
        toggleActionMenu(menu, menuToggle);
        return;
      }

      const actionButton = event.target.closest("[data-playlist-action]");
      if (actionButton) {
        event.stopPropagation();
        closeActionMenus();
        const action = actionButton.getAttribute("data-playlist-action");
        if (!canEditPlaylistAction(action)) {
          ensureRoomControl("只有房主可以编辑播放队列");
          return;
        }
        if (action === "bindLocal") openLocalVideoPicker(item);
        if (action === "rename") startPlaylistRename(item);
        if (action === "delete") deletePlaylistItem(item);
        if (action === "up") movePlaylistItem(item, -1);
        if (action === "down") movePlaylistItem(item, 1);
        return;
      }
      activatePlaylistItem(item);
    });
  }

  function normalizeParsedPayload(rawLink, parsed) {
    const sourceUrl = parsed?.src || rawLink;
    const sourceType = parsed?.type || (player?.guessSourceType ? player.guessSourceType(sourceUrl) : "page");
    const payload = {
      id: "video-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 7),
      title: parsed?.title || rawLink,
      pageUrl: parsed?.pageUrl || rawLink,
      refererUrl: parsed?.refererUrl || parsed?.headers?.referer || parsed?.finalUrl || parsed?.pageUrl || rawLink,
      sourceUrl: sourceUrl,
      sourceType: sourceType,
      requiresClientParse: shouldClientParseSource(parsed?.pageUrl || rawLink, sourceUrl, parsed),
      parseMessage: parsed?.message || "",
      finalUrl: parsed?.finalUrl || "",
    };
    const bilibili = normalizeBilibiliMeta(parsed?.bilibili);
    if (bilibili) payload.bilibili = bilibili;
    return payload;
  }

  async function parseVideoLink(rawLink, options) {
    const force = Boolean(options?.force);
    const requestUrl = force ? "/api/parse?force=1" : "/api/parse";
    try {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: rawLink, force: force }),
      });
      const parsed = await response.json().catch(function () { return null; });
      if (!parsed) throw new Error("解析接口无响应");
      if (!response.ok || parsed.success === false || !parsed.src) {
        throw new Error(parsed?.message || parsed?.msg || "视频解析失败");
      }
      return normalizeParsedPayload(rawLink, parsed);
    } catch (error) {
      throw error;
    }
  }

  function addPlaylistPayload(payload, options) {
    const existing = payload.id ? playlistList?.querySelector('[data-source-id="' + CSS.escape(payload.id) + '"]') : null;
    if (existing) return existing;

    const item = createPlaylistItem(payload);
    const isFirstItem = getPlaylistItems().length === 0;
    playlistList.appendChild(item);
    updatePlaylistEmpty();
    updateCounts();
    persistPlaylist();

    if (isFirstItem || options?.activate) activatePlaylistItem(item, { silent: options?.silent });
    else scrollToBottom(document.querySelector("[data-playlist-scroll]"));
    scheduleSidebarHeightSync();
    return item;
  }

  function createPlaylistItem(payload) {
    const existingCount = getPlaylistItems().length;
    const rawLink = payload.pageUrl || payload.sourceUrl || "";
    const sourceType = payload.sourceType || (player?.guessSourceType ? player.guessSourceType(rawLink) : "page");
    const sourceId = payload.id || ("manual-" + Date.now().toString(36) + "-" + String(existingCount + 1));
    const titleText = payload.title || rawLink;

    const item = document.createElement("li");
    item.setAttribute("data-playlist-item", "true");
    item.dataset.sourceId = sourceId;
    item.dataset.sourceTitle = titleText;
    item.dataset.sharedSourceTitle = titleText;
    item.dataset.pageUrl = rawLink;
    item.dataset.refererUrl = payload.refererUrl || rawLink;
    item.dataset.sourceUrl = payload.sourceUrl || rawLink;
    item.dataset.sourceType = sourceType;
    item.dataset.sharedSourceUrl = payload.sourceUrl || rawLink;
    item.dataset.sharedSourceType = sourceType;
    item.dataset.sharedRequiresClientParse = payload.requiresClientParse ? "true" : "false";
    item.dataset.sharedParseMessage = payload.parseMessage || "";
    item.dataset.sharedFinalUrl = payload.finalUrl || "";
    item.dataset.sharedRefererUrl = payload.refererUrl || rawLink;
    item.dataset.requiresClientParse = payload.requiresClientParse ? "true" : "false";
    item.dataset.parseMessage = payload.parseMessage || "";
    item.dataset.finalUrl = payload.finalUrl || "";
    item.dataset.clientParsed = "false";
    item.dataset.clientParseInFlight = "false";
    const bilibili = setBilibiliMetaOnItem(item, payload.bilibili);
    if (sourceType === "local") {
      setLocalFileMetaOnItem(item, payload.localFile || {
        name: titleText,
        size: 0,
        type: "video/*",
        lastModified: 0,
      });
      updateLocalItemReady(item);
    }

    const index = document.createElement("span");
    index.setAttribute("data-playlist-index", "true");
    index.textContent = String(existingCount + 1).padStart(2, "0");

    const copy = document.createElement("div");
    copy.className = "playlist-copy";

    const title = document.createElement("b");
    title.setAttribute("data-playlist-title", "true");
    title.textContent = titleText;
    title.title = titleText;

    const meta = document.createElement("small");
    meta.textContent = getSourceMeta(sourceType, bilibili) + (payload.requiresClientParse ? " · 客机会本机重解" : "");

    let bilibiliToggleRow = null;
    if (bilibili?.danmakuAvailable) {
      bilibiliToggleRow = document.createElement("label");
      bilibiliToggleRow.className = "playlist-bilibili-toggle";
      bilibiliToggleRow.title = "同步显示当前B站视频的公开原弹幕";
      const bilibiliToggle = document.createElement("input");
      bilibiliToggle.type = "checkbox";
      bilibiliToggle.checked = bilibili.danmakuEnabled;
      bilibiliToggle.setAttribute("data-bilibili-danmaku-toggle", "true");
      bilibiliToggle.setAttribute("aria-label", "切换B站原弹幕");
      const toggleTrack = document.createElement("i");
      toggleTrack.setAttribute("aria-hidden", "true");
      const toggleLabel = document.createElement("span");
      toggleLabel.setAttribute("data-bilibili-danmaku-status", "true");
      toggleLabel.textContent = "B站弹幕";
      bilibiliToggleRow.appendChild(toggleLabel);
      bilibiliToggleRow.appendChild(bilibiliToggle);
      bilibiliToggleRow.appendChild(toggleTrack);
      bilibiliToggleRow.addEventListener("click", function (event) { event.stopPropagation(); });
      bilibiliToggle.addEventListener("change", function () {
        updateBilibiliDanmakuSetting(item, bilibiliToggle.checked);
      });
    }

    const actions = document.createElement("div");
    actions.className = "playlist-actions";

    const state = document.createElement("em");
    state.setAttribute("data-playlist-state", "true");
    state.textContent = existingCount === 0 ? "待播放" : "排队中";

    const menu = document.createElement("div");
    menu.className = "action-menu";
    menu.setAttribute("data-action-menu", "true");

    const menuToggle = document.createElement("button");
    menuToggle.className = "kebab-button";
    menuToggle.type = "button";
    menuToggle.setAttribute("data-menu-toggle", "true");
    menuToggle.setAttribute("aria-label", "更多播放项操作");
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.textContent = "⋯";

    const popover = document.createElement("div");
    popover.className = "action-menu-popover";
    popover.setAttribute("role", "menu");

    const menuActions = sourceType === "local"
      ? [
          ["bindLocal", "选择本机文件", "选择本机文件"],
          ["up", "排序上移", "排序上移"],
          ["down", "排序下移", "排序下移"],
          ["rename", "重命名", "重命名"],
          ["delete", "删除", "删除"],
        ]
      : [
          ["up", "排序上移", "排序上移"],
          ["down", "排序下移", "排序下移"],
          ["rename", "重命名", "重命名"],
          ["delete", "删除", "删除"],
        ];

    menuActions.forEach(function (config) {
      const button = document.createElement("button");
      button.className = "menu-action" + (config[0] === "delete" ? " danger" : "");
      button.type = "button";
      button.setAttribute("data-playlist-action", config[0]);
      button.title = config[1];
      button.textContent = config[2];
      popover.appendChild(button);
    });

    menu.appendChild(menuToggle);
    menu.appendChild(popover);
    actions.appendChild(state);
    actions.appendChild(menu);

    copy.appendChild(title);
    copy.appendChild(meta);
    if (bilibiliToggleRow) copy.appendChild(bilibiliToggleRow);
    item.appendChild(index);
    item.appendChild(copy);
    item.appendChild(actions);

    bindPlaylistItem(item);
    updatePlaylistItemControlUi(item);
    return item;
  }

  function restorePlaylist() {
    if (!playlistList || !Array.isArray(roomState.playlist)) return;
    roomState.playlist.forEach(function (payload) {
      playlistList.appendChild(createPlaylistItem(payload));
    });
    renumberPlaylist();
    updatePlaylistEmpty();
    updateCounts();
    const current = roomState.activeSourceId
      ? playlistList.querySelector('[data-source-id="' + CSS.escape(roomState.activeSourceId) + '"]')
      : getPlaylistItems()[0];
    if (current) activatePlaylistItem(current, { silent: true });
  }

  window.addEventListener("together-see:player-error", function (event) {
    const current = getCurrentPlaylistItem();
    if (!current) return;
    if (current.dataset.sourceType === "local") return;
    if (!current.dataset.pageUrl) return;
    const detail = event.detail || {};
    const sourceId = detail.source?.id || detail.sourceId || "";
    if (sourceId && current.dataset.sourceId !== sourceId) return;
    if (getBilibiliMetaFromItem(current)) {
      requestBilibiliSourceRefresh(current, "B站播放地址可能已过期，正在安全刷新...");
      return;
    }
    if (isPlaybackController()) return;
    const recoveryKey = getClientRecoveryKey(current);
    if (clientParseRecovery.canBegin(recoveryKey) && isHttpUrlForParse(current.dataset.pageUrl)) {
      current.dataset.requiresClientParse = "true";
      updatePlaylistItemSourceMeta(current);
      reparsePlaylistItemForClient(current, "当前设备加载失败，正在重新解析视频源。", { allowFallback: false });
      return;
    }
    if (clientParseRecovery.snapshot(recoveryKey).inFlight) return;
    setPlaylistState(current, "本机播放失败");
    if (clientParseRecovery.markFailureNotified(recoveryKey)) {
      showToast("当前设备仍无法播放该视频源，请让房主更换视频地址，或由维护人员检查解析项。", "error", 5600);
    }
  });

  window.addEventListener("together-see:player-source-ready", function (event) {
    const current = getCurrentPlaylistItem();
    if (!current) return;
    const detail = event.detail || {};
    const sourceId = detail.source?.id || detail.sourceId || "";
    if (sourceId && current.dataset.sourceId !== sourceId) return;
    const shouldNotify = clientParseRecovery.markReady(getClientRecoveryKey(current));
    setPlaylistState(current, "已就绪");
    if (shouldNotify) {
      showToast("本设备视频已就绪：" + getParseTypeLabel(current.dataset.sourceType), "success", 3000);
    }
  });

  if (playlistForm && playlistList) {
    playlistForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (!ensureRoomControl("只有房主可以添加视频链接")) return;
      const input = playlistForm.querySelector("input[name='videoLink']");
      const submitButton = playlistForm.querySelector("button[type='submit']");
      const rawLink = (input?.value || "").trim();
      if (!rawLink) {
        input?.focus();
        return;
      }

      try {
        new URL(rawLink);
      } catch (error) {
        input?.focus();
        return;
      }

      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "解析中";
      }
      showToast("正在解析视频链接...", "info", 1800);

      try {
        const payload = await parseVideoLink(rawLink);
        showToast("视频解析完成，正在写入房间播放列表...", "info", 1800);
        await addRemotePlaylistItem(payload);
        input.value = "";
        showToast("视频已加入房间：" + getParseTypeLabel(payload.sourceType), "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : "视频解析失败";
        showToast("添加视频失败：" + message, "error", 5200);
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = "添加链接";
        }
      }
    });
  }
  if (localVideoButton && localVideoInput) {
    localVideoButton.addEventListener("click", function () {
      const current = getCurrentPlaylistItem();
      if (current && current.dataset.sourceType === "local" && !localSourceRegistry.has(current.dataset.sourceId)) {
        openLocalVideoPicker(current);
      } else {
        if (!ensureRoomControl("只有房主可以添加本机视频到房间队列")) return;
        openLocalVideoPicker(null);
      }
    });

    localVideoInput.addEventListener("change", async function () {
      const file = localVideoInput.files && localVideoInput.files[0];
      if (!file) {
        pendingLocalBindItem = null;
        updateLocalVideoButtonState();
        return;
      }

      if (pendingLocalBindItem && pendingLocalBindItem.dataset.sourceType === "local") {
        await bindLocalFileToItem(pendingLocalBindItem, file);
      } else {
        await addLocalVideoFile(file);
      }
      pendingLocalBindItem = null;
      updateLocalVideoButtonState();
    });
  }


  function createMemberItem(member) {
    const item = document.createElement("div");
    item.className = "member-item";
    item.dataset.memberId = member.id;
    item.dataset.memberName = member.name || "访客";
    if (member.id === roomState.hostMemberId) item.setAttribute("data-host-member", "true");

    const avatar = document.createElement("span");
    avatar.className = "avatar" + (member.id === roomState.hostMemberId ? " host" : "");
    avatar.textContent = (member.name || "访").trim().slice(0, 1).toUpperCase();

    const copy = document.createElement("div");
    copy.className = "member-copy";
    const name = document.createElement("strong");
    name.setAttribute("data-member-name", "true");
    name.textContent = member.name || "访客";
    const status = document.createElement("small");
    status.textContent = member.id === roomState.hostMemberId ? "房主 / 控制中" : "同步良好";
    copy.appendChild(name);
    copy.appendChild(status);

    const actions = document.createElement("div");
    actions.className = "member-actions";
    const tag = document.createElement("span");
    tag.className = "member-tag" + (member.id === roomState.hostMemberId ? " accent" : "");
    tag.setAttribute("data-member-status", "true");
    tag.textContent = Number.isFinite(member.latencyMs) ? Math.round(member.latencyMs) + "ms" : "在线";
    actions.appendChild(tag);

    if (member.id === myMemberId) {
      const rename = document.createElement("button");
      rename.className = "member-rename-button";
      rename.type = "button";
      rename.setAttribute("data-member-rename", "true");
      rename.setAttribute("aria-label", "修改我的昵称");
      rename.title = "修改我的昵称";
      rename.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.23 5.23 18.77 8.77 8.54 19H5v-3.54L15.23 5.23zm1.42-1.42 1.12-1.12a1 1 0 0 1 1.42 0l2.12 2.12a1 1 0 0 1 0 1.42l-1.12 1.12-3.54-3.54zM4 21h16v2H4v-2z" /></svg>';
      actions.appendChild(rename);
    } else {
      const menu = document.createElement("div");
      menu.className = "action-menu";
      menu.setAttribute("data-action-menu", "true");
      const toggle = document.createElement("button");
      toggle.className = "kebab-button";
      toggle.type = "button";
      toggle.setAttribute("data-menu-toggle", "true");
      toggle.setAttribute("aria-label", "更多成员操作");
      toggle.textContent = "...";
      const popover = document.createElement("div");
      popover.className = "action-menu-popover";
      popover.setAttribute("role", "menu");
      const transfer = document.createElement("button");
      transfer.className = "menu-action";
      transfer.type = "button";
      transfer.setAttribute("data-transfer-host", "true");
      transfer.textContent = "转让";
      const kick = document.createElement("button");
      kick.className = "menu-action danger";
      kick.type = "button";
      kick.setAttribute("data-kick-member", "true");
      kick.textContent = "踢出";
      popover.appendChild(transfer);
      popover.appendChild(kick);
      menu.appendChild(toggle);
      menu.appendChild(popover);
      actions.appendChild(menu);
    }

    item.appendChild(avatar);
    item.appendChild(copy);
    item.appendChild(actions);
    return item;
  }

  function renderMembers(members) {
    if (!memberList || !Array.isArray(members)) return;
    closeActionMenus();
    memberList.innerHTML = "";
    members.forEach(function (member) {
      memberList.appendChild(createMemberItem(member));
    });
    updateMemberHostUi();
    updateCounts();
  }

  function renderAuditFromState(audit) {
    if (!auditLog) return;
    const entries = Array.isArray(audit) ? audit.slice(-8).reverse() : [];
    auditLog.innerHTML = "";
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "audit-empty";
      empty.textContent = "暂无管理操作";
      auditLog.appendChild(empty);
      return;
    }

    entries.forEach(function (entry) {
      const item = document.createElement("article");
      item.className = "audit-entry";
      const meta = document.createElement("time");
      meta.dateTime = new Date(Number(entry.createdAt) || Date.now()).toISOString();
      meta.textContent = formatChatTime(entry.createdAt);
      const title = document.createElement("strong");
      title.textContent = getAuditActionLabel(entry);
      item.title = title.textContent;
      item.appendChild(meta);
      item.appendChild(title);
      auditLog.appendChild(item);
    });
  }

  function reconcileBilibiliDanmakuFromState(state) {
    if (!playlistList || !Array.isArray(state?.playlist)) return;
    state.playlist.forEach(function (payload) {
      if (!payload?.id || !payload.bilibili) return;
      const item = playlistList.querySelector('[data-source-id="' + CSS.escape(payload.id) + '"]');
      if (!item) return;
      const previousEnabled = item.dataset.bilibiliDanmakuEnabled === "true";
      const meta = setBilibiliMetaOnItem(item, payload.bilibili);
      if (!meta) return;
      const input = item.querySelector("[data-bilibili-danmaku-toggle]");
      if (input) input.checked = meta.danmakuEnabled;
      if (previousEnabled === meta.danmakuEnabled) return;
      setBilibiliDanmakuStatus(item, meta.danmakuEnabled ? "B站弹幕 · 加载中" : "B站弹幕");
      if (item.classList.contains("is-current")) loadBilibiliTimelineForItem(item);
    });
  }

  function updatePlaylistItemFromState(item, payload) {
    if (!item || !payload?.id || item.dataset.sourceId !== payload.id) return false;
    const previousShared = getSharedPayloadFromItem(item);
    const previousBilibili = getBilibiliMetaFromItem(item);
    const nextBilibili = normalizeBilibiliMeta(payload.bilibili);
    if (getPlaylistSourceIdentity(previousShared) !== getPlaylistSourceIdentity(payload)) return false;
    if (Boolean(previousBilibili) !== Boolean(nextBilibili)) return false;

    const titleText = payload.title || payload.pageUrl || payload.sourceUrl || "未命名视频";
    const pageUrl = payload.pageUrl || payload.sourceUrl || "";
    const sourceUrl = payload.sourceUrl || pageUrl;
    const sourceType = payload.sourceType || item.dataset.sharedSourceType || item.dataset.sourceType || "page";
    const refererUrl = payload.refererUrl || pageUrl;
    const clientParsed = item.dataset.clientParsed === "true";

    item.dataset.sourceTitle = titleText;
    item.dataset.sharedSourceTitle = titleText;
    item.dataset.pageUrl = pageUrl;
    item.dataset.sharedSourceUrl = sourceUrl;
    item.dataset.sharedSourceType = sourceType;
    item.dataset.sharedRequiresClientParse = payload.requiresClientParse ? "true" : "false";
    item.dataset.sharedParseMessage = payload.parseMessage || "";
    item.dataset.sharedFinalUrl = payload.finalUrl || "";
    item.dataset.sharedRefererUrl = refererUrl;
    if (!clientParsed || sourceType === "local") {
      item.dataset.sourceUrl = sourceUrl;
      item.dataset.sourceType = sourceType;
      item.dataset.refererUrl = refererUrl;
      item.dataset.requiresClientParse = payload.requiresClientParse ? "true" : "false";
      item.dataset.parseMessage = payload.parseMessage || "";
      item.dataset.finalUrl = payload.finalUrl || "";
    }

    const title = item.querySelector("[data-playlist-title]");
    if (title) {
      title.textContent = titleText;
      title.title = titleText;
    }
    if (sourceType === "local") {
      setLocalFileMetaOnItem(item, payload.localFile || { name: titleText, size: 0, type: "video/*", lastModified: 0 });
      updateLocalItemReady(item);
    }
    if (nextBilibili) {
      const previousEnabled = previousBilibili?.danmakuEnabled === true;
      const meta = setBilibiliMetaOnItem(item, nextBilibili);
      const input = item.querySelector("[data-bilibili-danmaku-toggle]");
      if (input && meta) input.checked = meta.danmakuEnabled;
      if (meta && previousEnabled !== meta.danmakuEnabled && item.classList.contains("is-current")) {
        loadBilibiliTimelineForItem(item);
      }
    }
    updatePlaylistItemSourceMeta(item);
    updatePlaylistItemControlUi(item);
    return true;
  }

  function renderPlaylistFromState(state) {
    if (!playlistList || !Array.isArray(state.playlist)) return;
    const activeSourceId = state.playback?.activeSourceId || state.activeSourceId || null;
    const nextSignature = getPlaylistSignatureFromState(state);
    const playlistChanged = nextSignature !== lastPlaylistSignature;
    const activeChanged = activeSourceId !== lastActiveSourceId;
    const previousActive = lastActiveSourceId
      ? playlistList.querySelector('[data-source-id="' + CSS.escape(lastActiveSourceId) + '"]')
      : getCurrentPlaylistItem();
    const previousActiveIdentity = previousActive ? getPlaylistSourceIdentity(getSharedPayloadFromItem(previousActive)) : "";

    if (playlistChanged) {
      const nextSourceIds = new Set(state.playlist.map(function (item) { return item.id; }));
      Array.from(localSourceRegistry.keys()).forEach(function (sourceId) {
        if (!nextSourceIds.has(sourceId)) revokeLocalSource(sourceId);
      });
      const existingById = new Map(getPlaylistItems().map(function (item) { return [item.dataset.sourceId, item]; }));
      state.playlist.forEach(function (payload) {
        let item = existingById.get(payload.id) || null;
        if (item && !updatePlaylistItemFromState(item, payload)) {
          const replacement = createPlaylistItem(payload);
          item.replaceWith(replacement);
          item = replacement;
        }
        if (!item) item = createPlaylistItem(payload);
        playlistList.appendChild(item);
        existingById.delete(payload.id);
      });
      existingById.forEach(function (item) { item.remove(); });
      renumberPlaylist();
      updatePlaylistEmpty();
      updateCounts();
      lastPlaylistSignature = nextSignature;
    }

    const current = activeSourceId
      ? playlistList.querySelector('[data-source-id="' + CSS.escape(activeSourceId) + '"]')
      : getPlaylistItems()[0];
    getPlaylistItems().forEach(function (item) {
      const isCurrent = item === current;
      item.classList.toggle("is-current", isCurrent);
      setPlaylistState(item, isCurrent ? "当前" : "排队中");
    });
    const currentIdentity = current ? getPlaylistSourceIdentity(getSharedPayloadFromItem(current)) : "";
    const activeSourceChanged = Boolean(current && previousActive && current.dataset.sourceId === previousActive.dataset.sourceId
      && previousActiveIdentity !== currentIdentity);
    const playerSourceMissing = Boolean(current && (
      player?.video?.dataset?.sourceId !== current.dataset.sourceId || !player?.video?.src
    ));
    if (current && (activeChanged || activeSourceChanged || playerSourceMissing)) {
      const autoSyncEnabled = player?.getAutoSyncEnabled?.() !== false;
      const localWasPlaying = Boolean(player?.video?.src && !player.video.paused && !player.video.ended);
      const localRate = player?.getPreferredPlaybackRate?.() || player?.video?.playbackRate || 1;
      const remoteStartTime = autoSyncEnabled && state.playback ? predictHostTime(state.playback) : NaN;
      activatePlaylistItem(current, {
        silent: true,
        startTime: Number.isFinite(remoteStartTime) ? remoteStartTime : undefined,
        playing: autoSyncEnabled ? state.playback?.playing === true : localWasPlaying,
        playbackRate: autoSyncEnabled ? state.playback?.playbackRate : localRate,
        authoritativePlayback: state.playback,
      });
    }
    reconcileBilibiliDanmakuFromState(state);
    lastActiveSourceId = activeSourceId || current?.dataset.sourceId || null;

    roomState.playlist = Array.isArray(state.playlist) ? state.playlist : roomState.playlist;
    roomState.activeSourceId = activeSourceId || roomState.activeSourceId || null;
  }

  function applyRemoteRoomState(state, options) {
    if (!state || !state.members?.some(function (member) { return member.id === myMemberId; })) return;
    if (state.playback && sourceIntentGate.shouldIgnore(state.playback)) {
      const pendingSource = sourceIntentGate.snapshot().pending;
      const localPlayback = pendingSource
        ? Object.assign({}, roomState.playback || {}, {
          activeSourceId: pendingSource.targetSourceId,
          playing: pendingSource.playing,
          currentTime: 0,
        })
        : (roomState.playback || null);
      state = Object.assign({}, state, {
        playback: localPlayback,
        activeSourceId: localPlayback?.activeSourceId || roomState.activeSourceId || null,
      });
    }
    applyingRemoteState = true;
    try {
      if (Object.prototype.hasOwnProperty.call(state, "hostMemberId")) roomState.hostMemberId = state.hostMemberId;
      roomState.roomName = state.roomName || roomState.roomName;
      roomState.security = state.security || roomState.security || { locked: false };
      roomState.autoPlayNext = state.autoPlayNext === true;
      renderRoomName();
      roomState.members = Array.isArray(state.members) ? state.members : [];
      roomState.playlist = Array.isArray(state.playlist) ? state.playlist : roomState.playlist;
      roomState.activeSourceId = state.playback?.activeSourceId ?? null;
      if (state.playback) roomState.playback = state.playback;

      renderMembers(state.members);
      renderPlaylistFromState(state);
      renderChatFromState(state.chat);
      renderAuditFromState(state.audit);
      roomState.audit = Array.isArray(state.audit) ? state.audit : roomState.audit;
      updateRoleUi();
    } finally {
      applyingRemoteState = false;
    }

    if (state.playback) {
      const restorePlayback = options?.restorePlayback === true || needsAuthoritativePlaybackRestore;
      if (window.TogetherSeeRecovery.shouldApplyPlaybackSnapshot(state.playback, myMemberId, {
        restoreAuthoritative: restorePlayback,
      })) {
        applyRemotePlayback(state.playback, {
          allowSelf: restorePlayback,
          allowAuthority: restorePlayback,
          forceRestore: restorePlayback,
        });
      }
      if (restorePlayback) needsAuthoritativePlaybackRestore = false;
    }
  }

  function guardRemotePlaybackEvents() {
    applyingRemotePlayback = true;
    window.clearTimeout(remotePlaybackGuardTimer);
    remotePlaybackGuardTimer = window.setTimeout(function () {
      applyingRemotePlayback = false;
      remotePlaybackGuardTimer = null;
    }, 800);
  }

  function applyRemotePlayback(playback, options) {
    if (!roomAccessGranted || !playback || !player?.video) return;
    if (sourceIntentGate.shouldIgnore(playback, options)) return;
    const observed = remotePlaybackSnapshots.observe(playback);
    const snapshot = observed.accepted && observed.snapshot
      ? observed.snapshot
      : (options?.forceRestore ? remotePlaybackSnapshots.current() : null);
    if (!snapshot) return;
    const authoritativePlayback = snapshot.playback;
    sourceIntentGate.accept(authoritativePlayback);
    lastRemotePlayback = authoritativePlayback;
    roomState.playback = authoritativePlayback;
    updatePlaybackAuthorityUi();
    remotePlayOperations.invalidate();
    const video = player.video;
    const target = authoritativePlayback.activeSourceId
      ? playlistList?.querySelector('[data-source-id="' + CSS.escape(authoritativePlayback.activeSourceId) + '"]')
      : null;
    const sourceChanged = Boolean(target && (
      !target.classList.contains("is-current")
      || video.dataset.sourceId !== authoritativePlayback.activeSourceId
      || !video.src
    ));
    const autoSyncEnabled = player.getAutoSyncEnabled?.() !== false;
    if (!autoSyncEnabled) {
      if (sourceChanged) {
        const localWasPlaying = Boolean(video.src && !video.paused && !video.ended);
        const localRate = player.getPreferredPlaybackRate?.() || video.playbackRate || 1;
        activatePlaylistItem(target, {
          silent: true,
          playing: localWasPlaying,
          playbackRate: localRate,
          authoritativePlayback: authoritativePlayback,
        });
        setPlaybackStatusText("已跟随房间切换视频，自动同步保持关闭");
      }
      player.setDesiredPlaybackState?.(null);
      remotePlaybackSnapshots.clearPending();
      resetSyncCorrectionRate(player?.getPreferredPlaybackRate?.() || 1);
      resetSyncRecoveryState();
      return;
    }
    const playbackIntent = authoritativePlayback.buffering === true
      ? Object.assign({}, authoritativePlayback, { playing: false })
      : authoritativePlayback;
    player.setDesiredPlaybackState?.(playbackIntent);
    if (authoritativePlayback.updatedBy === myMemberId && !options?.allowSelf) return;

    guardRemotePlaybackEvents();
    const hostRate = getHostPlaybackRate(authoritativePlayback);
    const targetTime = predictHostTime(authoritativePlayback);
    const allowAuthority = options?.allowAuthority === true;

    if (sourceChanged) {
      resetSyncRecoveryState();
      activatePlaylistItem(target, {
        silent: true,
        startTime: Number.isFinite(targetTime) ? targetTime : undefined,
        playing: authoritativePlayback.playing === true && authoritativePlayback.buffering !== true,
        playbackRate: authoritativePlayback.playbackRate,
        authoritativePlayback: authoritativePlayback,
      });
      queueRemotePlaybackUntilReady(snapshot, "", { allowAuthority: allowAuthority });
      setPlaybackStatusText(authoritativePlayback.buffering === true
        ? "房主正在缓冲，视频就绪后继续"
        : (target?.dataset?.sourceType === "hls" ? "HLS 加载中，稍后同步" : "视频加载中，稍后同步"));
      return;
    }

    if (authoritativePlayback.buffering === true) {
      remotePlaybackGesturePending = false;
      player.setSyncPlaybackPending?.(false);
      if (!video.paused) video.pause();
      resetSyncCorrectionRate(getHostPlaybackRate(authoritativePlayback));
      remotePlaybackSnapshots.clearPending(snapshot);
      setPlaybackStatusText("房主正在缓冲，已暂停等待");
      return;
    }

    const driftSigned = Number.isFinite(targetTime) ? targetTime - (video.currentTime || 0) : NaN;
    const drift = Number.isFinite(driftSigned) ? Math.abs(driftSigned) : NaN;
    const hardThreshold = getHardSyncThreshold();
    const mediaReady = isMediaReadyForSync();
    const syncSuspended = !options?.forceRestore && shouldSuspendAutomaticSync(mediaReady);

    let queuedForReady = false;
    if (Number.isFinite(targetTime) && video.src) {
      if (syncSuspended) {
        remotePlaybackSnapshots.clearPending(snapshot);
        resetSyncCorrectionRate(hostRate);
      } else if (!mediaReady) {
        queueRemotePlaybackUntilReady(snapshot, isCurrentPlaybackHls() ? "等待 HLS 缓存后同步" : "等待视频就绪后同步", { allowAuthority: allowAuthority });
        queuedForReady = true;
      } else if (!authoritativePlayback.playing && drift > Math.min(1, softSyncThresholdSeconds)) {
        seekToHostPlayback(authoritativePlayback, "paused", snapshot);
      } else if (drift > hardThreshold) {
        seekToHostPlayback(authoritativePlayback, "hard", snapshot);
      } else if (authoritativePlayback.playing && drift > softSyncThresholdSeconds) {
        applySoftSyncRate(driftSigned, hostRate);
      } else if (!syncCorrectionActive || drift <= Math.max(0.12, softSyncThresholdSeconds * 0.35)) {
        resetSyncCorrectionRate(hostRate);
      }
    }

    if (authoritativePlayback.playing && video.paused && video.src) {
      const mayRetryRecoveryPlay = !syncSuspended
        || Date.now() - lastSyncRecoveryPlayAttemptAt >= SYNC_RECOVERY_PLAY_RETRY_MS;
      if (!queuedForReady && mayRetryRecoveryPlay) {
        lastSyncRecoveryPlayAttemptAt = syncSuspended ? Date.now() : 0;
        tryStartRemotePlayback(authoritativePlayback, snapshot);
      }
    } else if (!authoritativePlayback.playing && !video.paused) {
      remotePlaybackGesturePending = false;
      player.setSyncPlaybackPending?.(false);
      video.pause();
      player.resumeBuffering?.();
      resetSyncCorrectionRate(hostRate);
    } else if (!authoritativePlayback.playing) {
      remotePlaybackGesturePending = false;
      player.setSyncPlaybackPending?.(false);
      player.resumeBuffering?.();
      resetSyncCorrectionRate(hostRate);
    }
    if (!queuedForReady) remotePlaybackSnapshots.clearPending(snapshot);
  }

  function handleAutoSyncChange(event) {
    const enabled = event?.detail?.enabled === true;
    remotePlayOperations.invalidate();
    remotePlaybackSnapshots.clearPending();
    resetSyncCorrectionRate(player?.getPreferredPlaybackRate?.() || 1);
    resetSyncRecoveryState();
    updatePlaybackAuthorityUi();
    if (!enabled) {
      player?.setDesiredPlaybackState?.(null);
      setPlaybackStatusText("自动同步已关闭，仍跟随房间切换视频，本机进度不再校准");
      return;
    }
    const playback = lastRemotePlayback || roomState.playback;
    if (playback) {
      applyRemotePlayback(playback, {
        allowSelf: true,
        allowAuthority: true,
        forceRestore: true,
      });
    }
  }

  function getPlaybackClientHealth() {
    const health = player?.getPlaybackHealth?.() || {};
    const video = player?.video;
    return {
      ready: health.readyForAuthority === true,
      hasMetadata: Boolean(video?.src && video.readyState >= 1),
      seeking: Boolean(video?.seeking),
      buffering: health.buffering === true,
    };
  }

  function updateLocalBufferingPublishedFromAuthority() {
    const authoritativePlayback = roomState.playback;
    localBufferingPublished = authoritativePlayback?.buffering === true
      && authoritativePlayback?.updatedBy === myMemberId;
  }

  function reconcileLocalBufferingPublication() {
    if (!socket?.connected || !roomAccessGranted || !isCurrentPlaybackAuthority()) return;
    if (localBufferingState === localBufferingPublished) return;
    if (localBufferingState && player?.video?.paused) return;
    window.setTimeout(function () { publishLocalBufferingState(localBufferingState); }, 0);
  }

  function resetLocalBufferingPublishState() {
    window.clearTimeout(localBufferingPublishTimer);
    localBufferingPublishTimer = null;
    localBufferingAckFlight.reset();
    localBufferingState = player?.getPlaybackHealth?.().buffering === true;
    localBufferingPublished = false;
  }

  function publishLocalBufferingState(buffering) {
    if (!roomAccessGranted || !isCurrentPlaybackAuthority()) return false;
    if (localBufferingAckFlight.isInFlight()) return true;
    const attempt = localBufferingAckFlight.begin(function () {
      updateLocalBufferingPublishedFromAuthority();
      reconcileLocalBufferingPublication();
    });
    if (!attempt) return true;
    const sent = emitPlaybackState({
      force: true,
      action: "buffering",
      buffering: buffering === true,
      onAck: function (state) {
        if (!localBufferingAckFlight.settle(attempt)) return;
        const authoritativePlayback = state?.playback || roomState.playback;
        localBufferingPublished = authoritativePlayback?.buffering === true
          && authoritativePlayback?.updatedBy === myMemberId;
        reconcileLocalBufferingPublication();
      },
    });
    if (sent) return true;
    localBufferingAckFlight.settle(attempt);
    return false;
  }

  function handlePlayerBufferingChange(event) {
    localBufferingState = event?.detail?.buffering === true;
    window.clearTimeout(localBufferingPublishTimer);
    localBufferingPublishTimer = null;
    if (localBufferingState) {
      localBufferingPublishTimer = window.setTimeout(function () {
        localBufferingPublishTimer = null;
        if (localBufferingState && !player?.video?.paused) publishLocalBufferingState(true);
      }, BUFFERING_PUBLISH_DELAY_MS);
      return;
    }
    if (localBufferingPublished || localBufferingAckFlight.isInFlight()) publishLocalBufferingState(false);
  }

  function handlePlaybackUpdateAck(state, baseRevision, requestContext) {
    const playback = state?.playback;
    if (!playback) {
      if (requestContext?.action === "source") sourceIntentGate.cancel(requestContext);
      return;
    }
    const allowAuthoritativeConflict = requestContext?.action === "source";
    if (sourceIntentGate.shouldIgnore(playback, {
      requestContext: requestContext,
      allowAuthoritativeConflict: allowAuthoritativeConflict,
    })) return;
    const nextRevision = Number(playback.revision || 0);
    const acceptedBySelf = playback.updatedBy === myMemberId && nextRevision > baseRevision;
    if (acceptedBySelf) {
      const observed = remotePlaybackSnapshots.observe(playback);
      if (!observed.accepted || !observed.snapshot) return;
      const authoritativePlayback = observed.snapshot.playback;
      sourceIntentGate.accept(authoritativePlayback);
      roomState.playback = authoritativePlayback;
      lastRemotePlayback = authoritativePlayback;
      player?.setDesiredPlaybackState?.(authoritativePlayback);
      updatePlaybackAuthorityUi();
      return;
    }
    applyRemotePlayback(playback, {
      allowSelf: true,
      allowAuthority: true,
      forceRestore: true,
      requestContext: requestContext,
      allowAuthoritativeConflict: allowAuthoritativeConflict,
    });
  }

  function emitPlaybackState(options) {
    if (!socket?.connected || !player?.video) return false;
    if (applyingRemotePlayback && !options?.userAction) return false;
    if (!canControlRoom()) return false;
    if (options?.periodic && !isCurrentPlaybackAuthority()) return false;
    const health = getPlaybackClientHealth();
    if (options?.periodic && !health.ready) return false;
    const now = Date.now();
    if (!options?.force && now - lastPlaybackEmitAt < 350) return false;
    lastPlaybackEmitAt = now;
    const action = options?.action || (options?.periodic ? "periodic" : "seek");
    const baseRevision = Number(roomState.playback?.revision || 0);
    const current = document.querySelector(".playlist-list li.is-current");
    const authoritativeSourceId = roomState.playback?.activeSourceId || null;
    const domSourceId = current?.dataset.sourceId || null;
    const mediaSourceId = player.video.dataset.sourceId || null;
    if (action !== "source" && (!authoritativeSourceId || domSourceId !== authoritativeSourceId || mediaSourceId !== authoritativeSourceId)) return false;
    const patchSourceId = action === "source" ? (domSourceId || roomState.activeSourceId || null) : authoritativeSourceId;
    const requestContext = sourceIntentGate.capture(patchSourceId, baseRevision, action);
    const patch = {
      activeSourceId: patchSourceId,
      playing: !player.video.paused,
      buffering: action === "buffering" ? options?.buffering === true : false,
      currentTime: player.video.currentTime || 0,
      duration: Number.isFinite(player.video.duration) ? player.video.duration : null,
      playbackRate: Number.isFinite(player.video.playbackRate) ? player.video.playbackRate : 1,
    };
    remotePlayOperations.invalidate();
    socket.emit("playback_update", {
      roomCode: roomCode,
      patch: patch,
      action: action,
      baseRevision: baseRevision,
      client: {
        ready: action === "source" ? true : (action === "seek" ? health.hasMetadata : health.ready),
        seeking: health.seeking,
      },
    }, function (state) {
      handlePlaybackUpdateAck(state, baseRevision, requestContext);
      options?.onAck?.(state);
    });
    return true;
  }

  function addChatMessage(message) {
    if (!chatFeed) return;
    const article = document.createElement("article");
    const isSystem = message.kind === "system";
    article.className = "chat-line" + (message.self && !isSystem ? " self" : "") + (isSystem ? " system" : "");
    if (message.id) article.dataset.messageId = message.id;

    const meta = document.createElement("div");
    meta.className = "chat-meta";
    const sender = document.createElement("b");
    sender.textContent = message.sender || "我";
    const time = document.createElement("span");
    time.textContent = message.time || "刚刚";
    const text = document.createElement("p");
    text.textContent = message.text;

    meta.appendChild(sender);
    meta.appendChild(time);
    if (!isSystem) article.appendChild(meta);
    article.appendChild(text);
    chatFeed.appendChild(article);
    updateCounts();
    scrollToBottom(chatFeed);
    scheduleSidebarHeightSync();
  }

  function renderChatFromState(chat) {
    if (!chatFeed || !Array.isArray(chat)) return;
    chatFeed.innerHTML = "";
    chat.forEach(function (message) {
      addChatMessage({
        id: message.id,
        kind: message.kind === "system" ? "system" : "user",
        sender: message.senderName || "我",
        text: message.text || "",
        time: formatChatTime(message.createdAt),
        self: message.senderId === myMemberId,
      });
    });
    updateCounts();
    scrollToBottom(chatFeed);
    scheduleSidebarHeightSync();
  }

  function appendChatMessageFromServer(message) {
    if (!roomAccessGranted || !message || !message.id || !chatFeed) return;
    if (chatFeed.querySelector('[data-message-id="' + CSS.escape(message.id) + '"]')) return;
    addChatMessage({
      id: message.id,
      kind: message.kind === "system" ? "system" : "user",
      sender: message.senderName || "我",
      text: message.text || "",
      time: formatChatTime(message.createdAt),
      self: message.senderId === myMemberId,
    });
  }

  function openPageFullscreen() {
    const shell = document.querySelector("[data-player-shell]");
    const enabled = !shell?.classList.contains("is-page-fullscreen");
    shell?.classList.toggle("is-page-fullscreen", enabled);
    document.body.classList.toggle("has-page-player-fullscreen", enabled);
    updatePageFullscreenButton();
  }

  function updatePageFullscreenButton() {
    const active = document.querySelector("[data-player-shell]")?.classList.contains("is-page-fullscreen");
    document.querySelectorAll("[data-page-fullscreen]").forEach(function (button) {
      button.classList.toggle("is-active", Boolean(active));
      button.setAttribute("title", active ? "退出网页全屏" : "网页全屏");
      button.setAttribute("aria-label", active ? "退出网页全屏" : "网页全屏");
    });
  }

  function updateMemberHostUi() {
    if (!memberList) return;
    const canTransferHost = isPlaybackController();
    const canKickMembers = canManageRoom();
    const everyoneControls = roomState.security?.controlPolicy === "everyone";
    const activeControllerId = getCurrentPlaybackAuthorityId();
    memberList.querySelectorAll(".member-item").forEach(function (item) {
      const isHost = item.dataset.memberId === roomState.hostMemberId;
      const isActiveController = item.dataset.memberId === activeControllerId;
      item.toggleAttribute("data-host-member", isHost);
      item.querySelector(".avatar")?.classList.toggle("host", isHost);

      const statusText = item.querySelector("small");
      if (statusText) {
        statusText.textContent = isActiveController
          ? (isHost ? "房主 / 控制中" : "成员 / 控制中")
          : (isHost ? "房主 / 在线" : "同步良好");
      }

      const tag = item.querySelector("[data-member-status]");
      if (tag) tag.classList.toggle("accent", isHost || isActiveController);
      const transferButton = item.querySelector("[data-transfer-host]");
      if (transferButton) {
        transferButton.hidden = isHost || !canTransferHost;
        transferButton.disabled = isHost || !canTransferHost;
      }
      const kickButton = item.querySelector("[data-kick-member]");
      if (kickButton) {
        kickButton.hidden = isHost || !canKickMembers;
        kickButton.disabled = isHost || !canKickMembers;
      }
      const actionMenu = item.querySelector("[data-action-menu]");
      if (actionMenu) {
        actionMenu.hidden = isHost || (!canTransferHost && !canKickMembers);
        if (actionMenu.hidden) {
          actionMenu.classList.remove("is-open");
          actionMenu.querySelector("[data-menu-toggle]")?.setAttribute("aria-expanded", "false");
          clearActionMenuPosition(actionMenu);
        }
      }
    });
  }

  function startCurrentMemberRename(memberItem) {
    if (!socket?.connected) {
      showToast("房间连接尚未就绪", "warning", 2600);
      return;
    }
    const item = memberItem || memberList?.querySelector('[data-member-id="' + CSS.escape(myMemberId) + '"]');
    if (!item || item.querySelector(".inline-rename-form")) return;
    const nameNode = item.querySelector("[data-member-name]");
    const copy = nameNode?.parentElement;
    if (!nameNode || !copy) return;

    const form = document.createElement("form");
    form.className = "inline-rename-form";
    form.setAttribute("data-inline-member-rename", "true");
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 24;
    input.value = myMemberName;
    input.setAttribute("aria-label", "我的昵称");
    const confirm = document.createElement("button");
    confirm.className = "inline-edit-confirm";
    confirm.type = "submit";
    setInterfaceIcon(confirm, "check");
    confirm.title = "保存";
    confirm.setAttribute("aria-label", "保存昵称");
    const cancel = document.createElement("button");
    cancel.className = "inline-edit-cancel";
    cancel.type = "button";
    setInterfaceIcon(cancel, "x");
    cancel.title = "取消";
    cancel.setAttribute("aria-label", "取消修改昵称");

    function closeEditor() {
      form.remove();
      nameNode.hidden = false;
      window.setTimeout(function () { memberItem.querySelector("[data-member-rename]")?.focus(); }, 0);
    }

    form.addEventListener("click", function (event) { event.stopPropagation(); });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      event.stopPropagation();
      const nextName = input.value.replace(/\s+/g, " ").trim().slice(0, 24);
      if (!nextName) {
        showToast("昵称不能为空", "warning", 2400);
        input.focus();
        return;
      }
      if (nextName === myMemberName) {
        closeEditor();
        return;
      }
      form.querySelectorAll("input, button").forEach(function (node) { node.disabled = true; });
      socket.emit("member_rename", { roomCode: roomCode, name: nextName }, function (state) {
        const renamedMember = state?.members?.find(function (member) { return member.id === myMemberId; });
        if (renamedMember?.name !== nextName) {
          form.querySelectorAll("input, button").forEach(function (node) { node.disabled = false; });
          return;
        }
        saveMemberName(renamedMember.name);
        handleRoomActionAck(state);
        window.setTimeout(function () {
          memberList?.querySelector('[data-member-id="' + CSS.escape(myMemberId) + '"] [data-member-rename]')?.focus();
        }, 0);
        showToast("昵称已更新", "success", 2400);
      });
    });
    form.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
      }
    });
    cancel.addEventListener("click", closeEditor);

    form.appendChild(input);
    form.appendChild(confirm);
    form.appendChild(cancel);
    nameNode.hidden = true;
    copy.insertBefore(form, nameNode.nextSibling);
    input.focus();
    input.select();
  }

  async function transferHost(targetItem) {
    if (!targetItem) return;
    if (!isPlaybackController()) {
      showToast("只有当前房主可以转让房主身份", "warning", 2800);
      return;
    }
    const memberName = targetItem.dataset.memberName || "该成员";
    const confirmed = await requestRoomConfirmation({
      title: "转让房主",
      message: "确定将房主身份转让给“" + memberName + "”吗？转让后，仅房主控制模式下你将失去播放和队列控制权。",
      confirmLabel: "确认转让",
    });
    if (!confirmed || !targetItem.isConnected) return;
    if (!socket?.connected) return;
    const targetMemberId = targetItem.dataset.memberId;
    const previousAuditId = getLatestAuditId(roomState);
    socket.emit("transfer_host", { roomCode: roomCode, memberId: targetMemberId }, function (state) {
      handleRoomActionAck(state);
      if (state?.hostMemberId === targetMemberId && hasNewAuditEntry(state, previousAuditId, "host_transferred", targetMemberId)) {
        showToast("房主已转让给 " + memberName, "success", 2800);
      }
    });
  }

  function toggleRoomLock() {
    if (!ensureRoomAdmin("只有当前房间管理员可以锁定或解锁房间")) return;
    const nextLocked = !(roomState.security?.locked === true);
    if (!socket?.connected) return;
    const previousAuditId = getLatestAuditId(roomState);
    roomLockToggle.disabled = true;
    socket.emit("room_lock_update", { roomCode: roomCode, locked: nextLocked, adminToken: roomAdminToken }, function (state) {
      handleRoomActionAck(state);
      const expectedAction = nextLocked ? "room_locked" : "room_unlocked";
      if (state?.security?.locked === nextLocked && hasNewAuditEntry(state, previousAuditId, expectedAction)) {
        showToast(nextLocked ? "房间已锁定，新成员暂时无法加入" : "房间已解锁，新成员可以加入", "success", 2600);
      }
      updateRoomSecurityUi();
    });
  }

  function setRoomControlPolicy(nextPolicy) {
    if (!ensureRoomAdmin("只有当前房间管理员可以切换控制策略")) return;
    const currentPolicy = roomState.security?.controlPolicy || "host_only";
    const cleanPolicy = nextPolicy === "everyone" ? "everyone" : "host_only";
    if (cleanPolicy === currentPolicy || !socket?.connected) return;
    const previousAuditId = getLatestAuditId(roomState);
    roomControlPolicyOptions.forEach(function (button) { button.disabled = true; });
    socket.emit("room_control_policy_update", { roomCode: roomCode, controlPolicy: cleanPolicy, adminToken: roomAdminToken }, function (state) {
      handleRoomActionAck(state);
      if (state?.security?.controlPolicy === cleanPolicy && hasNewAuditEntry(state, previousAuditId, "control_policy_updated")) {
        showToast(cleanPolicy === "everyone" ? "已允许所有成员协作控制播放和队列" : "已切回仅房主控制", "success", 2800);
      }
      updateRoomSecurityUi();
    });
  }

  function updateRoomPassword(nextPassword) {
    if (!ensureRoomAdmin("只有当前房间管理员可以设置房间密码")) return;
    const cleanPassword = String(nextPassword || "").trim().slice(0, 80);
    if (cleanPassword && cleanPassword.length < 4) {
      showToast("房间密码至少 4 个字符", "warning", 2600);
      roomPasswordInput?.focus();
      return;
    }
    if (socket?.connected) {
      const previousAudit = Array.isArray(roomState.audit) ? roomState.audit[roomState.audit.length - 1] : null;
      const previousAuditId = previousAudit?.id || "";
      socket.emit("room_password_update", { roomCode: roomCode, password: cleanPassword, adminToken: roomAdminToken }, function (state) {
        handleRoomActionAck(state);
        const expected = Boolean(cleanPassword);
        const latestAudit = Array.isArray(state?.audit) ? state.audit[state.audit.length - 1] : null;
        const expectedAction = expected ? "password_set" : "password_cleared";
        const confirmed = state?.security?.hasPassword === expected
          && latestAudit?.id !== previousAuditId
          && latestAudit?.action === expectedAction
          && latestAudit?.actorId === myMemberId;
        if (confirmed) {
          saveRoomPassword(cleanPassword);
          if (roomPasswordInput) roomPasswordInput.value = "";
          showToast(cleanPassword ? "房间密码已更新" : "房间密码已清除", "success", 2600);
        }
        updateRoomSecurityUi();
      });
    }
  }

  function recoverRoomAdmin(recoveryCode, options) {
    const errorNode = options?.errorNode || null;
    const focusTarget = options?.input || roomAdminRecoveryInput;
    const quiet = options?.quiet === true;
    if (!socket?.connected) {
      if (errorNode) errorNode.textContent = "服务器未连接，请稍后重试。";
      else if (!quiet) showToast("服务器未连接，暂时无法恢复管理身份", "warning", 2600);
      options?.onFailure?.({ message: "服务器未连接，请稍后重试。" });
      return false;
    }
    const cleanCode = String(recoveryCode || "").trim().slice(0, 120);
    if (!cleanCode) {
      if (errorNode) errorNode.textContent = "请输入管理恢复码。";
      else if (!quiet) showToast("请输入恢复码", "warning", 2400);
      if (!quiet) focusTarget?.focus();
      options?.onFailure?.({ message: "请输入管理恢复码。" });
      return false;
    }
    if (errorNode) errorNode.textContent = "";
    socket.emit("recover_admin_token", {
      roomCode: roomCode,
      recoveryCode: cleanCode,
      memberId: myMemberId,
      name: myMemberName,
    }, function (result) {
      if (result?.state) handleRoomActionAck(result.state);
      if (result?.ok === false) {
        if (errorNode) errorNode.textContent = result.message || "恢复码无效或房间不存在";
        else if (!quiet) showToast(result.message || "恢复码无效或房间不存在", "warning", 3200);
        if (!quiet) focusTarget?.focus();
        options?.onFailure?.(result);
      } else if (result?.ok === true) {
        if (options?.input) options.input.value = "";
        else if (roomAdminRecoveryInput) roomAdminRecoveryInput.value = "";
        options?.onSuccess?.(result);
      }
    });
    return true;
  }

  function maybeRecoverStoredAdmin(options) {
    if (roomAdminAuthorized || automaticAdminRecoveryAttempted || !roomAdminRecoveryCode || !socket?.connected) return false;
    automaticAdminRecoveryAttempted = true;
    roomAdminAuthorized = false;
    saveRoomAdminToken("");
    updateRoomSecurityUi();
    return recoverRoomAdmin(roomAdminRecoveryCode, {
      quiet: true,
      onSuccess: function (result) {
        options?.onSuccess?.(result);
      },
      onFailure: function (result) {
        options?.onFailure?.(result);
      },
    });
  }

  async function kickMember(targetItem) {
    if (!targetItem) return;
    if (!ensureRoomAdmin("只有当前房间管理员可以踢出成员")) return;
    const memberId = targetItem.dataset.memberId;
    if (!memberId || memberId === myMemberId) return;
    const memberName = targetItem.dataset.memberName || "该成员";
    const confirmed = await requestRoomConfirmation({
      title: "请出成员",
      message: "确定要将“" + memberName + "”请出房间吗？该成员短时间内无法重新加入。",
      confirmLabel: "确认请出",
    });
    if (!confirmed) return;
    if (socket?.connected) {
      const previousAuditId = getLatestAuditId(roomState);
      socket.emit("kick_member", { roomCode: roomCode, memberId: memberId, adminToken: roomAdminToken }, function (state) {
        handleRoomActionAck(state);
        const removed = state && !state.members?.some(function (member) { return member.id === memberId; });
        if (removed && hasNewAuditEntry(state, previousAuditId, "member_kicked", memberId)) {
          showToast("已将 " + memberName + " 请出房间", "success", 2600);
        }
      });
    }
  }

  if (chatForm) {
    chatForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!roomAccessGranted) return;
      const input = chatForm.querySelector("input[name='message']");
      const text = (input?.value || "").trim();
      if (!text) {
        input?.focus();
        return;
      }
      if (socket?.connected) {
        const previousMessageId = roomState.chat?.at?.(-1)?.id || "";
        socket.emit("chat_message", { roomCode: roomCode, text: text }, function (state) {
          handleRoomActionAck(state);
          const createdMessage = state?.chat?.at?.(-1);
          const accepted = createdMessage?.id && createdMessage.id !== previousMessageId
            && createdMessage.senderId === myMemberId
            && createdMessage.text === text;
          if (accepted && input.value.trim() === text) input.value = "";
        });
      } else {
        showToast("房间连接尚未就绪，请稍后再试", "warning", 2600);
        return;
      }
    });
  }

  if (danmakuForm) {
    danmakuForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!roomAccessGranted) return;
      const text = String(danmakuInput?.value || "").replace(/\s+/g, " ").trim().slice(0, 100);
      if (!text) {
        danmakuInput?.focus();
        return;
      }
      if (!player?.video?.src) {
        showToast("请先加载视频再发送弹幕", "warning", 2600);
        return;
      }
      if (!socket?.connected) {
        showToast("房间连接尚未就绪", "warning", 2600);
        return;
      }
      player?.setDanmakuVisible?.(true);
      const previousMessageId = roomState.chat?.at?.(-1)?.id || "";
      socket.emit("danmaku_message", { roomCode: roomCode, text: text }, function (state) {
        handleRoomActionAck(state);
        const createdMessage = state?.chat?.at?.(-1);
        const accepted = createdMessage?.id && createdMessage.id !== previousMessageId
          && createdMessage.senderId === myMemberId
          && createdMessage.text === text;
        if (accepted && String(danmakuInput.value || "").replace(/\s+/g, " ").trim() === text) {
          danmakuInput.value = "";
        }
      });
    });
  }

  document.querySelector("[data-player-prev]")?.addEventListener("click", function () {
    if (!ensureRoomControl("只有房主可以切换播放项")) return;
    const items = getPlaylistItems();
    const currentIndex = items.findIndex(function (item) { return item.classList.contains("is-current"); });
    const previous = currentIndex > 0 ? items[currentIndex - 1] : items[items.length - 1];
    activatePlaylistItem(previous);
  });

  document.querySelector("[data-player-next]")?.addEventListener("click", function () {
    if (!ensureRoomControl("只有房主可以切换播放项")) return;
    const items = getPlaylistItems();
    const currentIndex = items.findIndex(function (item) { return item.classList.contains("is-current"); });
    const next = currentIndex >= 0 && currentIndex < items.length - 1 ? items[currentIndex + 1] : items[0];
    activatePlaylistItem(next);
  });

  player?.video?.addEventListener("ended", function () {
    if (!isCurrentPlaybackAuthority()) return;
    if (!roomState.autoPlayNext) return;
    const items = getPlaylistItems();
    if (items.length < 2) return;
    const currentIndex = items.findIndex(function (item) { return item.classList.contains("is-current"); });
    const next = currentIndex >= 0 && currentIndex < items.length - 1 ? items[currentIndex + 1] : items[0];
    activatePlaylistItem(next);
  });

  if (autoPlayNextInput) {
    autoPlayNextInput.checked = Boolean(roomState.autoPlayNext);
    autoPlayNextInput.addEventListener("change", function () {
      const previousEnabled = roomState.autoPlayNext === true;
      const nextEnabled = autoPlayNextInput.checked === true;
      if (!socket?.connected || !canControlRoom()) {
        autoPlayNextInput.checked = previousEnabled;
        showToast("当前没有修改自动连播的权限", "warning", 2600);
        return;
      }
      autoPlayNextInput.disabled = true;
      socket.emit("room_autoplay_next_update", {
        roomCode: roomCode,
        enabled: nextEnabled,
      }, function (state) {
        if (state) applyRemoteRoomState(state);
        else autoPlayNextInput.checked = previousEnabled;
        updateRoleUi();
      });
    });
  }

  // 网页全屏由 assets/js/player.js 统一处理，避免同一个按钮被两个脚本重复切换。

  memberList?.addEventListener("click", function (event) {
    const renameButton = event.target.closest("[data-member-rename]");
    if (renameButton) {
      event.stopPropagation();
      startCurrentMemberRename(renameButton.closest(".member-item"));
      return;
    }

    const menuToggle = event.target.closest("[data-menu-toggle]");
    if (menuToggle) {
      event.stopPropagation();
      const menu = menuToggle.closest("[data-action-menu]");
      toggleActionMenu(menu, menuToggle);
      return;
    }

    const button = event.target.closest("[data-transfer-host]");
    const kickButton = event.target.closest("[data-kick-member]");
    if (!button && !kickButton) return;
    event.stopPropagation();
    closeActionMenus();
    if (button) transferHost(button.closest(".member-item"));
    if (kickButton) kickMember(kickButton.closest(".member-item"));
  });

  document.addEventListener("click", function (event) {
    const floatingPopover = event.target.closest(".action-menu-popover");
    const sourceMenu = floatingPopover?.__ownerMenu || null;

    const playlistAction = event.target.closest("[data-playlist-action]");
    if (playlistAction && sourceMenu) {
      event.stopPropagation();
      const item = sourceMenu.closest("[data-playlist-item]");
      const action = playlistAction.getAttribute("data-playlist-action");
      closeActionMenus();
      if (!canEditPlaylistAction(action)) {
        ensureRoomControl("只有房主可以编辑播放队列");
        return;
      }
      if (action === "bindLocal") openLocalVideoPicker(item);
      if (action === "rename") startPlaylistRename(item);
      if (action === "delete") deletePlaylistItem(item);
      if (action === "up") movePlaylistItem(item, -1);
      if (action === "down") movePlaylistItem(item, 1);
      return;
    }

    const transferButton = event.target.closest("[data-transfer-host]");
    if (transferButton && sourceMenu) {
      event.stopPropagation();
      const memberItem = sourceMenu.closest(".member-item");
      closeActionMenus();
      transferHost(memberItem);
      return;
    }

    const kickButton = event.target.closest("[data-kick-member]");
    if (kickButton && sourceMenu) {
      event.stopPropagation();
      const memberItem = sourceMenu.closest(".member-item");
      closeActionMenus();
      kickMember(memberItem);
      return;
    }

    if (!event.target.closest("[data-action-menu]") && !floatingPopover) closeActionMenus();
  });

  document.addEventListener("keydown", function (event) {
    if (trapModalFocus(event, confirmModal) || trapModalFocus(event, passwordModal)) return;
    if (event.key !== "Escape") return;
    closeActionMenus();
    if (confirmModal && !confirmModal.hidden) closeRoomConfirmation(false);
  });

  window.addEventListener("scroll", function () { closeActionMenus(); }, true);
  window.addEventListener("resize", function () { closeActionMenus(); });

  function getShareUrl() {
    const url = new URL("./room.html", window.location.href);
    url.searchParams.set("room", roomState.roomName || roomName);
    return url.toString();
  }

  function setShareResult(text) {
    if (shareResult) shareResult.textContent = text;
  }

  function openShareModal() {
    const url = getShareUrl();
    if (shareLinkInput) {
      shareLinkInput.value = url;
      window.setTimeout(function () {
        shareLinkInput.focus();
        shareLinkInput.select();
      }, 60);
    }
    if (shareNativeButton) shareNativeButton.hidden = typeof navigator.share !== "function";
    setShareResult("复制失败时，可长按输入框手动复制。");
    if (shareModal) shareModal.hidden = false;
  }

  function closeShareModal() {
    if (shareModal) shareModal.hidden = true;
  }

  async function copyShareUrl() {
    const text = shareLinkInput?.value || getShareUrl();
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        shareLinkInput?.focus();
        shareLinkInput?.select();
        document.execCommand("copy");
      }
      setShareResult("房间链接已复制，可以直接发给朋友。");
    } catch (error) {
      setShareResult("自动复制失败，请长按或全选输入框手动复制。");
      shareLinkInput?.focus();
      shareLinkInput?.select();
    }
  }

  function syncThresholdInputToState() {
    if (!syncThresholdInput) return;
    syncThresholdInput.value = softSyncThresholdSeconds.toFixed(1);
    syncThresholdInput.addEventListener("change", function () {
      const nextValue = saveSyncThresholdSetting(syncThresholdInput.value);
      setPlaybackStatusText("同步阈值已设为 " + nextValue.toFixed(1) + "s");
      showToast("同步阈值已设为 " + nextValue.toFixed(1) + "s", "success", 2200);
    });
    syncThresholdInput.addEventListener("blur", function () {
      saveSyncThresholdSetting(syncThresholdInput.value);
    });
  }

  function measureServerClockOffset() {
    if (!socket?.connected) return;
    const sentAt = Date.now();
    try {
      socket.timeout?.(1200).emit("ping_latency", { roomCode: roomCode, clientTime: sentAt }, function (err, serverTime) {
        if (err || !Number.isFinite(Number(serverTime))) return;
        const receivedAt = Date.now();
        const midpoint = sentAt + (receivedAt - sentAt) / 2;
        serverTimeOffsetMs = Number(serverTime) - midpoint;
      });
    } catch (error) {
      socket.emit("ping_latency", { roomCode: roomCode, clientTime: sentAt }, function (serverTime) {
        if (!Number.isFinite(Number(serverTime))) return;
        const receivedAt = Date.now();
        const midpoint = sentAt + (receivedAt - sentAt) / 2;
        serverTimeOffsetMs = Number(serverTime) - midpoint;
      });
    }
  }

  function joinCurrentRoom(passwordOverride, options) {
    if (!socket?.connected) return false;
    if (joinRequestPending && options?.force !== true) return false;
    if (!roomAccessGranted && !roomAdminToken) reloadPendingCreationCredentials();
    const password = passwordOverride !== undefined ? passwordOverride : roomPassword;
    const attemptId = "join-" + Date.now().toString(36) + "-" + (++joinAttemptSequence).toString(36);
    currentJoinAttemptId = attemptId;
    joinRequestPending = true;
    window.clearTimeout(joinRequestTimeout);
    joinRequestTimeout = window.setTimeout(function () {
      if (currentJoinAttemptId !== attemptId) return;
      joinRequestPending = false;
      currentJoinAttemptId = "";
      if (roomAccessGranted) return;
      if (socket?.connected && joinTimeoutRetryCount < 2) {
        joinTimeoutRetryCount += 1;
        showRoomAccessGate("checking", "暂未收到入房确认，正在重新尝试（" + joinTimeoutRetryCount + "/2）。", false);
        roomAccessRetryTimer = window.setTimeout(function () {
          if (!roomAccessGranted && socket?.connected) joinCurrentRoom(roomPassword, { force: true });
        }, joinTimeoutRetryCount * 800);
        return;
      }
      showRoomAccessGate("retry", "房间连接没有及时确认。你可以重新尝试，或返回首页后再次加入。", false);
    }, 6000);
    socket.emit("join_room", {
      roomCode: roomCode,
      roomName: roomName,
      clientId: clientId,
      memberId: myMemberId,
      name: myMemberName,
      password: password || "",
      adminToken: roomAdminToken || "",
      reconnectToken: roomMemberReconnectToken || "",
      attemptId: attemptId,
    }, function (state) {
      if (currentJoinAttemptId !== attemptId) return;
      joinRequestPending = false;
      window.clearTimeout(joinRequestTimeout);
      if (!state?.members?.some(function (member) { return member.id === myMemberId; })) return;
      currentJoinAttemptId = "";
      grantRoomAccess();
      applyRemoteRoomState(state, { restorePlayback: needsAuthoritativePlaybackRestore });
    });
    return true;
  }

  window.addEventListener("together-see:player-ready-for-sync", flushPendingRemotePlayback);
  window.addEventListener("together-see:player-buffering-change", handlePlayerBufferingChange);
  window.addEventListener("together-see:manual-sync", handleManualSyncRequest);
  window.addEventListener("together-see:auto-sync-change", handleAutoSyncChange);
  window.addEventListener("together-see:playback-user-action", function (event) {
    const action = ["play", "pause", "seek", "rate"].includes(event?.detail?.action)
      ? event.detail.action
      : "seek";
    emitPlaybackState({ force: true, userAction: true, action: action });
  });
  window.addEventListener("together-see:playback-control-blocked", function () {
    showToast("当前为仅房主控制，可使用手动同步跟随房主进度", "info", 2800);
  });
  window.addEventListener("together-see:sync-playback-resumed", function () {
    remotePlaybackGesturePending = false;
    const playback = lastRemotePlayback || roomState.playback;
    if (playback) seekToHostPlayback(playback, "source");
    setPlaybackStatusText("已继续播放并跟随房主");
  });
  syncThresholdInputToState();

  document.querySelector("[data-share-room]")?.addEventListener("click", openShareModal);
  roomLockToggle?.addEventListener("click", toggleRoomLock);
  roomControlPolicyOptions.forEach(function (button) {
    button.addEventListener("click", function () {
      setRoomControlPolicy(button.dataset.roomControlPolicyOption);
    });
  });
  roomPasswordForm?.addEventListener("submit", function (event) {
    event.preventDefault();
    updateRoomPassword(roomPasswordInput?.value || "");
  });
  roomPasswordClear?.addEventListener("click", function () {
    if (roomState.security?.hasPassword) updateRoomPassword("");
    else if (roomPasswordInput) roomPasswordInput.value = "";
  });
  roomAdminRecoveryForm?.addEventListener("submit", function (event) {
    event.preventDefault();
    recoverRoomAdmin(roomAdminRecoveryInput?.value || "");
  });
  adminRecoveryCopy?.addEventListener("click", function () {
    copyInputValue(adminRecoveryCodeInput, "管理恢复码已复制");
  });
  confirmAccept?.addEventListener("click", function () { closeRoomConfirmation(true); });
  document.querySelectorAll("[data-room-confirm-cancel]").forEach(function (node) {
    node.addEventListener("click", function () { closeRoomConfirmation(false); });
  });
  joinPasswordForm?.addEventListener("submit", function (event) {
    event.preventDefault();
    if (document.body.dataset.roomAccess === "creator_recovery") {
      recoverRoomAdmin(roomAccessRecoveryInput?.value || roomAdminRecoveryCode, {
        errorNode: roomAccessRecoveryError,
        input: roomAccessRecoveryInput,
      });
      return;
    }
    if (document.body.dataset.roomAccess === "retry") {
      joinTimeoutRetryCount = 0;
      showRoomAccessGate("checking", "正在重新验证房间访问状态，请稍候。", false);
      joinCurrentRoom(roomPassword, { force: true });
      return;
    }
    const cleanPassword = String(joinPasswordInput?.value || "").trim().slice(0, 80);
    if (!cleanPassword) {
      if (joinPasswordError) joinPasswordError.textContent = "请输入房间密码。";
      joinPasswordInput?.focus();
      return;
    }
    if (joinPasswordError) joinPasswordError.textContent = "";
    saveRoomPassword(cleanPassword);
    updateConnectionStatus("正在验证密码", false);
    joinCurrentRoom(cleanPassword);
  });
  shareCopyButton?.addEventListener("click", copyShareUrl);
  shareNativeButton?.addEventListener("click", async function () {
    const url = getShareUrl();
    try {
      await navigator.share({ title: "一起See · Together See", text: "加入房间：" + (roomState.roomName || roomName), url });
      setShareResult("已调用系统分享。");
    } catch (error) {
      setShareResult("系统分享已取消，可使用一键复制。");
    }
  });
  document.querySelectorAll("[data-share-close]").forEach(function (node) {
    node.addEventListener("click", closeShareModal);
  });

  if (socket) {
    socket.on("connect", function () {
      sourceIntentGate.reset();
      resetLocalBufferingPublishState();
      joinRequestPending = false;
      currentJoinAttemptId = "";
      joinTimeoutRetryCount = 0;
      automaticAdminRecoveryAttempted = false;
      identityFallbackAttempted = false;
      if (!roomAccessGranted) showRoomAccessGate("checking", "正在验证房间访问状态，请稍候。", false);
      else updateConnectionStatus("已连接", true);
      measureServerClockOffset();
      joinCurrentRoom();
    });

    socket.on("room_member_token", function (payload) {
      if (!payload || payload.roomCode !== roomCode || payload.memberId !== myMemberId || !payload.reconnectToken) return;
      saveRoomMemberReconnectToken(payload.reconnectToken);
    });

    socket.on("room_permissions", function (payload) {
      if (!payload || payload.roomCode !== roomCode || payload.memberId !== myMemberId) return;
      roomAdminAuthorizationKnown = true;
      roomAdminAuthorized = payload.canManage === true;
      roomAdminIsCreator = payload.isCreator === true;
      if (!roomAdminAuthorized && roomAdminToken) saveRoomAdminToken("");
      updateRoleUi();
      if (!roomAdminAuthorized) {
        maybeRecoverStoredAdmin({
          onFailure: function () {
            if (roomAccessGranted) {
              showToast("当前设备的管理身份需要重新确认，可在房间设置中使用恢复码", "warning", 4200);
            }
          },
        });
      }
    });

    socket.on("room_admin_token", function (payload) {
      if (!payload || payload.roomCode !== roomCode || !payload.adminToken) return;
      if (!roomAccessGranted && payload.recoveryCode) {
        try { roomCredentialStore?.stageCreated(payload.adminToken, payload.recoveryCode); } catch (error) {}
      }
      saveRoomAdminToken(payload.adminToken);
      roomAdminAuthorizationKnown = true;
      roomAdminAuthorized = true;
      roomAdminIsCreator = payload.delegated !== true;
      if (payload.recoveryCode) {
        saveRoomAdminRecoveryCode(payload.recoveryCode);
        showAdminRecoveryCode(payload.recoveryCode, payload.recovered === true);
      }
      updateRoleUi();
      if (payload.delegated) {
        showToast("原管理员持续离线，你已接管房间管理", "success", 4200);
      } else if (payload.recovered) {
        showToast("管理身份已恢复，正在重新加入房间", "success", 2800);
        window.setTimeout(function () { joinCurrentRoom(roomPassword, { force: true }); }, 120);
      } else {
        showToast(payload.recovered ? "已恢复房间管理身份" : "已保存房间管理身份", "success", 2600);
      }
    });

    socket.on("room_state", function (state) {
      if (!state?.members?.some(function (member) { return member.id === myMemberId; })) return;
      grantRoomAccess();
      applyRemoteRoomState(state);
      window.setTimeout(function () {
        localBufferingState = player?.getPlaybackHealth?.().buffering === true;
        updateLocalBufferingPublishedFromAuthority();
        reconcileLocalBufferingPublication();
      }, 0);
    });
    socket.on("playback_state", function (playback) {
      applyRemotePlayback(playback, { fromBroadcast: true });
    });
    socket.on("chat_message_created", appendChatMessageFromServer);
    socket.on("danmaku_message_created", function (message) {
      if (!roomAccessGranted || !message || message.roomCode !== roomCode) return;
      player?.showDanmaku?.(message);
    });
    socket.on("room_error", function (payload) {
      if (payload?.attemptId && payload.attemptId !== currentJoinAttemptId) return;
      if (payload?.attemptId) {
        joinRequestPending = false;
        joinTimeoutRetryCount = 0;
        window.clearTimeout(joinRequestTimeout);
        currentJoinAttemptId = "";
      }
      if (roomAccessGranted && payload?.state) applyRemoteRoomState(payload.state);
      if (payload?.code === "admin_member_mismatch"
        || (payload?.code === "member_identity_invalid" && roomAdminToken)) {
        if (maybeRecoverStoredAdmin({
          onFailure: function (result) {
            revokeRoomAccess(
              "creator_recovery",
              result?.message || "本设备的成员或管理身份已变化，请确认管理恢复码后继续，或返回首页。",
              false,
            );
          },
        })) {
          revokeRoomAccess("checking", "成员身份已变化，正在使用本机恢复码恢复创建者身份。", false);
          return;
        }
        if (roomAdminRecoveryCode) {
          revokeRoomAccess(
            "creator_recovery",
            "当前成员身份与管理凭据不一致，请使用本机保存的恢复码重新确认，或返回首页。",
            false,
          );
          return;
        }
        scheduleFreshMemberIdentityJoin("管理身份无法用于当前成员，正在按普通成员重新加入。");
        return;
      }
      if (payload?.code === "reconnect_token_invalid"
        || payload?.code === "member_online_elsewhere"
        || payload?.code === "member_identity_invalid") {
        scheduleFreshMemberIdentityJoin("成员凭据已失效，正在申请新的房间身份。");
        return;
      }
      if (payload?.code === "join_pending") {
        window.clearTimeout(identityFallbackTimer);
        identityFallbackTimer = window.setTimeout(function () { joinCurrentRoom(roomPassword); }, 420);
        return;
      }
      if (payload?.code === "room_not_found") {
        revokeRoomAccess("missing", payload?.message || "房间不存在或已经销毁，请返回首页重新创建。", false);
        return;
      }
      if (payload?.code === "creator_pending") {
        if (reloadPendingCreationCredentials()) {
          revokeRoomAccess("checking", "已恢复本设备的创建凭据，正在重新进入房间。", false);
          window.setTimeout(function () { joinCurrentRoom(roomPassword); }, 120);
          return;
        }
        const creatorAdmissionExpected = createdRoomNavigation
          || Boolean(roomCredentialStore?.getPending())
          || Boolean(roomAdminRecoveryCode);
        if (creatorAdmissionExpected) {
          revokeRoomAccess(
            "creator_recovery",
            "本设备未能完成创建者凭据验证。可使用创建时保存的管理恢复码继续，或返回首页重新创建其他房间。",
            false,
          );
          return;
        }
        revokeRoomAccess("creator_pending", payload?.message || "房间创建者正在完成入房，页面会自动重试。", false);
        return;
      }
      if ((payload?.code === "password_required"
        || payload?.code === "password_invalid"
        || payload?.code === "locked"
        || payload?.code === "room_full") && roomAdminRecoveryCode) {
        if (maybeRecoverStoredAdmin({
          onFailure: function (result) {
            revokeRoomAccess(
              "creator_recovery",
              result?.message || "创建者管理身份需要重新确认，请使用恢复码继续。",
              false,
            );
          },
        })) {
          revokeRoomAccess("checking", "正在使用本机恢复码确认创建者身份。", false);
          return;
        }
        revokeRoomAccess("creator_recovery", "创建者管理身份需要重新确认，请使用恢复码继续。", false);
        return;
      }
      if (payload?.code === "password_required" || payload?.code === "password_invalid") {
        if (payload.code === "password_invalid") saveRoomPassword("");
        revokeRoomAccess("password", payload?.message || "请输入房间密码", payload.code === "password_invalid");
        return;
      }
      if (payload?.code === "password_rate_limited") {
        revokeRoomAccess("denied", payload?.message || "密码尝试过于频繁，请稍后再试或返回首页。", false);
        return;
      }
      if (payload?.code === "locked") {
        revokeRoomAccess("locked", payload?.message || "当前房间已锁定，新成员暂时无法加入。页面会自动检查解锁状态。", false);
        return;
      }
      if (payload?.code === "room_full") {
        revokeRoomAccess("denied", payload?.message || "当前房间人数已满，请稍后再试或返回首页更换房间。", false);
        return;
      }
      if (payload?.code === "kicked") {
        revokeRoomAccess("denied", payload?.message || "你暂时无法加入这个房间，请返回首页更换房间。", false);
        return;
      }
      if (/只有(?:当前)?房间(?:创建者|管理员)/.test(payload?.message || "") && roomAdminToken) {
        saveRoomAdminToken("");
        roomAdminAuthorizationKnown = true;
        roomAdminAuthorized = false;
        updateRoomSecurityUi();
      }
      if (!roomAccessGranted) {
        revokeRoomAccess("denied", payload?.message || "暂时无法进入这个房间，请返回首页后重试。", false);
        return;
      }
      showToast(payload?.message || "房间操作被服务器拒绝", "warning", 3200);
    });
    socket.on("room_kicked", function (payload) {
      saveRoomMemberReconnectToken("");
      document.body.dataset.roomKicked = "true";
      revokeRoomAccess("denied", payload?.message || "你已被房主请出该房间，请返回首页更换房间。", false);
      showToast(payload?.message || "你已被房主请出该房间", "error", 5200);
      updateConnectionStatus("已被请出", false);
      if (chatForm) {
        chatForm.querySelectorAll("input, button").forEach(function (node) { node.disabled = true; });
      }
      if (danmakuForm) {
        danmakuForm.querySelectorAll("input, button").forEach(function (node) { node.disabled = true; });
      }
      if (playlistForm) {
        playlistForm.querySelectorAll("input, button").forEach(function (node) { node.disabled = true; });
      }
      roomLockToggle?.setAttribute("disabled", "true");
      roomControlPolicyOptions.forEach(function (button) { button.disabled = true; });
      roomPasswordForm?.querySelectorAll("input, button").forEach(function (node) { node.disabled = true; });
      roomAdminRecoveryForm?.querySelectorAll("input, button").forEach(function (node) { node.disabled = true; });
    });
    socket.on("connect_error", function () {
      updateConnectionStatus("连接重试中", false);
      if (!roomAccessGranted) showRoomAccessGate("checking", "房间服务连接异常，正在自动重试。", false);
    });
    socket.on("disconnect", function (reason) {
      sourceIntentGate.reset();
      resetLocalBufferingPublishState();
      if (document.body.dataset.roomKicked === "true") return;
      needsAuthoritativePlaybackRestore = true;
      remotePlaybackSnapshots.clear();
      remotePlayOperations.invalidate();
      updateConnectionStatus("重新连接中", false);
      if (reason === "io server disconnect") {
        window.setTimeout(function () { socket.connect(); }, 800);
      }
    });

    socket.io?.on("reconnect_attempt", function () {
      updateConnectionStatus("重新连接中", false);
    });
    socket.io?.on("reconnect_failed", function () {
      updateConnectionStatus("连接异常", false);
    });

    window.setInterval(measureServerClockOffset, 15000);
  }

  if (player?.video) {
    window.setInterval(function () {
      updatePlaybackAuthorityUi();
      if (player.video && !player.video.paused && isCurrentPlaybackAuthority()) {
        emitPlaybackState({ force: true, periodic: true, action: "periodic" });
      }
    }, 2500);
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      activateTab(tab.getAttribute("data-room-tab"));
    });
  });

  updateConnectionStatus(socket?.connected ? "已连接" : "连接中", Boolean(socket?.connected));
  updateRoleUi();
  activateTab("chat");
  showRoomAccessGate("checking", socket ? "正在验证房间访问状态，请稍候。" : "无法连接房间服务，请返回首页稍后重试。", false);
  if (socket?.connected) {
    measureServerClockOffset();
    joinCurrentRoom();
  }

  if (window.ResizeObserver && videoStage) {
    new ResizeObserver(scheduleSidebarHeightSync).observe(videoStage);
  }

  window.addEventListener("resize", scheduleSidebarHeightSync);
  updateCounts();
  updateLocalVideoButtonState();
  scrollToBottom(chatFeed);
  scheduleSidebarHeightSync();
})();
