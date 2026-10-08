import { recordVerifiedDirectMediaUrl } from '../../dist/services/parser.service.js';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

// Admit a syntactically public playlist URL, but deterministically fail its media
// probe. This tests legacy bypass parameters without DNS or external traffic.
const originalRequest = https.request;
https.request = function (input, ...args) {
  if (String(input) === 'https://93.184.216.34/public-unverified.mp4') {
    const request = new PassThrough();
    request.setTimeout = () => request;
    queueMicrotask(() => request.destroy(Object.assign(new Error('Synthetic unverified media'), { code: 'ECONNRESET' })));
    return request;
  }
  return originalRequest.call(this, input, ...args);
};
syncBuiltinESMExports();

recordVerifiedDirectMediaUrl('https://93.184.216.34/verified-room-video.mp4?token=exact', 'video');
recordVerifiedDirectMediaUrl('https://93.184.216.34/verified-room-stream.m3u8?token=exact', 'hls');

const originalFetch = globalThis.fetch.bind(globalThis);
const testBvid = 'BV1182FBRExJ';
const testCid = 33755434897;

globalThis.fetch = async function (input, init) {
  const target = String(input);
  if (target.startsWith('https://api.bilibili.com/x/web-interface/view?')) {
    return new Response(JSON.stringify({
      code: 0,
      data: {
        bvid: testBvid,
        title: 'Socket Refresh Fixture',
        duration: 226,
        state: 0,
        cid: testCid,
        pages: [{ cid: testCid, page: 1, part: 'Socket Refresh Fixture', duration: 226 }],
        rights: { pay: 0, ugc_pay: 0 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (target.startsWith('https://api.bilibili.com/x/player/playurl?')) {
    return new Response(JSON.stringify({
      code: 0,
      data: {
        quality: 80,
        format: 'mp4',
        durl: [{ url: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/socket-refreshed.mp4?deadline=fresh' }],
        support_formats: [{ quality: 80, new_description: '1080P 高清' }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return originalFetch(input, init);
};
