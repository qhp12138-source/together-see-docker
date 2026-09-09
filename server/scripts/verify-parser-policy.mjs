import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.PARSE_MAX_RESPONSE_BYTES = '32';

const { assertPublicHttpUrl, isBlockedRemoteIpAddress } = await import('../dist/utils/remote-url.js');
const {
  classifyMediaProbe,
  isVerifiedDirectMediaUrl,
  parseVideoUrl,
  readRemoteText,
  recordVerifiedDirectMediaUrl,
} = await import('../dist/services/parser.service.js');

assert.equal(isBlockedRemoteIpAddress('127.0.0.1'), true);
assert.equal(isBlockedRemoteIpAddress('169.254.169.254'), true);
assert.equal(isBlockedRemoteIpAddress('::1'), true);
assert.equal(isBlockedRemoteIpAddress('::ffff:127.0.0.1'), true);
assert.equal(isBlockedRemoteIpAddress('10.20.30.40'), true);
assert.equal(isBlockedRemoteIpAddress('8.8.8.8'), false);
assert.throws(() => assertPublicHttpUrl('http://localhost/private-page'), /内网|本机/);
assert.throws(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data'), /内网|本机/);
assert.throws(() => assertPublicHttpUrl('http://user:password@example.com/page'), /用户名|密码/);

const mp4Header = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.alloc(20),
]);
assert.equal(classifyMediaProbe(mp4Header, 'video/mp4', 'https://direct.example/media'), 'video');
assert.equal(
  classifyMediaProbe(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n'), 'application/vnd.apple.mpegurl', 'https://direct.example/media'),
  'hls',
);
assert.equal(
  classifyMediaProbe(Buffer.from('<!doctype html><video></video>'), 'video/mp4', 'https://direct.example/media.mp4'),
  null,
  'an HTML response must not be accepted only because its URL or Content-Type claims video',
);

const verifiedDirectUrl = 'https://direct.example/media.mp4?token=exact#player';
recordVerifiedDirectMediaUrl(verifiedDirectUrl, 'video');
assert.equal(isVerifiedDirectMediaUrl('https://direct.example/media.mp4?token=exact', 'video'), true);
assert.equal(isVerifiedDirectMediaUrl('https://direct.example/media.mp4?token=changed', 'video'), false);
assert.equal(isVerifiedDirectMediaUrl('https://direct.example/media.mp4?token=exact', 'hls'), false);
assert.throws(() => recordVerifiedDirectMediaUrl('http://127.0.0.1/private.mp4', 'video'), /内网|本机/);
assert.throws(() => recordVerifiedDirectMediaUrl('https://example.com:8443/private.mp4', 'video'), /标准 HTTP\/HTTPS 端口/);

await assert.rejects(
  parseVideoUrl('http://127.0.0.1/private-page', { force: true }),
  /内网|本机/,
  'the parser must reject loopback targets before opening a connection',
);
await assert.rejects(
  parseVideoUrl('file:///etc/passwd', { force: true }),
  /仅支持 http \/ https/,
  'non-HTTP media inputs must be rejected before probing',
);
await assert.rejects(
  parseVideoUrl('http://[::1]/private-page', { force: true }),
  /内网|本机/,
  'the parser must reject IPv6 loopback targets',
);
await assert.rejects(
  parseVideoUrl('http://127.0.0.1/private.mp4', { force: true }),
  /内网|本机/,
  'direct video URLs must not bypass the public-address policy',
);
await assert.rejects(
  parseVideoUrl('http://169.254.169.254/latest/meta-data/video.m3u8', { force: true }),
  /内网|本机/,
  'direct HLS URLs must not bypass the public-address policy',
);
await assert.rejects(
  parseVideoUrl('https://example.com:8443/video.mp4', { force: true }),
  /标准 HTTP\/HTTPS 端口/,
  'the public parser must not be usable as an arbitrary port scanner',
);

let malformedBilibiliFetchCalls = 0;
const malformedBilibiliFetch = async (url) => {
  malformedBilibiliFetchCalls += 1;
  if (String(url).includes('/x/web-interface/view')) {
    return new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected parser policy URL: ${url}`);
};
const classifiedBilibiliFailure = await parseVideoUrl('https://www.bilibili.com/video/BV1182FBRExJ', {
  force: true,
  fetchImpl: malformedBilibiliFetch,
});
assert.equal(classifiedBilibiliFailure.success, false);
assert.equal(classifiedBilibiliFailure.code, 'bilibili_upstream_payload_invalid');
assert.equal(classifiedBilibiliFailure.recoverable, true);
assert.equal(classifiedBilibiliFailure.retryAfterMs, 5_000);
assert.equal(classifiedBilibiliFailure.requiresClientParse, false, 'classified Bilibili failures must not start generic parser retry loops');
const cooledDownBilibiliFailure = await parseVideoUrl('https://www.bilibili.com/video/BV1182FBRExJ', {
  force: true,
  fetchImpl: async () => {
    throw new Error('a classified Bilibili cooldown must suppress immediate forced retries');
  },
});
assert.equal(cooledDownBilibiliFailure.code, 'bilibili_upstream_payload_invalid');
assert.equal(malformedBilibiliFetchCalls, 1, 'a recoverable Bilibili failure should honor retryAfterMs even for force parsing');

const oversized = Readable.from([Buffer.alloc(33)]);
oversized.headers = {};
await assert.rejects(readRemoteText(oversized), /响应过大/);

console.log('parser policy verification passed');
