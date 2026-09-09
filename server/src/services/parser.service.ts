import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { load } from 'cheerio';
import { env } from '../config/env.js';
import {
  isBilibiliVideoUrl,
  parseBilibiliVideo,
  toBilibiliPublicError,
} from './bilibili.service.js';
import type { ParsedVideoSource, SourceType } from '../types/room.js';
import { assertPublicHttpUrl, resolvePublicAddress } from '../utils/remote-url.js';

const DIRECT_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.m4v', '.mkv', '.flv'];
const HLS_EXTENSIONS = ['.m3u8'];
const DASH_EXTENSIONS = ['.mpd'];
const PARSE_CACHE = new Map<string, { expiresAt: number; result: ParsedVideoSource }>();
const IN_FLIGHT_PARSES = new Map<string, Promise<ParsedVideoSource>>();
const VERIFIED_DIRECT_MEDIA = new Map<string, { expiresAt: number; type: 'hls' | 'video' }>();
const MAX_PARSE_REDIRECTS = 5;
const MAX_PARSE_HTTP_TRANSACTIONS = 10;
const MAX_PARSE_DOCUMENTS = 2;
const MAX_MEDIA_CANDIDATES = 24;
const MAX_NESTED_PAGE_CANDIDATES = 4;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 5000;
const MEDIA_PROBE_BYTES = 4096;

const DYNAMIC_PARSE_HOST_KEYWORDS = [
  'jx.',
  'jx-',
  'parse',
  'player',
  'xmflv',
  'jsonplayer',
  'm3u8',
];

const DEVICE_BOUND_SOURCE_KEYWORDS = [
  'bilibilidance.com',
  'aafun.cc',
  '4kvm.tv',
  'kvmplay.org',
  'bilibili',
  'bilivideo',
  'upos',
  'mcdn.bilivideo',
];

const MEDIA_CONTEXT_PATTERN = /(?:video|media|movie|episode|stream|playback|playlist|source|sources|file|files|hls|m3u8)/i;
const MEDIA_URL_KEY_PATTERN = /^(?:contenturl|file|playurl|realurl|videourl|sourceurl|streamurl|mediaurl|hlsurl|m3u8|hls|src|url)$/i;
const NESTED_URL_KEY_PATTERN = /^(?:embedurl|playerurl|iframeurl|embed|iframe|player)$/i;
const PROTECTED_MEDIA_PATTERN = /(?:widevine|playready|fairplay|contentprotection|sample-aes|license(?:url|server|_url|_server)|encrypted-media|\bdrm\b)/i;
const REJECTED_ASSET_PATTERN = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp|ico|css|js|map|json|vtt|srt|ass|ssa|ttf|woff2?)(?:[?#]|$)/i;
const DECOY_PATTERN = /(?:^|[\W_])(?:ads?|advert|analytics|tracking|pixel|poster|thumbnail|sprite)(?:[\W_]|$)/i;

interface RemoteText {
  text: string;
  finalUrl: string;
  contentType: string;
}

interface ParseContext {
  controller: AbortController;
  timeout: NodeJS.Timeout;
  transactions: number;
  documents: number;
  textBytes: number;
}

interface RequestOptions {
  accept?: string;
  referer?: string;
  range?: string;
}

export interface ExtractedMediaCandidate {
  url: string;
  type: SourceType;
  score: number;
  evidence: string;
  foundOnUrl: string;
}

export interface ExtractedMediaPage {
  title: string;
  duration: number | null;
  candidates: ExtractedMediaCandidate[];
  nestedPages: string[];
  protectedMediaDetected: boolean;
}

interface SelectedCandidate extends ExtractedMediaCandidate {
  verified: boolean;
}

function toUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('仅支持 http / https 链接');
  }
  if (url.username || url.password) {
    throw new Error('链接不能包含用户名或密码');
  }
  return url;
}

function assertParserHttpUrl(rawUrl: string): URL {
  const url = assertPublicHttpUrl(rawUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if ((url.protocol === 'https:' && port !== '443') || (url.protocol === 'http:' && port !== '80')) {
    throw new Error('视频解析仅允许访问标准 HTTP/HTTPS 端口');
  }
  return url;
}

function canonicalDirectMediaUrl(rawUrl: string): string {
  const url = assertParserHttpUrl(rawUrl);
  url.hash = '';
  return url.toString();
}

function cleanupVerifiedDirectMedia(now = Date.now()): void {
  for (const [url, grant] of VERIFIED_DIRECT_MEDIA.entries()) {
    if (grant.expiresAt <= now) VERIFIED_DIRECT_MEDIA.delete(url);
  }
}

export function recordVerifiedDirectMediaUrl(rawUrl: string, type: SourceType): void {
  if (type !== 'hls' && type !== 'video') throw new Error('仅可登记已验证的 MP4/HLS 直链');
  cleanupVerifiedDirectMedia();
  const url = canonicalDirectMediaUrl(rawUrl);
  VERIFIED_DIRECT_MEDIA.set(url, {
    expiresAt: Date.now() + env.mediaProxyTokenTtlMs,
    type,
  });
  const maxEntries = Math.min(env.mediaProxyTokenMaxActive, 50_000);
  while (VERIFIED_DIRECT_MEDIA.size > maxEntries) {
    const oldest = VERIFIED_DIRECT_MEDIA.keys().next().value;
    if (!oldest) break;
    VERIFIED_DIRECT_MEDIA.delete(oldest);
  }
}

export function isVerifiedDirectMediaUrl(rawUrl: string, type?: 'hls' | 'video'): boolean {
  cleanupVerifiedDirectMedia();
  try {
    const grant = VERIFIED_DIRECT_MEDIA.get(canonicalDirectMediaUrl(rawUrl));
    return Boolean(grant && (!type || grant.type === type));
  } catch {
    return false;
  }
}

function assertNoHttpsDowngrade(previous: URL, next: URL): void {
  if (previous.protocol === 'https:' && next.protocol !== 'https:') {
    throw new Error('出于安全原因，不允许解析链接从 HTTPS 降级到 HTTP');
  }
}

function hasExtension(pathname: string, extensions: string[]): boolean {
  const lower = pathname.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

export function guessSourceType(rawUrl: string): SourceType {
  try {
    const url = toUrl(rawUrl);
    const pathname = url.pathname.toLowerCase();
    if (hasExtension(pathname, HLS_EXTENSIONS)) return 'hls';
    if (hasExtension(pathname, DASH_EXTENSIONS)) return 'dash';
    if (hasExtension(pathname, DIRECT_VIDEO_EXTENSIONS)) return 'video';
    if (/m3u8/i.test(url.search)) return 'hls';
    return 'page';
  } catch {
    return 'unknown';
  }
}

function sourceTypeFromContentType(contentType: string): SourceType | null {
  const lower = contentType.toLowerCase().split(';')[0].trim();
  if (lower.includes('mpegurl') || lower.includes('vnd.apple.mpegurl')) return 'hls';
  if (lower.includes('dash+xml')) return 'dash';
  if (lower.startsWith('video/')) return 'video';
  return null;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function titleFromUrl(url: URL): string {
  const fileName = safeDecodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '未命名视频');
  return fileName || url.hostname;
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function decodeScriptEscapes(value: string): string {
  return htmlDecode(value)
    .replace(/\\\//g, '/')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u003a/gi, ':')
    .replace(/\\u003f/gi, '?')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u0025/gi, '%');
}

function cleanCandidate(candidate: string): string {
  return decodeScriptEscapes(candidate)
    .replace(/^url\((.*)\)$/i, '$1')
    .replace(/^['"]|['"]$/g, '')
    .replace(/[),;]+$/g, '')
    .trim();
}

function normalizeCandidateUrl(candidate: string, baseUrl: string): string | null {
  const clean = cleanCandidate(candidate);
  if (!clean || /^(?:data|blob|javascript):/i.test(clean)) return null;
  try {
    const url = new URL(clean, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function typeFromHint(hint: string | undefined, url: string): SourceType {
  const hinted = hint ? sourceTypeFromContentType(hint) : null;
  return hinted || guessSourceType(url);
}

function parseIsoDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return null;
  const seconds = (Number(match[1] || 0) * 86400)
    + (Number(match[2] || 0) * 3600)
    + (Number(match[3] || 0) * 60)
    + Number(match[4] || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function isVideoObjectType(value: unknown): boolean {
  const values = Array.isArray(value) ? value : [value];
  return values.some((entry) => typeof entry === 'string' && entry.toLowerCase() === 'videoobject');
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

export function extractMediaPage(html: string, pageUrl: string, fallbackTitle = ''): ExtractedMediaPage {
  const $ = load(html);
  const candidateMap = new Map<string, ExtractedMediaCandidate>();
  const nestedMap = new Map<string, number>();
  let structuredTitle = '';
  let duration: number | null = null;

  const addCandidate = (rawValue: string, score: number, evidence: string, typeHint?: string): void => {
    if (candidateMap.size >= MAX_MEDIA_CANDIDATES && !candidateMap.has(rawValue)) return;
    if (PROTECTED_MEDIA_PATTERN.test(`${rawValue} ${evidence}`)) return;
    const url = normalizeCandidateUrl(rawValue, pageUrl);
    if (!url || REJECTED_ASSET_PATTERN.test(url)) return;
    let type = typeFromHint(typeHint, url);
    const semanticEvidence = MEDIA_CONTEXT_PATTERN.test(evidence);
    if (type === 'page' && !semanticEvidence) return;
    if (type === 'unknown') type = 'page';

    let adjustedScore = score;
    if (url.startsWith('https:')) adjustedScore += 2;
    if (type === 'video') adjustedScore += 8;
    if (type === 'hls') adjustedScore += 7;
    if (type === 'dash') adjustedScore -= 40;
    if (type === 'page') adjustedScore -= 20;
    if (DECOY_PATTERN.test(url)) adjustedScore -= 70;
    if (/\b(?:promo|trailer|preview|sample)\b/i.test(url)) adjustedScore -= 20;
    if (adjustedScore < 50) return;

    const next: ExtractedMediaCandidate = {
      url,
      type,
      score: adjustedScore,
      evidence,
      foundOnUrl: pageUrl,
    };
    const previous = candidateMap.get(url);
    if (!previous || next.score > previous.score) candidateMap.set(url, next);
  };

  const addNestedPage = (rawValue: string, score: number, evidence: string): void => {
    if (PROTECTED_MEDIA_PATTERN.test(`${rawValue} ${evidence}`)) return;
    const url = normalizeCandidateUrl(rawValue, pageUrl);
    if (!url || url === pageUrl || DECOY_PATTERN.test(url)) return;
    const description = `${url} ${evidence}`;
    if (!/(?:player|video|media|embed|watch|stream)/i.test(description)) return;
    const previous = nestedMap.get(url);
    if (previous === undefined || score > previous) nestedMap.set(url, score);
  };

  $('video[src]').each((_index, element) => {
    addCandidate($(element).attr('src') || '', 100, 'video.src', $(element).attr('type'));
  });
  $('video source[src]').each((_index, element) => {
    addCandidate($(element).attr('src') || '', 98, 'video.source.src', $(element).attr('type'));
  });
  $('video[data-src], video source[data-src]').each((_index, element) => {
    addCandidate($(element).attr('data-src') || '', 90, 'video.data-src', $(element).attr('type'));
  });
  $('[data-video-src], [data-stream-url], [data-hls], [data-m3u8]').each((_index, element) => {
    const node = $(element);
    for (const attribute of ['data-video-src', 'data-stream-url', 'data-hls', 'data-m3u8']) {
      const value = node.attr(attribute);
      if (value) addCandidate(value, 84, attribute, attribute.includes('hls') || attribute.includes('m3u8') ? 'application/vnd.apple.mpegurl' : undefined);
    }
  });
  $('link[rel="preload"][as="video"][href]').each((_index, element) => {
    addCandidate($(element).attr('href') || '', 88, 'link.preload.video', $(element).attr('type'));
  });
  $('[itemprop="contentUrl"]').each((_index, element) => {
    const node = $(element);
    addCandidate(node.attr('content') || node.attr('href') || node.attr('src') || '', 92, 'itemprop.contentUrl', node.attr('type'));
  });

  const meta = new Map<string, string[]>();
  $('meta').each((_index, element) => {
    const node = $(element);
    const key = (node.attr('property') || node.attr('name') || '').trim().toLowerCase();
    const content = node.attr('content') || '';
    if (!key || !content) return;
    const values = meta.get(key) || [];
    values.push(content);
    meta.set(key, values);
  });

  const metaFirst = (key: string): string => meta.get(key)?.[0] || '';
  const ogType = metaFirst('og:video:type');
  for (const key of ['og:video:secure_url', 'og:video:url', 'og:video']) {
    for (const value of meta.get(key) || []) {
      const normalized = normalizeCandidateUrl(value, pageUrl);
      const type = normalized ? typeFromHint(ogType, normalized) : 'unknown';
      if (type === 'video' || type === 'hls' || type === 'dash') addCandidate(value, 90, key, ogType);
      else addNestedPage(value, 88, key);
    }
  }

  if (metaFirst('twitter:card').toLowerCase() === 'player') {
    const streamType = metaFirst('twitter:player:stream:content_type');
    for (const value of meta.get('twitter:player:stream') || []) {
      const normalized = normalizeCandidateUrl(value, pageUrl);
      const type = normalized ? typeFromHint(streamType, normalized) : 'unknown';
      if (type === 'video' || type === 'hls' || type === 'dash') addCandidate(value, 92, 'twitter.player.stream', streamType);
    }
    for (const value of meta.get('twitter:player') || []) addNestedPage(value, 86, 'twitter.player');
  }

  $('iframe[src], embed[src]').each((_index, element) => {
    const node = $(element);
    const context = [node.attr('id'), node.attr('class'), node.attr('title'), node.attr('src')].filter(Boolean).join(' ');
    addNestedPage(node.attr('src') || '', 80, `embed.${context}`);
  });

  let jsonNodes = 0;
  const walkJson = (value: unknown, path: string[], score: number): void => {
    if (jsonNodes >= MAX_JSON_NODES || path.length > MAX_JSON_DEPTH) return;
    jsonNodes += 1;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walkJson(entry, [...path, String(index)], score));
      return;
    }
    if (!value || typeof value !== 'object') return;

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => PROTECTED_MEDIA_PATTERN.test(key))) return;
    const isVideoObject = isVideoObjectType(record['@type']);
    if (isVideoObject) {
      if (!structuredTitle && typeof record.name === 'string') structuredTitle = record.name.trim();
      if (duration === null) duration = parseIsoDuration(record.duration);
      for (const source of stringValues(record.contentUrl)) addCandidate(source, 94, 'jsonld.VideoObject.contentUrl');
      for (const embed of stringValues(record.embedUrl)) addNestedPage(embed, 90, 'jsonld.VideoObject.embedUrl');
    }

    const mimeHint = typeof record.type === 'string' ? record.type : (typeof record.contentType === 'string' ? record.contentType : undefined);
    for (const [key, entry] of Object.entries(record)) {
      const nextPath = [...path, key];
      const semanticPath = nextPath.join('.');
      if (typeof entry === 'string') {
        if (NESTED_URL_KEY_PATTERN.test(key) && MEDIA_CONTEXT_PATTERN.test(semanticPath)) {
          addNestedPage(entry, score - 4, `json.${semanticPath}`);
        } else if (MEDIA_URL_KEY_PATTERN.test(key) && (MEDIA_CONTEXT_PATTERN.test(semanticPath) || guessSourceType(entry) !== 'page')) {
          addCandidate(entry, score, `json.${semanticPath}`, mimeHint);
        }
      }
      walkJson(entry, nextPath, score);
    }
  };

  $('script[type="application/ld+json"]').each((_index, element) => {
    try {
      walkJson(JSON.parse($(element).text()), ['jsonld'], 90);
    } catch {
      // Invalid structured data is ignored; scripts are never executed.
    }
  });

  $('script[type="application/json"], script#__NEXT_DATA__').each((_index, element) => {
    try {
      walkJson(JSON.parse($(element).text()), ['hydration'], 78);
    } catch {
      // Only valid serialized JSON is traversed.
    }
  });

  $('video[data-setup]').each((_index, element) => {
    try {
      walkJson(JSON.parse($(element).attr('data-setup') || '{}'), ['video', 'data-setup'], 86);
    } catch {
      // Invalid player configuration is ignored.
    }
  });

  $('script:not([type="application/ld+json"]):not([type="application/json"])').each((_index, element) => {
    const script = decodeScriptEscapes($(element).text());
    const keyedPattern = /["']?(contentUrl|play_url|playUrl|real_url|realUrl|video_url|videoUrl|source_url|sourceUrl|stream_url|streamUrl|hls_url|hlsUrl|m3u8|file|src)["']?\s*[:=]\s*["']((?:\\.|[^"'\\])*)["']/gi;
    for (const match of script.matchAll(keyedPattern)) {
      addCandidate(match[2] || '', 82, `script.${match[1]}`);
    }
    const hlsLoadPattern = /\.loadSource\(\s*["']((?:\\.|[^"'\\])*)["']\s*\)/gi;
    for (const match of script.matchAll(hlsLoadPattern)) addCandidate(match[1] || '', 86, 'script.hls.loadSource', 'application/vnd.apple.mpegurl');
    const explicitMediaPattern = /["']((?:https?:)?\/\/[^"']+?\.(?:m3u8|mpd|mp4|webm|ogg|ogv|mov|m4v|mkv|flv)(?:\?[^"']*)?)["']/gi;
    for (const match of script.matchAll(explicitMediaPattern)) addCandidate(match[1] || '', 72, 'script.explicit-media-url');
  });

  const ogTitle = metaFirst('og:title').trim();
  const documentTitle = $('title').first().text().replace(/\s+/g, ' ').trim();
  const title = ogTitle || documentTitle || structuredTitle || fallbackTitle;
  const candidates = [...candidateMap.values()].sort((left, right) => right.score - left.score);
  const nestedPages = [...nestedMap.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_NESTED_PAGE_CANDIDATES)
    .map(([url]) => url);

  return {
    title,
    duration,
    candidates,
    nestedPages,
    protectedMediaDetected: PROTECTED_MEDIA_PATTERN.test(html),
  };
}

function createParseContext(): ParseContext {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.parseTimeoutMs);
  return { controller, timeout, transactions: 0, documents: 0, textBytes: 0 };
}

function consumeTransaction(context: ParseContext): void {
  if (context.controller.signal.aborted) throw new Error('视频解析超时');
  context.transactions += 1;
  if (context.transactions > MAX_PARSE_HTTP_TRANSACTIONS) throw new Error('视频解析请求次数超过安全上限');
}

function resolvePublicAddressWithSignal(hostname: string, signal: AbortSignal, timeoutMessage: string): Promise<{ address: string; family: 4 | 6 }> {
  if (signal.aborted) return Promise.reject(new Error(timeoutMessage));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new Error(timeoutMessage)));
    signal.addEventListener('abort', onAbort, { once: true });
    resolvePublicAddress(hostname).then(
      (address) => finish(() => resolve(address)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function requestRemoteUrl(target: URL, context: ParseContext, options: RequestOptions = {}): Promise<IncomingMessage> {
  consumeTransaction(context);
  const resolved = await resolvePublicAddressWithSignal(target.hostname, context.controller.signal, '视频解析超时');
  if (context.controller.signal.aborted) throw new Error('视频解析超时');
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const referer = options.referer ? toUrl(options.referer) : target;
  const headers: Record<string, string> = {
    'user-agent': env.proxyUserAgent,
    accept: options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.8,application/vnd.apple.mpegurl;q=0.8,*/*;q=0.6',
    'accept-encoding': 'identity',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
    referer: referer.toString(),
    origin: `${referer.protocol}//${referer.host}`,
  };
  if (options.range) headers.range = options.range;

  return new Promise((resolve, reject) => {
    const upstreamRequest = request(target, {
      method: 'GET',
      signal: context.controller.signal,
      headers,
      lookup: ((_hostname: string, lookupOptions: { all?: boolean }, callback: (...args: any[]) => void) => {
        if (lookupOptions?.all) {
          callback(null, [resolved]);
          return;
        }
        callback(null, resolved.address, resolved.family);
      }) as any,
    }, resolve);
    upstreamRequest.once('error', reject);
    upstreamRequest.end();
  });
}

export async function readRemoteText(response: IncomingMessage, maxBytes = env.parseMaxResponseBytes): Promise<string> {
  const declaredLength = Number(response.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    response.destroy();
    throw new Error('解析页面响应过大');
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      response.destroy();
      throw new Error('解析页面响应过大');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchRemoteText(rawUrl: string, context: ParseContext, referer?: string): Promise<RemoteText> {
  if (context.documents >= MAX_PARSE_DOCUMENTS) throw new Error('解析页面嵌套层级超过安全上限');
  let target = assertParserHttpUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_PARSE_REDIRECTS; redirectCount += 1) {
    const response = await requestRemoteUrl(target, context, { referer });
    const status = response.statusCode || 502;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new Error('解析页面重定向缺少目标地址');
      if (redirectCount === MAX_PARSE_REDIRECTS) throw new Error('解析页面重定向次数过多');
      const next = assertParserHttpUrl(new URL(location, target).toString());
      assertNoHttpsDowngrade(target, next);
      target = next;
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`页面请求失败：HTTP ${status}`);
    }

    const contentType = String(response.headers['content-type'] || '');
    const directType = sourceTypeFromContentType(contentType);
    const accepted = directType
      || !contentType
      || contentType.includes('text/html')
      || contentType.includes('application/xhtml+xml')
      || contentType.includes('application/json')
      || contentType.includes('text/plain');
    if (!accepted) {
      response.destroy();
      throw new Error('该链接不是网页或直接视频源');
    }

    context.documents += 1;
    if (directType) {
      response.destroy();
      return { text: '', finalUrl: target.toString(), contentType };
    }
    const remainingBytes = env.parseMaxResponseBytes - context.textBytes;
    if (remainingBytes <= 0) {
      response.destroy();
      throw new Error('解析页面累计响应过大');
    }
    const text = await readRemoteText(response, remainingBytes);
    context.textBytes += Buffer.byteLength(text);
    return { text, finalUrl: target.toString(), contentType };
  }
  throw new Error('解析页面重定向次数过多');
}

async function readProbeBytes(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MEDIA_PROBE_BYTES - totalBytes;
    if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
    totalBytes += Math.min(buffer.length, Math.max(0, remaining));
    if (totalBytes >= MEDIA_PROBE_BYTES) {
      response.destroy();
      break;
    }
  }
  return Buffer.concat(chunks);
}

export function classifyMediaProbe(bytes: Buffer, contentType: string, rawUrl: string): SourceType | null {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  const hinted = sourceTypeFromContentType(contentType);
  const guessed = guessSourceType(rawUrl);
  if ((hinted === 'hls' || guessed === 'hls') && text.startsWith('#EXTM3U')) {
    if (/^#EXT-X-KEY:.*METHOD=SAMPLE-AES/im.test(text)) return null;
    return 'hls';
  }
  if ((hinted === 'dash' || guessed === 'dash') && /<(?:\w+:)?MPD\b/i.test(text)) {
    if (/<(?:\w+:)?ContentProtection\b/i.test(text)) return null;
    return 'dash';
  }

  const isIsoBmff = bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  const isEbml = bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  const isOgg = bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'OggS';
  const isFlv = bytes.length >= 3 && bytes.subarray(0, 3).toString('ascii') === 'FLV';
  const isMpeg = bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && [0xba, 0xb3].includes(bytes[3]);
  if (isIsoBmff || isEbml || isOgg || isFlv || isMpeg) return 'video';
  if ((hinted === 'video' || guessed === 'video') && !/^\s*(?:<!doctype|<html|<\?xml|\{)/i.test(text) && bytes.length >= 16) return 'video';
  return null;
}

async function probeRemoteMedia(candidate: ExtractedMediaCandidate, context: ParseContext): Promise<SelectedCandidate | null> {
  let target = assertParserHttpUrl(candidate.url);
  const probeController = new AbortController();
  const probeTimeout = setTimeout(() => probeController.abort(), env.parseProbeTimeoutMs);
  const abortProbe = (): void => probeController.abort();
  context.controller.signal.addEventListener('abort', abortProbe, { once: true });

  try {
    for (let redirectCount = 0; redirectCount <= MAX_PARSE_REDIRECTS; redirectCount += 1) {
      if (probeController.signal.aborted) throw new Error('媒体候选探测超时');
      consumeTransaction(context);
      const resolved = await resolvePublicAddressWithSignal(target.hostname, probeController.signal, '媒体候选探测超时');
      const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const referer = toUrl(candidate.foundOnUrl);
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const upstreamRequest = request(target, {
          method: 'GET',
          signal: probeController.signal,
          headers: {
            'user-agent': env.proxyUserAgent,
            accept: 'video/*,application/vnd.apple.mpegurl,application/x-mpegURL,application/dash+xml,application/octet-stream;q=0.8,*/*;q=0.2',
            'accept-encoding': 'identity',
            referer: referer.toString(),
            origin: `${referer.protocol}//${referer.host}`,
            range: `bytes=0-${MEDIA_PROBE_BYTES - 1}`,
          },
          lookup: ((_hostname: string, lookupOptions: { all?: boolean }, callback: (...args: any[]) => void) => {
            if (lookupOptions?.all) callback(null, [resolved]);
            else callback(null, resolved.address, resolved.family);
          }) as any,
        }, resolve);
        upstreamRequest.once('error', reject);
        upstreamRequest.end();
      });

      const status = response.statusCode || 502;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.destroy();
        if (!location || redirectCount === MAX_PARSE_REDIRECTS) return null;
        const next = assertParserHttpUrl(new URL(location, target).toString());
        assertNoHttpsDowngrade(target, next);
        target = next;
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        return null;
      }
      const bytes = await readProbeBytes(response);
      const type = classifyMediaProbe(bytes, String(response.headers['content-type'] || ''), target.toString());
      if (!type || type === 'dash') return null;
      return { ...candidate, url: target.toString(), type, score: candidate.score + 15, verified: true };
    }
    return null;
  } finally {
    clearTimeout(probeTimeout);
    context.controller.signal.removeEventListener('abort', abortProbe);
  }
}

async function selectPlayableCandidate(candidates: ExtractedMediaCandidate[], context: ParseContext): Promise<SelectedCandidate | null> {
  const playable = candidates.filter((candidate) => candidate.type !== 'dash');
  const limit = Math.min(Math.max(env.parseProbeMaxCandidates, 1), 5, playable.length);
  for (const candidate of playable.slice(0, limit)) {
    try {
      const verified = await probeRemoteMedia(candidate, context);
      if (verified) return verified;
    } catch (error) {
      if (context.controller.signal.aborted) throw new Error('视频解析超时');
      if (error instanceof Error && /超时/.test(error.message)) throw error;
      // A failed candidate is skipped; the shared deadline and transaction budget still apply.
    }
  }
  return null;
}

function getCachedParse(inputUrl: string): ParsedVideoSource | null {
  const hit = PARSE_CACHE.get(inputUrl);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    PARSE_CACHE.delete(inputUrl);
    return null;
  }
  return { ...hit.result, message: hit.result.message ? `${hit.result.message}（缓存命中）` : '解析缓存命中' };
}

function isClassifiedParseFailure(result: ParsedVideoSource): result is ClassifiedParseFailure {
  const candidate = result as Partial<ClassifiedParseFailure>;
  return !result.success
    && typeof candidate.code === 'string'
    && typeof candidate.recoverable === 'boolean'
    && (candidate.retryAfterMs === null || typeof candidate.retryAfterMs === 'number');
}

function setCachedParse(inputUrl: string, result: ParsedVideoSource): void {
  const failureTtlMs = isClassifiedParseFailure(result)
    ? (result.recoverable ? Number(result.retryAfterMs) || 5_000 : 60_000)
    : 0;
  const ttlMs = result.success ? env.parseCacheTtlMs : failureTtlMs;
  if (ttlMs <= 0) return;
  PARSE_CACHE.set(inputUrl, {
    expiresAt: Date.now() + Math.min(ttlMs, 60_000),
    result,
  });
  if (PARSE_CACHE.size > 300) {
    const firstKey = PARSE_CACHE.keys().next().value;
    if (firstKey) PARSE_CACHE.delete(firstKey);
  }
}

function hostContains(rawUrl: string, keywords: string[]): boolean {
  try {
    const url = toUrl(rawUrl);
    const host = url.hostname.toLowerCase();
    const full = url.toString().toLowerCase();
    return keywords.some((keyword) => host.includes(keyword) || full.includes(keyword));
  } catch {
    return false;
  }
}

function isParserWrapperUrl(rawUrl: string): boolean {
  try {
    const url = toUrl(rawUrl);
    const host = url.hostname.toLowerCase();
    const search = decodeScriptEscapes(url.search || '');
    return search.includes('http://')
      || search.includes('https://')
      || DYNAMIC_PARSE_HOST_KEYWORDS.some((keyword) => host.includes(keyword));
  } catch {
    return false;
  }
}

function requiresClientParse(inputUrl: string, sourceUrl: string): boolean {
  return isParserWrapperUrl(inputUrl) || hostContains(sourceUrl, DEVICE_BOUND_SOURCE_KEYWORDS);
}

function buildHeaders(refererUrl: string, finalUrl: string): Record<string, string> {
  try {
    const ref = toUrl(refererUrl);
    return {
      referer: ref.toString(),
      origin: `${ref.protocol}//${ref.host}`,
      finalUrl,
    };
  } catch {
    return { finalUrl };
  }
}

type ClassifiedParseFailure = ParsedVideoSource & {
  code: string;
  recoverable: boolean;
  retryAfterMs: number | null;
};

function failureResult(inputUrl: string, title: string, finalUrl: string, message: string): ParsedVideoSource {
  return {
    success: false,
    inputUrl,
    title,
    type: 'page',
    src: '',
    pageUrl: inputUrl,
    duration: null,
    headers: {},
    message,
    requiresClientParse: isParserWrapperUrl(inputUrl),
    finalUrl,
  };
}

function bilibiliFailureResult(inputUrl: string, error: unknown): ClassifiedParseFailure {
  const failure = toBilibiliPublicError(error);
  return {
    ...failureResult(inputUrl, inputUrl, inputUrl, failure.message),
    code: failure.code,
    recoverable: failure.recoverable,
    retryAfterMs: failure.retryAfterMs,
    requiresClientParse: false,
  };
}

async function parseVideoUrlUncached(inputUrl: string, fetchImpl?: typeof fetch): Promise<ParsedVideoSource> {
  if (isBilibiliVideoUrl(inputUrl)) {
    try {
      return await parseBilibiliVideo(inputUrl, { fetchImpl });
    } catch (error) {
      return bilibiliFailureResult(inputUrl, error);
    }
  }
  const parsedUrl = toUrl(inputUrl);
  const directType = guessSourceType(inputUrl);
  const context = createParseContext();
  try {
    if (directType === 'hls' || directType === 'video' || directType === 'dash') {
      const safeUrl = assertParserHttpUrl(inputUrl);
      if (directType === 'dash') {
        await resolvePublicAddressWithSignal(safeUrl.hostname, context.controller.signal, '视频解析超时');
        return failureResult(inputUrl, titleFromUrl(parsedUrl), inputUrl, '已识别到 DASH/MPD 地址，但当前播放器尚未支持 DASH。请改用公开的 MP4 或 M3U8 地址。');
      }
      const verified = await probeRemoteMedia({
        url: safeUrl.toString(),
        type: directType,
        score: 110,
        evidence: 'direct-url',
        foundOnUrl: safeUrl.toString(),
      }, context);
      if (!verified) {
        return failureResult(inputUrl, titleFromUrl(parsedUrl), inputUrl, '直接视频地址未通过状态码与媒体格式校验，请确认链接仍可匿名访问。');
      }
      recordVerifiedDirectMediaUrl(verified.url, verified.type);
      return {
        success: true,
        inputUrl,
        title: titleFromUrl(new URL(verified.url)),
        type: verified.type,
        src: verified.url,
        pageUrl: inputUrl,
        duration: null,
        headers: buildHeaders(inputUrl, verified.url),
        message: '直接视频源已通过状态码与媒体格式校验',
        requiresClientParse: false,
        finalUrl: verified.url,
        refererUrl: inputUrl,
      };
    }

    const first = await fetchRemoteText(inputUrl, context);
    const directFromContent = sourceTypeFromContentType(first.contentType);
    if (directFromContent) {
      if (directFromContent === 'dash') {
        return failureResult(inputUrl, titleFromUrl(new URL(first.finalUrl)), first.finalUrl, '该链接响应为 DASH/MPD，但当前播放器尚未支持 DASH。');
      }
      const directCandidate: ExtractedMediaCandidate = {
        url: first.finalUrl,
        type: directFromContent,
        score: 100,
        evidence: 'response.content-type',
        foundOnUrl: inputUrl,
      };
      const verified = await probeRemoteMedia(directCandidate, context);
      if (!verified) return failureResult(inputUrl, titleFromUrl(new URL(first.finalUrl)), first.finalUrl, '媒体响应未通过有限格式校验，未将其加入播放队列。');
      recordVerifiedDirectMediaUrl(verified.url, verified.type);
      return {
        success: true,
        inputUrl,
        title: titleFromUrl(new URL(first.finalUrl)),
        type: verified.type,
        src: verified.url,
        pageUrl: inputUrl,
        duration: null,
        headers: buildHeaders(inputUrl, verified.url),
        message: '该链接响应为可播放媒体源，且已通过格式校验',
        requiresClientParse: requiresClientParse(inputUrl, verified.url),
        finalUrl: verified.url,
        refererUrl: inputUrl,
      };
    }

    const firstPage = extractMediaPage(first.text, first.finalUrl || inputUrl, parsedUrl.hostname);
    let selected = await selectPlayableCandidate(firstPage.candidates, context);
    let selectedDuration = firstPage.duration;
    let protectedMediaDetected = firstPage.protectedMediaDetected;

    if (!selected) {
      for (const nestedUrl of firstPage.nestedPages) {
        if (context.documents >= MAX_PARSE_DOCUMENTS) break;
        try {
          const nested = await fetchRemoteText(nestedUrl, context, first.finalUrl);
          const nestedDirectType = sourceTypeFromContentType(nested.contentType);
          if (nestedDirectType && nestedDirectType !== 'dash') {
            selected = await probeRemoteMedia({
              url: nested.finalUrl,
              type: nestedDirectType,
              score: 100,
              evidence: 'nested.response.content-type',
              foundOnUrl: first.finalUrl,
            }, context);
          } else if (!nestedDirectType) {
            const nestedPage = extractMediaPage(nested.text, nested.finalUrl || nestedUrl, firstPage.title);
            protectedMediaDetected = protectedMediaDetected || nestedPage.protectedMediaDetected;
            selectedDuration = selectedDuration ?? nestedPage.duration;
            selected = await selectPlayableCandidate(nestedPage.candidates, context);
          }
          if (selected) break;
        } catch (error) {
          if (context.controller.signal.aborted) throw new Error('视频解析超时');
          if (error instanceof Error && /超时/.test(error.message)) throw error;
          // Nested candidates are optional and remain inside the shared request budget.
        }
      }
    }

    if (!selected) {
      const hasDashOnly = firstPage.candidates.some((candidate) => candidate.type === 'dash');
      const message = protectedMediaDetected
        ? '页面仅声明了受 DRM、许可证或会员访问控制保护的媒体，本项目不会尝试绕过这些限制。'
        : hasDashOnly
          ? '页面中仅找到 DASH/MPD 媒体；当前播放器尚未支持 DASH，请改用公开 MP4 或 M3U8 来源。'
          : '暂未在公开页面声明中找到可匿名直连并通过校验的 MP4/M3U8 视频源。动态脚本、登录、会员、验证码和 DRM 内容不会被嗅探或绕过。';
      return failureResult(inputUrl, firstPage.title, first.finalUrl, message);
    }

    const result: ParsedVideoSource = {
      success: true,
      inputUrl,
      title: firstPage.title,
      type: selected.type,
      src: selected.url,
      pageUrl: inputUrl,
      duration: selectedDuration,
      headers: buildHeaders(selected.foundOnUrl, selected.url),
      message: requiresClientParse(inputUrl, selected.url)
        ? '已从公开页面声明中提取并校验视频源；该地址可能带动态签名，客机会优先在本设备重新解析'
        : `已从公开页面声明中提取并校验${selected.type === 'hls' ? ' HLS' : ''}视频源`,
      requiresClientParse: requiresClientParse(inputUrl, selected.url),
      finalUrl: selected.foundOnUrl,
      refererUrl: selected.foundOnUrl,
    };
    return result;
  } finally {
    clearTimeout(context.timeout);
  }
}

export async function parseVideoUrl(rawUrl: string, options: { force?: boolean; fetchImpl?: typeof fetch } = {}): Promise<ParsedVideoSource> {
  const inputUrl = String(rawUrl || '').trim();
  const cached = getCachedParse(inputUrl);
  if (cached && (!options.force || isClassifiedParseFailure(cached))) return cached;

  const inFlight = IN_FLIGHT_PARSES.get(inputUrl);
  if (inFlight) return inFlight;

  const task = parseVideoUrlUncached(inputUrl, options.fetchImpl)
    .then((result) => {
      setCachedParse(inputUrl, result);
      return result;
    })
    .finally(() => {
      if (IN_FLIGHT_PARSES.get(inputUrl) === task) IN_FLIGHT_PARSES.delete(inputUrl);
    });
  IN_FLIGHT_PARSES.set(inputUrl, task);
  return task;
}
