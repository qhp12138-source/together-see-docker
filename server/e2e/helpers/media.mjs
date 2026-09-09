import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';

const FIXTURE_URL = new URL('../fixtures/together-see-e2e.webm', import.meta.url);
const FIXTURE_SHA256 = '5f00e381c3b14f35b507d201540661fd8481ccd7b2f6f4222c5da9f9172896ad';
const FIXTURE_BYTES = fs.readFileSync(FIXTURE_URL);
const FIXTURE_SEGMENT_ID = Buffer.from([0x18, 0x53, 0x80, 0x67]);
const FIXTURE_CLUSTER_ID = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
const FIXTURE_CLUSTER_DURATION_MS = 2186;
const fixtureDigest = createHash('sha256').update(FIXTURE_BYTES).digest('hex');

if (fixtureDigest !== FIXTURE_SHA256) {
  throw new Error(`E2E media fixture checksum mismatch: ${fixtureDigest}`);
}

export function loadFixtureWebM({ name }) {
  const buffer = Buffer.from(FIXTURE_BYTES);
  expect(buffer.byteLength).toBeGreaterThan(1024);
  return { name, mimeType: 'video/webm', buffer };
}

function encodeEbmlSize(value) {
  for (let length = 1; length <= 8; length += 1) {
    const maxValue = (2 ** (7 * length)) - 2;
    if (value > maxValue) continue;
    const bytes = Buffer.alloc(length);
    let remainder = value;
    for (let index = length - 1; index >= 0; index -= 1) {
      bytes[index] = remainder & 0xff;
      remainder = Math.floor(remainder / 256);
    }
    bytes[0] |= 1 << (8 - length);
    return bytes;
  }
  throw new Error(`EBML size is too large: ${value}`);
}

function createVoidElement(payloadBytes) {
  if (!payloadBytes) return Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from([0xec]),
    encodeEbmlSize(payloadBytes),
    Buffer.alloc(payloadBytes),
  ]);
}

function createDurationElement(durationMs) {
  const payload = Buffer.alloc(8);
  payload.writeDoubleBE(durationMs);
  return Buffer.concat([Buffer.from([0x44, 0x89, 0x88]), payload]);
}

export function buildRepeatedFixtureWebM({
  name,
  durationSeconds,
  paddingBytesPerCluster = 0,
}) {
  const requestedDurationMs = Math.max(FIXTURE_CLUSTER_DURATION_MS, Math.ceil(Number(durationSeconds) * 1000));
  const repeatCount = Math.ceil(requestedDurationMs / FIXTURE_CLUSTER_DURATION_MS);
  const lastClusterTimecode = (repeatCount - 1) * FIXTURE_CLUSTER_DURATION_MS;
  if (lastClusterTimecode > 0xffffff) {
    throw new Error('Repeated E2E fixture exceeds the supported 24-bit WebM cluster timecode');
  }

  const segmentOffset = FIXTURE_BYTES.indexOf(FIXTURE_SEGMENT_ID);
  const clusterOffset = FIXTURE_BYTES.indexOf(FIXTURE_CLUSTER_ID);
  if (segmentOffset < 0) throw new Error('E2E fixture WebM segment was not found');
  if (clusterOffset < 0) throw new Error('E2E fixture WebM cluster was not found');
  const ebmlHeader = FIXTURE_BYTES.subarray(0, segmentOffset);
  const segmentContentOffset = segmentOffset + 12;
  const infoId = FIXTURE_BYTES.subarray(segmentContentOffset, segmentContentOffset + 4);
  const infoSizeByte = FIXTURE_BYTES[segmentContentOffset + 4];
  if (!infoId.equals(Buffer.from([0x15, 0x49, 0xa9, 0x66])) || (infoSizeByte & 0x80) !== 0x80) {
    throw new Error('E2E fixture WebM info layout changed');
  }
  const infoPayloadSize = infoSizeByte & 0x7f;
  const infoPayloadStart = segmentContentOffset + 5;
  const infoPayloadEnd = infoPayloadStart + infoPayloadSize;
  const infoPayload = FIXTURE_BYTES.subarray(infoPayloadStart, infoPayloadEnd);
  const tracks = FIXTURE_BYTES.subarray(infoPayloadEnd, clusterOffset);
  const sourceCluster = FIXTURE_BYTES.subarray(clusterOffset);
  const timecodeOffset = 12;
  if (!sourceCluster.subarray(timecodeOffset, timecodeOffset + 3).equals(Buffer.from([0xe7, 0x81, 0x00]))) {
    throw new Error('E2E fixture WebM cluster timecode layout changed');
  }

  const clusterBeforeTimecode = sourceCluster.subarray(0, timecodeOffset);
  const clusterAfterTimecode = sourceCluster.subarray(timecodeOffset + 3);
  const clusterPayloadPrefix = clusterBeforeTimecode.subarray(12);
  const padding = createVoidElement(Math.max(0, Number(paddingBytesPerCluster) || 0));
  const clusters = Array.from({ length: repeatCount }, (_, index) => {
    const timecode = index * FIXTURE_CLUSTER_DURATION_MS;
    const payload = Buffer.concat([
      clusterPayloadPrefix,
      Buffer.from([0xe7, 0x83, (timecode >>> 16) & 0xff, (timecode >>> 8) & 0xff, timecode & 0xff]),
      clusterAfterTimecode,
      padding,
    ]);
    return Buffer.concat([FIXTURE_CLUSTER_ID, encodeEbmlSize(payload.byteLength), payload]);
  });
  const expectedDurationMs = repeatCount * FIXTURE_CLUSTER_DURATION_MS;
  const durationElement = createDurationElement(expectedDurationMs);
  const info = Buffer.concat([
    infoId,
    encodeEbmlSize(infoPayload.byteLength + durationElement.byteLength),
    infoPayload,
    durationElement,
  ]);
  const segmentContent = Buffer.concat([info, tracks, ...clusters]);
  const buffer = Buffer.concat([
    ebmlHeader,
    FIXTURE_SEGMENT_ID,
    encodeEbmlSize(segmentContent.byteLength),
    segmentContent,
  ]);
  expect(buffer.byteLength).toBeGreaterThan((sourceCluster.byteLength - 12) * repeatCount);
  return {
    name,
    mimeType: 'video/webm',
    buffer,
    expectedDurationSeconds: expectedDurationMs / 1000,
    repeatCount,
  };
}

export function mediaResponse(buffer, mimeType, rangeHeader, maxChunkBytes = 0) {
  const total = buffer.byteLength;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader || '');
  const chunkLimit = Math.max(0, Number(maxChunkBytes) || 0);
  if (!match && !chunkLimit) {
    return {
      status: 200,
      body: buffer,
      headers: {
        'accept-ranges': 'bytes',
        'access-control-allow-origin': '*',
        'content-length': String(total),
        'content-type': mimeType,
      },
    };
  }

  const start = match ? Math.min(Number(match[1]), Math.max(0, total - 1)) : 0;
  const requestedEnd = match?.[2] ? Number(match[2]) : total - 1;
  const limitedEnd = chunkLimit ? Math.min(requestedEnd, start + chunkLimit - 1) : requestedEnd;
  const end = Math.min(Math.max(start, limitedEnd), total - 1);
  const body = buffer.subarray(start, end + 1);
  return {
    status: 206,
    body,
    headers: {
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      'content-length': String(body.byteLength),
      'content-range': `bytes ${start}-${end}/${total}`,
      'content-type': mimeType,
    },
  };
}

export async function installRemoteWebMFixture(context, {
  inputUrl,
  mediaUrl,
  title,
  buffer,
  mimeType = 'video/webm',
  mockParser = false,
  parserResult,
  networkProfile,
  onMediaRequest,
}) {
  let mediaRequestChain = Promise.resolve();
  const readNetworkProfile = () => {
    const profile = typeof networkProfile === 'function' ? networkProfile() : networkProfile;
    return profile && typeof profile === 'object' ? profile : {};
  };
  const waitForNetworkProfile = async () => {
    let profile = readNetworkProfile();
    while (profile.blocked === true) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      profile = readNetworkProfile();
    }
    const delayMs = Math.max(0, Number(profile.delayMs) || 0);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return profile;
  };

  await context.route(mediaUrl, async (route) => {
    const serve = async () => {
      const profile = await waitForNetworkProfile();
      const rangeHeader = route.request().headers().range;
      const response = mediaResponse(buffer, mimeType, rangeHeader, profile.maxChunkBytes);
      onMediaRequest?.({
        rangeHeader: rangeHeader || '',
        status: response.status,
        bytes: response.body.byteLength,
        contentRange: response.headers['content-range'] || '',
      });
      await route.fulfill(response);
    };
    if (!networkProfile) {
      await serve();
      return;
    }
    const pending = mediaRequestChain.then(serve);
    mediaRequestChain = pending.catch(() => {});
    await pending;
  });

  if (!mockParser) return;
  await context.route('**/api/parse*', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const payload = route.request().postDataJSON();
    if (payload?.url !== inputUrl) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        success: true,
        src: mediaUrl,
        type: 'video',
        title,
        pageUrl: mediaUrl,
        finalUrl: mediaUrl,
        refererUrl: mediaUrl,
        requiresClientParse: false,
        message: 'E2E WebM fixture',
        ...(parserResult || {}),
      }),
    });
  });
}
