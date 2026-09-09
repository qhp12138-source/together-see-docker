(function () {
  const video = document.querySelector("[data-room-video]");

  if (!video) {
    return;
  }

  const shell = document.querySelector("[data-player-shell]");
  const controls = document.querySelector("[data-player-controls]");
  const danmakuInput = document.querySelector("[data-danmaku-input]");
  const empty = document.querySelector("[data-player-empty]");
  const emptyText = document.querySelector("[data-player-empty-text]");
  const sourceChips = document.querySelectorAll("[data-player-source-chip]");
  const modeChips = document.querySelectorAll("[data-player-mode-chip]");
  const stageTimes = document.querySelectorAll("[data-player-stage-time]");
  const stageClock = document.querySelector("[data-player-stage-clock]");
  const sourceStatus = document.querySelector("[data-player-source-status]");
  const playbackStatus = document.querySelector("[data-player-playback-status]");
  const progressTrack = document.querySelector("[data-player-progress-track]");
  const progressCurrent = document.querySelector("[data-player-current]");
  const progressBuffer = document.querySelector("[data-player-buffer]");
  const progressHoverTime = document.querySelector("[data-progress-hover-time]");
  const playButton = document.querySelector("[data-player-play]");
  const centerPlayButton = document.querySelector("[data-player-center-play]");
  const rateButton = document.querySelector("[data-player-rate]");
  const pageFullscreenButton = document.querySelector("[data-page-fullscreen]");
  const fullscreenButton = document.querySelector("[data-player-fullscreen]");
  const danmakuButton = document.querySelector("[data-player-danmaku]");
  const danmakuLayer = document.querySelector("[data-player-danmaku-layer]");
  const autoSyncButton = document.querySelector("[data-player-auto-sync]");
  const manualSyncButton = document.querySelector("[data-player-manual-sync]");
  const volumeControl = document.querySelector("[data-player-volume-control]");
  const volumeButton = document.querySelector("[data-player-volume]");
  const volumePopover = document.querySelector("[data-player-volume-popover]");
  const volumeRange = document.querySelector("[data-player-volume-range]");
  const volumeValue = document.querySelector("[data-player-volume-value]");
  const controlLockButton = document.querySelector("[data-player-control-lock]");
  const systemClock = document.querySelector("[data-player-system-clock]");

  const rateSteps = [1, 1.25, 1.5, 2, 0.75];
  let currentRateIndex = 0;
  let currentSource = null;
  let hlsInstance = null;
  let lastHlsSource = null;
  let lastHlsUsingProxy = false;
  let danmakuVisible = loadDanmakuPreference();
  let danmakuQueue = [];
  let danmakuLaneAvailableAt = [];
  let danmakuFlushTimer = null;
  let timelineDanmaku = [];
  let timelineDanmakuKey = "";
  let timelineDanmakuIndex = 0;
  let timelineDanmakuLastTime = null;
  let timelineDanmakuSeeking = false;
  let timelineDanmakuAnimationFrame = null;
  let autoSyncEnabled = true;
  let playbackControlEnabled = true;
  let syncPlaybackPending = false;
  let controlsLocked = false;
  let controlsPointerInside = false;
  let controlsFocusInside = false;
  let hideControlsTimer = null;
  let hideLockTimer = null;
  let pageFullscreenPlaceholder = null;
  let pageFullscreenParent = null;
  let pageFullscreenNextSibling = null;
  let pauseBufferTimer = null;
  let lastBufferingState = false;
  let sourceLoadWatchdogTimer = null;
  let desiredPlaybackState = null;
  let lastHlsStallRecoveryAt = 0;
  let hlsMediaRecoveryAttempts = 0;
  let lastHlsMediaRecoveryAt = 0;
  let hlsMediaRecoveryTimer = null;
  let hlsStallTimeoutTimer = null;
  let mediaStallFallbackTimer = null;
  let lastMediaSource = null;
  let lastMediaUsingProxy = false;
  let hlsProxyGrantRefreshAttempts = 0;
  let mediaProxyGrantRefreshAttempts = 0;
  let mediaLoadCleanup = null;
  let mediaRecoveryTransition = false;

  const sourceLoadTracker = window.TogetherSeeRecovery.createLoadTracker();
  const initialSeekState = window.TogetherSeeRecovery.createGenerationValue(function (token) {
    return sourceLoadTracker.isCurrent(token);
  });
  const mediaRecoveryIntentState = window.TogetherSeeRecovery.createGenerationValue(function (token) {
    return sourceLoadTracker.isCurrent(token);
  });
  const recoveryPlayOperations = window.TogetherSeeRecovery.createOperationTracker();
  const userPlayOperations = window.TogetherSeeRecovery.createOperationTracker();
  const proxyFallbackController = window.TogetherSeeRecovery.createFallbackController({ maxAttempts: 1 });

  const HLS_FORWARD_BUFFER_SECONDS = 120;
  const HLS_MAX_FORWARD_BUFFER_SECONDS = 240;
  const HLS_BACK_BUFFER_SECONDS = 45;
  const HLS_MAX_BUFFER_SIZE = 160 * 1000 * 1000;
  const NATIVE_SOURCE_LOAD_TIMEOUT_MS = 20000;
  const BILIBILI_DIRECT_LOAD_TIMEOUT_MS = 12000;
  const NATIVE_HLS_LOAD_TIMEOUT_MS = 35000;
  const HLS_JS_LOAD_TIMEOUT_MS = 60000;
  const HLS_MEDIA_RECOVERY_LIMIT = 1;
  const HLS_MEDIA_RECOVERY_SETTLE_MS = 5000;
  const HLS_MEDIA_RECOVERY_TIMEOUT_MS = 10000;
  const HLS_STALL_TIMEOUT_MS = 45000;
  const BILIBILI_STALL_FALLBACK_MS = 8000;
  const BUFFER_SPINNER_THRESHOLD = 1.2;
  const DANMAKU_STORAGE_KEY = "together-see:danmaku-visible";
  const DANMAKU_SPEED_PX_PER_SECOND = 105;
  const DANMAKU_QUEUE_LIMIT = 40;

  const playSvg = `<svg class="control-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.75v10.5L17.25 12z" /></svg>`;
  const pauseSvg = `<svg class="control-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6.5h3.1v11H8zM12.9 6.5H16v11h-3.1z" /></svg>`;
  const danmakuOnSvg = `<svg class="control-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.6A2.6 2.6 0 0 1 6.6 3h10.8A2.6 2.6 0 0 1 20 5.6v6.8a2.6 2.6 0 0 1-2.6 2.6H11l-4.3 4.1A1 1 0 0 1 5 18.4v-3.2a2.6 2.6 0 0 1-2-2.5V5.6zm4 1.8v1.5h8V7.4H8zm0 3.1V12h5.8v-1.5H8z" /></svg>`;
  const danmakuOffSvg = `<svg class="control-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.7 3.3 20.7 19.3 19.3 20.7 16.6 18H11l-4.3 4.1A1 1 0 0 1 5 21.4v-3.2a2.6 2.6 0 0 1-2-2.5V8.4L3.3 4.7 4.7 3.3zm1.9 3.3L5 8.2v4.5c0 .27.18.5.44.58l1.56.47V18l3.2-3h4.4l-2-2H8v-1.5h3.1L9.6 10H8V8.5h.1L6.6 6.6zM6.6 3h10.8A2.6 2.6 0 0 1 20 5.6v6.8c0 .82-.38 1.56-.98 2.04L16.6 12H18V5.6a.6.6 0 0 0-.6-.6H7.6L5.7 3.1c.28-.07.58-.1.9-.1z" /></svg>`;
  const lockOpenSvg = `<svg class="control-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 9V7a5 5 0 0 0-9.8-1.4l1.9.6A3 3 0 0 1 15 7v2H7.5A2.5 2.5 0 0 0 5 11.5v6A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-6A2.5 2.5 0 0 0 16.5 9H17zm-9.5 2h9a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-6a.5.5 0 0 1 .5-.5z" /></svg>`;
  const lockClosedSvg = `<svg class="control-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9V7a4 4 0 1 1 8 0v2h.5A2.5 2.5 0 0 1 19 11.5v6a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 17.5v-6A2.5 2.5 0 0 1 7.5 9H8zm2 0h4V7a2 2 0 1 0-4 0v2zm-2.5 2a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-6a.5.5 0 0 0-.5-.5h-9z" /></svg>`;
  const volumeHighSvg = `<svg class="control-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm11.5-.3 1.4-1.4A6.8 6.8 0 0 1 19 12a6.8 6.8 0 0 1-2.1 4.7l-1.4-1.4A4.7 4.7 0 0 0 17 12a4.7 4.7 0 0 0-1.5-3.3z" /></svg>`;
  const volumeLowSvg = `<svg class="control-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm11.2.8 1.4-1.4A5.1 5.1 0 0 1 18 12a5.1 5.1 0 0 1-1.4 3.6l-1.4-1.4c.5-.6.8-1.3.8-2.2s-.3-1.6-.8-2.2z" /></svg>`;
  const volumeMutedSvg = `<svg class="control-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm12.2.1 1.9 1.9 1.9-1.9 1.4 1.4-1.9 1.9 1.9 1.9-1.4 1.4-1.9-1.9-1.9 1.9-1.4-1.4 1.9-1.9-1.9-1.9 1.4-1.4z" /></svg>`;

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  function loadDanmakuPreference() {
    try {
      return window.localStorage.getItem("together-see:danmaku-visible") !== "false";
    } catch (error) {
      return true;
    }
  }

  function saveDanmakuPreference() {
    try {
      window.localStorage.setItem(DANMAKU_STORAGE_KEY, danmakuVisible ? "true" : "false");
    } catch (error) {}
  }

  function dispatchPlayerEvent(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch (error) {}
  }

  function dispatchPlaybackUserAction(action) {
    dispatchPlayerEvent("together-see:playback-user-action", { action: action || "update" });
  }

  function getSourceIdentity(source) {
    return [source?.id || "", source?.sourceType || "", source?.sourceUrl || ""].join("|");
  }

  function createLoadPlaybackIntent(source, options) {
    return {
      sourceId: source?.id || "",
      currentTime: Number.isFinite(Number(options?.startTime)) ? Math.max(0, Number(options.startTime)) : 0,
      playing: options?.playWhenReady === true,
      playbackRate: Number.isFinite(Number(options?.playbackRate)) ? Number(options.playbackRate) : 1,
    };
  }

  function getCurrentLoadToken() {
    return sourceLoadTracker.current();
  }

  function isCurrentLoadToken(token) {
    return sourceLoadTracker.isCurrent(token);
  }

  function bindInitialSeek(value, token) {
    const time = getSafeStartTime(value);
    if (time === null) {
      initialSeekState.clear();
      return false;
    }
    return initialSeekState.bind(token, time);
  }

  function captureMediaRecoveryIntent(source) {
    const currentToken = getCurrentLoadToken();
    const boundIntent = currentToken ? mediaRecoveryIntentState.peek(currentToken) : null;
    const desiredMatchesSource = desiredPlaybackState?.activeSourceId
      && desiredPlaybackState.activeSourceId === source?.id;
    const boundMatchesSource = boundIntent
      && (!boundIntent.sourceId || boundIntent.sourceId === source?.id);
    const currentTime = Number.isFinite(Number(video.currentTime)) && Number(video.currentTime) > 0
      ? Math.max(0, Number(video.currentTime))
      : (boundMatchesSource && Number.isFinite(Number(boundIntent.currentTime))
        ? Math.max(0, Number(boundIntent.currentTime))
        : 0);
    return {
      sourceId: source?.id || "",
      currentTime: currentTime,
      playing: desiredMatchesSource
        ? desiredPlaybackState.playing === true
        : (boundMatchesSource ? boundIntent.playing === true : (!video.paused || syncPlaybackPending)),
      playbackRate: desiredMatchesSource && Number.isFinite(Number(desiredPlaybackState.playbackRate))
        ? Number(desiredPlaybackState.playbackRate)
        : (boundMatchesSource && Number.isFinite(Number(boundIntent.playbackRate))
          ? Number(boundIntent.playbackRate)
          : (Number.isFinite(Number(video.playbackRate)) ? Number(video.playbackRate) : 1)),
    };
  }

  function bindMediaRecoveryIntent(intent, token) {
    if (!intent) {
      mediaRecoveryIntentState.clear();
      return false;
    }
    return mediaRecoveryIntentState.bind(token, Object.assign({}, intent));
  }

  function setDesiredPlaybackState(playback) {
    const previousSourceId = desiredPlaybackState?.activeSourceId || "";
    desiredPlaybackState = playback ? {
      activeSourceId: playback.activeSourceId || "",
      playing: playback.playing === true,
      playbackRate: Number.isFinite(Number(playback.playbackRate)) ? Number(playback.playbackRate) : 1,
    } : null;

    if (!desiredPlaybackState
      || desiredPlaybackState.playing !== true
      || (previousSourceId && desiredPlaybackState.activeSourceId && previousSourceId !== desiredPlaybackState.activeSourceId)) {
      recoveryPlayOperations.invalidate();
      userPlayOperations.invalidate();
    }

    const token = getCurrentLoadToken();
    if (!token || !desiredPlaybackState) return;
    mediaRecoveryIntentState.update(token, function (intent) {
      if (desiredPlaybackState.activeSourceId && intent.sourceId && desiredPlaybackState.activeSourceId !== intent.sourceId) return intent;
      return Object.assign({}, intent, {
        playing: desiredPlaybackState.playing,
        playbackRate: desiredPlaybackState.playbackRate,
      });
    });
  }

  function restoreMediaRecoveryIntent(source, token) {
    const intent = mediaRecoveryIntentState.take(token);
    if (!intent || (intent.sourceId && source?.id && intent.sourceId !== source.id)) return;
    const safeRate = Number.isFinite(Number(intent.playbackRate)) ? Math.min(3, Math.max(0.25, Number(intent.playbackRate))) : 1;
    video.playbackRate = safeRate;

    recoveryPlayOperations.invalidate();
    if (!intent.playing) {
      if (!video.paused) video.pause();
      syncPlaybackPending = false;
      updatePlaybackControlUi();
      return;
    }
    if (!video.paused) return;

    const operation = recoveryPlayOperations.begin([token.generation, token.identity, source?.id || ""].join("|"));
    Promise.resolve(video.play()).then(function () {
      if (!recoveryPlayOperations.isCurrent(operation) || !isCurrentLoadToken(token)) return;
      syncPlaybackPending = false;
      updatePlaybackControlUi();
    }).catch(function () {
      if (!recoveryPlayOperations.isCurrent(operation) || !isCurrentLoadToken(token)) return;
      syncPlaybackPending = true;
      updatePlaybackControlUi();
      setText(playbackStatus, "浏览器需要一次点按才能继续播放");
      showControls();
    });
  }

  function ensurePlaybackControl() {
    if (playbackControlEnabled) return true;
    setText(playbackStatus, "当前为仅房主控制，可使用手动同步");
    dispatchPlayerEvent("together-see:playback-control-blocked");
    showControls();
    return false;
  }

  function updatePlaybackControlUi() {
    if (playButton) playButton.disabled = !playbackControlEnabled;
    if (rateButton) rateButton.disabled = !playbackControlEnabled;
    if (centerPlayButton) centerPlayButton.disabled = !playbackControlEnabled && !syncPlaybackPending;
    if (progressTrack) progressTrack.setAttribute("aria-disabled", playbackControlEnabled ? "false" : "true");
    shell?.classList.toggle("is-playback-readonly", !playbackControlEnabled);
  }

  function clearSourceWatchdog() {
    clearTimeout(sourceLoadWatchdogTimer);
    sourceLoadWatchdogTimer = null;
  }

  function startSourceWatchdog(source, token) {
    clearSourceWatchdog();
    if (!source || !source.sourceUrl) return;
    const loadToken = token || sourceLoadTracker.current();
    const timeoutMs = source.sourceType === "hls"
      ? (canPlayNativeHls() ? NATIVE_HLS_LOAD_TIMEOUT_MS : HLS_JS_LOAD_TIMEOUT_MS)
      : (source.bilibili ? BILIBILI_DIRECT_LOAD_TIMEOUT_MS : NATIVE_SOURCE_LOAD_TIMEOUT_MS);
    sourceLoadWatchdogTimer = window.setTimeout(function () {
      if (!sourceLoadTracker.isCurrent(loadToken)) return;
      if (sourceLoadTracker.isReady(loadToken)) return;
      if (source.sourceType === "hls" && !lastHlsUsingProxy && tryHlsProxyFallback("等待元数据超时")) {
        return;
      }
      if (source.sourceType === "video" && !lastMediaUsingProxy && tryMediaProxyFallback("等待元数据超时")) return;
      if (source.sourceType === "hls") destroyHlsInstance();
      setText(sourceStatus, "视频源加载超时");
      setText(playbackStatus, "当前设备加载失败");
      dispatchTerminalSourceError(source, "load-timeout", {
        readyState: video.readyState,
      }, loadToken);
    }, timeoutMs);
  }

  function setButtonSvg(button, svg, label) {
    if (!button) return;
    button.innerHTML = svg;
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
  }

  function getForwardBufferSeconds() {
    const current = Number(video.currentTime || 0);
    if (!video.buffered || !video.buffered.length) return 0;

    for (let index = 0; index < video.buffered.length; index += 1) {
      const start = video.buffered.start(index);
      const end = video.buffered.end(index);
      if (current >= start - 0.25 && current <= end + 0.25) {
        return Math.max(0, end - current);
      }
    }

    try {
      return Math.max(0, video.buffered.end(video.buffered.length - 1) - current);
    } catch (error) {
      return 0;
    }
  }

  function hasEnoughForwardBuffer() {
    if (!currentSource || !video.src) return false;
    if (video.paused && getForwardBufferSeconds() > 3) return true;
    return getForwardBufferSeconds() > BUFFER_SPINNER_THRESHOLD && video.readyState >= 3;
  }

  function isMediaReadyForSync() {
    return Boolean(video.src && video.readyState >= 2 && !video.seeking && !lastBufferingState);
  }

  function setBufferingState(active, statusText, options) {
    const hasPlayableSource = Boolean(currentSource && video.src);
    const allowPausedSpinner = Boolean(options?.allowPausedSpinner);
    const shouldSpin = Boolean(active && hasPlayableSource && (!video.paused || allowPausedSpinner || !hasEnoughForwardBuffer()));

    const bufferingChanged = lastBufferingState !== shouldSpin;
    lastBufferingState = shouldSpin;
    shell?.classList.toggle("is-buffering", shouldSpin);

    if (statusText) {
      setText(playbackStatus, statusText);
    }
    // 缓冲状态只更新内部状态和控制器内提示，不主动显示中央按钮或底部控制器。
    // 中央缓冲环由 CSS 限定为“控制器可见时才显示”，避免观影时被独立弹出打扰。
    if (bufferingChanged) {
      dispatchPlayerEvent("together-see:player-buffering-change", {
        buffering: shouldSpin,
        readyState: video.readyState,
        bufferedAhead: getForwardBufferSeconds(),
      });
    }
  }

  function refreshBufferingFromMediaState() {
    if (!lastBufferingState) return;
    if (hasEnoughForwardBuffer()) {
      setBufferingState(false, video.paused ? "已暂停 · 后台缓存中" : "正在播放");
    }
  }

  function resumeHlsBufferingFromCurrentTime() {
    if (!hlsInstance) return;
    try {
      if (typeof hlsInstance.resumeBuffering === "function") {
        hlsInstance.resumeBuffering();
      }
      if (typeof hlsInstance.startLoad === "function") {
        hlsInstance.startLoad(Number.isFinite(video.currentTime) ? video.currentTime : -1);
      }
    } catch (error) {}
  }

  function schedulePauseBuffering() {
    clearInterval(pauseBufferTimer);
    if (!currentSource || !video.src) return;

    // 暂停后仍允许 hls.js 继续向前取片。浏览器有权自行停止或清理缓存，
    // 因此这里做成温和的后台续载，而不是反复重置 video。
    resumeHlsBufferingFromCurrentTime();

    if (currentSource.sourceType === "hls" && hlsInstance) {
      pauseBufferTimer = window.setInterval(function () {
        if (!video.paused || !hlsInstance) {
          clearInterval(pauseBufferTimer);
          pauseBufferTimer = null;
          return;
        }
        if (getForwardBufferSeconds() < HLS_FORWARD_BUFFER_SECONDS * 0.85) {
          resumeHlsBufferingFromCurrentTime();
          setText(playbackStatus, "已暂停 · 后台缓存中");
        } else {
          setText(playbackStatus, "已暂停 · 缓存充足");
        }
        updateBufferUi();
      }, 3500);
    }
  }

  function updateSystemClock() {
    if (!systemClock) return;
    const now = new Date();
    const text = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
    systemClock.textContent = text;
    systemClock.dateTime = now.toISOString();
  }

  function setTextAll(nodes, text) {
    nodes.forEach(function (node) {
      node.textContent = text;
    });
  }

  function setProgress(node, value) {
    if (node) {
      node.style.width = Math.max(0, Math.min(100, value)) + "%";
    }
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
      return [hours, minutes, secs].map(function (part) { return String(part).padStart(2, "0"); }).join(":");
    }
    return [minutes, secs].map(function (part) { return String(part).padStart(2, "0"); }).join(":");
  }

  function guessSourceType(rawUrl) {
    let pathname = "";
    try {
      pathname = new URL(rawUrl).pathname.toLowerCase();
    } catch (error) {
      return "unknown";
    }
    if (rawUrl.startsWith("blob:") || rawUrl.startsWith("local:")) return "local";
    if (pathname.endsWith(".m3u8")) return "hls";
    if (pathname.endsWith(".mpd")) return "dash";
    if (/\.(mp4|webm|ogg|ogv|mov|m4v|mkv)$/i.test(pathname)) return "video";
    return "page";
  }

  function canPlayNativeHls() {
    return Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
  }

  function showLockTemporarily() {
    if (!shell) return;
    shell.classList.add("is-lock-visible");
    clearTimeout(hideLockTimer);
    hideLockTimer = window.setTimeout(function () {
      if (controlsLocked) {
        shell.classList.remove("is-lock-visible");
      }
    }, controlsLocked ? 1400 : 2600);
  }

  function hideControlsNow() {
    shell?.classList.remove("is-controls-visible");
    shell?.classList.add("is-controls-hidden");
    clearTimeout(hideControlsTimer);
  }

  function isEditableControl(element) {
    return Boolean(
      controls
      && element
      && controls.contains(element)
      && element.matches("input, textarea, select, [contenteditable='true']")
    );
  }

  function isControlsInteractionActive() {
    return controlsPointerInside
      || controlsFocusInside
      || isEditableControl(document.activeElement);
  }

  function showControls(hideDelayMs) {
    if (controlsLocked) {
      hideControlsNow();
      showLockTemporarily();
      return;
    }

    shell?.classList.add("is-controls-visible", "is-lock-visible");
    shell?.classList.remove("is-controls-hidden");

    clearTimeout(hideControlsTimer);
    clearTimeout(hideLockTimer);
    if (isControlsInteractionActive()) return;
    hideControlsTimer = window.setTimeout(function () {
      if (isControlsInteractionActive()) {
        keepControlsVisible();
        return;
      }
      if (currentSource && shell?.classList.contains("has-source") && !video.paused) {
        shell?.classList.remove("is-controls-visible", "is-lock-visible");
        shell?.classList.add("is-controls-hidden");
      }
    }, Number.isFinite(hideDelayMs) ? hideDelayMs : 2200);
  }

  function keepControlsVisible() {
    if (controlsLocked) {
      showLockTemporarily();
      return;
    }
    shell?.classList.add("is-controls-visible", "is-lock-visible");
    shell?.classList.remove("is-controls-hidden");
    clearTimeout(hideControlsTimer);
    clearTimeout(hideLockTimer);
  }

  function destroyHlsInstance() {
    clearHlsMediaRecoveryTimer();
    clearInterval(pauseBufferTimer);
    pauseBufferTimer = null;
    if (hlsInstance) {
      try { hlsInstance.destroy(); } catch (error) {}
      hlsInstance = null;
    }
  }

  function canPlayHlsWithJs() {
    return Boolean(window.Hls && typeof window.Hls.isSupported === "function" && window.Hls.isSupported());
  }

  function isHttpUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (error) {
      return false;
    }
  }

  function requestMediaProxyUrl(source, routeName) {
    const sourceUrl = source?.sourceUrl || "";
    if (!isHttpUrl(sourceUrl)) return Promise.reject(new Error("视频源地址无效"));
    const ref = source?.refererUrl && isHttpUrl(source.refererUrl)
      ? source.refererUrl
      : (source?.pageUrl && isHttpUrl(source.pageUrl) ? source.pageUrl : sourceUrl);
    const requester = window.TogetherSeeRoomProxy?.request;
    if (typeof requester !== "function") return Promise.reject(new Error("解析服务尚未就绪"));
    return requester({
      routeName: routeName || "hls",
      url: sourceUrl,
      refUrl: ref || "",
    }).then(function (result) { return result.proxyUrl; });
  }

  function dispatchTerminalSourceError(source, reason, extra, token) {
    const loadToken = token || sourceLoadTracker.current();
    if (!sourceLoadTracker.markTerminal(loadToken)) return false;
    mediaRecoveryTransition = false;
    clearSourceWatchdog();
    dispatchPlayerEvent("together-see:player-error", Object.assign({
      source: source || currentSource,
      reason: reason || "media-error",
      generation: loadToken?.generation || 0,
    }, extra || {}));
    return true;
  }

  function clearHlsMediaRecoveryTimer() {
    clearTimeout(hlsMediaRecoveryTimer);
    hlsMediaRecoveryTimer = null;
  }

  function clearHlsStallTimeout() {
    clearTimeout(hlsStallTimeoutTimer);
    hlsStallTimeoutTimer = null;
  }

  function clearMediaStallFallback() {
    clearTimeout(mediaStallFallbackTimer);
    mediaStallFallbackTimer = null;
  }

  function scheduleMediaStallFallback() {
    if (!currentSource?.bilibili
      || currentSource.sourceType !== "video"
      || lastMediaUsingProxy
      || video.paused
      || mediaRecoveryTransition) return;
    const token = sourceLoadTracker.current();
    if (!token || mediaStallFallbackTimer) return;
    mediaStallFallbackTimer = window.setTimeout(function () {
      mediaStallFallbackTimer = null;
      if (!sourceLoadTracker.isCurrent(token)
        || lastMediaUsingProxy
        || video.paused
        || !lastBufferingState
        || video.readyState >= 3
        || getForwardBufferSeconds() > BUFFER_SPINNER_THRESHOLD) return;
      tryMediaProxyFallback("B站直连持续缓冲");
    }, BILIBILI_STALL_FALLBACK_MS);
  }

  function scheduleHlsStallTimeout() {
    if (!currentSource || currentSource.sourceType !== "hls" || video.paused) return;
    const source = currentSource;
    const token = sourceLoadTracker.current();
    if (!token || hlsStallTimeoutTimer) return;
    hlsStallTimeoutTimer = window.setTimeout(function () {
      hlsStallTimeoutTimer = null;
      if (!sourceLoadTracker.isCurrent(token) || video.paused || video.readyState >= 3 || getForwardBufferSeconds() > BUFFER_SPINNER_THRESHOLD) return;
      sourceLoadTracker.markRecovering(token);
      destroyHlsInstance();
      setText(sourceStatus, "视频流缓冲恢复超时");
      setText(playbackStatus, "当前设备加载失败");
      dispatchTerminalSourceError(source, "hls-stall-timeout", {}, token);
    }, HLS_STALL_TIMEOUT_MS);
  }

  function clearMediaLoadEvents() {
    if (mediaLoadCleanup) mediaLoadCleanup();
    mediaLoadCleanup = null;
  }

  function beginLoadGeneration(source, mode) {
    clearHlsMediaRecoveryTimer();
    clearHlsStallTimeout();
    clearMediaStallFallback();
    hlsMediaRecoveryAttempts = 0;
    lastHlsMediaRecoveryAt = 0;
    mediaRecoveryTransition = Boolean(mode && mode !== "direct");
    if (mediaRecoveryTransition) {
      setBufferingState(true, "正在切换兼容播放", { allowPausedSpinner: true });
    }
    const token = sourceLoadTracker.begin([source?.id, source?.sourceType, source?.sourceUrl, mode || "direct"].join("|"));
    video.dataset.loadGeneration = String(token.generation);
    return token;
  }

  function markSourcePlayable(source, token) {
    if (!sourceLoadTracker.markReady(token)) return;
    clearSourceWatchdog();
    clearHlsMediaRecoveryTimer();
    clearHlsStallTimeout();
    mediaRecoveryTransition = false;
    restoreMediaRecoveryIntent(source, token);
    dispatchReadyForSync();
    dispatchPlayerEvent("together-see:player-source-ready", {
      source: source,
      generation: token.generation,
    });
    updatePlayButton();
  }

  function handleMediaLoadError(source, token) {
    if (!sourceLoadTracker.isCurrent(token)) return;
    setBufferingState(false);
    if (source.sourceType === "hls" && lastHlsUsingProxy && retryHlsProxyGrant("播放授权已更新")) return;
    if (source.sourceType === "video" && lastMediaUsingProxy && retryMediaProxyGrant("播放授权已更新")) return;
    if (source.sourceType === "hls" && tryHlsProxyFallback("原生 HLS 加载失败")) return;
    if (source.sourceType === "video" && tryMediaProxyFallback("直链加载失败")) return;
    if (source.sourceType === "hls" && video.error?.code === 3 && tryHlsMediaRecovery(hlsInstance, source, token)) return;

    const dispatched = dispatchTerminalSourceError(source, "media-error", {
      errorCode: video.error?.code || null,
    }, token);
    if (!dispatched) return;

    shell?.classList.remove("has-source", "is-controls-hidden");
    shell?.classList.add("is-pending", "is-controls-visible");
    if (empty) empty.hidden = false;
    setText(sourceStatus, "视频源加载失败");
    setText(playbackStatus, "请检查链接是否允许跨站播放");
    setText(emptyText, "浏览器无法加载这个视频源，可能是跨域、防盗链、签名过期、编码不兼容或链接本身不可播放。系统已完成有限次数的直连与兼容加载尝试。");
  }

  function isExpectedMediaUrl(expectedUrl) {
    if (!expectedUrl) return true;
    const currentUrl = video.currentSrc || video.src || "";
    if (!currentUrl) return false;
    try {
      return new URL(currentUrl, window.location.href).href === new URL(expectedUrl, window.location.href).href;
    } catch (error) {
      return currentUrl === expectedUrl;
    }
  }

  function bindMediaLoadEvents(source, token, expectedUrl) {
    clearMediaLoadEvents();
    const isCurrentLoad = function () {
      return sourceLoadTracker.isCurrent(token) && isExpectedMediaUrl(expectedUrl);
    };
    const onLoadedMetadata = function () {
      if (!isCurrentLoad()) return;
      updateTimeUi();
      updatePlayButton();
      applyInitialSeekIfNeeded("已定位到房主进度");
      setBufferingState(false);
      dispatchReadyForSync();
    };
    const onCanPlay = function () {
      if (!isCurrentLoad()) return;
      updatePlayButton();
      setBufferingState(false, video.paused ? "已暂停 · 点击播放" : "正在播放");
      markSourcePlayable(source, token);
    };
    const onPlaying = function () {
      if (!isCurrentLoad()) return;
      markSourcePlayable(source, token);
    };
    const onError = function () {
      if (!isCurrentLoad()) return;
      handleMediaLoadError(source, token);
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("error", onError);
    mediaLoadCleanup = function () {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("error", onError);
    };
  }

  function getSafeStartTime(value) {
    const time = Number(value);
    return Number.isFinite(time) && time > 0 ? Math.max(0, time) : null;
  }

  function applyInitialSeekIfNeeded(label) {
    const token = getCurrentLoadToken();
    const pendingInitialSeekTime = token ? initialSeekState.peek(token) : null;
    if (pendingInitialSeekTime === null || !Number.isFinite(pendingInitialSeekTime)) return false;
    if (video.readyState < 1) return false;
    const target = Math.max(0, pendingInitialSeekTime);
    try {
      const duration = Number(video.duration);
      video.currentTime = Number.isFinite(duration) && duration > 0 ? Math.min(Math.max(0, duration - 0.05), target) : target;
      initialSeekState.take(token);
      if (label) setText(playbackStatus, label);
      dispatchPlayerEvent("together-see:player-ready-for-sync", {
        source: currentSource,
        generation: token.generation,
        initialSeekApplied: true,
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  function dispatchReadyForSync() {
    const token = getCurrentLoadToken();
    dispatchPlayerEvent("together-see:player-ready-for-sync", {
      source: currentSource,
      generation: token?.generation || 0,
      readyState: video.readyState,
      currentTime: video.currentTime || 0,
    });
  }

  function shouldUseHlsProxyFirst(source, options) {
    if (options?.useProxy === true) return true;
    if (options?.useProxy === false) return false;
    if (!source?.sourceUrl) return false;
    try {
      const url = new URL(source.sourceUrl, window.location.href);
      return url.origin !== window.location.origin;
    } catch (error) {
      return true;
    }
  }

  function recoverHlsStall(detail) {
    if (!hlsInstance || !currentSource || currentSource.sourceType !== "hls") return;
    const now = Date.now();
    if (now - lastHlsStallRecoveryAt < 1600) return;
    lastHlsStallRecoveryAt = now;
    setText(playbackStatus, "视频流正在恢复缓冲");
    scheduleHlsStallTimeout();
  }

  function tryHlsMediaRecovery(instance, source, token) {
    if (!instance || instance !== hlsInstance || !sourceLoadTracker.isCurrent(token)) return false;
    const now = Date.now();
    if (hlsMediaRecoveryAttempts >= HLS_MEDIA_RECOVERY_LIMIT) {
      return now - lastHlsMediaRecoveryAt < HLS_MEDIA_RECOVERY_SETTLE_MS;
    }
    hlsMediaRecoveryAttempts += 1;
    lastHlsMediaRecoveryAt = now;
    setText(playbackStatus, "正在恢复媒体解码");
    try {
      sourceLoadTracker.markRecovering(token);
      instance.recoverMediaError();
      clearHlsMediaRecoveryTimer();
      hlsMediaRecoveryTimer = window.setTimeout(function () {
        if (!sourceLoadTracker.isCurrent(token) || sourceLoadTracker.isReady(token)) return;
        destroyHlsInstance();
        setText(sourceStatus, "视频流恢复超时");
        setText(playbackStatus, "当前设备加载失败");
        dispatchTerminalSourceError(source, "hls-media-recovery-timeout", {}, token);
      }, HLS_MEDIA_RECOVERY_TIMEOUT_MS);
      return true;
    } catch (error) {
      return false;
    }
  }

  function tryHlsProxyFallback(reason) {
    if (!lastHlsSource || lastHlsUsingProxy) return false;
    const recoveryIntent = captureMediaRecoveryIntent(lastHlsSource);
    const fallback = proxyFallbackController.begin(getSourceIdentity(lastHlsSource), recoveryIntent);
    if (!fallback) return false;

    setText(sourceStatus, "直连失败，尝试兼容解析");
    setText(playbackStatus, "正在切换兼容播放");
    const token = beginLoadGeneration(lastHlsSource, "hls-proxy");
    const ok = loadHlsSource(lastHlsSource, {
      useProxy: true,
      token: token,
      startTime: recoveryIntent.currentTime,
      recoveryIntent: recoveryIntent,
    });
    if (ok) startSourceWatchdog(lastHlsSource, token);
    return ok;
  }

  function tryMediaProxyFallback(reason) {
    if (!lastMediaSource || lastMediaUsingProxy || lastMediaSource.sourceType !== "video") return false;
    const recoveryIntent = captureMediaRecoveryIntent(lastMediaSource);
    const fallback = proxyFallbackController.begin(getSourceIdentity(lastMediaSource), recoveryIntent);
    if (!fallback) return false;

    lastMediaUsingProxy = true;
    video.dataset.mediaProxy = "true";
    video.removeAttribute("referrerpolicy");
    setText(sourceStatus, "直链失败，尝试兼容解析");
    setText(playbackStatus, "正在切换兼容播放");
    const token = beginLoadGeneration(lastMediaSource, "media-proxy");
    requestMediaProxyUrl(lastMediaSource, "media").then(function (proxyUrl) {
      if (!sourceLoadTracker.isCurrent(token)) return;
      bindInitialSeek(recoveryIntent.currentTime, token);
      bindMediaRecoveryIntent(recoveryIntent, token);
      bindMediaLoadEvents(lastMediaSource, token, proxyUrl);
      video.src = proxyUrl;
      video.load();
      video.playbackRate = Math.min(3, Math.max(0.25, Number(recoveryIntent.playbackRate) || 1));
      startSourceWatchdog(lastMediaSource, token);
    }).catch(function (error) {
      if (!sourceLoadTracker.isCurrent(token)) return;
      setText(sourceStatus, "授权解析失败");
      setText(playbackStatus, error?.message || "当前设备加载失败");
      dispatchTerminalSourceError(lastMediaSource, "media-proxy-token-failed", {}, token);
    });
    startSourceWatchdog(lastMediaSource, token);
    return true;
  }

  function retryHlsProxyGrant(reason) {
    if (!lastHlsSource || !lastHlsUsingProxy || hlsProxyGrantRefreshAttempts >= 1) return false;
    hlsProxyGrantRefreshAttempts += 1;
    const recoveryIntent = captureMediaRecoveryIntent(lastHlsSource);
    const token = beginLoadGeneration(lastHlsSource, "hls-proxy-refresh");
    setText(sourceStatus, "正在刷新解析授权");
    setText(playbackStatus, "正在恢复兼容播放");
    const ok = loadHlsSource(lastHlsSource, {
      useProxy: true,
      token: token,
      startTime: recoveryIntent.currentTime,
      recoveryIntent: recoveryIntent,
    });
    if (ok) startSourceWatchdog(lastHlsSource, token);
    return ok;
  }

  function retryMediaProxyGrant(reason) {
    if (!lastMediaSource || !lastMediaUsingProxy || mediaProxyGrantRefreshAttempts >= 1) return false;
    mediaProxyGrantRefreshAttempts += 1;
    const recoveryIntent = captureMediaRecoveryIntent(lastMediaSource);
    const token = beginLoadGeneration(lastMediaSource, "media-proxy-refresh");
    video.removeAttribute("referrerpolicy");
    setText(sourceStatus, "正在刷新解析授权");
    setText(playbackStatus, "正在恢复兼容播放");
    requestMediaProxyUrl(lastMediaSource, "media").then(function (proxyUrl) {
      if (!sourceLoadTracker.isCurrent(token)) return;
      bindInitialSeek(recoveryIntent.currentTime, token);
      bindMediaRecoveryIntent(recoveryIntent, token);
      bindMediaLoadEvents(lastMediaSource, token, proxyUrl);
      video.src = proxyUrl;
      video.load();
      video.playbackRate = Math.min(3, Math.max(0.25, Number(recoveryIntent.playbackRate) || 1));
      startSourceWatchdog(lastMediaSource, token);
    }).catch(function (error) {
      if (!sourceLoadTracker.isCurrent(token)) return;
      setText(sourceStatus, "解析授权刷新失败");
      setText(playbackStatus, error?.message || "当前设备加载失败");
      dispatchTerminalSourceError(lastMediaSource, "media-proxy-token-refresh-failed", {}, token);
    });
    startSourceWatchdog(lastMediaSource, token);
    return true;
  }

  function loadHlsSource(source, options) {
    destroyHlsInstance();
    const loadToken = options?.token || sourceLoadTracker.current();

    const useProxy = shouldUseHlsProxyFirst(source, options);
    const startPosition = getSafeStartTime(options?.startTime);
    bindInitialSeek(startPosition, loadToken);
    bindMediaRecoveryIntent(options?.recoveryIntent || null, loadToken);
    if (useProxy && !options?.proxyUrl) {
      setText(sourceStatus, "正在申请解析授权");
      requestMediaProxyUrl(source, "hls").then(function (proxyUrl) {
        if (!sourceLoadTracker.isCurrent(loadToken)) return;
        loadHlsSource(source, Object.assign({}, options || {}, { useProxy: true, proxyUrl: proxyUrl, token: loadToken }));
      }).catch(function (error) {
        if (!sourceLoadTracker.isCurrent(loadToken)) return;
        setText(sourceStatus, "授权解析失败");
        setText(playbackStatus, error?.message || "当前设备加载失败");
        dispatchTerminalSourceError(source, "hls-proxy-token-failed", {}, loadToken);
      });
      return true;
    }
    const loadUrl = useProxy ? options?.proxyUrl : source.sourceUrl;
    if (!loadUrl) {
      setPendingState(source, "没有可加载的 HLS/M3U8 地址。请检查链接是否有效。");
      return false;
    }

    lastHlsSource = source;
    lastHlsUsingProxy = useProxy;
    video.dataset.hlsProxy = useProxy ? "true" : "false";

    if (canPlayNativeHls()) {
      bindMediaLoadEvents(source, loadToken, loadUrl);
      video.preload = "auto";
      video.src = loadUrl;
      video.load();
      setText(sourceStatus, useProxy ? "兼容模式加载中" : "视频流加载中");
      setText(playbackStatus, startPosition !== null ? "正在从房主进度加载" : "等待视频元数据");
      return true;
    }

    if (!canPlayHlsWithJs()) {
      setPendingState(source, "当前浏览器暂不支持该视频流格式，播放组件也未能正常加载。请换用其他浏览器，或改用 MP4/WebM 直链。");
      setTextAll(sourceChips, "流媒体播放不可用");
      setText(sourceStatus, "视频流不可用");
      setText(playbackStatus, "播放组件未就绪");
      return false;
    }

    clearMediaLoadEvents();

    const instance = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
      autoStartLoad: false,
      startPosition: startPosition !== null ? startPosition : -1,
      startFragPrefetch: true,
      capLevelToPlayerSize: true,
      backBufferLength: HLS_BACK_BUFFER_SECONDS,
      maxBufferLength: HLS_FORWARD_BUFFER_SECONDS,
      maxMaxBufferLength: HLS_MAX_FORWARD_BUFFER_SECONDS,
      maxBufferSize: HLS_MAX_BUFFER_SIZE,
      maxBufferHole: 0.85,
      maxSeekHole: 2,
      maxFragLookUpTolerance: 0.25,
      nudgeOffset: 0.1,
      nudgeMaxRetry: 6,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 500,
      manifestLoadingMaxRetryTimeout: 10000,
      levelLoadingTimeOut: 20000,
      levelLoadingMaxRetry: 5,
      levelLoadingRetryDelay: 500,
      levelLoadingMaxRetryTimeout: 12000,
      fragLoadingTimeOut: 30000,
      fragLoadingMaxRetry: 10,
      fragLoadingRetryDelay: 500,
      fragLoadingMaxRetryTimeout: 12000,
      appendErrorMaxRetry: 6,
    });

    hlsInstance = instance;

    instance.on(window.Hls.Events.MEDIA_ATTACHED, function () {
      if (instance !== hlsInstance || !sourceLoadTracker.isCurrent(loadToken)) return;
      bindMediaLoadEvents(source, loadToken, video.currentSrc || video.src);
      instance.loadSource(loadUrl);
      setText(sourceStatus, useProxy ? "兼容模式加载中" : "视频流加载中");
      setText(playbackStatus, "正在读取视频流");
    });

    instance.on(window.Hls.Events.MANIFEST_PARSED, function () {
      if (instance !== hlsInstance || !sourceLoadTracker.isCurrent(loadToken)) return;
      try { instance.startLoad(startPosition !== null ? startPosition : -1); } catch (error) {}
      setText(sourceStatus, useProxy ? "兼容模式已就绪" : "视频流已就绪");
      setText(playbackStatus, startPosition !== null ? "正在从房主进度缓冲" : "等待点击播放");
    });

    instance.on(window.Hls.Events.FRAG_BUFFERED, function () {
      if (instance !== hlsInstance || !sourceLoadTracker.isCurrent(loadToken)) return;
      if (applyInitialSeekIfNeeded("已定位到房主进度")) return;
      dispatchReadyForSync();
    });

    instance.on(window.Hls.Events.ERROR, function (_event, data) {
      if (instance !== hlsInstance || !sourceLoadTracker.isCurrent(loadToken)) return;
      const detail = data?.details || data?.type || "未知错误";
      const detailText = String(detail);

      if (/buffer(Stalled|Nudge|Seek|Append)|buffer/i.test(detailText) && !data?.fatal) {
        recoverHlsStall(detailText);
        return;
      }

      if (!data?.fatal) return;

      setText(sourceStatus, "视频流加载异常");
      setText(playbackStatus, "当前视频流加载异常");

      if (!useProxy && data.type === window.Hls.ErrorTypes.NETWORK_ERROR && tryHlsProxyFallback(detail)) return;
      if (useProxy && data.type === window.Hls.ErrorTypes.NETWORK_ERROR && retryHlsProxyGrant(detail)) return;

      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && tryHlsMediaRecovery(instance, source, loadToken)) return;

      destroyHlsInstance();
      dispatchTerminalSourceError(source, detailText, { hls: data }, loadToken);
    });

    instance.attachMedia(video);
    return true;
  }

  function resetVideoElement() {
    clearSourceWatchdog();
    clearHlsStallTimeout();
    clearMediaStallFallback();
    clearMediaLoadEvents();
    destroyHlsInstance();
    lastHlsSource = null;
    lastHlsUsingProxy = false;
    lastMediaSource = null;
    lastMediaUsingProxy = false;
    hlsProxyGrantRefreshAttempts = 0;
    mediaProxyGrantRefreshAttempts = 0;
    hlsMediaRecoveryAttempts = 0;
    lastHlsMediaRecoveryAt = 0;
    initialSeekState.clear();
    mediaRecoveryIntentState.clear();
    mediaRecoveryTransition = false;
    recoveryPlayOperations.invalidate();
    userPlayOperations.invalidate();
    setBufferingState(false);
    clearInterval(pauseBufferTimer);
    pauseBufferTimer = null;
    video.pause();
    video.preload = "auto";
    video.removeAttribute("referrerpolicy");
    video.removeAttribute("src");
    delete video.dataset.sourceId;
    delete video.dataset.sourceUrl;
    delete video.dataset.sourceType;
    delete video.dataset.hlsProxy;
    delete video.dataset.mediaProxy;
    video.load();
    updatePlayButton();
    setProgress(progressCurrent, 0);
    setProgress(progressBuffer, 0);
  }

  function setPendingState(item, message) {
    sourceLoadTracker.invalidate();
    currentSource = item || null;
    clearDanmaku();
    clearTimelineDanmaku();
    shell?.classList.remove("has-source", "is-controls-hidden");
    shell?.classList.add("is-pending", "is-controls-visible");
    resetVideoElement();

    setTextAll(sourceChips, "等待解析视频源");
    setTextAll(modeChips, "播放器已就绪");
    setTextAll(stageTimes, "尚未开始播放");
    setText(stageClock, item?.title ? "已选中：" + item.title : "等待解析视频源");
    setText(sourceStatus, "等待视频源");
    setText(playbackStatus, "等待后端解析");
    setText(emptyText, message || "该链接已进入播放队列。后续接入后端解析服务后，会把真实视频源加载到这里。");
    setButtonSvg(centerPlayButton, playSvg, "播放");
    setButtonSvg(playButton, playSvg, "播放");

    if (empty) empty.hidden = false;
  }

  function clearSource(message) {
    setPendingState(null, message || "加入房间后才会加载视频内容。");
  }

  function loadSource(item, options) {
    const source = {
      id: item?.id || "manual-source",
      title: item?.title || "未命名视频",
      pageUrl: item?.pageUrl || item?.sourceUrl || "",
      refererUrl: item?.refererUrl || item?.pageUrl || item?.sourceUrl || "",
      sourceUrl: item?.sourceUrl || item?.pageUrl || "",
      sourceType: item?.sourceType || guessSourceType(item?.sourceUrl || item?.pageUrl || ""),
      localFile: item?.localFile || null,
      bilibili: item?.bilibili || null,
    };

    if (source.sourceType === "local" && (!source.sourceUrl || source.sourceUrl.startsWith("local:"))) {
      setPendingState(source, "这是房间内的本地视频条目。浏览器不能把本地文件直接共享给其他成员，请在本机选择同一个视频文件后再同步播放。");
      setTextAll(sourceChips, "等待选择本地文件");
      setText(sourceStatus, "需要本机文件");
      setText(playbackStatus, "请选择本地视频文件");
      return false;
    }

    if (!source.sourceUrl) {
      setPendingState(source, "还没有可加载的视频源。请先从右侧添加一个带视频的链接。");
      return false;
    }
    if (source.sourceType === "page" || source.sourceType === "unknown") {
      setPendingState(source, "暂时无法从这个页面获得可播放的视频。请使用可公开访问的视频页面，或直接添加 MP4 / HLS 地址。");
      return false;
    }
    if (source.sourceType === "dash") {
      setPendingState(source, "暂不支持 DASH / MPD 格式。请改用可公开播放的 MP4 或 HLS 地址。");
      return false;
    }
    const isSameSource = !options?.forceReload && currentSource
      && currentSource.id === source.id
      && video.dataset.sourceId === source.id
      && video.dataset.sourceUrl === source.sourceUrl
      && video.src;

    currentSource = source;
    shell?.classList.add("has-source", "is-controls-visible");
    shell?.classList.remove("is-pending", "is-controls-hidden");
    if (empty) empty.hidden = true;

    if (!isSameSource) {
      proxyFallbackController.reset(getSourceIdentity(source));
      clearDanmaku();
      clearTimelineDanmaku();
      resetVideoElement();
      const loadToken = beginLoadGeneration(source, "direct");
      const requestedPlaybackIntent = createLoadPlaybackIntent(source, options);
      bindMediaRecoveryIntent(requestedPlaybackIntent, loadToken);
      video.dataset.sourceId = source.id;
      video.dataset.sourceUrl = source.sourceUrl;
      video.dataset.sourceType = source.sourceType;
      video.dataset.loadGeneration = String(loadToken.generation);

      if (source.sourceType === "hls") {
        const hlsLoaded = loadHlsSource(source, {
          useProxy: options?.useProxy,
          startTime: options?.startTime,
          token: loadToken,
          recoveryIntent: requestedPlaybackIntent,
        });
        if (!hlsLoaded) return false;
      } else if (source.sourceType === "video" && source.bilibili) {
        lastMediaSource = source;
        lastMediaUsingProxy = false;
        video.dataset.mediaProxy = "false";
        video.referrerPolicy = "no-referrer";
        bindInitialSeek(options?.startTime, loadToken);
        bindMediaLoadEvents(source, loadToken, source.sourceUrl);
        video.preload = "auto";
        video.src = source.sourceUrl;
        video.load();
        setText(sourceStatus, "B站直连加载中");
      } else {
        lastMediaSource = source;
        lastMediaUsingProxy = false;
        video.dataset.mediaProxy = "false";
        video.removeAttribute("referrerpolicy");
        bindInitialSeek(options?.startTime, loadToken);
        bindMediaLoadEvents(source, loadToken, source.sourceUrl);
        video.preload = "auto";
        video.src = source.sourceUrl;
        video.load();
      }
    }

    const sourceLabel = source.sourceType === "local"
      ? "本地视频源"
      : source.sourceType === "hls"
        ? "HLS 视频源"
        : "直接视频源";
    setTextAll(sourceChips, sourceLabel);
    setTextAll(modeChips, source.sourceType === "local" ? "本地文件同步" : source.sourceType === "hls" ? "HLS 兼容播放" : "浏览器播放");
    setTextAll(stageTimes, "00:00 / 读取时长中");
    setText(stageClock, source.title);
    setText(sourceStatus, "视频源已加载");
    setText(playbackStatus, options?.playWhenReady === true ? "加载完成后自动播放" : "已暂停 · 点击播放");
    showControls();
    startSourceWatchdog(source, sourceLoadTracker.current());

    return true;
  }

  async function togglePlay() {
    if (!currentSource || !video.src) {
      setPendingState(currentSource, "还没有可播放的视频源。请先添加直接 MP4/WebM 链接，或在本机选择需要同步的本地视频。");
      return;
    }

    if (!playbackControlEnabled && syncPlaybackPending && video.paused) {
      const loadToken = getCurrentLoadToken();
      const operation = userPlayOperations.begin([loadToken?.generation || 0, currentSource?.id || "", "sync-resume"].join("|"));
      try {
        await video.play();
        if (!userPlayOperations.isCurrent(operation) || (loadToken && !isCurrentLoadToken(loadToken))) return;
        syncPlaybackPending = false;
        updatePlaybackControlUi();
        dispatchPlayerEvent("together-see:sync-playback-resumed");
        showControls();
      } catch (error) {
        if (!userPlayOperations.isCurrent(operation) || (loadToken && !isCurrentLoadToken(loadToken))) return;
        setText(playbackStatus, "浏览器仍未允许播放，请再次点按播放按钮");
      }
      return;
    }
    if (!ensurePlaybackControl()) return;

    if (video.paused) {
      const loadToken = getCurrentLoadToken();
      const operation = userPlayOperations.begin([loadToken?.generation || 0, currentSource?.id || "", "user-play"].join("|"));
      try {
        clearInterval(pauseBufferTimer);
        pauseBufferTimer = null;
        await video.play();
        if (!userPlayOperations.isCurrent(operation) || (loadToken && !isCurrentLoadToken(loadToken))) return;
        dispatchPlaybackUserAction("play");
        showControls();
      } catch (error) {
        if (!userPlayOperations.isCurrent(operation) || (loadToken && !isCurrentLoadToken(loadToken))) return;
        setText(playbackStatus, "浏览器阻止自动播放，请手动点击视频控件");
      }
    } else {
      userPlayOperations.invalidate();
      video.pause();
      dispatchPlaybackUserAction("pause");
      showControls();
    }
  }

  function updateTimeUi() {
    const current = video.currentTime || 0;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const currentText = formatTime(current);
    const durationText = duration > 0 ? formatTime(duration) : "读取时长中";

    setTextAll(stageTimes, currentText + " / " + durationText);
    setProgress(progressCurrent, duration > 0 ? (current / duration) * 100 : 0);
  }

  function updateBufferUi() {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration || !video.buffered.length) {
      setProgress(progressBuffer, 0);
      return;
    }
    const end = video.buffered.end(video.buffered.length - 1);
    setProgress(progressBuffer, (end / duration) * 100);
    refreshBufferingFromMediaState();
  }

  function updatePlayButton() {
    const paused = video.paused;
    setButtonSvg(playButton, paused ? playSvg : pauseSvg, paused ? "播放" : "暂停");
    setButtonSvg(centerPlayButton, paused ? playSvg : pauseSvg, paused ? "播放" : "暂停");
    if (!shell?.classList.contains("is-buffering")) {
      setText(playbackStatus, paused ? "已暂停" : "正在播放");
    }
    showControls();
  }

  function cycleRate() {
    if (!ensurePlaybackControl()) return;
    currentRateIndex = (currentRateIndex + 1) % rateSteps.length;
    const rate = rateSteps[currentRateIndex];
    video.playbackRate = rate;
    setText(rateButton, rate.toFixed(2) + "x");
    rateButton?.setAttribute("title", "切换倍速：" + rate.toFixed(2) + "x");
    rateButton?.setAttribute("aria-label", "切换倍速，当前 " + rate.toFixed(2) + "x");
    setText(playbackStatus, "倍速 " + rate.toFixed(2) + "x");
    dispatchPlaybackUserAction("rate");
    showControls();
  }

  function clearDanmaku() {
    window.clearTimeout(danmakuFlushTimer);
    danmakuFlushTimer = null;
    danmakuQueue = [];
    danmakuLaneAvailableAt = [];
    if (danmakuLayer) danmakuLayer.innerHTML = "";
  }

  function clearSourceDanmakuDisplay() {
    danmakuQueue = danmakuQueue.filter(function (message) { return message.kind !== "source"; });
    danmakuLayer?.querySelectorAll(".is-source-danmaku").forEach(function (node) { node.remove(); });
    danmakuLaneAvailableAt = [];
  }

  function findTimelineIndex(time) {
    let low = 0;
    let high = timelineDanmaku.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (timelineDanmaku[middle].time < time) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function resetTimelineDanmakuCursor(time) {
    const currentTime = Number.isFinite(Number(time)) ? Math.max(0, Number(time)) : 0;
    timelineDanmakuIndex = findTimelineIndex(Math.max(0, currentTime - 0.08));
    timelineDanmakuLastTime = currentTime;
  }

  function clearTimelineDanmaku() {
    if (timelineDanmakuAnimationFrame !== null) {
      window.cancelAnimationFrame(timelineDanmakuAnimationFrame);
      timelineDanmakuAnimationFrame = null;
    }
    timelineDanmaku = [];
    timelineDanmakuKey = "";
    timelineDanmakuIndex = 0;
    timelineDanmakuLastTime = null;
    timelineDanmakuSeeking = false;
    shell?.classList.remove("has-source-danmaku");
    clearSourceDanmakuDisplay();
  }

  function setTimelineDanmaku(entries, key) {
    const nextKey = String(key || "");
    if (nextKey && nextKey === timelineDanmakuKey && timelineDanmaku.length) return timelineDanmaku.length;
    clearSourceDanmakuDisplay();
    timelineDanmaku = (Array.isArray(entries) ? entries : []).map(function (entry, index) {
      const time = Number(entry?.time);
      const text = String(entry?.text || "").replace(/\s+/g, " ").trim().slice(0, 100);
      if (!Number.isFinite(time) || time < 0 || !text) return null;
      const mode = entry?.mode === "top" || entry?.mode === "bottom" ? entry.mode : "scroll";
      const color = /^#[0-9a-f]{6}$/i.test(String(entry?.color || "")) ? String(entry.color) : "#ffffff";
      return {
        id: String(entry?.id || ("timeline-" + index)).slice(0, 80),
        senderId: "bilibili",
        text: text,
        time: time,
        mode: mode,
        color: color,
        fontSize: Math.min(36, Math.max(12, Number(entry?.fontSize) || 25)),
        kind: "source",
      };
    }).filter(Boolean).sort(function (left, right) { return left.time - right.time; });
    timelineDanmakuKey = nextKey;
    shell?.classList.toggle("has-source-danmaku", timelineDanmaku.length > 0);
    resetTimelineDanmakuCursor(video.currentTime || 0);
    processTimelineDanmaku();
    scheduleTimelineDanmakuFrame();
    return timelineDanmaku.length;
  }

  function scheduleTimelineDanmakuFrame() {
    if (timelineDanmakuAnimationFrame !== null
      || !timelineDanmaku.length
      || video.paused
      || video.ended) return;
    timelineDanmakuAnimationFrame = window.requestAnimationFrame(function () {
      timelineDanmakuAnimationFrame = null;
      processTimelineDanmaku();
      scheduleTimelineDanmakuFrame();
    });
  }

  function processTimelineDanmaku() {
    if (!timelineDanmaku.length || timelineDanmakuSeeking || video.paused || video.seeking) return;
    const currentTime = Math.max(0, Number(video.currentTime) || 0);
    if (timelineDanmakuLastTime === null
      || currentTime < timelineDanmakuLastTime - 0.35
      || currentTime > timelineDanmakuLastTime + 1.5) {
      resetTimelineDanmakuCursor(currentTime);
    }
    const previousTime = timelineDanmakuLastTime === null ? currentTime : timelineDanmakuLastTime;
    const dueUntil = currentTime + 0.16;
    let rendered = 0;
    while (timelineDanmakuIndex < timelineDanmaku.length && timelineDanmaku[timelineDanmakuIndex].time <= dueUntil) {
      const message = timelineDanmaku[timelineDanmakuIndex];
      timelineDanmakuIndex += 1;
      if (message.time >= previousTime - 0.12 && rendered < 10) {
        showDanmaku(message);
        rendered += 1;
      }
    }
    timelineDanmakuLastTime = currentTime;
  }

  function getDanmakuLaneCount() {
    if (!danmakuLayer) return 0;
    const laneHeight = window.innerWidth <= 760 ? 25 : 30;
    return Math.max(1, Math.min(7, Math.floor(danmakuLayer.clientHeight / laneHeight)));
  }

  function scheduleDanmakuFlush(delay) {
    window.clearTimeout(danmakuFlushTimer);
    danmakuFlushTimer = window.setTimeout(flushDanmakuQueue, Math.max(16, Number(delay || 0)));
  }

  function spawnDanmaku(message, laneIndex, laneHeight) {
    if (!danmakuLayer) return;
    const item = document.createElement("span");
    item.className = "danmaku-item is-measuring " + (message.kind === "source" ? "is-source-danmaku" : "is-room-danmaku");
    item.textContent = message.text;
    item.dataset.danmakuId = message.id || "";
    item.dataset.senderId = message.senderId || "";
    item.style.top = (laneIndex * laneHeight) + "px";
    if (message.color) item.style.color = message.color;
    if (message.fontSize) item.style.fontSize = Math.min(22, Math.max(13, message.fontSize * 0.72)) + "px";
    danmakuLayer.appendChild(item);

    if (message.mode === "top" || message.mode === "bottom") {
      item.classList.add(message.mode === "top" ? "is-fixed-top" : "is-fixed-bottom");
      if (message.mode === "bottom") {
        item.style.top = Math.max(0, danmakuLayer.clientHeight - ((laneIndex + 1) * laneHeight)) + "px";
      }
      item.classList.remove("is-measuring");
      window.setTimeout(function () {
        item.remove();
        flushDanmakuQueue();
      }, 4000);
      danmakuLaneAvailableAt[laneIndex] = performance.now() + 4100;
      return;
    }

    const layerWidth = Math.max(1, danmakuLayer.clientWidth);
    const textWidth = Math.max(1, item.getBoundingClientRect().width);
    const durationMs = Math.min(14000, Math.max(7000, ((layerWidth + textWidth) / DANMAKU_SPEED_PX_PER_SECOND) * 1000));
    item.style.setProperty("--danmaku-start", layerWidth + "px");
    item.style.setProperty("--danmaku-end", (-textWidth) + "px");
    item.style.setProperty("--danmaku-duration", durationMs + "ms");
    item.classList.remove("is-measuring");
    item.addEventListener("animationend", function () {
      item.remove();
      flushDanmakuQueue();
    }, { once: true });

    danmakuLaneAvailableAt[laneIndex] = performance.now() + ((textWidth + 28) / DANMAKU_SPEED_PX_PER_SECOND) * 1000;
  }

  function flushDanmakuQueue() {
    window.clearTimeout(danmakuFlushTimer);
    danmakuFlushTimer = null;
    if (!danmakuVisible || !danmakuLayer || !shell?.classList.contains("has-source")) return;

    const laneCount = getDanmakuLaneCount();
    const laneHeight = window.innerWidth <= 760 ? 25 : 30;
    if (danmakuLaneAvailableAt.length !== laneCount) {
      danmakuLaneAvailableAt = Array.from({ length: laneCount }, function (_, index) {
        return danmakuLaneAvailableAt[index] || 0;
      });
    }

    while (danmakuQueue.length) {
      const now = performance.now();
      const availableLanes = [];
      danmakuLaneAvailableAt.forEach(function (availableAt, index) {
        if (availableAt <= now) availableLanes.push(index);
      });
      if (!availableLanes.length) {
        scheduleDanmakuFlush(Math.min.apply(null, danmakuLaneAvailableAt) - now);
        return;
      }
      const laneIndex = availableLanes[Math.floor(Math.random() * availableLanes.length)];
      spawnDanmaku(danmakuQueue.shift(), laneIndex, laneHeight);
    }
  }

  function showDanmaku(message) {
    const text = String(message?.text || "").replace(/\s+/g, " ").trim().slice(0, 100);
    if (!text || !danmakuVisible || !shell?.classList.contains("has-source")) return false;
    danmakuQueue.push({
      id: String(message?.id || ""),
      senderId: String(message?.senderId || ""),
      text: text,
      mode: message?.mode === "top" || message?.mode === "bottom" ? message.mode : "scroll",
      color: /^#[0-9a-f]{6}$/i.test(String(message?.color || "")) ? String(message.color) : "",
      fontSize: Number.isFinite(Number(message?.fontSize)) ? Number(message.fontSize) : null,
      kind: message?.kind === "source" ? "source" : "room",
    });
    if (danmakuQueue.length > DANMAKU_QUEUE_LIMIT) danmakuQueue.shift();
    flushDanmakuQueue();
    return true;
  }

  function setDanmakuVisible(visible) {
    danmakuVisible = Boolean(visible);
    shell?.classList.toggle("danmaku-hidden", !danmakuVisible);
    if (!danmakuVisible) {
      if (timelineDanmakuAnimationFrame !== null) {
        window.cancelAnimationFrame(timelineDanmakuAnimationFrame);
        timelineDanmakuAnimationFrame = null;
      }
      clearDanmaku();
    }
    else {
      resetTimelineDanmakuCursor(video.currentTime || 0);
      scheduleTimelineDanmakuFrame();
    }
    saveDanmakuPreference();
    if (danmakuButton) {
      danmakuButton.dataset.danmakuOn = danmakuVisible ? "true" : "false";
      danmakuButton.classList.toggle("is-active", danmakuVisible);
      danmakuButton.innerHTML = danmakuVisible ? danmakuOnSvg : danmakuOffSvg;
      danmakuButton.setAttribute("title", danmakuVisible ? "弹幕开" : "弹幕关");
      danmakuButton.setAttribute("aria-label", danmakuVisible ? "关闭弹幕" : "开启弹幕");
    }
    dispatchPlayerEvent("together-see:danmaku-visibility", { visible: danmakuVisible });
    showControls();
  }

  function toggleDanmaku() {
    setDanmakuVisible(!danmakuVisible);
  }

  function updateVolumeUi() {
    if (!volumeButton) return;
    const percent = Math.round((video.muted ? 0 : video.volume) * 100);
    const label = percent <= 0 ? "静音" : "音量 " + percent + "%";
    volumeButton.innerHTML = percent <= 0 ? volumeMutedSvg : percent < 50 ? volumeLowSvg : volumeHighSvg;
    volumeButton.setAttribute("title", label);
    volumeButton.setAttribute("aria-label", label);
    if (volumeValue) {
      volumeValue.textContent = percent + "%";
    }
    if (volumeRange) {
      volumeRange.style.setProperty("--volume-percent", percent + "%");
      volumeControl?.style.setProperty("--volume-percent", percent + "%");
      volumePopover?.style.setProperty("--volume-percent", percent + "%");
      if (document.activeElement !== volumeRange) {
        volumeRange.value = String(percent);
      }
    }
  }

  function toggleVolumePopover(event) {
    event?.stopPropagation();
    volumeControl?.classList.toggle("is-open");
    showControls();
  }

  function closeVolumePopover() {
    volumeControl?.classList.remove("is-open");
  }

  function setVolumeFromRange() {
    if (!volumeRange) return;
    const nextValue = Math.max(0, Math.min(100, Number(volumeRange.value) || 0));
    volumeRange.style.setProperty("--volume-percent", nextValue + "%");
    volumeControl?.style.setProperty("--volume-percent", nextValue + "%");
    volumePopover?.style.setProperty("--volume-percent", nextValue + "%");
    if (volumeValue) {
      volumeValue.textContent = nextValue + "%";
    }
    video.volume = nextValue / 100;
    video.muted = nextValue === 0;
    updateVolumeUi();
    showControls();
  }

  function updateControlLockUi() {
    if (!controlLockButton) return;
    controlLockButton.innerHTML = controlsLocked ? lockClosedSvg : lockOpenSvg;
    controlLockButton.setAttribute("title", controlsLocked ? "解锁控制器" : "锁定控制器");
    controlLockButton.setAttribute("aria-label", controlsLocked ? "解锁控制器" : "锁定控制器");
    shell?.classList.toggle("is-controls-locked", controlsLocked);
  }

  function toggleControlLock(event) {
    event?.stopPropagation();
    controlsLocked = !controlsLocked;
    updateControlLockUi();
    if (controlsLocked) {
      hideControlsNow();
      showLockTemporarily();
    } else {
      showControls();
    }
  }

  function toggleAutoSync() {
    autoSyncEnabled = !autoSyncEnabled;
    if (autoSyncButton) {
      autoSyncButton.dataset.syncOn = autoSyncEnabled ? "true" : "false";
      autoSyncButton.classList.toggle("is-active", autoSyncEnabled);
      autoSyncButton.setAttribute("title", autoSyncEnabled ? "自动同步开" : "自动同步关");
      autoSyncButton.setAttribute("aria-label", autoSyncEnabled ? "关闭自动同步" : "开启自动同步");
    }
    setText(playbackStatus, autoSyncEnabled ? "自动同步已开启" : "自动同步已关闭");
    dispatchPlayerEvent("together-see:auto-sync-change", { enabled: autoSyncEnabled });
    showControls();
  }

  function triggerManualSync() {
    manualSyncButton?.classList.remove("is-pulsing");
    window.requestAnimationFrame(function () {
      manualSyncButton?.classList.add("is-pulsing");
    });
    setText(playbackStatus, "已请求手动同步");
    dispatchPlayerEvent("together-see:manual-sync", { requestedAt: Date.now(), source: currentSource });
    window.setTimeout(function () {
      manualSyncButton?.classList.remove("is-pulsing");
    }, 520);
    showControls();
  }

  function enterPageFullscreen() {
    if (!shell || shell.classList.contains("is-page-fullscreen")) return;
    clearDanmaku();
    pageFullscreenParent = shell.parentNode;
    pageFullscreenNextSibling = shell.nextSibling;
    pageFullscreenPlaceholder = document.createComment("Together See player page-fullscreen placeholder");
    pageFullscreenParent.insertBefore(pageFullscreenPlaceholder, shell);
    document.body.appendChild(shell);
    document.body.classList.add("has-page-player-fullscreen");
    shell.classList.add("is-page-fullscreen", "is-controls-visible");
    if (pageFullscreenButton) {
      pageFullscreenButton.classList.add("is-active");
      pageFullscreenButton.setAttribute("title", "退出网页全屏");
      pageFullscreenButton.setAttribute("aria-label", "退出网页全屏");
    }
    showControls();
  }

  function exitPageFullscreen() {
    if (!shell || !shell.classList.contains("is-page-fullscreen")) return;
    clearDanmaku();
    shell.classList.remove("is-page-fullscreen");
    document.body.classList.remove("has-page-player-fullscreen");
    if (pageFullscreenParent && pageFullscreenPlaceholder) {
      pageFullscreenParent.insertBefore(shell, pageFullscreenNextSibling || pageFullscreenPlaceholder);
      pageFullscreenPlaceholder.remove();
    }
    pageFullscreenPlaceholder = null;
    pageFullscreenParent = null;
    pageFullscreenNextSibling = null;
    if (pageFullscreenButton) {
      pageFullscreenButton.classList.remove("is-active");
      pageFullscreenButton.setAttribute("title", "网页全屏");
      pageFullscreenButton.setAttribute("aria-label", "网页全屏");
    }
    showControls();
  }

  function togglePageFullscreen() {
    if (shell?.classList.contains("is-page-fullscreen")) exitPageFullscreen();
    else enterPageFullscreen();
  }

  function openFullscreen() {
    if (shell?.classList.contains("is-page-fullscreen")) exitPageFullscreen();
    const target = shell || video;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      return;
    }
    target.requestFullscreen?.();
  }

  function getProgressRatio(event) {
    if (!progressTrack) return 0;
    const rect = progressTrack.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }

  function updateProgressHover(event) {
    if (!progressTrack || !progressHoverTime || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const ratio = getProgressRatio(event);
    progressHoverTime.textContent = formatTime(ratio * video.duration);
    progressHoverTime.style.left = (ratio * 100) + "%";
    progressTrack.classList.add("is-hovering");
  }

  function hideProgressHover() {
    progressTrack?.classList.remove("is-hovering");
  }

  function seekFromEvent(event) {
    if (!ensurePlaybackControl()) return;
    if (!progressTrack || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const ratio = getProgressRatio(event);
    video.currentTime = ratio * video.duration;
    updateTimeUi();
    dispatchPlaybackUserAction("seek");
    showControls();
  }

  function isEditableTarget(target) {
    if (!target) return false;
    const tagName = target.tagName ? target.tagName.toLowerCase() : "";
    return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable || Boolean(target.closest?.('[contenteditable="true"]'));
  }

  function canUsePlaybackShortcut() {
    return Boolean(currentSource && video.src);
  }

  function seekBy(seconds) {
    if (!ensurePlaybackControl()) return;
    if (!canUsePlaybackShortcut()) {
      showControls();
      return;
    }
    const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    const nextTime = duration === null
      ? Math.max(0, current + seconds)
      : Math.max(0, Math.min(duration, current + seconds));
    video.currentTime = nextTime;
    updateTimeUi();
    setText(playbackStatus, seconds > 0 ? "快进 5 秒" : "快退 5 秒");
    dispatchPlaybackUserAction("seek");
    showControls();
  }

  function adjustVolume(delta) {
    const nextVolume = Math.max(0, Math.min(1, (Number.isFinite(video.volume) ? video.volume : 1) + delta));
    video.volume = nextVolume;
    video.muted = nextVolume === 0;
    updateVolumeUi();
    setText(playbackStatus, "音量 " + Math.round(nextVolume * 100) + "%");
    showControls();
  }

  function toggleMute() {
    if (video.muted || video.volume === 0) {
      if (video.volume === 0) video.volume = 0.6;
      video.muted = false;
      setText(playbackStatus, "已取消静音");
    } else {
      video.muted = true;
      setText(playbackStatus, "已静音");
    }
    updateVolumeUi();
    showControls();
  }

  function triggerPlaylistStep(direction) {
    const items = document.querySelectorAll(".playlist-list li[data-playlist-item]");
    if (items.length < 2) {
      setText(playbackStatus, "播放列表没有上一集/下一集");
      showControls();
      return;
    }
    const button = document.querySelector(direction < 0 ? "[data-player-prev]" : "[data-player-next]");
    button?.click();
    setText(playbackStatus, direction < 0 ? "已切换上一集" : "已切换下一集");
    showControls();
  }

  function handlePlayerShortcut(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isEditableTarget(event.target)) return;

    const key = event.key;
    const lowerKey = typeof key === "string" ? key.toLowerCase() : "";

    if (key === "Escape") {
      if (shell?.classList.contains("is-page-fullscreen")) {
        event.preventDefault();
        exitPageFullscreen();
      }
      return;
    }

    switch (key) {
      case "ArrowLeft":
        event.preventDefault();
        seekBy(-5);
        break;
      case "ArrowRight":
        event.preventDefault();
        seekBy(5);
        break;
      case "ArrowUp":
        event.preventDefault();
        adjustVolume(0.1);
        break;
      case "ArrowDown":
        event.preventDefault();
        adjustVolume(-0.1);
        break;
      case " ":
      case "Spacebar":
        event.preventDefault();
        togglePlay();
        break;
      case "[":
        event.preventDefault();
        triggerPlaylistStep(-1);
        break;
      case "]":
        event.preventDefault();
        triggerPlaylistStep(1);
        break;
      default:
        if (lowerKey === "f") {
          event.preventDefault();
          openFullscreen();
        } else if (lowerKey === "d") {
          event.preventDefault();
          toggleDanmaku();
        } else if (lowerKey === "m") {
          event.preventDefault();
          toggleMute();
        }
    }
  }

  playButton?.addEventListener("click", togglePlay);
  centerPlayButton?.addEventListener("click", togglePlay);
  rateButton?.addEventListener("click", cycleRate);
  danmakuButton?.addEventListener("click", toggleDanmaku);
  autoSyncButton?.addEventListener("click", toggleAutoSync);
  manualSyncButton?.addEventListener("click", triggerManualSync);
  volumeButton?.addEventListener("click", toggleVolumePopover);
  volumeRange?.addEventListener("input", setVolumeFromRange);
  volumePopover?.addEventListener("click", function (event) { event.stopPropagation(); });
  document.addEventListener("click", function (event) {
    if (volumeControl && !volumeControl.contains(event.target)) closeVolumePopover();
  });
  controlLockButton?.addEventListener("click", toggleControlLock);
  controlLockButton?.addEventListener("pointerenter", function () { clearTimeout(hideLockTimer); shell?.classList.add("is-lock-visible"); });
  controlLockButton?.addEventListener("pointerleave", showLockTemporarily);
  pageFullscreenButton?.addEventListener("click", togglePageFullscreen);
  fullscreenButton?.addEventListener("click", openFullscreen);
  progressTrack?.addEventListener("click", seekFromEvent);
  progressTrack?.addEventListener("pointermove", updateProgressHover);
  progressTrack?.addEventListener("pointerenter", updateProgressHover);
  progressTrack?.addEventListener("pointerleave", hideProgressHover);

  shell?.addEventListener("pointermove", showControls);
  shell?.addEventListener("pointerenter", showControls);
  shell?.addEventListener("pointerleave", function () {
    if (currentSource && shell?.classList.contains("has-source")) {
      clearTimeout(hideControlsTimer);
      if (isControlsInteractionActive()) {
        keepControlsVisible();
        return;
      }
      if (video.paused && !controlsLocked) {
        shell?.classList.add("is-controls-visible", "is-lock-visible");
        shell?.classList.remove("is-controls-hidden");
        return;
      }
      hideControlsTimer = window.setTimeout(function () {
        if (isControlsInteractionActive()) return;
        shell?.classList.remove("is-controls-visible", "is-lock-visible");
        shell?.classList.add("is-controls-hidden");
      }, 350);
    }
  });
  controls?.addEventListener("pointerenter", function (event) {
    controlsPointerInside = event.pointerType !== "touch";
    keepControlsVisible();
  });
  controls?.addEventListener("pointerleave", function () {
    controlsPointerInside = false;
    showControls(700);
  });
  controls?.addEventListener("focusin", function (event) {
    controlsFocusInside = isEditableControl(event.target);
    if (controlsFocusInside) keepControlsVisible();
  });
  controls?.addEventListener("focusout", function () {
    window.setTimeout(function () {
      controlsFocusInside = isEditableControl(document.activeElement);
      if (!controlsFocusInside) showControls(900);
    }, 0);
  });
  danmakuInput?.addEventListener("input", keepControlsVisible);
  shell?.addEventListener("dblclick", function (event) {
    if (event.target.closest("button")) return;
    openFullscreen();
  });
  video.addEventListener("click", function () {
    showControls();
  });

  video.addEventListener("loadstart", function () {
    setBufferingState(true, mediaRecoveryTransition ? "正在切换兼容播放" : "加载视频中", { allowPausedSpinner: true });
    updatePlayButton();
  });
  video.addEventListener("loadedmetadata", updatePlayButton);
  video.addEventListener("durationchange", updateTimeUi);
  video.addEventListener("timeupdate", function () {
    updateTimeUi();
    processTimelineDanmaku();
    refreshBufferingFromMediaState();
    if (video.readyState >= 3) clearHlsStallTimeout();
    if (video.readyState >= 3 || getForwardBufferSeconds() > BUFFER_SPINNER_THRESHOLD) clearMediaStallFallback();
  });
  video.addEventListener("progress", updateBufferUi);
  video.addEventListener("waiting", function () {
    setBufferingState(true, video.paused ? "已暂停 · 后台缓存中" : "缓冲中");
    scheduleHlsStallTimeout();
    scheduleMediaStallFallback();
  });
  video.addEventListener("stalled", function () {
    setBufferingState(true, video.paused ? "已暂停 · 等待缓存" : "网络等待中");
    scheduleHlsStallTimeout();
    scheduleMediaStallFallback();
  });
  video.addEventListener("seeking", function () {
    timelineDanmakuSeeking = true;
    if (timelineDanmakuAnimationFrame !== null) {
      window.cancelAnimationFrame(timelineDanmakuAnimationFrame);
      timelineDanmakuAnimationFrame = null;
    }
    clearDanmaku();
    setBufferingState(true, "定位中", { allowPausedSpinner: true });
  });
  video.addEventListener("seeked", function () {
    timelineDanmakuSeeking = false;
    resetTimelineDanmakuCursor(video.currentTime || 0);
    setBufferingState(false, video.paused ? "已暂停" : "正在播放");
    dispatchReadyForSync();
    scheduleTimelineDanmakuFrame();
  });
  video.addEventListener("canplaythrough", function () { setBufferingState(false); });
  video.addEventListener("playing", function () {
    clearInterval(pauseBufferTimer);
    pauseBufferTimer = null;
    resumeHlsBufferingFromCurrentTime();
    setBufferingState(false, "正在播放");
    processTimelineDanmaku();
    clearMediaStallFallback();
    scheduleTimelineDanmakuFrame();
  });
  video.addEventListener("play", updatePlayButton);
  video.addEventListener("pause", function () {
    if (timelineDanmakuAnimationFrame !== null) {
      window.cancelAnimationFrame(timelineDanmakuAnimationFrame);
      timelineDanmakuAnimationFrame = null;
    }
    clearMediaStallFallback();
    clearHlsStallTimeout();
    if (mediaRecoveryTransition) {
      setBufferingState(true, "正在切换兼容播放", { allowPausedSpinner: true });
    } else {
      setBufferingState(false);
    }
    updatePlayButton();
    if (!mediaRecoveryTransition) schedulePauseBuffering();
  });
  video.addEventListener("volumechange", updateVolumeUi);
  video.addEventListener("ended", function () {
    setBufferingState(false);
    setButtonSvg(playButton, playSvg, "播放");
    setButtonSvg(centerPlayButton, playSvg, "播放");
    setText(playbackStatus, "播放结束");
    keepControlsVisible();
  });

  document.addEventListener("keydown", handlePlayerShortcut);

  document.addEventListener("fullscreenchange", function () {
    clearDanmaku();
    const active = document.fullscreenElement === shell;
    shell?.classList.toggle("is-native-fullscreen", active);
    if (fullscreenButton) {
      fullscreenButton.classList.toggle("is-active", active);
      fullscreenButton.setAttribute("title", active ? "退出全屏" : "全屏");
      fullscreenButton.setAttribute("aria-label", active ? "退出全屏" : "全屏");
    }
    showControls();
  });

  if (rateButton) {
    rateButton.setAttribute("title", "切换倍速：1.00x");
    rateButton.setAttribute("aria-label", "切换倍速，当前 1.00x");
  }
  if (danmakuButton) {
    shell?.classList.toggle("danmaku-hidden", !danmakuVisible);
    danmakuButton.classList.toggle("is-active", danmakuVisible);
    danmakuButton.dataset.danmakuOn = danmakuVisible ? "true" : "false";
    danmakuButton.innerHTML = danmakuVisible ? danmakuOnSvg : danmakuOffSvg;
    danmakuButton.setAttribute("title", danmakuVisible ? "弹幕开" : "弹幕关");
    danmakuButton.setAttribute("aria-label", danmakuVisible ? "关闭弹幕" : "开启弹幕");
  }
  updateControlLockUi();
  if (autoSyncButton) {
    autoSyncButton.classList.toggle("is-active", autoSyncEnabled);
    autoSyncButton.dataset.syncOn = autoSyncEnabled ? "true" : "false";
    autoSyncButton.setAttribute("title", "自动同步开");
    autoSyncButton.setAttribute("aria-label", "关闭自动同步");
  }
  if (manualSyncButton) {
    manualSyncButton.setAttribute("title", "手动同步");
    manualSyncButton.setAttribute("aria-label", "手动同步");
  }
  updateVolumeUi();
  updateSystemClock();
  window.setInterval(updateSystemClock, 1000);
  updatePlayButton();

  window.TogetherSeePlayer = {
    video: video,
    loadSource: loadSource,
    clearSource: clearSource,
    showPending: setPendingState,
    guessSourceType: guessSourceType,
    formatTime: formatTime,
    togglePageFullscreen: togglePageFullscreen,
    enterPageFullscreen: enterPageFullscreen,
    exitPageFullscreen: exitPageFullscreen,
    getAutoSyncEnabled: function () { return autoSyncEnabled; },
    setAutoSyncEnabled: function (enabled) { if (Boolean(enabled) !== autoSyncEnabled) toggleAutoSync(); },
    getPreferredPlaybackRate: function () { return rateSteps[currentRateIndex] || 1; },
    setPlaybackStatus: function (text) { setText(playbackStatus, text); },
    setExternalPlaybackRate: function (rate, options) {
      const safeRate = Number.isFinite(Number(rate)) ? Math.min(3, Math.max(0.25, Number(rate))) : 1;
      video.playbackRate = safeRate;
      if (!options?.temporary && rateButton) {
        const nearestIndex = rateSteps.findIndex(function (step) { return Math.abs(step - safeRate) < 0.001; });
        if (nearestIndex >= 0) currentRateIndex = nearestIndex;
        setText(rateButton, safeRate.toFixed(2) + "x");
        rateButton.setAttribute("title", "切换倍速：" + safeRate.toFixed(2) + "x");
        rateButton.setAttribute("aria-label", "切换倍速，当前 " + safeRate.toFixed(2) + "x");
      }
    },
    triggerManualSync: triggerManualSync,
    isControlLocked: function () { return controlsLocked; },
    getForwardBufferSeconds: getForwardBufferSeconds,
    getPlaybackHealth: function () {
      return {
        readyForAuthority: Boolean(currentSource && video.src && video.readyState >= 3 && !video.seeking && !lastBufferingState),
        readyState: video.readyState,
        seeking: video.seeking,
        buffering: lastBufferingState,
        bufferedAhead: getForwardBufferSeconds(),
        usingProxy: lastMediaUsingProxy || lastHlsUsingProxy,
      };
    },
    isMediaReadyForSync: isMediaReadyForSync,
    getCurrentSourceType: function () { return currentSource?.sourceType || video.dataset.sourceType || "unknown"; },
    resumeBuffering: resumeHlsBufferingFromCurrentTime,
    showDanmaku: showDanmaku,
    clearDanmaku: clearDanmaku,
    setTimelineDanmaku: setTimelineDanmaku,
    clearTimelineDanmaku: clearTimelineDanmaku,
    getTimelineDanmakuState: function () {
      return {
        count: timelineDanmaku.length,
        keyPresent: Boolean(timelineDanmakuKey),
        visible: danmakuVisible,
        hasSource: Boolean(shell?.classList.contains("has-source")),
      };
    },
    isDanmakuVisible: function () { return danmakuVisible; },
    setDanmakuVisible: setDanmakuVisible,
    getLoadToken: getCurrentLoadToken,
    isLoadTokenCurrent: isCurrentLoadToken,
    setDesiredPlaybackState: setDesiredPlaybackState,
    setPlaybackControlEnabled: function (enabled) {
      playbackControlEnabled = Boolean(enabled);
      if (playbackControlEnabled) syncPlaybackPending = false;
      updatePlaybackControlUi();
    },
    setSyncPlaybackPending: function (pending) {
      syncPlaybackPending = Boolean(pending);
      updatePlaybackControlUi();
    },
  };
})();
