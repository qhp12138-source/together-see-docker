import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import express from 'express';

process.env.HLS_PROXY_RATE_LIMIT_PER_MINUTE = '0';

const {
  assertHlsRewriteTargetBudget,
  attachMediaProxySessionAbortController,
  buildProxyForwardHeaders,
  createMediaProxyClientBinding,
  createMediaProxyRouter,
  getMediaProxyGrantUsage,
  isBlockedProxyIpAddress,
  issueMediaProxyGrant,
  mediaProxyGrantLimits,
  proxyRouter,
  registerMediaProxySession,
  revokeMediaProxySession,
  suspendMediaProxySession,
  toPublicMediaGrantFailure,
} = await import('../dist/routes/proxy.routes.js');
const { env: runtimeEnv } = await import('../dist/config/env.js');
const { recordVerifiedDirectMediaUrl } = await import('../dist/services/parser.service.js');
const proxyPolicyUserAgent = 'proxy-policy-test';
const proxyPolicyClientBinding = createMediaProxyClientBinding('127.0.0.1', proxyPolicyUserAgent);

assert.equal(isBlockedProxyIpAddress('127.0.0.1'), true);
assert.equal(isBlockedProxyIpAddress('169.254.169.254'), true);
assert.equal(isBlockedProxyIpAddress('::ffff:127.0.0.1'), true);
assert.equal(isBlockedProxyIpAddress('10.20.30.40'), true);
assert.equal(isBlockedProxyIpAddress('8.8.8.8'), false);
assert.equal(isBlockedProxyIpAddress('2606:4700:4700::1111'), false);

const rangeHeaders = buildProxyForwardHeaders(
  'bytes=1024-2047',
  new URL('https://media.example.com/video.mp4'),
  'https://www.example.com/watch',
);
assert.equal(rangeHeaders.range, 'bytes=1024-2047');
assert.equal(rangeHeaders.referer, 'https://www.example.com/watch');
assert.equal(rangeHeaders.origin, 'https://www.example.com');
assert.equal(rangeHeaders['accept-encoding'], 'identity');

registerMediaProxySession('proxy-policy-opaque', 'ROOM-POLICY', 'member-opaque', proxyPolicyClientBinding);
const opaqueGrant = issueMediaProxyGrant(
  'hls',
  'https://media.example.com/video.m3u8?signature=must-not-leak',
  'https://media.example.com/watch/private-page',
  { sessionId: 'proxy-policy-opaque' },
);
const duplicateOpaqueGrant = issueMediaProxyGrant(
  'hls',
  'https://media.example.com/video.m3u8?signature=must-not-leak',
  'https://media.example.com/watch/private-page',
  { sessionId: 'proxy-policy-opaque' },
);
assert.match(opaqueGrant.proxyUrl, /^\/api\/proxy\/hls\?token=[A-Za-z0-9_-]+$/);
assert.equal(duplicateOpaqueGrant.proxyUrl, opaqueGrant.proxyUrl, 'identical grants in one session must reuse one token');
assert.equal(opaqueGrant.proxyUrl.includes('signature'), false);
assert.equal(opaqueGrant.proxyUrl.includes('private-page'), false);
assert.throws(() => issueMediaProxyGrant('media', 'http://127.0.0.1/private.mp4'), /内网|本机/);
recordVerifiedDirectMediaUrl('https://93.184.216.34/movie.mp4?token=exact', 'video');
registerMediaProxySession('proxy-policy-direct', 'ROOM-POLICY', 'member-direct', proxyPolicyClientBinding);
const verifiedDirectGrant = issueMediaProxyGrant(
  'media',
  'https://93.184.216.34/movie.mp4?token=exact',
  'https://93.184.216.34/movie.mp4?token=exact',
  { allowVerifiedDirect: true, sessionId: 'proxy-policy-direct' },
);
assert.match(verifiedDirectGrant.proxyUrl, /^\/api\/proxy\/media\?token=[A-Za-z0-9_-]+$/);
assert.deepEqual(toPublicMediaGrantFailure(new Error('生产环境必须配置 HLS_PROXY_ALLOWED_HOSTS 后才能使用媒体代理')), {
  code: 'parse_option_missing',
  message: '未配置解析项',
});
assert.deepEqual(toPublicMediaGrantFailure(new Error('目标不在允许的主机白名单中')), {
  code: 'parse_source_denied',
  message: '当前视频源不在可解析范围',
});
assert.deepEqual(toPublicMediaGrantFailure(new Error('直链媒体授权仅允许标准 HTTP/HTTPS 端口')), {
  code: 'parse_source_denied',
  message: '当前视频源不在可解析范围',
});
revokeMediaProxySession('proxy-policy-opaque');
revokeMediaProxySession('proxy-policy-direct');

const acceptedHlsTargets = Array.from({ length: mediaProxyGrantLimits.perHlsManifest }, (_, index) => `segment-${index}.ts`).join('\n');
assert.doesNotThrow(() => assertHlsRewriteTargetBudget(acceptedHlsTargets, 'https://media.example.com/index.m3u8'));
assert.throws(
  () => assertHlsRewriteTargetBudget(`${acceptedHlsTargets}\nsegment-overflow.ts`, 'https://media.example.com/index.m3u8'),
  /过多媒体地址/,
  'one manifest must not mint an unbounded number of child grants',
);

registerMediaProxySession('proxy-policy-cap', 'ROOM-POLICY', 'member-cap', proxyPolicyClientBinding);
for (let index = 0; index < mediaProxyGrantLimits.perSession; index += 1) {
  issueMediaProxyGrant('hls', `https://media.example.com/cap/${index}.m3u8`, '', { sessionId: 'proxy-policy-cap' });
}
assert.throws(
  () => issueMediaProxyGrant('hls', 'https://media.example.com/cap/overflow.m3u8', '', { sessionId: 'proxy-policy-cap' }),
  /单会话临时授权数量已达上限/,
);
revokeMediaProxySession('proxy-policy-cap');

const roomBudgetSessions = [];
let remainingRoomBudget = mediaProxyGrantLimits.perRoom;
for (let sessionIndex = 0; remainingRoomBudget > 0; sessionIndex += 1) {
  const sessionId = `proxy-policy-room-cap-${sessionIndex}`;
  roomBudgetSessions.push(sessionId);
  registerMediaProxySession(sessionId, 'ROOM-SHARED-CAP', `member-room-${sessionIndex}`, proxyPolicyClientBinding);
  const grantCount = Math.min(mediaProxyGrantLimits.perSession, remainingRoomBudget);
  for (let index = 0; index < grantCount; index += 1) {
    issueMediaProxyGrant('hls', `https://media.example.com/room-cap/${sessionIndex}/${index}.m3u8`, '', { sessionId });
  }
  remainingRoomBudget -= grantCount;
}
assert.throws(
  () => issueMediaProxyGrant('hls', 'https://media.example.com/room-cap/overflow.m3u8', '', { sessionId: roomBudgetSessions.at(-1) }),
  /当前房间临时授权数量已达上限/,
  'multiple anonymous sessions in one room must share one bounded grant budget',
);
roomBudgetSessions.forEach(revokeMediaProxySession);

const clientBudgetSessions = [];
let remainingClientBudget = mediaProxyGrantLimits.perClient;
for (let sessionIndex = 0; remainingClientBudget > 0; sessionIndex += 1) {
  const sessionId = `proxy-policy-client-cap-${sessionIndex}`;
  clientBudgetSessions.push(sessionId);
  registerMediaProxySession(sessionId, `ROOM-CLIENT-${sessionIndex}`, `member-client-${sessionIndex}`, proxyPolicyClientBinding);
  const grantCount = Math.min(mediaProxyGrantLimits.perSession, remainingClientBudget);
  for (let index = 0; index < grantCount; index += 1) {
    issueMediaProxyGrant('hls', `https://media.example.com/client-cap/${sessionIndex}/${index}.m3u8`, '', { sessionId });
  }
  remainingClientBudget -= grantCount;
}
registerMediaProxySession('proxy-policy-client-overflow', 'ROOM-CLIENT-OVERFLOW', 'member-client-overflow', proxyPolicyClientBinding);
assert.throws(
  () => issueMediaProxyGrant('hls', 'https://media.example.com/client-cap/overflow.m3u8', '', { sessionId: 'proxy-policy-client-overflow' }),
  /当前客户端临时授权数量已达上限/,
  'one anonymous client must not exhaust the global grant pool through many sessions or rooms',
);
[...clientBudgetSessions, 'proxy-policy-client-overflow'].forEach(revokeMediaProxySession);

const serverRoot = process.cwd();

async function isPortClosed(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`);
    return false;
  } catch (error) {
    return true;
  }
}

async function pickTestPort(base) {
  for (let offset = 0; offset < 80; offset += 1) {
    const port = base + offset;
    if (await isPortClosed(port)) return port;
  }
  throw new Error('failed to find a closed local test port');
}

async function verifyRoomSessionGrantLifecycle() {
  const port = await pickTestPort(45640);
  const app = express();
  app.use('/api', proxyRouter);
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    const malformedBareParent = await fetch(`http://127.0.0.1:${port}/api/proxy?token=unused`);
    assert.equal(malformedBareParent.status, 404, 'a bare proxy parent path must not reach a token endpoint');
    const malformedTrailingSlash = await fetch(`http://127.0.0.1:${port}/api/proxy/media/?token=unused`);
    assert.equal(malformedTrailingSlash.status, 404, 'a trailing-slash proxy alias must not reach the canonical token endpoint');
    const malformedCase = await fetch(`http://127.0.0.1:${port}/api/proxy/MEDIA?token=unused`);
    assert.equal(malformedCase.status, 404, 'a case-variant proxy alias must not reach the canonical token endpoint');

    assert.throws(
      () => issueMediaProxyGrant('hls', 'https://media.example.com/video.m3u8'),
      /会话|浼氳瘽/,
      'the lower-level grant API must reject an empty room session',
    );
    registerMediaProxySession('proxy-session-a', 'ROOM-A', 'member-a', proxyPolicyClientBinding);
    const grant = issueMediaProxyGrant(
      'hls',
      'https://media.example.com/video.m3u8',
      '',
      { sessionId: 'proxy-session-a' },
    );
    const wrongClientResponse = await fetch(`http://127.0.0.1:${port}${grant.proxyUrl}`, {
      headers: { 'user-agent': 'different-client' },
    });
    assert.equal(wrongClientResponse.status, 401, 'a bearer grant must remain bound to the issuing client context');
    const activeController = new AbortController();
    const detachController = attachMediaProxySessionAbortController('proxy-session-a', activeController);
    assert.equal(typeof detachController, 'function', 'an active room session should accept an in-flight proxy controller');
    revokeMediaProxySession('proxy-session-a');
    assert.equal(activeController.signal.aborted, true, 'revoking a room session must abort its in-flight proxy stream');
    detachController?.();
    const revokedResponse = await fetch(`http://127.0.0.1:${port}${grant.proxyUrl}`, { headers: { 'user-agent': proxyPolicyUserAgent } });
    assert.equal(revokedResponse.status, 401, 'revoking a room session must invalidate previously issued media grants');

    registerMediaProxySession('proxy-session-b', 'ROOM-A', 'member-a', proxyPolicyClientBinding);
    suspendMediaProxySession('proxy-session-b', 0);
    assert.throws(
      () => issueMediaProxyGrant('hls', 'https://media.example.com/video.m3u8', '', { sessionId: 'proxy-session-b' }),
      /会话已失效/,
      'an expired reconnect grace must prevent new proxy grants',
    );

    registerMediaProxySession('proxy-session-c', 'ROOM-A', 'member-c', proxyPolicyClientBinding);
    suspendMediaProxySession('proxy-session-c', 10_000);
    const graceGrant = issueMediaProxyGrant(
      'hls',
      'https://media.example.com/video.m3u8',
      '',
      { sessionId: 'proxy-session-c' },
    );
    assert.match(graceGrant.proxyUrl, /^\/api\/proxy\/hls\?token=/, 'a transient disconnect should keep grants usable during reconnect grace');
    revokeMediaProxySession('proxy-session-c');

    registerMediaProxySession('proxy-session-old', 'ROOM-A', 'member-d', proxyPolicyClientBinding);
    const supersededGrant = issueMediaProxyGrant(
      'hls',
      'https://media.example.com/video.m3u8',
      '',
      { sessionId: 'proxy-session-old' },
    );
    registerMediaProxySession('proxy-session-new', 'ROOM-A', 'member-d', proxyPolicyClientBinding);
    const supersededResponse = await fetch(`http://127.0.0.1:${port}${supersededGrant.proxyUrl}`, { headers: { 'user-agent': proxyPolicyUserAgent } });
    assert.equal(supersededResponse.status, 401, 'a successful member reconnect must revoke grants from the superseded socket session');
    revokeMediaProxySession('proxy-session-new');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function verifyInFlightSessionRevocation() {
  const port = await pickTestPort(45740);
  let upstreamAbortCount = 0;
  const injectedRouter = createMediaProxyRouter(async (_req, targetUrl, _refUrl, signal) => {
    const upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = { 'content-type': 'video/mp4' };
    const timer = setInterval(() => upstream.write(Buffer.alloc(1024, 1)), 10);
    const stop = () => clearInterval(timer);
    upstream.once('close', stop);
    signal.addEventListener('abort', () => {
      upstreamAbortCount += 1;
      stop();
      const error = new Error('session revoked');
      error.name = 'AbortError';
      upstream.destroy(error);
    }, { once: true });
    return { response: upstream, responseUrl: targetUrl };
  });
  const app = express();
  app.use('/api', injectedRouter);
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    const iterations = runtimeEnv.hlsProxyMaxConcurrentPerClient + 1;
    for (let index = 0; index < iterations; index += 1) {
      const sessionId = `proxy-session-stream-${index}`;
      registerMediaProxySession(sessionId, 'ROOM-STREAM', `member-stream-${index}`, proxyPolicyClientBinding);
      const grant = issueMediaProxyGrant(
        'media',
        `https://media.example.com/slow-video-${index}.mp4`,
        '',
        { sessionId },
      );
      const response = await fetch(`http://127.0.0.1:${port}${grant.proxyUrl}`, {
        headers: { 'user-agent': proxyPolicyUserAgent },
      });
      assert.equal(response.status, 200, 'each revoked stream must release its client concurrency slot');
      const reader = response.body.getReader();
      const firstChunk = await reader.read();
      assert.equal(firstChunk.done, false, 'the injected upstream must begin streaming before revocation');
      revokeMediaProxySession(sessionId);
      await sleep(25);
      await reader.read().catch(() => ({ done: true }));
    }
    assert.equal(upstreamAbortCount, iterations, 'revoking sessions must abort every real proxy route stream');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function verifyHlsRewriteFailsClosed() {
  const port = await pickTestPort(45780);
  const injectedRouter = createMediaProxyRouter(async (_req, targetUrl) => {
    const upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = { 'content-type': 'application/vnd.apple.mpegurl' };
    upstream.end('#EXTM3U\n#EXTINF:5,\nhttps://media.example.com/valid-before-private.ts\n#EXTINF:5,\nhttp://127.0.0.1/private-segment.ts\n');
    return { response: upstream, responseUrl: targetUrl };
  });
  const app = express();
  app.use('/api', injectedRouter);
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    registerMediaProxySession('proxy-session-hls-closed', 'ROOM-HLS-CLOSED', 'member-hls-closed', proxyPolicyClientBinding);
    const grant = issueMediaProxyGrant(
      'hls',
      'https://media.example.com/master.m3u8',
      '',
      { sessionId: 'proxy-session-hls-closed' },
    );
    const usageBefore = getMediaProxyGrantUsage('proxy-session-hls-closed');
    const response = await fetch(`http://127.0.0.1:${port}${grant.proxyUrl}`, {
      headers: { 'user-agent': proxyPolicyUserAgent },
    });
    const body = await response.text();
    assert.equal(response.status, 502, 'a rejected HLS child target must fail the whole rewrite');
    assert.equal(body.includes('127.0.0.1'), false, 'a rejected child URI must never be returned to the browser');
    assert.deepEqual(
      getMediaProxyGrantUsage('proxy-session-hls-closed'),
      usageBefore,
      'a mixed valid/private manifest failure must not retain grants created earlier in the rewrite',
    );
  } finally {
    revokeMediaProxySession('proxy-session-hls-closed');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function verifyHlsRewriteGrantReuse() {
  const port = await pickTestPort(45820);
  const playlist = `#EXTM3U\n${Array.from(
    { length: mediaProxyGrantLimits.perHlsManifest },
    (_, index) => `#EXTINF:5,\nhttps://media.example.com/reused/${index}.ts`,
  ).join('\n')}\n`;
  const injectedRouter = createMediaProxyRouter(async (_req, targetUrl) => {
    const upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = { 'content-type': 'application/vnd.apple.mpegurl' };
    upstream.end(playlist);
    return { response: upstream, responseUrl: targetUrl };
  });
  const app = express();
  app.use('/api', injectedRouter);
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    const sessionId = 'proxy-session-hls-reuse';
    registerMediaProxySession(sessionId, 'ROOM-HLS-REUSE', 'member-hls-reuse', proxyPolicyClientBinding);
    const grant = issueMediaProxyGrant(
      'hls',
      'https://media.example.com/reused-master.m3u8',
      '',
      { sessionId },
    );
    for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
      const response = await fetch(`http://127.0.0.1:${port}${grant.proxyUrl}`, {
        headers: { 'user-agent': proxyPolicyUserAgent },
      });
      const body = await response.text();
      assert.equal(response.status, 200, 'an identical maximum-size HLS manifest must remain reloadable');
      assert.equal(body.includes('media.example.com/reused/'), false, 'rewritten HLS must not expose child targets');
      assert.equal(
        getMediaProxyGrantUsage(sessionId).session,
        1 + mediaProxyGrantLimits.perHlsManifest,
        'reloading an identical manifest must reuse child grants without consuming more capacity',
      );
    }
  } finally {
    revokeMediaProxySession('proxy-session-hls-reuse');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function verifyHlsNormalizedTargetDedupe() {
  const port = await pickTestPort(45920);
  const playlist = '#EXTM3U\n#EXTINF:5,\nhttps://MEDIA.EXAMPLE.com:443/same.ts#first\n#EXTINF:5,\nhttps://media.example.com/same.ts#second\n';
  const injectedRouter = createMediaProxyRouter(async (_req, targetUrl) => {
    const upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = { 'content-type': 'application/vnd.apple.mpegurl' };
    upstream.end(playlist);
    return { response: upstream, responseUrl: targetUrl };
  });
  const app = express();
  app.use('/api', injectedRouter);
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    const sessionId = 'proxy-session-hls-normalized';
    registerMediaProxySession(sessionId, 'ROOM-HLS-NORMALIZED', 'member-hls-normalized', proxyPolicyClientBinding);
    const grant = issueMediaProxyGrant('hls', 'https://media.example.com/normalized-master.m3u8', '', { sessionId });
    const response = await fetch(`http://127.0.0.1:${port}${grant.proxyUrl}`, {
      headers: { 'user-agent': proxyPolicyUserAgent },
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    const childTokens = [...body.matchAll(/\/api\/proxy\/hls\?token=([^\r\n]+)/g)].map((match) => match[1]);
    assert.equal(childTokens.length, 2);
    assert.equal(childTokens[0], childTokens[1], 'equivalent final target URLs must reuse one child grant');
    assert.equal(getMediaProxyGrantUsage(sessionId).session, 2, 'normalized duplicates must count as one child grant');
  } finally {
    revokeMediaProxySession('proxy-session-hls-normalized');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function verifyHlsRollingManifestReclaimsStaleGrants() {
  const port = await pickTestPort(46020);
  const windowSize = 8;
  let manifestIndex = 0;
  const injectedRouter = createMediaProxyRouter(async (_req, targetUrl) => {
    const firstSegment = manifestIndex;
    manifestIndex += 1;
    const upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = { 'content-type': 'application/vnd.apple.mpegurl' };
    upstream.end(`#EXTM3U\n${Array.from(
      { length: windowSize },
      (_, offset) => `#EXTINF:2,\nhttps://media.example.com/live/${firstSegment + offset}.ts`,
    ).join('\n')}\n`);
    return { response: upstream, responseUrl: targetUrl };
  });
  const app = express();
  app.use('/api', injectedRouter);
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    const sessionId = 'proxy-session-hls-rolling';
    registerMediaProxySession(sessionId, 'ROOM-HLS-ROLLING', 'member-hls-rolling', proxyPolicyClientBinding);
    const grant = issueMediaProxyGrant('hls', 'https://media.example.com/live.m3u8', '', { sessionId });
    for (let requestIndex = 0; requestIndex < mediaProxyGrantLimits.perSession + 32; requestIndex += 1) {
      const response = await fetch(`http://127.0.0.1:${port}${grant.proxyUrl}`, {
        headers: { 'user-agent': proxyPolicyUserAgent },
      });
      assert.equal(response.status, 200, `rolling manifest refresh ${requestIndex} must remain authorized`);
      await response.arrayBuffer();
      assert.equal(
        getMediaProxyGrantUsage(sessionId).session,
        1 + windowSize + (requestIndex === 0 ? 0 : 1),
        'a rolling manifest must retain only the current window and one outgoing-generation grace grant',
      );
    }
  } finally {
    revokeMediaProxySession('proxy-session-hls-rolling');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function verifyHlsLargeRollingWindowsReuseReclaimableCapacity() {
  const port = await pickTestPort(46070);
  const windowSize = 500;
  let manifestIndex = 0;
  const injectedRouter = createMediaProxyRouter(async (_req, targetUrl) => {
    if (targetUrl.pathname.endsWith('.ts')) {
      const segment = new PassThrough();
      segment.statusCode = 200;
      segment.headers = { 'content-type': 'video/mp2t' };
      segment.end('segment');
      return { response: segment, responseUrl: targetUrl };
    }
    const generation = manifestIndex;
    manifestIndex += 1;
    const manifestWindowSize = generation === 3 ? 900 : windowSize;
    const upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = { 'content-type': 'application/vnd.apple.mpegurl' };
    upstream.end(`#EXTM3U\n${Array.from(
      { length: manifestWindowSize },
      (_, offset) => `#EXTINF:2,\nhttps://media.example.com/large-live/${generation}/${offset}.ts`,
    ).join('\n')}\n`);
    return { response: upstream, responseUrl: targetUrl };
  });
  const app = express();
  app.use('/api', injectedRouter);
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    const sessionId = 'proxy-session-hls-large-rolling';
    registerMediaProxySession(sessionId, 'ROOM-HLS-LARGE-ROLLING', 'member-hls-large-rolling', proxyPolicyClientBinding);
    const grant = issueMediaProxyGrant('hls', 'https://media.example.com/large-live.m3u8', '', { sessionId });
    let outgoingGraceUrl = '';
    for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
      const response = await fetch(`http://127.0.0.1:${port}${grant.proxyUrl}`, {
        headers: { 'user-agent': proxyPolicyUserAgent },
      });
      assert.equal(response.status, 200, `large rolling manifest refresh ${requestIndex} must reclaim stale grace capacity`);
      const body = await response.text();
      if (requestIndex === 1) outgoingGraceUrl = body.match(/\/api\/proxy\/hls\?token=[^\r\n]+/)?.[0] || '';
      assert.equal(
        getMediaProxyGrantUsage(sessionId).session,
        1 + windowSize + (requestIndex === 0 ? 0 : windowSize),
        'large rolling manifests must retain only the current and one outgoing generation',
      );
    }
    const rejected = await fetch(`http://127.0.0.1:${port}${grant.proxyUrl}`, {
      headers: { 'user-agent': proxyPolicyUserAgent },
    });
    assert.equal(rejected.status, 502, 'an oversized next generation must fail without committing');
    assert.ok(outgoingGraceUrl, 'the prior successful generation must expose a rewritten child URL');
    assert.equal(
      getMediaProxyGrantUsage(sessionId).session,
      1 + (windowSize * 2),
      'a failed preflight must retain the last successful current and grace generations',
    );
    const graceResponse = await fetch(`http://127.0.0.1:${port}${outgoingGraceUrl}`, {
      headers: { 'user-agent': proxyPolicyUserAgent },
    });
    assert.equal(graceResponse.status, 200, 'a failed preflight must not revoke the prior grace generation');
    assert.equal(await graceResponse.text(), 'segment');
  } finally {
    revokeMediaProxySession('proxy-session-hls-large-rolling');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await verifyRoomSessionGrantLifecycle();
await verifyInFlightSessionRevocation();
await verifyHlsRewriteFailsClosed();
await verifyHlsRewriteGrantReuse();
await verifyHlsNormalizedTargetDedupe();
await verifyHlsRollingManifestReclaimsStaleGrants();
await verifyHlsLargeRollingWindowsReuseReclaimableCapacity();

async function waitForHealth(baseUrl, getExitCode) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const exitCode = getExitCode();
    if (exitCode !== null) throw new Error(`server process exited before health check passed: ${exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const body = await response.json();
      if (response.ok && body.ok === true) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw lastError || new Error('server health check did not become ready');
}

async function withServer(env, run) {
  const port = await pickTestPort(env.portBase);
  const baseUrl = `http://127.0.0.1:${port}`;
  const storeFile = path.join(serverRoot, 'data', `verify-proxy-policy-${Date.now()}-${port}.json`);
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: env.nodeEnv || 'test',
      PORT: String(port),
      PUBLIC_ORIGIN: env.publicOrigin || '*',
      ROOM_STORE_FILE: storeFile,
      ROOM_STORE_WRITE_DELAY_MS: '10',
      PARSE_RATE_LIMIT_PER_MINUTE: '0',
      HLS_PROXY_ENABLED: 'true',
      HLS_PROXY_RATE_LIMIT_PER_MINUTE: String(env.rateLimit),
      HLS_PROXY_ALLOWED_HOSTS: env.allowedHosts || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let childExitCode = null;
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  child.once('exit', (code, signal) => {
    childExitCode = signal || code;
  });

  try {
    await waitForHealth(baseUrl, () => childExitCode);
    await run(baseUrl);
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    if (childExitCode === null) child.kill('SIGTERM');
  }
}

async function getProxy(baseUrl, url, headers = {}, route = 'hls') {
  const response = await fetch(`${baseUrl}/api/proxy/${route}?url=${encodeURIComponent(url)}`, { headers });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

await withServer({
  portBase: 45780,
  rateLimit: 0,
  allowedHosts: 'media.example.com,*.cdn.example.com',
  publicOrigin: 'https://allowed.example',
}, async (baseUrl) => {
  const blockedHost = await getProxy(baseUrl, 'https://blocked.example.com/video.m3u8');
  assert.equal(blockedHost.response.status, 400);
  assert.equal(blockedHost.body.message, '授权解析失败');

  const privateHost = await getProxy(baseUrl, 'http://127.0.0.1/private.m3u8');
  assert.equal(privateHost.response.status, 400);
  assert.equal(privateHost.body.message, '授权解析失败');

  const privateMedia = await getProxy(baseUrl, 'http://127.0.0.1/private.mp4', {}, 'media');
  assert.equal(privateMedia.response.status, 400);
  assert.equal(privateMedia.body.message, '授权解析失败');

  const deniedOrigin = await getProxy(baseUrl, 'http://127.0.0.1/private.m3u8', {
    origin: 'https://denied.example',
  });
  assert.equal(deniedOrigin.response.headers.get('access-control-allow-origin'), null, 'proxy responses must follow PUBLIC_ORIGIN');
});

await withServer({ portBase: 45880, rateLimit: 1, allowedHosts: '' }, async (baseUrl) => {
  const firstResponse = await fetch(`${baseUrl}/api/proxy/hls?token=invalid-token`, { headers: {
    'x-forwarded-for': '198.51.100.1, 203.0.113.10, 192.0.2.20',
  } });
  assert.equal(firstResponse.status, 401);

  const secondResponse = await fetch(`${baseUrl}/api/proxy/hls?token=another-invalid-token`, { headers: {
    'x-forwarded-for': '198.51.100.99, 203.0.113.10, 192.0.2.20',
  } });
  assert.equal(secondResponse.status, 429);
  assert.match((await secondResponse.json()).message || '', /频繁/);
});

const productionPolicy = spawnSync(process.execPath, ['--input-type=module', '--eval', `
  process.env.NODE_ENV = 'production';
  process.env.HLS_PROXY_ALLOWED_HOSTS = '';
  const { recordVerifiedDirectMediaUrl } = await import('./dist/services/parser.service.js');
  const { createMediaProxyClientBinding, issueMediaProxyGrant, registerMediaProxySession, toPublicMediaGrantFailure } = await import('./dist/routes/proxy.routes.js');
  try {
    issueMediaProxyGrant('hls', 'https://media.example.com/video.m3u8');
    process.exit(2);
  } catch (error) {
    const failure = toPublicMediaGrantFailure(error);
    if (failure.code !== 'parse_option_missing' || failure.message !== '未配置解析项') process.exit(3);
  }
  recordVerifiedDirectMediaUrl('https://93.184.216.34/video.m3u8?token=exact', 'hls');
  try {
    issueMediaProxyGrant('hls', 'https://93.184.216.34/video.m3u8?token=exact');
    process.exit(4);
  } catch (error) {
    const failure = toPublicMediaGrantFailure(error);
    if (failure.code !== 'parse_option_missing') process.exit(5);
  }
  registerMediaProxySession('production-policy-direct', 'ROOM-PROD', 'member-prod', createMediaProxyClientBinding('203.0.113.9', 'production-policy-test'));
  const directGrant = issueMediaProxyGrant(
    'hls',
    'https://93.184.216.34/video.m3u8?token=exact',
    '',
    { allowVerifiedDirect: true, sessionId: 'production-policy-direct' },
  );
  if (!directGrant.proxyUrl.startsWith('/api/proxy/hls?token=')) process.exit(6);
  try {
    issueMediaProxyGrant('hls', 'https://93.184.216.34/video.m3u8?token=changed', '', { allowVerifiedDirect: true, sessionId: 'production-policy-direct' });
    process.exit(7);
  } catch (error) {
    const failure = toPublicMediaGrantFailure(error);
    if (failure.code !== 'parse_option_missing') process.exit(8);
  }
`], { cwd: serverRoot, env: { ...process.env, NODE_ENV: 'production', HLS_PROXY_ALLOWED_HOSTS: '' }, encoding: 'utf8' });
assert.equal(productionPolicy.status, 0, productionPolicy.stderr || productionPolicy.stdout || 'production proxy policy worker failed');

console.log('proxy policy verification passed');
