import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import config from '../playwright.config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const input = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) || path.join(root, '..', '\u7d20\u6750', '\u95ee\u53f7\u7d20\u6750.mp4'));
const assetId = process.argv.find(arg => arg.startsWith('--asset='))?.slice(8) || 'question';
if (!['question', 'lightning', 'explosion', 'questions', 'danger', 'tnt'].includes(assetId)) throw new Error('Unknown asset ID');
const output = path.join(root, 'assets/interactions', assetId);
const diagnostics = path.join(root, 'server/.artifacts/interactions', assetId);
const outputFile = name => name.startsWith('qa/') ? path.join(diagnostics, name) : path.join(output, name);
const inspectOnly = process.argv.includes('--inspect');
const presets = {
  // A few debris pixels leave the original bottom edge; preserve that source boundary.
  tnt: { crop: { x: 140, y: 65, width: 1000, height: 655 }, width: 280, height: 184, columns: 8, start: 0, duration: 2.8, posterFrame: 8, redWeight: 0.5, fadeOut: 0.25, format: 'webp', quality: 0.9, allowEdges: true },
  lightning: { crop: { x: 480, y: 0, width: 960, height: 1080 }, width: 224, height: 252, columns: 8, start: 0, duration: 2, posterFrame: 8, allowEdges: true, redWeight: 0.7, fadeOut: 0.12 },
  explosion: { crop: { x: 220, y: 0, width: 800, height: 720 }, width: 240, height: 216, columns: 6, start: 0, duration: 1.45, posterFrame: 16, redWeight: 0.8, fadeOut: 0.08 },
  questions: { crop: { x: 0, y: 0, width: 1920, height: 1080 }, width: 240, height: 135, columns: 8, start: 0, duration: 2.7, posterFrame: 20, allowEdges: true, redWeight: 0.85, format: 'webp', quality: 0.85 },
  danger: { crop: { x: 240, y: 60, width: 380, height: 390 }, width: 224, height: 230, columns: 8, start: 0, duration: 3, posterFrame: 8, redWeight: 0.1, fadeOut: 0.2 },
};
const preset = presets[assetId];
const source = await fs.readFile(input);
const sourceSha256 = createHash('sha256').update(source).digest('hex');
function boxes(start, end) {
  const result = [];
  for (let offset = start; offset + 8 <= end;) {
    let size = source.readUInt32BE(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new Error('Truncated MP4 box');
      size = Number(source.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) size = end - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > end) throw new Error('Unsupported MP4 box');
    result.push({ type: source.toString('ascii', offset + 4, offset + 8), start: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}
const children = (box) => boxes(box.start, box.end);
const moov = boxes(0, source.length).find((box) => box.type === 'moov');
const sourceVideo = children(moov).filter((box) => box.type === 'trak').map((track) => {
  const mdia = children(track).find((box) => box.type === 'mdia');
  const parts = children(mdia);
  const handler = parts.find((box) => box.type === 'hdlr');
  if (source.toString('ascii', handler.start + 8, handler.start + 12) !== 'vide') return null;
  const mdhd = parts.find((box) => box.type === 'mdhd');
  if (source[mdhd.start] !== 0) throw new Error('Unsupported MP4 timing version');
  const timescale = source.readUInt32BE(mdhd.start + 12);
  const ticks = source.readUInt32BE(mdhd.start + 16);
  const stbl = children(parts.find((box) => box.type === 'minf')).find((box) => box.type === 'stbl');
  const stsz = children(stbl).find((box) => box.type === 'stsz');
  const frames = source.readUInt32BE(stsz.start + 8);
  return { frames, duration: ticks / timescale, fps: frames * timescale / ticks };
}).find(Boolean);
if (!inspectOnly) await fs.mkdir(output, { recursive: true });
await fs.mkdir(path.join(diagnostics, 'qa'), { recursive: true });
const server = http.createServer((req, res) => {
  if (req.url === '/source.mp4') {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), source.length - 1) : source.length - 1;
    if (start > end || start >= source.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${source.length}` }).end();
      return;
    }
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${source.length}` } : {}),
    });
    res.end(source.subarray(start, end + 1));
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body></body></html>');
  } else {
    res.writeHead(404).end();
  }
});
let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  browser = await chromium.launch({ ...config.use.launchOptions, headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async ({ inspectOnly, preset }) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = '/source.mp4';
    document.body.append(video);
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('Video decoding failed'));
    });
    const seek = async (time) => {
      if (Math.abs(video.currentTime - time) > 0.00001) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Seek timeout: ${time}`)), 10000);
          video.onseeked = () => { clearTimeout(timeout); resolve(); };
          video.currentTime = time;
        });
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };
    const canvas = (width, height) => Object.assign(document.createElement('canvas'), { width, height });
    const raw = canvas(video.videoWidth, video.videoHeight);
    const ctx = raw.getContext('2d', { willReadFrequently: true });
    const samples = 16;
    const thumbWidth = 320;
    const thumbHeight = Math.round(thumbWidth * raw.height / raw.width);
    const contact = canvas(thumbWidth * 4, (thumbHeight + 24) * 4);
    const cc = contact.getContext('2d');
    const timestamps = [];
    for (let i = 0; i < samples; i++) {
      const time = i * (video.duration - 0.04) / (samples - 1);
      await seek(time);
      timestamps.push(time);
      ctx.drawImage(video, 0, 0);
      const x = i % 4 * thumbWidth;
      const y = Math.floor(i / 4) * (thumbHeight + 24);
      cc.drawImage(raw, x, y, thumbWidth, thumbHeight);
      cc.fillStyle = '#222';
      cc.fillRect(x, y + thumbHeight, thumbWidth, 24);
      cc.fillStyle = '#fff';
      cc.font = '16px sans-serif';
      cc.fillText(`${time.toFixed(3)} s`, x + 8, y + thumbHeight + 18);
    }
    await seek(video.duration / 2);
    ctx.drawImage(video, 0, 0);
    const metadata = { sourceWidth: raw.width, sourceHeight: raw.height, sourceDuration: video.duration, timestamps };
    const files = { 'qa/source-contact.png': contact.toDataURL(), 'qa/source-midpoint.png': raw.toDataURL() };
    if (inspectOnly) return { metadata, files };
    if (!preset && (raw.width !== 1280 || raw.height !== 720 || video.duration > 3)) {
      throw new Error('This inspected crop is specific to the supplied 1280x720 short source');
    }
    // The logo occupies the top-right corner; this fixed crop retains the entrance from y=0.
    const crop = preset?.crop || { x: 400, y: 0, width: 336, height: 640 };
    if (crop.x + crop.width > raw.width || crop.y + crop.height > raw.height) throw new Error('Crop exceeds source');
    const width = preset?.width || 168;
    const height = preset?.height || 320;
    const fps = 20;
    const frames = Math.round((preset?.duration || Math.ceil(video.duration * fps) / fps) * fps);
    const columns = preset?.columns || 7;
    const duration = frames / fps;
    const start = preset?.start || 0;
    const posterFrame = preset?.posterFrame ?? 14;
    if (frames < 1 || frames > 256 || duration > 3 || width > 2048 || height > 2048 || start + duration > video.duration + 1 / fps) throw new Error('Invalid output budget or timing');
    const sheet = canvas(width * columns, height * Math.ceil(frames / columns));
    const sheetCtx = sheet.getContext('2d');
    const keyed = canvas(crop.width, crop.height);
    const kc = keyed.getContext('2d', { willReadFrequently: true });
    const tile = canvas(width, height);
    const tc = tile.getContext('2d', { willReadFrequently: true });
    const preview = canvas(width * columns, (height + 24) * Math.ceil(frames / columns));
    const pc = preview.getContext('2d');
    const sourceFrames = canvas(preview.width, preview.height);
    const sc = sourceFrames.getContext('2d');
    const frameStats = [];
    let initialBackground;
    for (let frame = 0; frame < frames; frame++) {
      const time = Math.min(start + frame / fps, video.duration - 0.001);
      await seek(time);
      ctx.drawImage(video, 0, 0);
      // A source corner stays clear in these inspected clips, even with tight output crops.
      const corner = ctx.getImageData(raw.width - 12, raw.height - 12, 8, 8).data;
      let background = [0, 1, 2].map(ch => Array.from({ length: 64 }, (_, i) => corner[i * 4 + ch]).sort((a, b) => a - b)[32]);
      initialBackground ||= background;
      if (background.some((value, ch) => Math.abs(value - initialBackground[ch]) > 50)) background = initialBackground;
      const redWeight = preset?.redWeight ?? 1;
      const backgroundExcess = background[1] - (background[0] * redWeight + background[2] * (1 - redWeight));
      if (frame === 5 || frame === 35) {
        ctx.drawImage(video, 0, 0);
        files[`qa/source-frame-${frame}.png`] = raw.toDataURL();
      }
      kc.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
      sc.drawImage(keyed, frame % columns * width, Math.floor(frame / columns) * (height + 24), width, height);
      const pixels = kc.getImageData(0, 0, crop.width, crop.height);
      const data = pixels.data;
      for (let p = 0; p < data.length; p += 4) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const excess = g - (preset ? r * redWeight + b * (1 - redWeight) : Math.max(r, b));
        const alpha = preset
          ? Math.max(0, Math.min(1, (backgroundExcess - excess - 10) / Math.max(1, backgroundExcess - 35)))
          : Math.max(0, Math.min(1, (125 - excess) / 95));
        data[p + 3] = Math.round(255 * alpha);
        if (alpha === 0) {
          data[p] = data[p + 1] = data[p + 2] = 0;
        } else if (preset) {
          // Unmix the measured screen color before despill, preserving translucent glows.
          for (let ch = 0; ch < 3; ch++) data[p + ch] = Math.max(0, Math.min(255, Math.round((data[p + ch] - (1 - alpha) * background[ch]) / alpha)));
          data[p + 1] = Math.min(data[p + 1], Math.round(data[p] * redWeight + data[p + 2] * (1 - redWeight)));
        } else {
          // Suppress green spill without recoloring the orange interior.
          data[p + 1] = Math.min(g, Math.round(r * 0.85 + b * 0.15));
        }
      }
      kc.putImageData(pixels, 0, 0);
      tc.clearRect(0, 0, width, height);
      tc.imageSmoothingEnabled = true;
      tc.imageSmoothingQuality = 'high';
      tc.drawImage(keyed, 0, 0, width, height);
      const tilePixels = tc.getImageData(0, 0, width, height);
      if (preset) {
        for (let p = 0; p < tilePixels.data.length; p += 4) {
          const d = tilePixels.data;
          d[p + 1] = Math.min(d[p + 1], Math.round(d[p] * redWeight + d[p + 2] * (1 - redWeight)));
        }
        tc.putImageData(tilePixels, 0, 0);
      }
      const x = frame % columns * width;
      const y = Math.floor(frame / columns) * height;
      sheetCtx.drawImage(tile, x, y);
      const py = Math.floor(frame / columns) * (height + 24);
      pc.fillStyle = frame % 2 ? '#eeeeee' : '#20242b';
      pc.fillRect(x, py, width, height);
      pc.drawImage(tile, x, py);
      pc.fillStyle = '#444';
      pc.fillRect(x, py + height, width, 24);
      pc.fillStyle = '#fff';
      pc.font = '14px sans-serif';
      pc.fillText(`${frame}: ${time.toFixed(2)} s`, x + 6, py + height + 17);
      sc.fillStyle = '#444';
      sc.fillRect(x, py + height, width, 24);
      sc.fillStyle = '#fff';
      sc.font = '14px sans-serif';
      sc.fillText(`${frame}: ${time.toFixed(2)} s`, x + 6, py + height + 17);
      const tileData = tc.getImageData(0, 0, width, height).data;
      let visiblePixels = 0, edgePixels = 0, sidePixels = 0, greenPixels = 0;
      for (let p = 0; p < tileData.length; p += 4) {
        if (tileData[p + 3] < 8) continue;
        visiblePixels++;
        const px = p / 4 % width, py = Math.floor(p / 4 / width);
        if (px === 0 || px === width - 1 || py === height - 1) edgePixels++;
        if (px === 0 || px === width - 1) sidePixels++;
        if (tileData[p + 1] > Math.max(tileData[p], tileData[p + 2]) + 12) greenPixels++;
      }
      frameStats.push({ frame, time, visiblePixels, edgePixels, sidePixels, greenPixels });
      if (frame === posterFrame) files['poster.png'] = tile.toDataURL();
    }
    const visualFormat = preset?.format || 'png';
    const visualData = sheet.toDataURL(`image/${visualFormat}`, preset?.quality);
    if (!visualData.startsWith(`data:image/${visualFormat};base64,`)) throw new Error('Requested image encoder unavailable');
    files[`spritesheet.${visualFormat}`] = visualData;
    files['qa/keyed-contact.png'] = preview.toDataURL();
    files['qa/source-cropped-contact.png'] = sourceFrames.toDataURL();
    const audioContext = new AudioContext({ sampleRate: 44100 });
    let audio;
    try {
      audio = await audioContext.decodeAudioData(await (await fetch('/source.mp4')).arrayBuffer());
    } finally {
      await audioContext.close();
    }
    const channels = audio.numberOfChannels;
    const sourceAudioEnvelope = Array.from({ length: Math.ceil(audio.duration * 10) }, (_, bin) => {
      let sum = 0, count = 0;
      for (let ch = 0; ch < channels; ch++) {
        const data = audio.getChannelData(ch);
        for (let i = Math.floor(bin * audio.sampleRate / 10); i < Math.min(data.length, Math.floor((bin + 1) * audio.sampleRate / 10)); i++) { sum += data[i] ** 2; count++; }
      }
      return { time: bin / 10, rms: Math.sqrt(sum / Math.max(1, count)) };
    });
    const sampleRate = audio.sampleRate;
    const sampleCount = Math.round(duration * sampleRate);
    const buffer = new ArrayBuffer(44 + sampleCount * channels * 2);
    const view = new DataView(buffer);
    const ascii = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true);
    ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, buffer.byteLength - 44, true);
    let peak = 0, sumSquares = 0, firstNonSilentSample = -1, lastNonSilentSample = -1;
    for (let i = 0; i < sampleCount; i++) {
      for (let ch = 0; ch < channels; ch++) {
        const sourceIndex = Math.round(start * sampleRate) + i;
        const original = sourceIndex < audio.length ? audio.getChannelData(ch)[sourceIndex] : 0;
        const fadeSamples = Math.round(sampleRate * 0.008);
        const gain = preset ? Math.min(1, i / fadeSamples, (sampleCount - 1 - i) / Math.round(sampleRate * (preset.fadeOut || 0.008))) : 1;
        const value = original * gain;
        peak = Math.max(peak, Math.abs(value));
        sumSquares += value * value;
        if (Math.abs(value) > 0.001) {
          if (firstNonSilentSample < 0) firstNonSilentSample = i;
          lastNonSilentSample = i;
        }
        const clamped = Math.max(-1, Math.min(1, value));
        view.setInt16(44 + (i * channels + ch) * 2, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
      }
    }
    if (peak === 0) throw new Error('Decoded audio is silent');
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    files['audio.wav'] = `data:audio/wav;base64,${btoa(binary)}`;
    Object.assign(metadata, {
      width, height, columns, frames, duration, fps, crop, start, visualFormat, visualQuality: preset?.quality ?? null,
      sheetWidth: sheet.width, sheetHeight: sheet.height, posterFrame,
      audio: { channels, sampleRate, bitsPerSample: 16, samples: sampleCount, duration,
        decodedDuration: audio.duration, peak, rms: Math.sqrt(sumSquares / (sampleCount * channels)),
        firstNonSilentTime: firstNonSilentSample / sampleRate, lastNonSilentTime: lastNonSilentSample / sampleRate },
      frameStats, sourceAudioEnvelope,
    });
    return { metadata, files };
  }, { inspectOnly, preset });
  // Keep inspection evidence even when a crop fails; publish no asset until validation passes.
  for (const [name, data] of Object.entries(result.files)) {
    if (name.startsWith('qa/')) await fs.writeFile(outputFile(name), Buffer.from(data.split(',')[1], 'base64'));
  }
  await fs.writeFile(path.join(diagnostics, 'inspection.json'), JSON.stringify(result.metadata, null, 2));
  if (!inspectOnly) {
    if (result.metadata.frameStats.every(frame => frame.visiblePixels === 0)) throw new Error('Empty animation');
    if (result.metadata.frameStats.some(frame => frame.greenPixels || (!preset?.allowEdges && frame.edgePixels))) throw new Error('Crop/key validation failed');
    if (assetId === 'lightning' && result.metadata.frameStats.some(frame => frame.sidePixels)) throw new Error('Lightning clipped horizontally');
    for (const [name, data] of Object.entries(result.files)) {
      if (name.startsWith('qa/')) continue;
      const limit = name.endsWith('.wav') ? 1024 * 1024 : 8 * 1024 * 1024;
      if (Buffer.from(data.split(',')[1], 'base64').length > limit) throw new Error(`File budget exceeded: ${name}`);
      if (preset && name.startsWith('spritesheet.') && Buffer.from(data.split(',')[1], 'base64').length > 1024 * 1024) throw new Error(`Prewarm budget exceeded: ${name} (${Buffer.from(data.split(',')[1], 'base64').length} bytes)`);
    }
  }
  for (const [name, data] of Object.entries(result.files)) {
    await fs.writeFile(outputFile(name), Buffer.from(data.split(',')[1], 'base64'));
  }
  result.metadata.sourceSha256 = sourceSha256;
  result.metadata.sourceBytes = source.length;
  result.metadata.sourceVideo = sourceVideo;
  if (preset && !inspectOnly) {
    const { width, height, columns, frames, duration } = result.metadata;
    result.metadata.recommendedCatalog = {
      id: assetId, label: { lightning: '\u95ea\u7535', explosion: '\u7206\u70b8', questions: '\u6ee1\u5c4f\u95ee\u53f7', danger: '\u5371' }[assetId],
      type: 'sprite', src: `/assets/interactions/${assetId}/spritesheet.${result.metadata.visualFormat}`,
      poster: `/assets/interactions/${assetId}/poster.png`, audio: `/assets/interactions/${assetId}/audio.wav`,
      durationMs: Math.round(duration * 1000), width, height, columns, frames,
    };
    result.metadata.selectionReason = {
      lightning: 'Keep the visible strike and its fade through 2s, removing the blank visual tail and fading the shortened audio over its final 120ms. Source top/bottom boundary contact is preserved.',
      explosion: 'Select the first burst through the following blank frames, excluding the repeated bursts after 1.45s. The source burst resets abruptly rather than fading.',
      questions: `Keep the complete question cascade through its fade; exclude the source black tail. Transparent WebP quality ${preset.quality} at ${width}x${height} targets the 1MiB prewarm budget and a roughly 240px-wide display. The older PNG was archived to ignored server/.artifacts/interactions/questions/qa/large-original-spritesheet.png and is not referenced by the catalog.`,
      danger: 'The glyph is visible only from 0 to 1s; frames from 1 to 3s are intentionally transparent for the original sound decay, without holding, stretching or looping the glyph. Trim the remaining 0.877s and fade the final 200ms. The smaller sprite targets the 1MiB prewarm budget.',
    }[assetId];
    const visible = result.metadata.frameStats.filter(frame => frame.visiblePixels > 0);
    result.metadata.visualTiming = {
      firstVisibleMs: Math.round(visible[0].time * 1000),
      lastVisibleFrameMs: Math.round(visible.at(-1).time * 1000),
      visibleEndMs: Math.round((visible.at(-1).time + 1 / result.metadata.fps) * 1000),
      transparentTailMs: Math.round((duration - (visible.at(-1).time + 1 / result.metadata.fps)) * 1000),
      tailPurpose: assetId === 'danger' ? 'Intentional sound decay only; no visible glyph.' : 'Source timing; no extended audio-only hold.',
    };
  }
  result.metadata.fileBytes = Object.fromEntries(await Promise.all(Object.keys(result.files).map(async (name) => [name, (await fs.stat(outputFile(name))).size])));
  if (!inspectOnly) {
    if (result.metadata.frameStats.every((frame) => frame.visiblePixels === 0)) throw new Error('Empty animation');
    result.metadata.qualityNotes = preset ? [
      'Screen color sampled per frame; soft alpha, background unmixing and green despill applied before downsampling.',
      'Source-boundary contact is intentional for lightning, full-frame questions and TNT debris at the original bottom edge; other crops must have clear side/bottom edges.',
      `PCM audio uses the same source interval, 8ms fade-in and ${Math.round((preset.fadeOut || 0.008) * 1000)}ms fade-out; source level retained, not listening-verified.`,
      `${result.metadata.visualFormat.toUpperCase()}/WAV avoids alpha-video dependence; physical Safari/mobile playback has not been tested.`,
    ] : [
      'Top-right text and bilibili watermark excluded geometrically by crop x=400..735, y=0..639.',
      'Source already has blocky ghosting near 0.25s and broken contours during its final fade; these are not repaired.',
      'Thin circular strokes retain some gray-brown fringing and may lose subpixel detail after keying/downsampling.',
      'Top-edge clipping during entrance is present in the source; crop retains y=0.',
      'Audio is non-silent stereo PCM, original low level retained without gain; not listening-verified.',
      'Output holds 42 frames at 20fps; first and final blank frames intentionally preserve source timing.',
      'Audio decoder returned 2.072676s; padded with silence to the 2.1s animation duration.',
      'PNG/WAV avoids alpha-video dependence; Safari device playback has not been tested.',
    ];
    await fs.writeFile(path.join(diagnostics, 'metadata.json'), JSON.stringify(result.metadata, null, 2) + '\n');
  }
  if (createHash('sha256').update(await fs.readFile(input)).digest('hex') !== sourceSha256) throw new Error('Source changed during processing');
  const { timestamps, frameStats, sourceAudioEnvelope, ...summary } = result.metadata;
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
