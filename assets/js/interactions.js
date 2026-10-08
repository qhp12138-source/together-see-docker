(function () {
  "use strict";

  const BUILTIN_EFFECTS = ["heart", "fireworks", "sakura", "birthday"];
  const BUILTIN_SIZE = 320;
  const PARTICLE_COLORS = ["#ff668c", "#ffd166", "#70e5c5", "#81c9ff", "#e6a0ff", "#ffffff"];

  function createBuiltinEffect(effect, id) {
    if (!BUILTIN_EFFECTS.includes(effect)) return null;
    let seed = 2166136261;
    for (let i = 0; i < id.length; i += 1) seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
    const random = () => {
      seed += 0x6D2B79F5;
      let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
      value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
    const variant = Math.floor(random() * 4);
    const color = PARTICLE_COLORS[Math.floor(random() * 5)];
    const count = { heart: 24, fireworks: 96, sakura: 46, birthday: 40 }[effect];
    const particles = Array.from({ length: count }, (_, index) => ({
      angle: random() * Math.PI * 2, speed: 35 + random() * 80,
      x: 35 + random() * 250, y: 55 + random() * 150,
      size: 4 + random() * (effect === "heart" ? 13 : 6),
      spin: (random() - 0.5) * 8, phase: random() * Math.PI * 2,
      delay: effect === "fireworks" ? Math.floor(index / 32) * 0.1 + 0.03 : random() * 0.15,
      color: effect === "sakura" ? ["#ffb8d3", "#ff83b5", "#ffe2ee"][index % 3]
        : effect === "heart" ? ["#ff527c", "#ff91af", "#ffd0df"][index % 3]
          : PARTICLE_COLORS[Math.floor(random() * PARTICLE_COLORS.length)],
    }));
    return { effect, variant, color, particles };
  }

  function heartPath(ctx) {
    ctx.beginPath();
    ctx.moveTo(0, 0.9);
    ctx.bezierCurveTo(-1.5, -0.1, -0.8, -1.25, 0, -0.5);
    ctx.bezierCurveTo(0.8, -1.25, 1.5, -0.1, 0, 0.9);
    ctx.fill();
  }

  function sparkle(ctx, x, y, size, color, alpha) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.quadraticCurveTo(size * 0.15, -size * 0.15, size, 0);
    ctx.quadraticCurveTo(size * 0.15, size * 0.15, 0, size);
    ctx.quadraticCurveTo(-size * 0.15, size * 0.15, -size, 0);
    ctx.quadraticCurveTo(-size * 0.15, -size * 0.15, 0, -size);
    ctx.fill();
    ctx.restore();
  }

  function glossyHeart(ctx, size, alpha) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.scale(size, size);
    const paint = ctx.createLinearGradient(-0.8, -0.9, 0.6, 0.8);
    paint.addColorStop(0, "#ffe0ef");
    paint.addColorStop(0.24, "#ff8eba");
    paint.addColorStop(0.6, "#ed3974");
    paint.addColorStop(1, "#a80e4e");
    ctx.fillStyle = paint;
    heartPath(ctx);
    ctx.strokeStyle = "rgba(255,220,239,.6)";
    ctx.lineWidth = 0.035;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.lineWidth = 0.09;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-0.65, -0.17);
    ctx.bezierCurveTo(-0.81, -0.55, -0.5, -0.75, -0.26, -0.56);
    ctx.stroke();
    ctx.restore();
  }

  function cakeTier(ctx, x, y, width, height, color) {
    const icing = ctx.createLinearGradient(x, y, x + width, y);
    icing.addColorStop(0, "#bf6e91"); icing.addColorStop(0.28, color);
    icing.addColorStop(0.66, "#ffe7ed"); icing.addColorStop(1, "#b65580");
    ctx.fillStyle = icing;
    ctx.beginPath(); ctx.roundRect(x, y, width, height, 10); ctx.fill();
    ctx.fillStyle = "rgba(120,45,72,.22)";
    ctx.fillRect(x + 2, y + height * 0.64, width - 4, 3);
    ctx.fillStyle = "#fff3eb";
    ctx.beginPath(); ctx.roundRect(x, y - 3, width, 17, 8); ctx.fill();
    for (let k = 0; k < 7; k++) {
      ctx.beginPath(); ctx.roundRect(x + 8 + k * (width - 20) / 7, y + 5, 8, 11 + (k % 3) * 4, 4); ctx.fill();
    }
    ctx.fillStyle = "#fffaf5";
    ctx.beginPath(); ctx.ellipse(x + width / 2, y - 1, width / 2 - 3, 7, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawBuiltinEffect(ctx, model, progress) {
    if (!ctx || !model) return;
    const p = Math.max(0, Math.min(1, progress));
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (p >= 1) return;
    ctx.save();
    ctx.scale(ctx.canvas.width / BUILTIN_SIZE, ctx.canvas.height / BUILTIN_SIZE);
    const fade = Math.min(1, p * 14) * Math.min(1, (1 - p) * 4);
    ctx.globalAlpha = fade;
    for (let i = 0; i < model.particles.length; i += 1) {
      const particle = model.particles[i];
      if (p < particle.delay) continue;
      const t = (p - particle.delay) / (1 - particle.delay);
      ctx.save();
      ctx.fillStyle = particle.color;
      if (model.effect === "heart") {
        const spread = 0.3 + Math.sin(t * Math.PI / 2) * 0.7;
        ctx.translate(160 + (particle.x - 160) * spread + Math.sin(t * 4 + particle.phase) * 9,
          232 - t * (120 + particle.speed * 0.6));
        ctx.rotate(Math.sin(t * 3 + particle.phase) * 0.3);
        glossyHeart(ctx, particle.size * (0.55 + Math.sin(t * Math.PI) * 0.45), 0.8 * (1 - t));
      } else if (model.effect === "fireworks") {
        const burst = Math.floor(i / 32);
        const originX = [100, 218, 163][burst], originY = [128, 103, 183][burst];
        const angle = (i % 32) / 32 * Math.PI * 2 + model.variant * 0.07;
        const speed = 54 + particle.speed * 0.35;
        const point = age => ({ x: originX + Math.cos(angle) * (1 - Math.exp(-age * 4)) * speed,
          y: originY + Math.sin(angle) * (1 - Math.exp(-age * 4)) * speed + age * age * 43 });
        const head = point(t), tail = point(Math.max(0, t - 0.08));
        const hue = ["#ffbd76", "#90dfff", "#ff99d0"][(burst + model.variant) % 3];
        const trail = ctx.createLinearGradient(tail.x, tail.y, head.x + 0.001, head.y + 0.001);
        trail.addColorStop(0, "transparent"); trail.addColorStop(1, hue);
        ctx.globalAlpha = fade * Math.pow(1 - t, 0.8);
        ctx.strokeStyle = trail;
        ctx.lineWidth = 2.8;
        ctx.beginPath();
        ctx.moveTo(tail.x, tail.y); ctx.lineTo(head.x, head.y);
        ctx.stroke();
        ctx.fillStyle = "#fff9e9";
        ctx.beginPath();
        ctx.arc(head.x, head.y, 1.2 + (1 - t), 0, Math.PI * 2);
        ctx.fill();
        if (i % 4 === 0) sparkle(ctx, head.x, head.y, 4, hue, Math.pow(Math.sin(t * 20 + particle.phase), 2));
      } else {
        const isPetal = model.effect === "sakura";
        const depth = 0.5 + (i % 4) / 4;
        ctx.translate(particle.x + Math.sin(t * 5 + particle.phase) * 24 + t * 14,
          (isPetal ? particle.y - 65 : particle.y - 35) + t * (isPetal ? 135 : 95));
        ctx.rotate(particle.phase + t * particle.spin);
        if (isPetal) {
          ctx.globalAlpha *= 0.5 + depth * 0.4;
          ctx.scale(particle.size * depth, particle.size * depth * (0.2 + Math.abs(Math.cos(t * 5 + particle.phase)) * 0.8));
          const petal = ctx.createLinearGradient(-1, -1, 0.5, 1);
          petal.addColorStop(0, "#fff5fa"); petal.addColorStop(0.45, particle.color); petal.addColorStop(1, "#db6298");
          ctx.fillStyle = petal;
          ctx.beginPath();
          ctx.moveTo(0, -0.65); ctx.bezierCurveTo(0.4, -1.2, 1.05, -0.8, 0.8, 0.1);
          ctx.quadraticCurveTo(0.55, 0.8, 0, 1.1); ctx.quadraticCurveTo(-1.2, 0.15, -0.75, -0.65);
          ctx.quadraticCurveTo(-0.35, -1.1, 0, -0.65);
          ctx.fill();
          ctx.strokeStyle = "rgba(255,245,250,.55)"; ctx.lineWidth = 0.05;
          ctx.beginPath(); ctx.moveTo(0, -0.5); ctx.quadraticCurveTo(0.15, 0.1, 0, 0.85); ctx.stroke();
        } else {
          ctx.globalAlpha *= 0.8;
          ctx.scale(Math.cos(t * 8 + particle.phase), 1);
          ctx.fillRect(-2, -4, 4, 8);
        }
      }
      ctx.restore();
    }
    if (model.effect === "heart") {
      ctx.save();
      ctx.translate(160 + Math.sin(p * 4) * 8, 207 - p * 100);
      ctx.rotate(Math.sin(p * 5) * 0.1);
      glossyHeart(ctx, (40 + Math.sin(p * Math.PI) * 10) * Math.min(1, p * 10), 1);
      ctx.restore();
      for (let i = 0; i < 6; i++) {
        const angle = i * Math.PI / 3 + p;
        sparkle(ctx, 160 + Math.cos(angle) * (58 + p * 35), 170 + Math.sin(angle) * 60 - p * 45, 4 + Math.sin(p * 10 + i) * 2, "#ffe0b5", 0.8);
      }
    }
    if (model.effect === "birthday") {
      ctx.save();
      ctx.translate(160, 164 - p * 16);
      const entrance = Math.min(1, p * 8);
      ctx.scale(entrance * (1 + Math.sin(p * 10) * 0.015), entrance);
      if (model.variant < 2) {
        ctx.fillStyle = "#cadbe4";
        ctx.beginPath(); ctx.ellipse(0, 65, 80, 10, 0, 0, Math.PI * 2); ctx.fill();
        cakeTier(ctx, -65, 4, 130, 56, model.variant === 0 ? "#ffbbd4" : "#e0bdff");
        if (model.variant === 1) {
          cakeTier(ctx, -43, -32, 86, 36, "#e7cafa");
        }
        const top = model.variant === 1 ? -35 : 1;
        for (let candle = -1; candle <= 1; candle += 1) {
          ctx.fillStyle = "#7acddc";
          ctx.fillRect(candle * 24 - 3, top - 24, 6, 24);
          ctx.strokeStyle = "#ecfbff"; ctx.lineWidth = 2;
          for (let stripe = 0; stripe < 3; stripe++) { ctx.beginPath(); ctx.moveTo(candle * 24 - 3, top - 22 + stripe * 7); ctx.lineTo(candle * 24 + 3, top - 18 + stripe * 7); ctx.stroke(); }
          const flame = ctx.createRadialGradient(candle * 24, top - 31, 1, candle * 24, top - 31, 12);
          flame.addColorStop(0, "#fff8d7"); flame.addColorStop(0.45, "#ffd260"); flame.addColorStop(1, "rgba(255,151,67,0)");
          ctx.fillStyle = flame;
          ctx.beginPath();
          ctx.ellipse(candle * 24 + Math.sin(p * 22 + candle), top - 32, 8, 12 + Math.sin(p * 18 + candle) * 2, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.rotate(model.variant === 2 ? -0.08 : 0.06);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "italic bold 39px Georgia, serif";
        const gold = ctx.createLinearGradient(0, -55, 0, 60);
        gold.addColorStop(0, "#fff8dc"); gold.addColorStop(0.5, "#ffdb91"); gold.addColorStop(1, "#d9905f");
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(71,34,34,.65)";
        ctx.strokeText("Happy", 0, -24, 270); ctx.strokeText("Birthday", 0, 24, 270);
        ctx.fillStyle = gold;
        ctx.fillText("Happy", 0, -24, 270); ctx.fillText("Birthday", 0, 24, 270);
      }
      ctx.restore();
      for (let i = 0; i < 8; i++) sparkle(ctx, 50 + i * 31, 77 + Math.sin(i * 2 + p * 3) * 32, 4 + (i % 3), "#ffe4a6", Math.abs(Math.sin(p * 8 + i)));
    }
    ctx.restore();
  }

  function pictureRect(video) {
    const box = video.getBoundingClientRect();
    const ratio = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : box.width / box.height;
    const width = Math.min(box.width, box.height * ratio);
    const height = width / ratio;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
  }

  function create(options) {
    const video = options.player?.video;
    const shell = document.querySelector("[data-player-shell]");
    const layer = document.querySelector("[data-interaction-layer]");
    const toggle = document.querySelector("[data-interaction-toggle]");
    const controls = document.querySelector("[data-player-controls]");
    if (!video || !shell || !layer || !toggle || !controls) return null;
    const popover = document.createElement("dialog");
    popover.id = "interactionPopover";
    popover.className = "interaction-popover";
    popover.hidden = true;
    popover.setAttribute("aria-label", "互动");
    popover.innerHTML = '<header><strong>互动</strong><button type="button" data-interaction-close aria-label="关闭互动" title="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12"/></svg></button></header><div class="interaction-options"><label><input type="checkbox" data-interaction-enabled checked>互动效果</label><label><input type="checkbox" data-interaction-sound checked>音效</label></div><div class="interaction-assets" data-interaction-assets></div><p class="interaction-empty" data-interaction-empty>正在加载</p><footer class="interaction-pagination" hidden><button type="button" data-interaction-prev aria-label="上一页" title="上一页"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button><span data-interaction-page aria-live="polite"></span><button type="button" data-interaction-next aria-label="下一页" title="下一页"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button></footer>';
    // Keep the modal outside the controls' inert/opacity subtree, including fullscreen.
    shell.appendChild(popover);
    const groups = document.createElement("nav");
    groups.className = "interaction-group-tabs";
    groups.setAttribute("aria-label", "互动分组");
    groups.innerHTML = '<button type="button" data-interaction-group-tab="builtin" aria-pressed="true">预设</button><button type="button" data-interaction-group-tab="other" aria-pressed="false">其它</button>';
    popover.insertBefore(groups, popover.querySelector("[data-interaction-assets]"));
    popover.dataset.activeGroup = "builtin";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "interaction-placement-cancel";
    cancel.textContent = "取消互动";
    cancel.hidden = true;
    controls.appendChild(cancel);
    const enabledInput = popover.querySelector("[data-interaction-enabled]");
    const soundInput = popover.querySelector("[data-interaction-sound]");
    const assetsElement = popover.querySelector("[data-interaction-assets]");
    const empty = popover.querySelector("[data-interaction-empty]");
    const pagination = popover.querySelector(".interaction-pagination");
    let menuPage = 0;
    const assets = new Map();
    const images = new Map();
    const imagePixels = new Map();
    const sounds = new Map();
    const soundBytes = new Map();
    const pendingSoundLoads = new Map();
    const seen = new Map();
    const active = new Set();
    const playingSounds = new Set();
    let selected = null;
    let selectionVersion = 0;
    let selectionDeadline = 0;
    let selectionTimer = null;
    let selectionSourceId = null;
    const pendingSends = new Set();
    const sendTimes = [];
    let lastSendNotice = -Infinity;
    let catalogFlight = null;
    let catalogLoaded = false;
    let catalogSignature = "";
    let audioContext = null;
    let animationFrame = 0;
    let generation = 0;
    const warmedVisualUrls = new Set();
    let warmedVisualBytes = 0;
    let visualWarmupTimer = null;
    let visualWarmupFlight = null;
    const safeResource = value => typeof value === "string" && /^\/assets\/interactions\/(?:[a-zA-Z0-9][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value);
    const context = () => options.getContext();
    const resourceUrl = (asset, key) => asset[key] + (asset.revision ? "?v=" + encodeURIComponent(asset.revision) : "");
    const now = () => context().now || Date.now();
    const ageOf = event => Math.max(0, performance.now() - event.startedAt);
    const ready = sourceId => {
      const state = context();
      return state.connected && state.sourceId && state.sourceId === state.localSourceId
        && (!sourceId || sourceId === state.sourceId) && !document.hidden;
    };
    try {
      enabledInput.checked = localStorage.getItem("together-see:interactions") !== "off";
      soundInput.checked = localStorage.getItem("together-see:interaction-sound") !== "off";
    } catch { /* Storage is optional in private browsing. */ }

    function select(asset) {
      if (asset && options.player.isControlLocked?.()) return;
      clearTimeout(selectionTimer);
      selectionTimer = null;
      selectionVersion += 1;
      selected = asset;
      selectionSourceId = asset ? context().sourceId : null;
      selectionDeadline = asset?.type === "builtin" ? performance.now() + 3000 : 0;
      if (selectionDeadline) {
        const version = selectionVersion;
        const expire = () => {
          if (version !== selectionVersion) return;
          const remaining = selectionDeadline - performance.now();
          if (remaining <= 0) select(null);
          else selectionTimer = setTimeout(expire, remaining);
        };
        selectionTimer = setTimeout(expire, 3000);
      }
      shell.classList.toggle("is-interaction-placing", Boolean(asset));
      cancel.hidden = !asset;
      toggle.classList.toggle("is-active", Boolean(asset));
      shell.dispatchEvent(new Event("together-see:interaction-ui-change"));
      if (asset?.type === "builtin" && !animationFrame) render();
    }

    function open(value) {
      if (value && options.player.isControlLocked?.()) return;
      popover.hidden = !value;
      if (value && !popover.open) popover.showModal();
      else if (!value && popover.open) popover.close();
      shell.classList.toggle("has-interaction-popover", value);
      toggle.setAttribute("aria-expanded", String(value));
      if (value) { select(null); void loadCatalog(); }
      shell.dispatchEvent(new Event("together-see:interaction-ui-change"));
    }

    function getImage(url, lowPriority) {
      if (!images.has(url)) {
        const image = new Image();
        if (lowPriority) { image.fetchPriority = "low"; image.decoding = "async"; }
        images.set(url, new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { image.src = ""; images.delete(url); reject(new Error("asset_timeout")); }, 5000);
          image.onload = () => {
            clearTimeout(timeout);
            const pixels = image.naturalWidth * image.naturalHeight;
            if (!pixels || pixels > 8 * 1024 * 1024) {
              images.delete(url);
              image.src = "";
              reject(new Error("asset_dimensions"));
              return;
            }
            imagePixels.set(url, pixels);
            while (Array.from(imagePixels.values()).reduce((total, size) => total + size, 0) > 16 * 1024 * 1024) {
              const oldest = imagePixels.keys().next().value;
              images.delete(oldest);
              imagePixels.delete(oldest);
            }
            resolve(image);
          };
          image.onerror = () => { clearTimeout(timeout); images.delete(url); reject(new Error("asset_unavailable")); };
          image.src = url;
        }));
        if (images.size > 16) {
          const oldest = images.keys().next().value;
          images.delete(oldest);
          imagePixels.delete(oldest);
        }
      }
      return images.get(url);
    }

    function canWarmVisuals() {
      if (!catalogLoaded || !enabledInput.checked || !ready() || !video.src
        || video.readyState < 3 || video.seeking || video.ended) return false;
      const health = options.player.getPlaybackHealth?.();
      const rate = Math.max(1, Number(video.playbackRate) || 1);
      return health?.readyForAuthority === true && health.buffering === false
        && Number.isFinite(health.bufferedAhead) && health.bufferedAhead / rate >= 4;
    }

    function nextVisualWarmup() {
      if (warmedVisualUrls.size >= 2) return null;
      for (const asset of assets.values()) {
        if (asset.type === "builtin" || asset.type === "video" || !Number.isSafeInteger(asset.visualBytes)
          || asset.visualBytes <= 0 || asset.visualBytes > 1024 * 1024
          || warmedVisualBytes + asset.visualBytes > 2 * 1024 * 1024) continue;
        const url = resourceUrl(asset, "src");
        if (!warmedVisualUrls.has(url) && !images.has(url)) return { url, bytes: asset.visualBytes };
      }
      return null;
    }

    function cancelVisualWarmup() {
      clearTimeout(visualWarmupTimer);
      visualWarmupTimer = null;
    }

    function scheduleVisualWarmup() {
      if (visualWarmupTimer !== null || visualWarmupFlight || !canWarmVisuals() || !nextVisualWarmup()) return;
      const warmupGeneration = generation;
      const sourceId = context().sourceId;
      visualWarmupTimer = setTimeout(() => {
        visualWarmupTimer = null;
        if (warmupGeneration !== generation || sourceId !== context().sourceId || !canWarmVisuals()) return;
        const next = nextVisualWarmup();
        if (!next) return;
        // Attempts consume the page-lifetime budget, including failures and catalog changes.
        warmedVisualUrls.add(next.url);
        warmedVisualBytes += next.bytes;
        visualWarmupFlight = getImage(next.url, true);
        void visualWarmupFlight.catch(() => {}).finally(() => {
          visualWarmupFlight = null;
          if (warmupGeneration === generation && sourceId === context().sourceId) scheduleVisualWarmup();
        });
      }, 250);
    }

    function unlockAudio() {
      if (!soundInput.checked) return;
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!audioContext && AudioContext) audioContext = new AudioContext();
        if (audioContext?.state === "suspended") void audioContext.resume().catch(() => {});
      } catch { /* Visual effects remain available without audio support. */ }
    }

    function getSound(url) {
      if (!audioContext) return Promise.resolve(null);
      if (!sounds.has(url)) {
        if (pendingSoundLoads.size >= 2) return Promise.resolve(null);
        const controller = new AbortController();
        let cancel;
        const cancelled = new Promise((resolve, reject) => {
          cancel = () => { controller.abort(); reject(new Error("audio_cancelled")); };
        });
        const timeout = setTimeout(() => cancel(), 5000);
        const loading = Promise.race([
          fetch(url, { credentials: "same-origin", signal: controller.signal }).then(async response => {
            if (!response.ok) throw new Error("asset_unavailable");
            const maximum = 1024 * 1024;
            if (Number(response.headers.get("content-length")) > maximum || !response.body) {
              controller.abort();
              throw new Error("audio_size");
            }
            const reader = response.body.getReader();
            const chunks = [];
            let size = 0;
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > maximum) throw new Error("audio_size");
                chunks.push(chunk.value);
              }
            } catch (error) { void reader.cancel().catch(() => {}); throw error; }
            finally { reader.releaseLock(); }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            return bytes.buffer;
          }).then(bytes => audioContext.decodeAudioData(bytes)).then(buffer => {
            const size = buffer.length * buffer.numberOfChannels * 4;
            if (controller.signal.aborted || !Number.isFinite(size) || size > 4 * 1024 * 1024
              || !Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 3) throw new Error("audio_dimensions");
            soundBytes.set(url, size);
            while (Array.from(soundBytes.values()).reduce((total, value) => total + value, 0) > 8 * 1024 * 1024) {
              const oldest = soundBytes.keys().next().value;
              sounds.delete(oldest);
              soundBytes.delete(oldest);
            }
            return buffer;
          }),
          cancelled,
        ]).catch(() => {
          if (sounds.get(url) === loading) sounds.delete(url);
          return null;
        }).finally(() => {
          clearTimeout(timeout);
          if (pendingSoundLoads.get(url) === cancel) pendingSoundLoads.delete(url);
        });
        sounds.set(url, loading);
        pendingSoundLoads.set(url, cancel);
        if (sounds.size > 16) {
          const oldest = sounds.keys().next().value;
          pendingSoundLoads.get(oldest)?.();
          sounds.delete(oldest);
          soundBytes.delete(oldest);
        }
      }
      return sounds.get(url);
    }

    async function playSound(asset, event) {
      if (asset.type === "builtin" || !asset.audio || !soundInput.checked || video.muted || !audioContext || audioContext.state !== "running") return;
      const buffer = await getSound(resourceUrl(asset, "audio"));
      const elapsed = ageOf(event) / 1000;
      if (!buffer || !ready(event.sourceId) || !soundInput.checked || !enabledInput.checked || video.muted
        || elapsed >= Math.min(buffer.duration, event.durationMs / 1000) || !active.has(event)) return;
      if (playingSounds.size + Array.from(active).filter(other => other.element?.tagName === "VIDEO" && !other.element.muted).length >= 2) return;
      const source = audioContext.createBufferSource();
      const gain = audioContext.createGain();
      source.buffer = buffer;
      gain.gain.value = Math.min(0.6, video.volume * 0.6);
      source.connect(gain).connect(audioContext.destination);
      source.onended = () => { playingSounds.delete(source); source.disconnect(); gain.disconnect(); };
      playingSounds.add(source);
      event.sound = source;
      event.gain = gain;
      source.start(0, Math.max(0, elapsed), Math.min(buffer.duration, event.durationMs / 1000) - Math.max(0, elapsed));
    }

    function stopSounds() {
      for (const source of playingSounds) { try { source.stop(); } catch {} }
      playingSounds.clear();
      for (const event of active) if (event.element?.tagName === "VIDEO") event.element.muted = true;
    }

    async function loadCatalog() {
      if (catalogFlight) return catalogFlight;
      const catalogGeneration = generation;
      catalogFlight = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await fetch("/api/interactions", { cache: "no-store", credentials: "same-origin", signal: controller.signal });
          if (!response.ok) throw new Error("catalog_unavailable");
          const catalog = await response.json();
          if (catalog.version !== 1 || !Array.isArray(catalog.items)) throw new Error("catalog_invalid");
          const items = catalog.items.slice(0, 64).filter(asset => asset && typeof asset.id === "string"
            && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(asset.id) && typeof asset.label === "string"
            && typeof asset.revision === "string" && /^[a-f0-9]{16}$/.test(asset.revision)
            && Number.isFinite(asset.durationMs) && asset.durationMs > 0 && asset.durationMs <= 3000
            && (asset.type === "builtin"
              ? asset.group === "builtin" && BUILTIN_EFFECTS.includes(asset.effect) && asset.visualBytes === 0
                && ["src", "poster", "audio", "width", "height", "columns", "frames"].every(key => asset[key] === undefined)
              : safeResource(asset.src) && (!asset.poster || safeResource(asset.poster))
                && (!asset.audio || safeResource(asset.audio)) && ["image", "sprite", "video"].includes(asset.type)));
          const signature = JSON.stringify(items);
          if (catalogLoaded && signature === catalogSignature) {
            empty.hidden = assets.size > 0;
            empty.textContent = "暂无互动素材";
            if (catalogGeneration === generation) scheduleVisualWarmup();
            return;
          }
          const focusedAsset = document.activeElement?.closest("[data-interaction-asset]");
          const focusedId = focusedAsset && assetsElement.contains(focusedAsset) ? focusedAsset.dataset.interactionAsset : null;
          assets.clear();
          assetsElement.replaceChildren();
          // Group headings span the grid; keep file assets in their catalog order.
          const orderedItems = items.filter(asset => asset.type === "builtin")
            .sort((a, b) => BUILTIN_EFFECTS.indexOf(a.effect) - BUILTIN_EFFECTS.indexOf(b.effect))
            .concat(items.filter(asset => asset.type !== "builtin"));
          let previousGroup = null;
          for (const asset of orderedItems) {
            const group = asset.type === "builtin" ? "builtin" : "other";
            if (group !== previousGroup) {
              const heading = document.createElement("h3");
              heading.className = "interaction-group-heading";
              heading.dataset.interactionGroup = group;
              heading.textContent = group === "builtin" ? "预设" : "其它";
              assetsElement.appendChild(heading);
              previousGroup = group;
            }
            assets.set(asset.id, asset);
            const button = document.createElement("button");
            button.type = "button";
            button.className = "interaction-asset";
            button.dataset.interactionAsset = asset.id;
            button.dataset.interactionType = asset.type;
            button.dataset.interactionAssetGroup = group;
            button.setAttribute("aria-label", asset.label);
            button.title = asset.label;
            const thumbnail = document.createElement(asset.type === "builtin" ? "canvas"
              : asset.type === "video" && !asset.poster ? "video" : "img");
            thumbnail.setAttribute("aria-hidden", "true");
            if (asset.type === "builtin") {
              thumbnail.width = 108;
              thumbnail.height = 108;
              drawBuiltinEffect(thumbnail.getContext("2d"), createBuiltinEffect(asset.effect, `preview:${asset.effect}`), 0.4);
            } else {
              thumbnail.src = resourceUrl(asset, asset.poster ? "poster" : "src");
              thumbnail.alt = "";
            }
            if (thumbnail.tagName === "IMG") { thumbnail.loading = "lazy"; thumbnail.decoding = "async"; }
            if (thumbnail.tagName === "VIDEO") { thumbnail.muted = true; thumbnail.preload = "metadata"; thumbnail.playsInline = true; }
            const label = document.createElement("span");
            label.textContent = asset.label;
            button.append(thumbnail, label);
            button.addEventListener("click", () => {
              if (!ready()) { options.showToast("视频就绪后可发送互动", "info"); return; }
              enabledInput.checked = true;
              savePreferences();
              if (asset.type !== "builtin") {
                unlockAudio();
                if (asset.type !== "video") void getImage(resourceUrl(asset, "src")).catch(() => {});
                if (asset.audio) void getSound(resourceUrl(asset, "audio"));
              }
              open(false);
              select(asset);
              toggle.focus({ preventScroll: true });
            });
            assetsElement.appendChild(button);
          }
          if (focusedId !== null) {
            const replacement = Array.from(assetsElement.children).find(button => button.dataset.interactionAsset === focusedId);
            (replacement || popover.querySelector("[data-interaction-close]")).focus({ preventScroll: true });
          }
          catalogLoaded = true;
          const availableGroups = new Set(orderedItems.map(asset => asset.type === "builtin" ? "builtin" : "other"));
          for (const button of groups.querySelectorAll("button")) button.hidden = !availableGroups.has(button.dataset.interactionGroupTab);
          setGroup(availableGroups.has(popover.dataset.activeGroup) ? popover.dataset.activeGroup : availableGroups.values().next().value || "builtin");
          catalogSignature = signature;
          if (selected && assets.get(selected.id)?.revision !== selected.revision) select(null);
          empty.hidden = assets.size > 0;
          empty.textContent = "暂无互动素材";
          for (const event of active) if (!assets.has(event.assetId)) remove(event);
          if (catalogGeneration === generation) scheduleVisualWarmup();
        } catch {
          empty.hidden = false;
          empty.textContent = "素材暂不可用";
        } finally { clearTimeout(timeout); catalogFlight = null; }
      })();
      return catalogFlight;
    }

    function remove(event) {
      active.delete(event);
      if (event.sound) { try { event.sound.stop(); } catch {} playingSounds.delete(event.sound); }
      if (event.element?.tagName === "VIDEO") { event.element.pause(); event.element.removeAttribute("src"); event.element.load(); }
      event.element?.remove();
    }

    function clear(keepMenu) {
      generation += 1;
      cancelVisualWarmup();
      for (const [url, cancel] of pendingSoundLoads) { sounds.delete(url); cancel(); }
      pendingSoundLoads.clear();
      for (const event of active) remove(event);
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      stopSounds();
      select(null);
      if (keepMenu !== true) open(false);
    }

    function render() {
      animationFrame = 0;
      if (selected && (!ready(selectionSourceId) || (selectionDeadline && performance.now() >= selectionDeadline))) select(null);
      const rect = pictureRect(video);
      const bounds = shell.getBoundingClientRect();
      Object.assign(layer.style, { left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      for (const event of active) {
        const age = ageOf(event);
        if (age >= event.durationMs || !ready(event.sourceId) || !enabledInput.checked) { remove(event); continue; }
        const asset = assets.get(event.assetId);
        if (!asset || asset.revision !== event.assetRevision) { remove(event); continue; }
        const ratio = asset.type === "builtin" ? 1 : (asset.width || event.image?.naturalWidth || event.element.videoWidth || 1)
          / (asset.height || event.image?.naturalHeight || event.element.videoHeight || 1);
        const height = asset.type === "builtin" ? Math.min(240, rect.height * 0.48, rect.width * 0.48)
          : Math.min(180, rect.height * 0.32, rect.width * 0.35 / ratio);
        const width = height * ratio;
        Object.assign(event.element.style, { width: `${width}px`, height: `${height}px`,
          left: `${Math.max(width / 2, Math.min(rect.width - width / 2, event.x * rect.width))}px`,
          top: `${Math.max(height / 2, Math.min(rect.height - height / 2, event.y * rect.height))}px` });
        if (asset.type === "builtin") {
          drawBuiltinEffect(event.drawingContext, event.builtin, age / event.durationMs);
        } else if (asset.type === "sprite") {
          const frame = Math.min(asset.frames - 1, Math.max(0, Math.floor(age / event.durationMs * asset.frames)));
          if (event.frame !== frame) {
            const ctx = event.element.getContext("2d");
            ctx.clearRect(0, 0, asset.width, asset.height);
            ctx.drawImage(event.image, (frame % asset.columns) * asset.width, Math.floor(frame / asset.columns) * asset.height,
              asset.width, asset.height, 0, 0, asset.width, asset.height);
            event.frame = frame;
          }
        }
      }
      if (active.size || selected?.type === "builtin") animationFrame = requestAnimationFrame(render);
    }

    async function show(payload) {
      const eventGeneration = generation;
      const receivedAt = performance.now();
      if (!payload || typeof payload.id !== "string" || !payload.id.length || payload.id.length > 128
        || seen.has(payload.id) || !ready(payload.sourceId) || !enabledInput.checked
        || !Number.isFinite(payload.sentAt) || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)
        || payload.x < 0 || payload.x > 1 || payload.y < 0 || payload.y > 1) return;
      const receivedAge = now() - payload.sentAt;
      if (receivedAge < -1000 || receivedAge >= Math.min(Number(payload.durationMs) || 0, 3000)) return;
      seen.set(payload.id, true);
      if (seen.size > 256) seen.delete(seen.keys().next().value);
      if (!catalogLoaded || !assets.has(payload.assetId) || assets.get(payload.assetId).revision !== payload.assetRevision) await loadCatalog();
      const asset = assets.get(payload.assetId);
      if (!asset || asset.revision !== payload.assetRevision) return;
      // Anchor once to a monotonic clock: later wall-clock or clock-sync corrections cannot extend the effect.
      const event = Object.assign({}, payload, { durationMs: Math.min(asset.durationMs, Number(payload.durationMs) || 0, 3000),
        startedAt: receivedAt - Math.max(0, receivedAge) });
      if (event.durationMs <= 0 || ageOf(event) >= event.durationMs) return;
      try {
        if (asset.type !== "builtin" && asset.type !== "video") event.image = await getImage(resourceUrl(asset, "src"));
        if (eventGeneration !== generation || !ready(event.sourceId) || !enabledInput.checked || ageOf(event) >= event.durationMs) return;
        event.element = document.createElement(asset.type === "builtin" || asset.type === "sprite" ? "canvas" : asset.type === "video" ? "video" : "img");
        event.element.className = "interaction-effect";
        event.element.dataset.interactionId = event.id;
        event.element.setAttribute("aria-hidden", "true");
        if (asset.type === "builtin") {
          event.element.width = BUILTIN_SIZE;
          event.element.height = BUILTIN_SIZE;
          event.drawingContext = event.element.getContext("2d");
          if (!event.drawingContext) return;
          event.builtin = createBuiltinEffect(asset.effect, event.id);
          event.element.dataset.interactionEffect = asset.effect;
          event.element.dataset.interactionVariant = String(event.builtin.variant);
        } else if (asset.type === "sprite") { event.element.width = asset.width; event.element.height = asset.height; }
        else event.element.src = resourceUrl(asset, "src");
        if (asset.type === "video") {
          event.element.playsInline = true;
          event.element.muted = Boolean(asset.audio || !soundInput.checked || video.muted || audioContext?.state !== "running"
            || playingSounds.size >= 2 || Array.from(active).some(other => other.element?.tagName === "VIDEO" && !other.element.muted));
          event.element.volume = Math.min(0.6, video.volume * 0.6);
          event.element.addEventListener("loadedmetadata", () => {
            if (!active.has(event)) return;
            event.element.currentTime = ageOf(event) / 1000;
            void event.element.play().catch(() => {
              if (!active.has(event)) return;
              event.element.muted = true;
              void event.element.play().catch(() => {});
            });
          }, { once: true });
        }
        while (active.size >= 8) remove(active.values().next().value);
        active.add(event);
        layer.appendChild(event.element);
        if (asset.type !== "builtin") void playSound(asset, event).catch(() => {});
        if (!animationFrame) render();
      } catch { /* Missing assets must never interrupt the main player. */ }
    }

    function savePreferences() {
      try {
        localStorage.setItem("together-see:interactions", enabledInput.checked ? "on" : "off");
        localStorage.setItem("together-see:interaction-sound", soundInput.checked ? "on" : "off");
      } catch {}
    }
    function sendNotice(message) {
      const time = performance.now();
      if (time - lastSendNotice < 1000) return;
      lastSendNotice = time;
      options.showToast(message, "warning");
    }

    async function sendPlacement(asset, x, y) {
      const time = performance.now();
      while (sendTimes.length && time - sendTimes[0] >= 3000) sendTimes.shift();
      if (sendTimes.length >= 4) { sendNotice("互动太频繁，请稍后再试"); return; }
      if (pendingSends.size >= 4) { sendNotice("互动正在发送，请稍后再试"); return; }
      const sourceId = selectionSourceId;
      if (asset.type !== "builtin") select(null);
      const version = selectionVersion;
      const sendGeneration = generation;
      const token = {};
      let timeout;
      pendingSends.add(token);
      sendTimes.push(time);
      const notifyFailure = message => {
        if (sendGeneration === generation && version === selectionVersion && ready(sourceId)) sendNotice(message);
      };
      try {
        // Bound a missing ACK without allowing its late result to affect a new selection.
        const expired = new Promise(resolve => {
          timeout = setTimeout(() => resolve({ ok: false, message: "互动发送超时，请稍后再试" }), 4500);
        });
        const result = await Promise.race([options.send({ assetId: asset.id, sourceId, x, y }), expired]);
        if (!result?.ok) notifyFailure(result?.message || "互动发送失败，请稍后再试");
      } catch { notifyFailure("互动发送失败，请稍后再试"); }
      finally { clearTimeout(timeout); pendingSends.delete(token); }
    }

    function renderMenuPage() {
      const buttons = [...assetsElement.querySelectorAll("[data-interaction-asset]")];
      const groupItems = buttons.filter(button => button.dataset.interactionAssetGroup === popover.dataset.activeGroup);
      const pages = Math.max(1, Math.ceil(groupItems.length / 6));
      menuPage = Math.max(0, Math.min(menuPage, pages - 1));
      for (const button of buttons) {
        const index = groupItems.indexOf(button);
        button.hidden = index < menuPage * 6 || index >= (menuPage + 1) * 6;
      }
      pagination.hidden = pages <= 1;
      pagination.querySelector("[data-interaction-page]").textContent = `${menuPage + 1} / ${pages}`;
      pagination.querySelector("[data-interaction-prev]").disabled = menuPage === 0;
      pagination.querySelector("[data-interaction-next]").disabled = menuPage === pages - 1;
    }
    function setGroup(group) {
      popover.dataset.activeGroup = group;
      for (const button of groups.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.interactionGroupTab === group));
      menuPage = 0;
      renderMenuPage();
    }
    groups.addEventListener("click", event => {
      const button = event.target.closest("[data-interaction-group-tab]");
      if (button) setGroup(button.dataset.interactionGroupTab);
    });
    pagination.querySelector("[data-interaction-prev]").addEventListener("click", () => { menuPage--; renderMenuPage(); });
    pagination.querySelector("[data-interaction-next]").addEventListener("click", () => { menuPage++; renderMenuPage(); });
    // The fixed, paginated menu needs no swipe. Cancel default gestures as well as bubbling.
    for (const type of ["touchmove", "wheel"]) {
      popover.addEventListener(type, event => { if (event.cancelable) event.preventDefault(); event.stopPropagation(); }, { passive: false });
    }
    for (const type of ["touchstart", "touchend", "pointerdown", "pointermove", "pointerup"]) {
      popover.addEventListener(type, event => event.stopPropagation(), { passive: true });
    }
    popover.addEventListener("keydown", event => event.stopPropagation());
    popover.addEventListener("cancel", event => { event.preventDefault(); select(null); open(false); });
    popover.addEventListener("close", () => { if (!popover.open && !popover.hidden) open(false); });
    toggle.addEventListener("click", () => { unlockAudio(); open(popover.hidden); });
    controls.addEventListener("keydown", event => {
      if (event.target.closest("[data-interaction-toggle], .interaction-popover, .interaction-placement-cancel")
        && event.key !== "Escape") event.stopPropagation();
    });
    popover.querySelector("[data-interaction-close]").addEventListener("click", () => { open(false); toggle.focus(); });
    cancel.addEventListener("click", () => select(null));
    enabledInput.addEventListener("change", () => {
      savePreferences();
      if (!enabledInput.checked) clear(true);
      else scheduleVisualWarmup();
    });
    soundInput.addEventListener("change", () => { savePreferences(); if (soundInput.checked) unlockAudio(); else stopSounds(); });
    video.addEventListener("volumechange", () => {
      if (video.muted || !video.volume) { stopSounds(); return; }
      for (const event of active) {
        if (event.gain) event.gain.gain.value = Math.min(0.6, video.volume * 0.6);
        if (event.element?.tagName === "VIDEO") event.element.volume = Math.min(0.6, video.volume * 0.6);
      }
    });
    video.addEventListener("emptied", clear);
    for (const type of ["canplay", "playing", "loadeddata", "progress"]) video.addEventListener(type, scheduleVisualWarmup);
    for (const type of ["waiting", "stalled", "seeking"]) video.addEventListener(type, cancelVisualWarmup);
    window.addEventListener("together-see:player-source-ready", scheduleVisualWarmup);
    window.addEventListener("together-see:player-buffering-change", event => {
      if (event.detail?.buffering) cancelVisualWarmup();
      else scheduleVisualWarmup();
    });
    document.addEventListener("pointerdown", event => {
      if (selected?.type !== "builtin" && !event.target.closest('[data-interaction-type="builtin"]')) unlockAudio();
    }, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) clear();
      else scheduleVisualWarmup();
    });
    window.addEventListener("together-see:control-lock-change", event => {
      if (event.detail?.locked) { select(null); open(false); }
    });
    document.addEventListener("keydown", event => { if (event.key === "Escape") { select(null); open(false); } });
    shell.addEventListener("contextmenu", event => { if (selected) { event.preventDefault(); select(null); } });
    shell.addEventListener("click", event => {
      if (event.target.closest(".interaction-popover")) return;
      if (options.player.isControlLocked?.()) { select(null); open(false); return; }
      if (event.target.closest("[data-player-controls], button, input, a")) return;
      if (!popover.hidden) open(false);
      if (!selected) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const asset = selected;
      if ((selectionDeadline && performance.now() >= selectionDeadline) || !ready(selectionSourceId)) {
        select(null);
        return;
      }
      const rect = pictureRect(video);
      if (!rect.width || !rect.height) return;
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      void sendPlacement(asset, x, y);
    }, true);
    void loadCatalog();
    return { show, clear, refreshCatalog: loadCatalog };
  }
  window.TogetherSeeInteractions = { create, pictureRect, createBuiltinEffect, drawBuiltinEffect };
})();
