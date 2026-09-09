import assert from 'node:assert/strict';

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
assert.equal(
  classifyMediaProbe(Buffer.from('<!doctype html><html>not media</html>'), 'video/mp4', 'https://cdn.example.com/fake.mp4'),
  null,
  'HTML mislabeled as video must fail the probe',
);

console.log('parser sniffing verification passed');
