(function () {
  "use strict";
  const MAX_BYTES = 4096;
  const TIMEOUT_MS = 8000;

  function isAllowedUrl(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
        && !/(?:bilibili|bilivideo|acgvideo|hdslb|b23\.tv)/i.test(url.hostname);
    } catch (error) { return false; }
  }

  function classify(bytes, type) {
    if (type === "hls") {
      const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").trimStart();
      return /^#EXTM3U(?:\r?\n|$)/.test(text) && !/(?:SAMPLE-AES|KEYFORMAT)/i.test(text);
    }
    if (type !== "video") return false;
    const mp4 = bytes.length >= 16 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp"
      && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) >= 16;
    const webm = bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    return mp4 || webm;
  }

  function verifyNativeMedia(url, type, signal) {
    const media = document.createElement("video");
    if (type === "hls" && !media.canPlayType("application/vnd.apple.mpegurl")) {
      return Promise.reject(new Error("当前浏览器需要来源允许 CORS 才能播放此 HLS 视频流"));
    }
    return new Promise(function (resolve, reject) {
      let settled = false;
      function finish(error) {
        if (settled) return;
        settled = true;
        media.removeEventListener("loadeddata", onReady);
        media.removeEventListener("error", onError);
        media.removeEventListener("encrypted", onEncrypted);
        signal.removeEventListener("abort", onAbort);
        media.pause();
        media.removeAttribute("src");
        media.load();
        if (error) reject(error);
        else resolve();
      }
      function onReady() {
        if (media.readyState >= 2 && media.videoWidth > 0 && media.videoHeight > 0) finish();
      }
      function onError() { finish(new Error("本机原生播放验证失败，来源拒绝访问或格式不可播放")); }
      function onEncrypted() { finish(new Error("本机直连不支持需要 DRM 授权的媒体")); }
      function onAbort() { finish(new Error("本机直连验证超时（8秒），未添加播放项")); }
      if (signal.aborted) { onAbort(); return; }
      media.addEventListener("loadeddata", onReady);
      media.addEventListener("error", onError);
      media.addEventListener("encrypted", onEncrypted);
      signal.addEventListener("abort", onAbort, { once: true });
      // Native media can decode a public cross-origin video without readable
      // CORS bytes. This never grants access to its pixels or a server proxy.
      media.preload = "auto";
      media.muted = true;
      media.playsInline = true;
      media.src = url;
      media.load();
    });
  }

  async function verify(candidate, inputUrl) {
    if (!candidate || !["hls", "video"].includes(candidate.type)
      || !isAllowedUrl(candidate.url) || !isAllowedUrl(inputUrl)) throw new Error("不支持本机直连验证的来源");
    const target = new URL(candidate.url);
    const input = new URL(inputUrl);
    target.hash = "";
    input.hash = "";
    if (target.href !== input.href) throw new Error("本机直连验证仅支持原始直链，不支持网页提取或跳转");
    const controller = new AbortController();
    let reader;
    let timer;
    let verifiedNatively = false;
    const timeout = new Promise(function (_resolve, reject) {
      timer = window.setTimeout(function () {
        reject(new Error("本机直连验证超时（8秒），未添加播放项"));
        controller.abort();
      }, TIMEOUT_MS);
    });
    try {
      const probe = (async function () {
        let response;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            response = await fetch(target.href, {
              mode: "cors", credentials: "omit", redirect: "error", cache: "no-store",
              // HLS manifests normally use GET without Range. Still stop reading
              // after MAX_BYTES, including when a source ignores a video Range.
              headers: candidate.type === "hls" ? {} : { Range: "bytes=0-4095" }, signal: controller.signal,
            });
          } catch (error) {
            if (!(error instanceof TypeError) || controller.signal.aborted) throw error;
            // The byte API cannot distinguish CORS rejection from transport
            // failure. Let the actual decoder try once, never use opaque fetch.
            await verifyNativeMedia(target.href, candidate.type, controller.signal);
            verifiedNatively = true;
            return;
          }
          if (attempt === 0 && [408, 429, 500, 502, 503, 504].includes(response.status)) {
            if (response.body) await response.body.cancel();
            await new Promise(function (resolve) { window.setTimeout(resolve, 400); });
            if (controller.signal.aborted) throw new Error("本机直连验证超时（8秒），未添加播放项");
            continue;
          }
          break;
        }
        if (!response.ok || response.type === "opaque" || response.type === "opaqueredirect" || !response.body
          || /(?:text\/html|application\/xhtml\+xml|image\/svg\+xml)/i.test(response.headers.get("content-type") || "")) {
          throw new Error("本机直连未返回可读取的媒体响应");
        }
        reader = response.body.getReader();
        const bytes = new Uint8Array(MAX_BYTES);
        let length = 0;
        while (length < MAX_BYTES) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const part = chunk.value.subarray(0, MAX_BYTES - length);
          bytes.set(part, length);
          length += part.length;
        }
        // Do not consume the remaining file even when the origin ignores Range.
        reader.cancel().catch(function () {});
        if (!classify(bytes.subarray(0, length), candidate.type)) throw new Error("本机直连内容未通过媒体字节校验，或声明了不支持的 DRM");
      })();
      await Promise.race([probe, timeout]);
      return {
        success: true, src: target.href, type: candidate.type, pageUrl: input.href,
        refererUrl: input.href, finalUrl: target.href, clientDirectOnly: true,
        requiresClientParse: false,
        message: verifiedNatively
          ? "本机原生解码验证通过，仅由各设备浏览器直连播放，不使用服务器代理"
          : "本机直连已通过媒体字节验证，仅由各设备浏览器直连播放，不使用服务器代理",
      };
    } catch (error) {
      if (error instanceof TypeError) throw new Error("本机直连验证失败：来源未允许 CORS、发生跳转或网络不可达");
      throw error;
    } finally {
      window.clearTimeout(timer);
      if (reader) reader.cancel().catch(function () {});
      controller.abort();
    }
  }

  window.TogetherSeeDirectMedia = { verify: verify, isAllowedUrl: isAllowedUrl };
})();
