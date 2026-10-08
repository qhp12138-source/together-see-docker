import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';

const { classifyMediaProbe, extractMediaPage } = await import('../dist/services/parser.service.js');

function findCandidate(page, suffix) {
  return page.candidates.find((candidate) => candidate.url.includes(suffix));
}

const native = extractMediaPage(`
  <html><head><title>Native sample</title></head><body>
    <picture><source src="/poster.mp4"></picture>
    <video src="/movie.mp4">
      <source src="/master.m3u8" type="application/vnd.apple.mpegurl">
    </video>
  </body></html>
`, 'https://media.example.com/watch/42');
assert.equal(native.title, 'Native sample');
assert.equal(findCandidate(native, '/movie.mp4')?.type, 'video');
assert.equal(findCandidate(native, '/master.m3u8')?.type, 'hls');
assert.equal(native.candidates.some((candidate) => candidate.url.endsWith('/poster.mp4')), false, 'picture sources are not video sources');
assert.equal(native.candidates[0].url, 'https://media.example.com/movie.mp4');

const openGraph = extractMediaPage(`
  <meta property="og:title" content="Open Graph title">
  <meta property="og:video:type" content="video/mp4">
  <meta property="og:video" content="http://cdn.example.com/movie.mp4">
  <meta property="og:video:secure_url" content="https://cdn.example.com/movie.mp4">
`, 'https://media.example.com/watch/og');
assert.equal(openGraph.title, 'Open Graph title');
assert.equal(openGraph.candidates[0].url, 'https://cdn.example.com/movie.mp4', 'HTTPS Open Graph video should rank first');

const jsonLd = extractMediaPage(`
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"VideoObject","name":"Structured movie","duration":"PT1H2M3.5S","contentUrl":"/structured/movie.mp4","embedUrl":"/embed/42"}
  </script>
`, 'https://media.example.com/watch/jsonld');
assert.equal(jsonLd.title, 'Structured movie');
assert.equal(jsonLd.duration, 3723.5);
assert.equal(findCandidate(jsonLd, '/structured/movie.mp4')?.type, 'video');
assert.deepEqual(jsonLd.nestedPages, ['https://media.example.com/embed/42']);

const twitter = extractMediaPage(`
  <meta name="twitter:card" content="player">
  <meta name="twitter:player:stream" content="//cdn.example.com/twitter/video">
  <meta name="twitter:player:stream:content_type" content="video/mp4">
  <meta name="twitter:player" content="/player/twitter">
`, 'https://media.example.com/watch/twitter');
assert.equal(twitter.candidates[0].url, 'https://cdn.example.com/twitter/video');
assert.equal(twitter.candidates[0].type, 'video');
assert.deepEqual(twitter.nestedPages, ['https://media.example.com/player/twitter']);

const playerConfigs = extractMediaPage(`
  <script>
    jwplayer('screen').setup({image:'/poster.jpg', sources:[{file:'https:\\/\\/cdn.example.com\\/jw\\/movie.mp4?sig=a%2Fb%26c%3Dd'}]});
    const hls = new Hls(); hls.loadSource('/live/master.m3u8?token=x%2Fy%26z%3D1');
  </script>
`, 'https://media.example.com/watch/config');
assert.ok(findCandidate(playerConfigs, '/jw/movie.mp4'));
assert.equal(
  findCandidate(playerConfigs, '/jw/movie.mp4')?.url,
  'https://cdn.example.com/jw/movie.mp4?sig=a%2Fb%26c%3Dd',
  'signed URL percent encoding must remain byte-for-byte intact',
);
assert.equal(findCandidate(playerConfigs, '/live/master.m3u8')?.type, 'hls');
assert.equal(playerConfigs.candidates.some((candidate) => candidate.url.includes('poster.jpg')), false);

const hydration = extractMediaPage(`
  <script id="__NEXT_DATA__" type="application/json">
    {"props":{"pageProps":{"avatar":{"url":"https://cdn.example.com/avatar.jpg"},"video":{"contentUrl":"https://cdn.example.com/next/movie.webm"}}}}
  </script>
`, 'https://media.example.com/watch/next');
assert.equal(hydration.candidates.length, 1);
assert.equal(hydration.candidates[0].url, 'https://cdn.example.com/next/movie.webm');

for (const navigationKey of ['url_next', 'url_pre', 'url_prev']) {
  for (const key of [navigationKey, `"${navigationKey}"`, `'${navigationKey}'`]) {
    const episode = extractMediaPage(`<script>var player_aaaa={
      ${key}: "https:\\/\\/cdn.example.com\\/other-episode.m3u8",
      "url": "https:\\/\\/cdn.example.com\\/current.m3u8?sig=a%2Fb%26c%3Dd"
    };</script>`, 'https://media.example.com/watch/episode');
    assert.deepEqual(episode.candidates.map(candidate => candidate.url), [
      'https://cdn.example.com/current.m3u8?sig=a%2Fb%26c%3Dd',
    ], 'episode navigation URLs must not be current-media candidates');
  }
}
const sharedEpisodeUrl = extractMediaPage(`<script>var player_aaaa={
  "url_next":"https://cdn.example.com/shared.m3u8",
  "url":"https://cdn.example.com/shared.m3u8"
};</script>`, 'https://media.example.com/watch/shared');
assert.equal(sharedEpisodeUrl.candidates.length, 1, 'skip navigation declarations, not independently declared current URLs');

const nested = extractMediaPage(`
  <iframe class="advert" src="https://ads.example.com/embed/ad"></iframe>
  <iframe id="video-player" src="/embed/player/42"></iframe>
`, 'https://media.example.com/watch/iframe');
assert.deepEqual(nested.nestedPages, ['https://media.example.com/embed/player/42']);

const dashFallback = extractMediaPage(`
  <video>
    <source src="/manifest.mpd" type="application/dash+xml">
    <source src="/fallback.mp4" type="video/mp4">
  </video>
`, 'https://media.example.com/watch/dash');
assert.equal(dashFallback.candidates[0].type, 'video', 'playable MP4 must outrank unsupported DASH');
assert.equal(dashFallback.candidates.some((candidate) => candidate.type === 'dash'), true);

const protectedMedia = extractMediaPage(`
  <script type="application/json">
    {"video":{"sources":[{"src":"https://cdn.example.com/protected.mp4","drm":{"widevine":{"licenseUrl":"https://license.example.com"}}}]}}
  </script>
`, 'https://media.example.com/watch/drm');
assert.equal(protectedMedia.protectedMediaDetected, true);
assert.equal(protectedMedia.candidates.length, 0, 'DRM-bound candidates must not be returned');

const ordinaryLicenseText = extractMediaPage(`
  <p>This freely available clip is licensed under Creative Commons.</p>
  <video src="/creative-commons.mp4"></video>
`, 'https://media.example.com/watch/creative-commons');
assert.equal(ordinaryLicenseText.protectedMediaDetected, false, 'ordinary copyright license text is not a DRM signal');
assert.equal(ordinaryLicenseText.candidates.length, 1);

assert.equal(
  classifyMediaProbe(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n'), 'text/plain', 'https://cdn.example.com/master.m3u8'),
  'hls',
);
assert.equal(
  classifyMediaProbe(Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n'), 'application/vnd.apple.mpegurl', 'https://cdn.example.com/master.m3u8'),
  null,
  'SAMPLE-AES protected HLS must be rejected',
);
assert.equal(
  classifyMediaProbe(Buffer.from('<?xml version="1.0"?><MPD><ContentProtection /></MPD>'), 'application/dash+xml', 'https://cdn.example.com/manifest.mpd'),
  null,
);

const mp4Header = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
assert.equal(classifyMediaProbe(mp4Header, 'application/octet-stream', 'https://cdn.example.com/video'), 'video');
for (const mime of ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/json', 'application/problem+json']) {
  assert.equal(classifyMediaProbe(mp4Header, mime, 'https://cdn.example.com/clip.mp4'), null, `non-media MIME ${mime} must not be verified`);
}
for (const body of ['<!-- CDN error -->\n<html>Access denied</html>', 'Access denied: this CDN request is forbidden', '["upstream unavailable"]']) {
  for (const mime of ['text/html', 'video/mp4', 'application/octet-stream', 'text/plain']) {
    assert.equal(classifyMediaProbe(Buffer.from(body), mime, 'https://cdn.example.com/clip.mp4'), null, 'a suffix and MIME do not establish actual media bytes');
  }
}
assert.equal(
  classifyMediaProbe(Buffer.from('<!doctype html><html>not media</html>'), 'video/mp4', 'https://cdn.example.com/fake.mp4'),
  null,
  'HTML mislabeled as video must fail the probe',
);

// Exercise the real page -> probe path without depending on a third-party site.
const { parseVideoUrl, isVerifiedDirectMediaUrl } = await import('../dist/services/parser.service.js');
const originalRequest = https.request;
const pageUrl = 'https://8.8.8.8/watch/fixture';
const mediaUrl = 'https://1.1.1.1/public/master.m3u8?signature=exact';
const requests = [];
https.request = (target, options, callback) => {
  const url = String(target);
  requests.push({ url, headers: options.headers });
  const request = new EventEmitter();
  request.end = () => queueMicrotask(() => {
    if (url.includes('socket-closed')) {
      request.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      return;
    }
    const isPage = url.startsWith(pageUrl);
    const rejected = url.includes('rejected');
    const body = isPage
      ? `<script>var player_data={"url":"${mediaUrl}${rejected ? '&rejected=1' : ''}${url.includes('body-reset') ? '&body-reset=1' : ''}"${url.includes('episode-navigation') ? `,"url_next":"${mediaUrl}&next-episode=1"` : ''}};</script>`
      : rejected || url.includes('invalid-media') ? '<!-- CDN error -->\n<html>Access denied</html>'
        : '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n3000k/hls/mixed.m3u8\n';
    const response = !isPage && url.includes('body-reset')
      ? new Readable({ read() { this.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })); } })
      : Readable.from([Buffer.from(body)]);
    response.statusCode = !isPage && rejected ? 403 : 200;
    response.headers = { 'content-type': isPage ? 'text/html' : 'application/vnd.apple.mpegurl' };
    if (url.includes('private-redirect')) {
      response.statusCode = 302;
      response.headers.location = 'http://127.0.0.1/private.m3u8';
    }
    callback(response);
  });
  return request;
};
syncBuiltinESMExports();
try {
  const parsed = await parseVideoUrl(pageUrl, { force: true });
  assert.equal(parsed.success, true);
  assert.equal(parsed.src, mediaUrl);
  assert.equal(parsed.type, 'hls');
  assert.equal(requests.length, 2, 'one page fetch and one bounded media probe');
  assert.equal(requests[1].headers.range, 'bytes=0-4095');
  assert.equal(requests[1].headers.referer, pageUrl);
  assert.equal(isVerifiedDirectMediaUrl(mediaUrl, 'hls'), true, 'validated page media must reuse its probe');
  assert.equal(isVerifiedDirectMediaUrl(`${mediaUrl}&changed=1`, 'hls'), false);
  assert.equal(isVerifiedDirectMediaUrl(pageUrl, 'hls'), false, 'a webpage is never a verified media target');
  const denied = await parseVideoUrl(`${pageUrl}?rejected=1`, { force: true });
  assert.equal(denied.success, false);
  assert.equal(denied.code, 'parse_upstream_http_403');
  assert.equal(denied.browserDirectCandidate, undefined, 'a blocked webpage must not become a browser media candidate');
  assert.equal(isVerifiedDirectMediaUrl(`${mediaUrl}&rejected=1`, 'hls'), false);
  const beforeEpisodeNavigation = requests.length;
  const rejectedEpisode = await parseVideoUrl(`${pageUrl}?rejected=1&episode-navigation=1`, { force: true });
  assert.equal(rejectedEpisode.success, false, 'a rejected current episode must not silently play the next episode');
  assert.equal(rejectedEpisode.code, 'parse_upstream_http_403');
  assert.equal(requests.length - beforeEpisodeNavigation, 2, 'only the page and current media may be requested');
  assert.equal(requests.some(request => request.url.includes('next-episode')), false);
  assert.equal(isVerifiedDirectMediaUrl(`${mediaUrl}&next-episode=1`, 'hls'), false);
  const resetPage = `${pageUrl}?body-reset=1`;
  const resetFailure = await parseVideoUrl(resetPage, { force: true });
  assert.equal(resetFailure.code, 'parse_upstream_socket_closed', 'body-read errors retain their classification across candidate selection');
  assert.equal(resetFailure.browserDirectCandidate, undefined);
  assert.equal(isVerifiedDirectMediaUrl(`${mediaUrl}&body-reset=1`, 'hls'), false);
  const resetCount = requests.length;
  await parseVideoUrl(resetPage, { force: true });
  assert.equal(requests.length, resetCount);
  for (const [suffix, code] of [
    ['rejected', 'parse_upstream_http_403'],
    ['socket-closed', 'parse_upstream_socket_closed'],
    ['invalid-media', 'parse_media_invalid'],
  ]) {
    const url = `https://1.1.1.1/${suffix}/master.m3u8`;
    const failure = await parseVideoUrl(url, { force: true });
    assert.equal(failure.success, false);
    assert.equal(failure.code, code);
    assert.equal(failure.requiresClientParse, false);
    assert.equal(failure.retryAfterMs, 5000);
    assert.deepEqual(failure.browserDirectCandidate, { url, type: 'hls' }, 'an explicit public direct URL is only a browser candidate, never server-verified media');
    assert.equal(isVerifiedDirectMediaUrl(url, 'hls'), false);
    const count = requests.length;
    const repeated = await parseVideoUrl(url, { force: true });
    assert.equal(repeated.code, code);
    assert.equal(requests.length, count, 'forced retries must respect upstream failure cooldown');
  }
  const errorPageMp4 = 'https://1.1.1.1/invalid-media/clip.mp4';
  const unverifiedMp4 = await parseVideoUrl(errorPageMp4, { force: true });
  assert.equal(unverifiedMp4.success, false);
  assert.equal(unverifiedMp4.code, 'parse_media_invalid');
  assert.deepEqual(unverifiedMp4.browserDirectCandidate, { url: errorPageMp4, type: 'video' });
  assert.equal(isVerifiedDirectMediaUrl(errorPageMp4, 'video'), false, '200 commented HTML must not become a proxy-verifiable video');
  await assert.rejects(parseVideoUrl('https://1.1.1.1/private-redirect.m3u8', { force: true }), /内网|本机/);
  const beforePrivate = requests.length;
  await assert.rejects(parseVideoUrl('https://127.0.0.1/rejected.m3u8', { force: true }), /内网|本机/);
  assert.equal(requests.length, beforePrivate, 'private targets never receive browser fallback candidates or a network request');
} finally {
  https.request = originalRequest;
  syncBuiltinESMExports();
}

console.log('parser sniffing verification passed');
