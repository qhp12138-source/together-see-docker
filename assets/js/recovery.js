(function (root) {
  function createAttemptRegistry(options) {
    const maxAttempts = Math.max(1, Number(options?.maxAttempts) || 1);
    const states = new Map();

    function getState(key) {
      const safeKey = String(key || "");
      if (!states.has(safeKey)) {
        states.set(safeKey, {
          attempts: 0,
          inFlight: false,
          pendingReadyNotice: false,
          ready: false,
          failureNotified: false,
        });
      }
      return states.get(safeKey);
    }

    function snapshot(key) {
      return Object.assign({}, getState(key));
    }

    return {
      canBegin: function (key) {
        const state = getState(key);
        return !state.inFlight && state.attempts < maxAttempts;
      },
      begin: function (key) {
        const state = getState(key);
        if (state.inFlight || state.attempts >= maxAttempts) return false;
        state.attempts += 1;
        state.inFlight = true;
        state.ready = false;
        state.failureNotified = false;
        return snapshot(key);
      },
      finish: function (key, outcome) {
        const state = getState(key);
        state.inFlight = false;
        state.pendingReadyNotice = Boolean(outcome?.pendingReadyNotice);
        return snapshot(key);
      },
      markReady: function (key) {
        const state = getState(key);
        const shouldNotify = state.pendingReadyNotice;
        state.inFlight = false;
        state.pendingReadyNotice = false;
        state.ready = true;
        state.failureNotified = false;
        return shouldNotify;
      },
      markFailureNotified: function (key) {
        const state = getState(key);
        if (state.failureNotified) return false;
        state.failureNotified = true;
        state.pendingReadyNotice = false;
        return true;
      },
      snapshot: snapshot,
      remove: function (key) { states.delete(String(key || "")); },
      clear: function () { states.clear(); },
    };
  }

  function createLoadTracker() {
    let generation = 0;
    let currentToken = null;
    let terminalDispatched = false;
    let ready = false;

    function begin(identity) {
      generation += 1;
      currentToken = {
        generation: generation,
        identity: String(identity || ""),
      };
      terminalDispatched = false;
      ready = false;
      return Object.assign({}, currentToken);
    }

    function isCurrent(token) {
      return Boolean(token
        && currentToken
        && token.generation === currentToken.generation
        && token.identity === currentToken.identity);
    }

    return {
      begin: begin,
      invalidate: function () { return begin("pending"); },
      current: function () { return currentToken ? Object.assign({}, currentToken) : null; },
      isCurrent: isCurrent,
      isTerminal: function (token) { return isCurrent(token) && terminalDispatched; },
      isReady: function (token) { return isCurrent(token) && ready; },
      markReady: function (token) {
        if (!isCurrent(token) || terminalDispatched || ready) return false;
        ready = true;
        return true;
      },
      markRecovering: function (token) {
        if (!isCurrent(token) || terminalDispatched) return false;
        ready = false;
        return true;
      },
      markTerminal: function (token) {
        if (!isCurrent(token) || terminalDispatched) return false;
        terminalDispatched = true;
        return true;
      },
    };
  }

  function playbackSignature(playback) {
    const value = playback || {};
    return [
      value.activeSourceId || "",
      value.playing === true ? "1" : "0",
      Number(value.currentTime || 0),
      Number.isFinite(Number(value.duration)) ? Number(value.duration) : "",
      Number.isFinite(Number(value.playbackRate)) ? Number(value.playbackRate) : 1,
      Number.isFinite(Number(value.revision)) ? Number(value.revision) : "",
      Number.isFinite(Number(value.controlLeaseUntil)) ? Number(value.controlLeaseUntil) : "",
      value.updatedBy || "",
    ].join("|");
  }

  function createPlaybackSnapshotQueue(options) {
    const now = typeof options?.now === "function" ? options.now : Date.now;
    let revision = 0;
    let latest = null;
    let pending = null;

    function cloneSnapshot(snapshot) {
      if (!snapshot) return null;
      return {
        playback: Object.assign({}, snapshot.playback),
        updatedAt: snapshot.updatedAt,
        serverRevision: snapshot.serverRevision,
        revision: snapshot.revision,
        signature: snapshot.signature,
      };
    }

    function isCurrent(snapshot) {
      return Boolean(snapshot && latest && snapshot.revision === latest.revision);
    }

    function observe(playback) {
      if (!playback) return { accepted: false, snapshot: cloneSnapshot(latest) };
      const updatedAtValue = Number(playback.updatedAt);
      const updatedAt = Number.isFinite(updatedAtValue) ? updatedAtValue : 0;
      const serverRevisionValue = Number(playback.revision);
      const serverRevision = Number.isSafeInteger(serverRevisionValue) && serverRevisionValue >= 0
        ? serverRevisionValue
        : null;
      const signature = playbackSignature(playback);

      if (latest && serverRevision !== null && latest.serverRevision !== null) {
        if (serverRevision < latest.serverRevision) {
          return { accepted: false, snapshot: cloneSnapshot(latest) };
        }
        if (serverRevision === latest.serverRevision) {
          return { accepted: false, duplicate: signature === latest.signature, snapshot: cloneSnapshot(latest) };
        }
      }
      if (latest && updatedAt < latest.updatedAt) {
        return { accepted: false, snapshot: cloneSnapshot(latest) };
      }
      if (latest && updatedAt === latest.updatedAt && signature === latest.signature) {
        return { accepted: false, duplicate: true, snapshot: cloneSnapshot(latest) };
      }

      revision += 1;
      latest = {
        playback: Object.assign({}, playback),
        updatedAt: updatedAt,
        serverRevision: serverRevision,
        revision: revision,
        signature: signature,
      };

      if (pending) {
        pending = {
          snapshot: cloneSnapshot(latest),
          sourceId: latest.playback.activeSourceId || "",
          queuedAt: now(),
          allowAuthority: pending.allowAuthority === true,
        };
      }

      return { accepted: true, snapshot: cloneSnapshot(latest) };
    }

    function queue(snapshot, context) {
      if (!isCurrent(snapshot)) return false;
      pending = {
        snapshot: cloneSnapshot(snapshot),
        sourceId: context?.sourceId || snapshot.playback.activeSourceId || "",
        queuedAt: Number(context?.queuedAt) || now(),
        allowAuthority: context?.allowAuthority === true,
      };
      return true;
    }

    function peekPending() {
      if (!pending || !isCurrent(pending.snapshot)) return null;
      return {
        snapshot: cloneSnapshot(pending.snapshot),
        sourceId: pending.sourceId,
        queuedAt: pending.queuedAt,
        allowAuthority: pending.allowAuthority,
      };
    }

    function consume(context) {
      const value = peekPending();
      if (!value) {
        pending = null;
        return null;
      }
      const sourceId = context?.sourceId || "";
      if (sourceId && value.sourceId && sourceId !== value.sourceId) return null;
      pending = null;
      return value;
    }

    function clearPending(snapshot) {
      if (snapshot && !isCurrent(snapshot)) return false;
      pending = null;
      return true;
    }

    return {
      observe: observe,
      current: function () { return cloneSnapshot(latest); },
      isCurrent: isCurrent,
      queue: queue,
      peekPending: peekPending,
      consume: consume,
      clearPending: clearPending,
      clear: function () {
        revision += 1;
        latest = null;
        pending = null;
      },
    };
  }

  function createOperationTracker() {
    let revision = 0;
    let currentToken = null;

    return {
      begin: function (identity) {
        revision += 1;
        currentToken = { revision: revision, identity: String(identity || "") };
        return Object.assign({}, currentToken);
      },
      invalidate: function () {
        revision += 1;
        currentToken = null;
      },
      isCurrent: function (token) {
        return Boolean(token
          && currentToken
          && token.revision === currentToken.revision
          && token.identity === currentToken.identity);
      },
    };
  }

  function createPlaybackStartController(options) {
    const schedule = options?.setTimeout || setTimeout;
    const cancel = options?.clearTimeout || clearTimeout;
    const retryDelays = [400, 1000, 2000];
    let current = null;

    function reset() {
      if (current?.timer != null) cancel(current.timer);
      current?.resolve?.(false);
      current = null;
    }

    function suspend() {
      if (!current) return;
      if (current.timer != null) cancel(current.timer);
      current.timer = null;
      current.run = (current.run || 0) + 1;
      current.resolve?.(false);
      current.promise = null;
      current.resolve = null;
    }

    function request(input) {
      if (!input?.identity || !input.isCurrent()) return Promise.resolve(false);
      if (current?.identity !== input.identity) reset();
      if (!current) current = { identity: input.identity, attempts: 0, blocked: false, timer: null, promise: null };
      const job = current;
      job.input = input;
      if (job.blocked) return Promise.resolve(false);
      if (job.promise) return job.promise;
      if (job.attempts >= retryDelays.length + 1) {
        job.blocked = true;
        input.onBlocked?.("interrupted");
        return Promise.resolve(false);
      }
      const run = job.run = (job.run || 0) + 1;
      job.promise = new Promise(function (resolve) { job.resolve = resolve; });
      const result = job.promise;

      function finish(ok) {
        job.resolve(ok);
        job.promise = null;
        job.resolve = null;
      }

      function attempt() {
        job.timer = null;
        if (current !== job || job.run !== run) return;
        if (!job.input.isCurrent()) {
          suspend();
          return;
        }
        job.attempts += 1;
        let promise;
        try { promise = job.input.play(); } catch (error) { promise = Promise.reject(error); }
        Promise.resolve(promise).then(function () {
          if (current !== job || job.run !== run) return;
          if (!job.input.isCurrent()) { suspend(); return; }
          job.attempts = 0;
          finish(true);
          job.input.onSuccess?.();
        }, function (error) {
          if (current !== job || job.run !== run) return;
          if (!job.input.isCurrent()) { suspend(); return; }
          if (error?.name === "AbortError" && job.attempts <= retryDelays.length) {
            job.timer = schedule(attempt, retryDelays[job.attempts - 1]);
            return;
          }
          job.blocked = true;
          const reason = error?.name === "NotAllowedError" ? "gesture"
            : error?.name === "AbortError" ? "interrupted" : "failed";
          job.input.onBlocked?.(reason);
          finish(false);
        });
      }

      attempt();
      return result;
    }

    return { request: request, reset: reset, suspend: suspend };
  }

  function createAckSingleFlight(options) {
    const timeoutMs = Math.max(1000, Number(options?.timeoutMs) || 5000);
    const schedule = typeof options?.setTimeout === "function" ? options.setTimeout : setTimeout;
    const cancel = typeof options?.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
    let generation = 0;
    let current = null;

    function matches(token) {
      return Boolean(token && current && token.generation === current.token.generation);
    }

    function invalidate() {
      generation += 1;
      if (current?.timeoutId !== null && current?.timeoutId !== undefined) cancel(current.timeoutId);
      current = null;
    }

    return {
      begin: function (onTimeout) {
        if (current) return null;
        generation += 1;
        const token = { generation: generation };
        const timeoutId = schedule(function () {
          if (!matches(token)) return;
          current = null;
          generation += 1;
          if (typeof onTimeout === "function") onTimeout(token);
        }, timeoutMs);
        current = { token: token, timeoutId: timeoutId };
        return Object.assign({}, token);
      },
      settle: function (token) {
        if (!matches(token)) return false;
        invalidate();
        return true;
      },
      reset: function () { invalidate(); },
      isInFlight: function () { return Boolean(current); },
      isCurrent: matches,
    };
  }

  function createGenerationValue(isCurrentToken) {
    let entry = null;
    const isCurrent = typeof isCurrentToken === "function" ? isCurrentToken : function () { return true; };

    return {
      bind: function (token, value) {
        if (!token || !isCurrent(token)) return false;
        entry = { token: Object.assign({}, token), value: value };
        return true;
      },
      peek: function (token) {
        if (!entry || !token || !isCurrent(token)) return null;
        if (entry.token.generation !== token.generation || entry.token.identity !== token.identity) return null;
        return entry.value;
      },
      update: function (token, updater) {
        const value = this.peek(token);
        if (value === null || typeof updater !== "function") return false;
        entry.value = updater(value);
        return true;
      },
      take: function (token) {
        const value = this.peek(token);
        if (value === null) return null;
        entry = null;
        return value;
      },
      clear: function () { entry = null; },
    };
  }

  function createFallbackController(options) {
    const maxAttempts = Math.max(1, Number(options?.maxAttempts) || 1);
    let revision = 0;
    let identity = "";
    let attempts = 0;

    return {
      reset: function (nextIdentity) {
        revision += 1;
        identity = String(nextIdentity || "");
        attempts = 0;
        return { revision: revision, identity: identity, attempts: attempts };
      },
      begin: function (expectedIdentity, value) {
        if (!identity || String(expectedIdentity || "") !== identity || attempts >= maxAttempts) return null;
        attempts += 1;
        return { revision: revision, identity: identity, attempts: attempts, value: value };
      },
      isCurrent: function (token) {
        return Boolean(token && token.revision === revision && token.identity === identity);
      },
      snapshot: function () { return { revision: revision, identity: identity, attempts: attempts }; },
    };
  }

  function shouldApplyPlaybackSnapshot(playback, memberId, options) {
    if (!playback) return false;
    return playback.updatedBy !== memberId || options?.restoreAuthoritative === true;
  }

  function getContiguousBufferAhead(buffered, currentTime) {
    if (!buffered || !Number.isFinite(currentTime)) return 0;
    const tolerance = 0.05;
    try {
      for (let index = 0; index < buffered.length; index += 1) {
        if (currentTime < buffered.start(index) - tolerance) return 0;
        let end = buffered.end(index);
        if (currentTime > end) continue;
        while (index + 1 < buffered.length && buffered.start(index + 1) <= end + tolerance) {
          end = Math.max(end, buffered.end(++index));
        }
        return Math.max(0, end - currentTime);
      }
    } catch (error) {
      // MediaSource can detach between reading the range count and its bounds.
    }
    return 0;
  }

  function resumeHlsBuffering(instance) {
    if (!instance || instance.loadingEnabled === false || instance.bufferingEnabled === true
      || typeof instance.resumeBuffering !== "function") return false;
    // startLoad() stops the stream controller and aborts its in-flight fragment.
    // Initial loading and fatal recovery belong to their existing explicit paths.
    instance.resumeBuffering();
    return true;
  }

  function createCatchUpRateGuard() {
    let blocked = false;
    return {
      reset: function () { blocked = false; },
      select: function (value) {
        const base = value.baseRate;
        const requested = value.requestedRate;
        if (!value.eligible) {
          blocked = true;
          return base;
        }
        if (requested <= base) return requested;
        // Measure runway at the requested rate; 2x consumes two media seconds per second.
        const runway = value.bufferedAhead / requested;
        if (!Number.isFinite(runway) || runway < 2) blocked = true;
        else if (runway >= 4) blocked = false;
        return blocked ? base : requested;
      },
    };
  }

  function createForegroundFrameRecovery() {
    let identity = "";
    let until = 0;
    let stage = 0;
    let anchor = null;
    let lastSampleAt = 0;
    return {
      reset: function (nextIdentity) {
        if (identity === nextIdentity) return;
        identity = nextIdentity;
        until = 0;
        stage = 0;
        anchor = null;
      },
      arm: function (now) {
        until = now + 30000;
        anchor = null;
        lastSampleAt = now;
      },
      suspend: function () { until = 0; anchor = null; },
      sample: function (value) {
        const now = value.now;
        const delayed = now - lastSampleAt > 2500;
        lastSampleAt = now;
        if (!identity || !until || now > until || stage >= 2) return null;
        if (!value.eligible || !Number.isFinite(value.frames) || !Number.isFinite(value.time)) {
          anchor = null;
          return null;
        }
        // A throttled timer or a seek is not evidence that video decoding froze.
        if (!anchor || delayed || value.frames !== anchor.frames || value.time < anchor.time
          || Math.abs(value.time - anchor.lastTime) > 4) {
          anchor = { now: now, time: value.time, lastTime: value.time, frames: value.frames };
          return null;
        }
        anchor.lastTime = value.time;
        if (now - anchor.now < 4500 || value.time - anchor.time < 1) return null;
        anchor = null;
        stage += 1;
        return stage === 1 ? "nudge" : "reload";
      },
    };
  }

  root.TogetherSeeRecovery = {
    createAttemptRegistry: createAttemptRegistry,
    createLoadTracker: createLoadTracker,
    createPlaybackSnapshotQueue: createPlaybackSnapshotQueue,
    createOperationTracker: createOperationTracker,
    createPlaybackStartController: createPlaybackStartController,
    createAckSingleFlight: createAckSingleFlight,
    createGenerationValue: createGenerationValue,
    createFallbackController: createFallbackController,
    getContiguousBufferAhead: getContiguousBufferAhead,
    resumeHlsBuffering: resumeHlsBuffering,
    createCatchUpRateGuard: createCatchUpRateGuard,
    createForegroundFrameRecovery: createForegroundFrameRecovery,
    shouldApplyPlaybackSnapshot: shouldApplyPlaybackSnapshot,
  };
})(typeof window !== "undefined" ? window : globalThis);
