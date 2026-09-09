import assert from 'node:assert/strict';

const {
  getBilibiliDanmaku,
  isBilibiliVideoUrl,
  parseBilibiliDanmakuXml,
  parseBilibiliVideo,
  parseBilibiliVideoInput,
  toBilibiliPublicError,
} = await import('../dist/services/bilibili.service.js');

const sampleBvid = 'BV1182FBRExJ';
const sampleCid = 33755434897;

assert.equal(isBilibiliVideoUrl(`https://www.bilibili.com/video/${sampleBvid}`), true);
assert.equal(isBilibiliVideoUrl('https://example.com/video/BV1182FBRExJ'), false);
assert.deepEqual(parseBilibiliVideoInput(`https://www.bilibili.com/video/${sampleBvid}?p=2`), {
  bvid: sampleBvid,
  aid: null,
  page: 2,
});

const xmlItems = parseBilibiliDanmakuXml(`<?xml version="1.0" encoding="UTF-8"?>
<i>
  <d p="1.25,1,25,16777215,1700000000,0,hash-a,101">滚动弹幕</d>
  <d p="2.5,5,30,16711680,1700000001,0,hash-b,102">顶部弹幕</d>
  <d p="3.75,4,20,255,1700000002,0,hash-c,103">底部弹幕</d>
</i>`);
assert.equal(xmlItems.length, 3);
assert.deepEqual(xmlItems.map((item) => item.mode), ['scroll', 'top', 'bottom']);
assert.deepEqual(xmlItems.map((item) => item.color), ['#ffffff', '#ff0000', '#0000ff']);
assert.equal(xmlItems[1].fontSize, 30);

function viewPayload({ bvid = sampleBvid, paid = false } = {}) {
  return {
    code: 0,
    data: {
      bvid,
      title: '公开视频示例',
      duration: 226,
      state: 0,
      cid: sampleCid,
      pages: [{ cid: sampleCid, page: 1, part: '公开视频示例', duration: 226 }],
      rights: paid ? { pay: 1 } : { pay: 0, ugc_pay: 0 },
    },
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const fakeFetch = async (url) => {
  const target = String(url);
  if (target.includes('/x/web-interface/view')) return jsonResponse(viewPayload());
  if (target.includes('/x/player/playurl')) {
    return jsonResponse({
      code: 0,
      data: {
        quality: 64,
        format: 'mp4720',
        durl: [{ url: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/test.mp4' }],
        support_formats: [{ quality: 64, new_description: '720P 高清' }],
      },
    });
  }
  if (target.includes('comment.bilibili.com')) {
    return new Response('<i><d p="1,1,25,16777215,1,0,h,1">测试弹幕</d></i>', {
      status: 200,
      headers: { 'content-type': 'application/xml' },
    });
  }
  throw new Error(`unexpected Bilibili test URL: ${target}`);
};

const parsed = await parseBilibiliVideo(`https://www.bilibili.com/video/${sampleBvid}`, { fetchImpl: fakeFetch });
assert.equal(parsed.success, true);
assert.equal(parsed.type, 'video');
assert.equal(parsed.requiresClientParse, false, 'Bilibili proxy playback should reuse the shared server-resolved source until a real load failure');
assert.match(parsed.src, /\.bilivideo\.com\//);
assert.equal(parsed.bilibili?.quality, 64);
assert.equal(parsed.bilibili?.qualityLabel, '720P 高清');
assert.equal(parsed.bilibili?.danmakuEnabled, false, 'source danmaku should be opt-in per playlist item');

function fetchWithPlayData(data) {
  return async (url) => {
    const target = String(url);
    if (target.includes('/x/web-interface/view')) return jsonResponse(viewPayload());
    if (target.includes('/x/player/playurl')) return jsonResponse({ code: 0, data });
    throw new Error(`unexpected Bilibili test URL: ${target}`);
  };
}

const backupParsed = await parseBilibiliVideo(`https://www.bilibili.com/video/${sampleBvid}`, {
  fetchImpl: fetchWithPlayData({
    quality: 64,
    durl: [{
      url: 'https://bilivideo.com.attacker.example/video.mp4',
      backup_url: ['//upos-sz-mirrorcos.bilivideo.com/upgcxcode/backup.mp4#fragment'],
    }],
  }),
});
assert.equal(
  backupParsed.src,
  'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/backup.mp4',
  'a trusted protocol-relative backup CDN URL should be used when the primary host is untrusted',
);

const upgradedParsed = await parseBilibiliVideo(`https://www.bilibili.com/video/${sampleBvid}`, {
  fetchImpl: fetchWithPlayData({
    quality: 64,
    durl: [{ url: 'http://upos-sz-mirrorcos.bilivideo.com/upgcxcode/http-source.mp4' }],
  }),
});
assert.equal(
  upgradedParsed.src,
  'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/http-source.mp4',
  'trusted legacy HTTP CDN URLs should be upgraded to HTTPS instead of being rejected as unexpected',
);

const exactAkamaiParsed = await parseBilibiliVideo(`https://www.bilibili.com/video/${sampleBvid}`, {
  fetchImpl: fetchWithPlayData({
    quality: 64,
    durl: [{ url: 'https://upos-hz-mirrorakam.akamaized.net/upgcxcode/official-api-source.mp4' }],
  }),
});
assert.equal(
  exactAkamaiParsed.src,
  'https://upos-hz-mirrorakam.akamaized.net/upgcxcode/official-api-source.mp4',
  'the exact Akamai hostname observed from the official anonymous playurl API should be accepted',
);

for (const rejectedAkamaiUrl of [
  'https://other.akamaized.net/upgcxcode/video.mp4',
  'https://attacker.upos-hz-mirrorakam.akamaized.net/upgcxcode/video.mp4',
  'https://upos-hz-mirrorakam.akamaized.net.attacker.example/upgcxcode/video.mp4',
]) {
  let rejectedAkamaiError;
  try {
    await parseBilibiliVideo(`https://www.bilibili.com/video/${sampleBvid}`, {
      fetchImpl: fetchWithPlayData({
        quality: 64,
        durl: [{ url: rejectedAkamaiUrl }],
      }),
    });
  } catch (error) {
    rejectedAkamaiError = toBilibiliPublicError(error);
  }
  assert.equal(
    rejectedAkamaiError?.code,
    'bilibili_cdn_unrecognized',
    `Akamai trust must remain exact-host only: ${new URL(rejectedAkamaiUrl).hostname}`,
  );
}

let unrecognizedCdnError;
try {
  await parseBilibiliVideo(`https://www.bilibili.com/video/${sampleBvid}`, {
    fetchImpl: fetchWithPlayData({
      quality: 64,
      durl: [{ url: 'https://bilivideo.com.attacker.example/video.mp4' }],
    }),
  });
} catch (error) {
  unrecognizedCdnError = toBilibiliPublicError(error);
}
assert.deepEqual(unrecognizedCdnError, {
  code: 'bilibili_cdn_unrecognized',
  message: 'B站暂未返回受支持的匿名播放线路，请稍后重试',
  status: 502,
  recoverable: true,
  retryAfterMs: 10_000,
});

let segmentedError;
try {
  await parseBilibiliVideo(`https://www.bilibili.com/video/${sampleBvid}`, {
    fetchImpl: fetchWithPlayData({
      quality: 64,
      durl: [
        { url: 'https://upos-sz-mirrorcos.bilivideo.com/part-1.mp4' },
        { url: 'https://upos-sz-mirrorcos.bilivideo.com/part-2.mp4' },
      ],
    }),
  });
} catch (error) {
  segmentedError = toBilibiliPublicError(error);
}
assert.equal(segmentedError?.code, 'bilibili_stream_unsupported');
assert.equal(segmentedError?.recoverable, false, 'unsupported segmented streams must not trigger retry loops');

const shortLinkFetch = async (url, init) => {
  if (String(url).startsWith('https://b23.tv/')) {
    assert.equal(init?.method, 'HEAD');
    return new Response(null, {
      status: 302,
      headers: { location: `https://www.bilibili.com/video/${sampleBvid}` },
    });
  }
  return fakeFetch(url, init);
};
const parsedShortLink = await parseBilibiliVideo('https://b23.tv/public-sample', { fetchImpl: shortLinkFetch });
assert.equal(parsedShortLink.bilibili?.bvid, sampleBvid, 'b23.tv redirects should resolve to the canonical BV item');

const danmaku = await getBilibiliDanmaku(sampleBvid, 1, { fetchImpl: fakeFetch, force: true });
assert.equal(danmaku.cid, sampleCid);
assert.equal(danmaku.items.length, 1);
assert.equal(danmaku.items[0].text, '测试弹幕');

const paidFetch = async (url) => {
  if (String(url).includes('/x/web-interface/view')) return jsonResponse(viewPayload({ bvid: 'BV1xx411c7mD', paid: true }));
  throw new Error('paid videos must be rejected before requesting a play URL');
};
await assert.rejects(
  parseBilibiliVideo('https://www.bilibili.com/video/BV1xx411c7mD', { fetchImpl: paidFetch }),
  /付费|会员|专属权限/,
);

let restrictedError;
try {
  await parseBilibiliVideo('https://www.bilibili.com/video/BV1xx411c7mD', { fetchImpl: paidFetch });
} catch (error) {
  restrictedError = toBilibiliPublicError(error);
}
assert.equal(restrictedError?.code, 'bilibili_access_restricted');
assert.equal(restrictedError?.status, 403);
assert.equal(restrictedError?.recoverable, false, 'login/member/paid restrictions must never be marked retryable');

const fallbackCalls = [];
const riskControlledFetch = async (url) => {
  const target = String(url);
  fallbackCalls.push(target);
  if (target.includes('/x/web-interface/view')) {
    return new Response(JSON.stringify({ code: -412, message: 'request blocked' }), {
      status: 412,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (target.includes('/x/player/pagelist')) {
    return jsonResponse({
      code: 0,
      data: [{ cid: sampleCid, page: 1, part: '兼容元数据示例', duration: 226 }],
    });
  }
  if (target.includes('/x/player/playurl')) {
    return jsonResponse({
      code: 0,
      data: {
        quality: 64,
        format: 'mp4720',
        is_preview: 0,
        is_drm: false,
        durl: [{ url: 'https://upos-hz-mirrorakam.akamaized.net/upgcxcode/fallback.mp4' }],
      },
    });
  }
  throw new Error(`unexpected risk-control test URL: ${target}`);
};

const fallbackParsed = await parseBilibiliVideo(`https://www.bilibili.com/video/${sampleBvid}`, {
  fetchImpl: riskControlledFetch,
});
assert.equal(fallbackParsed.success, true);
assert.equal(fallbackParsed.bilibili?.cid, sampleCid);
assert.equal(fallbackParsed.title, '兼容元数据示例');
assert.match(fallbackParsed.src, /^https:\/\/upos-hz-mirrorakam\.akamaized\.net\//);
assert.equal(fallbackCalls.filter((target) => target.includes('/x/web-interface/view')).length, 1);
assert.equal(fallbackCalls.filter((target) => target.includes('/x/player/pagelist')).length, 1);

let missingFallbackPageError;
try {
  await parseBilibiliVideo(`https://www.bilibili.com/video/${sampleBvid}?p=2`, {
    fetchImpl: riskControlledFetch,
  });
} catch (error) {
  missingFallbackPageError = toBilibiliPublicError(error);
}
assert.equal(missingFallbackPageError?.code, 'bilibili_page_unavailable');

const cooldownCalls = [];
const cooldownFetch = async (url) => {
  const target = String(url);
  cooldownCalls.push(target);
  if (target.includes('/x/web-interface/view')) throw new Error('view must stay inside the risk-control cooldown');
  if (target.includes('/x/player/pagelist')) {
    return jsonResponse({ code: 0, data: [{ cid: sampleCid, page: 1, part: '冷却期示例', duration: 120 }] });
  }
  if (target.includes('/x/player/playurl')) {
    return jsonResponse({
      code: 0,
      data: {
        quality: 64,
        durl: [{ url: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/cooldown.mp4' }],
      },
    });
  }
  throw new Error(`unexpected cooldown test URL: ${target}`);
};
await parseBilibiliVideo(`https://www.bilibili.com/video/${sampleBvid}`, { fetchImpl: cooldownFetch });
assert.equal(cooldownCalls.some((target) => target.includes('/x/web-interface/view')), false);

const restrictedFallbackFetch = async (url) => {
  const target = String(url);
  if (target.includes('/x/web-interface/view')) throw new Error('view must stay inside the risk-control cooldown');
  if (target.includes('/x/player/pagelist')) {
    return jsonResponse({ code: 0, data: [{ cid: sampleCid, page: 1, part: '试看内容', duration: 120 }] });
  }
  if (target.includes('/x/player/playurl')) {
    return jsonResponse({
      code: 0,
      data: {
        quality: 64,
        is_preview: 1,
        durl: [{ url: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/preview.mp4' }],
      },
    });
  }
  throw new Error(`unexpected restricted fallback URL: ${target}`);
};
let fallbackRestrictedError;
try {
  await parseBilibiliVideo(`https://www.bilibili.com/video/${sampleBvid}`, { fetchImpl: restrictedFallbackFetch });
} catch (error) {
  fallbackRestrictedError = toBilibiliPublicError(error);
}
assert.equal(fallbackRestrictedError?.code, 'bilibili_access_restricted');
assert.equal(fallbackRestrictedError?.recoverable, false);

const drmFallbackFetch = async (url) => {
  const target = String(url);
  if (target.includes('/x/web-interface/view')) throw new Error('view must stay inside the risk-control cooldown');
  if (target.includes('/x/player/pagelist')) {
    return jsonResponse({ code: 0, data: [{ cid: sampleCid, page: 1, part: '受保护内容', duration: 120 }] });
  }
  if (target.includes('/x/player/playurl')) {
    return jsonResponse({
      code: 0,
      data: {
        quality: 64,
        is_drm: 1,
        durl: [{ url: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/drm.mp4' }],
      },
    });
  }
  throw new Error(`unexpected DRM fallback URL: ${target}`);
};
let fallbackDrmError;
try {
  await parseBilibiliVideo(`https://www.bilibili.com/video/${sampleBvid}`, { fetchImpl: drmFallbackFetch });
} catch (error) {
  fallbackDrmError = toBilibiliPublicError(error);
}
assert.equal(fallbackDrmError?.code, 'bilibili_access_restricted');
assert.equal(fallbackDrmError?.recoverable, false);

const playurlLimitedFetch = async (url) => {
  const target = String(url);
  if (target.includes('/x/web-interface/view')) throw new Error('view must stay inside the risk-control cooldown');
  if (target.includes('/x/player/pagelist')) {
    return jsonResponse({ code: 0, data: [{ cid: sampleCid, page: 1, part: '接口受限', duration: 120 }] });
  }
  if (target.includes('/x/player/playurl')) {
    return new Response(JSON.stringify({ code: -412, message: 'request blocked' }), {
      status: 412,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`unexpected limited playurl URL: ${target}`);
};
let playurlLimitedError;
try {
  await parseBilibiliVideo(`https://www.bilibili.com/video/${sampleBvid}`, { fetchImpl: playurlLimitedFetch });
} catch (error) {
  playurlLimitedError = toBilibiliPublicError(error);
}
assert.equal(playurlLimitedError?.code, 'bilibili_upstream_limited');
assert.equal(playurlLimitedError?.recoverable, true);

let avCooldownError;
try {
  await parseBilibiliVideo('https://www.bilibili.com/video/av170001', {
    fetchImpl: async () => { throw new Error('AV fallback must not issue an unverified request during cooldown'); },
  });
} catch (error) {
  avCooldownError = toBilibiliPublicError(error);
}
assert.equal(avCooldownError?.code, 'bilibili_upstream_limited');
assert.equal(avCooldownError?.recoverable, true);
assert.ok(avCooldownError?.retryAfterMs >= 1_000 && avCooldownError.retryAfterMs <= 60_000);

console.log('Bilibili parser and danmaku verification passed');
