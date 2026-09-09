import { load } from 'cheerio';
import { env } from '../config/env.js';
import type { BilibiliDanmakuItem, BilibiliSourceMeta, ParsedVideoSource } from '../types/room.js';
import { normalizeBvid } from '../utils/bilibili.js';

const BILIBILI_API_HOST = 'api.bilibili.com';
const BILIBILI_DANMAKU_HOST = 'comment.bilibili.com';
const BILIBILI_PAGE_HOSTS = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv']);
const BILIBILI_CDN_HOSTS = ['bilivideo.com', 'bilibili.com'] as const;
const BILIBILI_CDN_EXACT_HOSTS = new Set(['upos-hz-mirrorakam.akamaized.net']);
const BILIBILI_REDIRECT_LIMIT = 5;
const BILIBILI_API_MAX_BYTES = 1024 * 1024;
const BILIBILI_VIEW_COOLDOWN_MS = 60_000;
const DANMAKU_CACHE = new Map<string, { expiresAt: number; result: BilibiliDanmakuResult }>();
const DANMAKU_IN_FLIGHT = new Map<string, Promise<BilibiliDanmakuResult>>();
let bilibiliViewLimitedUntil = 0;

interface BilibiliPage {
  cid: number;
  page: number;
  part?: string;
  duration?: number;
}

interface BilibiliViewData {
  bvid: string;
  aid?: number;
  title: string;
  duration?: number;
  state?: number;
  cid?: number;
  pages?: BilibiliPage[];
  rights?: Record<string, number>;
}

interface BilibiliViewResponse {
  code: number;
  message?: string;
  data?: BilibiliViewData;
}

interface BilibiliPageListResponse {
  code: number;
  message?: string;
  data?: BilibiliPage[];
}

interface BilibiliPlayResponse {
  code: number;
  message?: string;
  data?: {
    quality?: number;
    format?: string;
    durl?: Array<{
      url?: string;
      backup_url?: string[] | string | null;
      backupUrl?: string[] | string | null;
      size?: number;
      length?: number;
    }>;
    support_formats?: Array<{
      quality?: number;
      new_description?: string;
      display_desc?: string;
      description?: string;
    }>;
    is_preview?: boolean | number | string;
    isPreview?: boolean | number | string;
    is_drm?: boolean | number | string;
    isDrm?: boolean | number | string;
    need_login?: boolean | number | string;
    needLogin?: boolean | number | string;
    need_vip?: boolean | number | string;
    needVip?: boolean | number | string;
  };
}

export type BilibiliErrorCode =
  | 'bilibili_disabled'
  | 'bilibili_invalid_input'
  | 'bilibili_redirect_invalid'
  | 'bilibili_upstream_timeout'
  | 'bilibili_upstream_http'
  | 'bilibili_upstream_limited'
  | 'bilibili_upstream_payload_invalid'
  | 'bilibili_video_unavailable'
  | 'bilibili_access_restricted'
  | 'bilibili_page_unavailable'
  | 'bilibili_playurl_unavailable'
  | 'bilibili_stream_unsupported'
  | 'bilibili_cdn_unrecognized'
  | 'bilibili_response_too_large';

export class BilibiliServiceError extends Error {
  constructor(
    public readonly code: BilibiliErrorCode,
    message: string,
    public readonly status: number,
    public readonly recoverable: boolean,
    public readonly retryAfterMs: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BilibiliServiceError';
  }
}

export interface BilibiliPublicError {
  code: BilibiliErrorCode;
  message: string;
  status: number;
  recoverable: boolean;
  retryAfterMs: number | null;
}

export function toBilibiliPublicError(error: unknown): BilibiliPublicError {
  if (error instanceof BilibiliServiceError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      recoverable: error.recoverable,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return {
    code: 'bilibili_upstream_payload_invalid',
    message: 'B站公开接口返回了无法识别的数据，请稍后重试',
    status: 502,
    recoverable: true,
    retryAfterMs: 5_000,
  };
}

export interface BilibiliDanmakuResult {
  bvid: string;
  cid: number;
  page: number;
  title: string;
  count: number;
  items: BilibiliDanmakuItem[];
}

interface FetchOptions {
  fetchImpl?: typeof fetch;
  method?: 'GET' | 'HEAD';
  maxBytes?: number;
  accept?: string;
  redirect?: RequestRedirect;
}

function isBilibiliPageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return BILIBILI_PAGE_HOSTS.has(host) || host.endsWith('.bilibili.com');
}

function isHostOrSubdomain(hostname: string, parent: string): boolean {
  return hostname === parent || hostname.endsWith(`.${parent}`);
}

function normalizeBilibiliCdnUrl(rawUrl: string): string | null {
  try {
    const candidate = String(rawUrl || '').trim();
    if (!candidate) return null;
    const url = new URL(candidate.startsWith('//') ? `https:${candidate}` : candidate);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || (!BILIBILI_CDN_EXACT_HOSTS.has(host)
        && !BILIBILI_CDN_HOSTS.some((parent) => isHostOrSubdomain(host, parent)))) return null;
    url.protocol = 'https:';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function asUrlCandidates(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' && value.trim() ? [value] : [];
}

function bilibiliCdnRank(rawUrl: string): number {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (isHostOrSubdomain(host, 'bilivideo.com')) return 0;
    if (isHostOrSubdomain(host, 'bilibili.com')) return 1;
    if (BILIBILI_CDN_EXACT_HOSTS.has(host)) return 2;
  } catch {
    // Normalized candidates are expected to parse; invalid values remain last.
  }
  return 3;
}

function parseJsonPayload<T>(body: Buffer, context: string): T {
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch (error) {
    throw new BilibiliServiceError(
      'bilibili_upstream_payload_invalid',
      `B站${context}返回了无法识别的数据，请稍后重试`,
      502,
      true,
      5_000,
      { cause: error },
    );
  }
}

function getApiCode(body: Buffer): number | null {
  try {
    const code = Number((JSON.parse(body.toString('utf8')) as { code?: unknown })?.code);
    return Number.isFinite(code) ? code : null;
  } catch {
    return null;
  }
}

function isRiskControlled(response: Response, body: Buffer): boolean {
  return response.status === 412 || getApiCode(body) === -412;
}

function shouldFallbackViewStatus(status: number): boolean {
  return status === 403 || status === 412 || status === 429 || status >= 500;
}

function markViewLimited(): void {
  bilibiliViewLimitedUntil = Math.max(bilibiliViewLimitedUntil, Date.now() + BILIBILI_VIEW_COOLDOWN_MS);
}

function viewLimitedError(): BilibiliServiceError {
  const remainingMs = Math.max(1_000, bilibiliViewLimitedUntil - Date.now());
  return new BilibiliServiceError(
    'bilibili_upstream_limited',
    'B站公开信息接口暂时受限，请稍后再试',
    503,
    true,
    remainingMs,
  );
}

function flagEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

export function isBilibiliVideoUrl(rawUrl: string): boolean {
  try {
    const url = new URL(String(rawUrl || '').trim());
    return url.protocol === 'https:' && isBilibiliPageHost(url.hostname);
  } catch {
    return false;
  }
}

export function parseBilibiliVideoInput(rawInput: string): { bvid: string | null; aid: number | null; page: number } {
  const input = String(rawInput || '').trim();
  let page = 1;
  try {
    const url = new URL(input);
    const requestedPage = Number(url.searchParams.get('p') || 1);
    if (Number.isSafeInteger(requestedPage) && requestedPage > 0) page = requestedPage;
  } catch {
    // Plain BV/AV identifiers are accepted by the pure parser for tests and internal use.
  }
  const bvidMatch = input.match(/BV[0-9A-Za-z]{10}/i);
  const avMatch = input.match(/(?:^|\/|\b)av(\d{1,18})(?:\b|\/|\?|#|$)/i);
  return {
    bvid: bvidMatch ? normalizeBvid(bvidMatch[0]) : null,
    aid: avMatch && Number.isSafeInteger(Number(avMatch[1])) ? Number(avMatch[1]) : null,
    page,
  };
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new BilibiliServiceError('bilibili_response_too_large', 'B站接口响应过大', 502, true, 5_000);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BilibiliServiceError('bilibili_response_too_large', 'B站接口响应过大', 502, true, 5_000);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchBilibili(rawUrl: string, options: FetchOptions = {}): Promise<{ response: Response; body: Buffer }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.bilibiliTimeoutMs);
  try {
    const response = await (options.fetchImpl || fetch)(rawUrl, {
      method: options.method || 'GET',
      redirect: options.redirect || 'error',
      signal: controller.signal,
      headers: {
        'user-agent': env.proxyUserAgent,
        accept: options.accept || 'application/json,text/plain;q=0.8,*/*;q=0.2',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
        referer: 'https://www.bilibili.com/',
      },
    });
    const body = options.method === 'HEAD' ? Buffer.alloc(0) : await readLimitedBody(response, options.maxBytes || BILIBILI_API_MAX_BYTES);
    return { response, body };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new BilibiliServiceError('bilibili_upstream_timeout', 'B站公开接口请求超时', 504, true, 5_000, { cause: error });
    }
    if (error instanceof BilibiliServiceError) throw error;
    throw new BilibiliServiceError('bilibili_upstream_http', 'B站公开接口暂时无法连接，请稍后重试', 502, true, 5_000, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveBilibiliShortUrl(rawUrl: string, fetchImpl?: typeof fetch): Promise<string> {
  let current = new URL(rawUrl);
  for (let count = 0; count <= BILIBILI_REDIRECT_LIMIT; count += 1) {
    const parsed = parseBilibiliVideoInput(current.toString());
    if (parsed.bvid || parsed.aid) return current.toString();
    if (current.hostname.toLowerCase() !== 'b23.tv') break;
    let { response } = await fetchBilibili(current.toString(), {
      fetchImpl,
      method: 'HEAD',
      redirect: 'manual',
    });
    if (response.status === 405 || response.status === 501) {
      ({ response } = await fetchBilibili(current.toString(), {
        fetchImpl,
        method: 'GET',
        redirect: 'manual',
      }));
    }
    if (response.status === 412) {
      markViewLimited();
      throw viewLimitedError();
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      throw new BilibiliServiceError('bilibili_redirect_invalid', 'B站短链接未返回可识别的视频地址', 422, false);
    }
    const location = response.headers.get('location');
    if (!location) throw new BilibiliServiceError('bilibili_redirect_invalid', 'B站短链接缺少跳转地址', 422, false);
    const next = new URL(location, current);
    if (next.protocol !== 'https:' || !isBilibiliPageHost(next.hostname)) {
      throw new BilibiliServiceError('bilibili_redirect_invalid', 'B站短链接跳转目标不受支持', 422, false);
    }
    current = next;
  }
  throw new BilibiliServiceError('bilibili_invalid_input', 'B站链接中未找到 BV/AV 视频编号', 400, false);
}

async function getPageListData(bvid: string, fetchImpl?: typeof fetch): Promise<BilibiliViewData> {
  const query = new URLSearchParams({ bvid, jsonp: 'jsonp' });
  const { response, body } = await fetchBilibili(`https://${BILIBILI_API_HOST}/x/player/pagelist?${query}`, { fetchImpl });
  if (isRiskControlled(response, body)) {
    markViewLimited();
    throw viewLimitedError();
  }
  if (!response.ok) {
    throw new BilibiliServiceError('bilibili_upstream_http', `B站分P信息请求失败：HTTP ${response.status}`, 502, true, 10_000);
  }
  const payload = parseJsonPayload<BilibiliPageListResponse>(body, '分P信息接口');
  if (payload.code === -412) {
    markViewLimited();
    throw viewLimitedError();
  }
  if (payload.code !== 0 || !Array.isArray(payload.data)) {
    throw new BilibiliServiceError(
      'bilibili_video_unavailable',
      payload.message || 'B站视频不存在或暂不可访问',
      404,
      false,
    );
  }
  const pages = payload.data.slice(0, 10_000).map((entry): BilibiliPage => {
    const duration = Number(entry?.duration);
    return {
      cid: Number(entry?.cid),
      page: Number(entry?.page),
      duration: Number.isFinite(duration) && duration >= 0 ? duration : undefined,
      part: typeof entry?.part === 'string' ? entry.part.replace(/\s+/g, ' ').trim().slice(0, 120) : undefined,
    };
  }).filter((page) => Number.isSafeInteger(page.cid)
    && page.cid > 0
    && Number.isSafeInteger(page.page)
    && page.page > 0
    && page.page <= 10_000);
  if (!pages.length) {
    throw new BilibiliServiceError('bilibili_upstream_payload_invalid', 'B站分P信息缺少有效 CID', 502, true, 10_000);
  }
  const firstTitle = pages.length === 1 && pages[0].part ? pages[0].part : `B站视频 ${bvid}`;
  return {
    bvid,
    title: firstTitle,
    duration: pages.reduce((total, page) => total + (page.duration || 0), 0) || undefined,
    pages,
  };
}

async function getViewData(identifier: { bvid: string | null; aid: number | null }, fetchImpl?: typeof fetch): Promise<BilibiliViewData> {
  if (Date.now() < bilibiliViewLimitedUntil) {
    if (identifier.bvid) return getPageListData(identifier.bvid, fetchImpl);
    throw viewLimitedError();
  }
  const query = identifier.bvid ? `bvid=${encodeURIComponent(identifier.bvid)}` : `aid=${identifier.aid}`;
  const url = `https://${BILIBILI_API_HOST}/x/web-interface/view?${query}`;
  const { response, body } = await fetchBilibili(url, { fetchImpl });
  if (isRiskControlled(response, body)) {
    markViewLimited();
    if (identifier.bvid) return getPageListData(identifier.bvid, fetchImpl);
    throw viewLimitedError();
  }
  if (!response.ok) {
    if (identifier.bvid && shouldFallbackViewStatus(response.status)) {
      markViewLimited();
      return getPageListData(identifier.bvid, fetchImpl);
    }
    throw new BilibiliServiceError('bilibili_upstream_http', `B站视频信息请求失败：HTTP ${response.status}`, 502, true, 5_000);
  }
  const payload = parseJsonPayload<BilibiliViewResponse>(body, '视频信息接口');
  if (payload.code === -412) {
    markViewLimited();
    if (identifier.bvid) return getPageListData(identifier.bvid, fetchImpl);
    throw viewLimitedError();
  }
  if (payload.code !== 0 || !payload.data) {
    throw new BilibiliServiceError('bilibili_video_unavailable', payload.message || 'B站视频不存在或暂不可访问', 404, false);
  }
  const bvid = normalizeBvid(payload.data.bvid);
  if (!bvid) {
    throw new BilibiliServiceError('bilibili_upstream_payload_invalid', 'B站视频信息缺少有效 BV 编号', 502, true, 5_000);
  }
  return { ...payload.data, bvid };
}

function assertPublicVideo(data: BilibiliViewData): void {
  if (data.state !== undefined && data.state !== 0) {
    throw new BilibiliServiceError('bilibili_video_unavailable', '该B站视频当前不可公开播放', 403, false);
  }
  const rights = data.rights || {};
  if (rights.pay || rights.ugc_pay || rights.ugc_pay_preview || rights.arc_pay
    || rights.is_chargeable_season || rights.is_upower_exclusive) {
    throw new BilibiliServiceError(
      'bilibili_access_restricted',
      '该B站视频需要付费、会员或专属权限，本项目不会绕过访问限制',
      403,
      false,
    );
  }
}

function selectPage(data: BilibiliViewData, requestedPage: number): BilibiliPage {
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const selected = pages.find((page) => Number(page.page) === requestedPage)
    || (requestedPage === 1 && Number(data.cid) > 0 ? { cid: Number(data.cid), page: 1, duration: data.duration } : null);
  if (!selected || !Number.isSafeInteger(Number(selected.cid)) || Number(selected.cid) <= 0) {
    throw new BilibiliServiceError('bilibili_page_unavailable', `B站视频不存在第 ${requestedPage} 个分P`, 400, false);
  }
  return { ...selected, cid: Number(selected.cid), page: requestedPage };
}

async function getPlaySource(data: BilibiliViewData, page: BilibiliPage, fetchImpl?: typeof fetch): Promise<{
  sourceUrl: string;
  quality: number;
  qualityLabel: string;
}> {
  const query = new URLSearchParams({
    bvid: data.bvid,
    cid: String(page.cid),
    qn: '80',
    fnval: '0',
    fnver: '0',
    fourk: '0',
    platform: 'html5',
  });
  const { response, body } = await fetchBilibili(`https://${BILIBILI_API_HOST}/x/player/playurl?${query}`, { fetchImpl });
  if (isRiskControlled(response, body)) {
    markViewLimited();
    throw viewLimitedError();
  }
  if (!response.ok) {
    throw new BilibiliServiceError('bilibili_upstream_http', `B站播放地址请求失败：HTTP ${response.status}`, 502, true, 5_000);
  }
  const payload = parseJsonPayload<BilibiliPlayResponse>(body, '播放地址接口');
  if (payload.code !== 0 || !payload.data) {
    throw new BilibiliServiceError(
      'bilibili_playurl_unavailable',
      payload.message || 'B站未返回匿名可用的播放地址',
      502,
      true,
      5_000,
    );
  }
  if (flagEnabled(payload.data.is_preview)
    || flagEnabled(payload.data.isPreview)
    || flagEnabled(payload.data.is_drm)
    || flagEnabled(payload.data.isDrm)
    || flagEnabled(payload.data.need_login)
    || flagEnabled(payload.data.needLogin)
    || flagEnabled(payload.data.need_vip)
    || flagEnabled(payload.data.needVip)) {
    throw new BilibiliServiceError(
      'bilibili_access_restricted',
      '该B站视频需要登录、会员或受保护播放，本项目不会绕过访问限制',
      403,
      false,
    );
  }
  const streams = Array.isArray(payload.data.durl) ? payload.data.durl.filter((entry) => entry && typeof entry === 'object') : [];
  if (streams.length !== 1) {
    throw new BilibiliServiceError(
      'bilibili_stream_unsupported',
      '该B站视频使用分段或复合流，当前匿名播放器暂不支持',
      422,
      false,
    );
  }
  const stream = streams[0];
  const rawCandidates = [stream.url, ...asUrlCandidates(stream.backup_url), ...asUrlCandidates(stream.backupUrl)];
  const sourceUrl = Array.from(new Set(
    rawCandidates.map((candidate) => normalizeBilibiliCdnUrl(String(candidate || ''))).filter((candidate): candidate is string => Boolean(candidate)),
  )).sort((left, right) => bilibiliCdnRank(left) - bilibiliCdnRank(right))[0] || '';
  if (!sourceUrl) {
    throw new BilibiliServiceError(
      'bilibili_cdn_unrecognized',
      'B站暂未返回受支持的匿名播放线路，请稍后重试',
      502,
      true,
      10_000,
    );
  }
  const quality = Number(payload.data.quality) || 0;
  const format = payload.data.support_formats?.find((entry) => Number(entry.quality) === quality);
  const qualityLabel = String(format?.new_description || format?.display_desc || format?.description || payload.data.format || '自动清晰度')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return { sourceUrl, quality, qualityLabel };
}

export async function parseBilibiliVideo(rawUrl: string, options: { fetchImpl?: typeof fetch } = {}): Promise<ParsedVideoSource> {
  if (!env.bilibiliEnabled) throw new BilibiliServiceError('bilibili_disabled', 'B站解析项未启用', 503, false);
  if (!isBilibiliVideoUrl(rawUrl)) {
    throw new BilibiliServiceError('bilibili_invalid_input', '不是受支持的B站视频链接', 400, false);
  }
  const resolvedUrl = new URL(rawUrl).hostname.toLowerCase() === 'b23.tv'
    ? await resolveBilibiliShortUrl(rawUrl, options.fetchImpl)
    : rawUrl;
  const input = parseBilibiliVideoInput(resolvedUrl);
  if (!input.bvid && !input.aid) {
    throw new BilibiliServiceError('bilibili_invalid_input', 'B站链接中未找到 BV/AV 视频编号', 400, false);
  }
  const data = await getViewData(input, options.fetchImpl);
  assertPublicVideo(data);
  const page = selectPage(data, input.page);
  const source = await getPlaySource(data, page, options.fetchImpl);
  const canonicalUrl = `https://www.bilibili.com/video/${data.bvid}${page.page > 1 ? `?p=${page.page}` : ''}`;
  const title = page.part && page.part !== data.title ? `${data.title} - ${page.part}` : data.title;
  const bilibili: BilibiliSourceMeta = {
    bvid: data.bvid,
    cid: page.cid,
    page: page.page,
    quality: source.quality,
    qualityLabel: source.qualityLabel,
    danmakuAvailable: true,
    danmakuEnabled: false,
  };
  return {
    success: true,
    inputUrl: rawUrl,
    title,
    type: 'video',
    src: source.sourceUrl,
    pageUrl: canonicalUrl,
    duration: Number(page.duration || data.duration) || null,
    headers: {
      referer: canonicalUrl,
      origin: 'https://www.bilibili.com',
      finalUrl: canonicalUrl,
    },
    message: `B站公开视频 · ${source.qualityLabel} · 可加载原弹幕`,
    requiresClientParse: false,
    finalUrl: canonicalUrl,
    refererUrl: canonicalUrl,
    bilibili,
  };
}

function danmakuMode(value: number): BilibiliDanmakuItem['mode'] {
  if (value === 5) return 'top';
  if (value === 4) return 'bottom';
  return 'scroll';
}

function colorFromDecimal(value: number): string {
  const safe = Number.isFinite(value) ? Math.min(0xffffff, Math.max(0, Math.trunc(value))) : 0xffffff;
  return `#${safe.toString(16).padStart(6, '0')}`;
}

export function parseBilibiliDanmakuXml(xml: string, maxItems = env.bilibiliDanmakuMaxItems): BilibiliDanmakuItem[] {
  const $ = load(xml, { xmlMode: true });
  const items: BilibiliDanmakuItem[] = [];
  $('d').each((index, element) => {
    if (items.length >= maxItems) return false;
    const node = $(element);
    const fields = String(node.attr('p') || '').split(',');
    const time = Number(fields[0]);
    const text = node.text().replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!Number.isFinite(time) || time < 0 || !text) return;
    const fontSize = Math.min(36, Math.max(12, Number(fields[2]) || 25));
    items.push({
      id: String(fields[7] || `bili-${index}`).slice(0, 80),
      time,
      mode: danmakuMode(Number(fields[1])),
      fontSize,
      color: colorFromDecimal(Number(fields[3])),
      text,
    });
  });
  return items.sort((left, right) => left.time - right.time);
}

export async function getBilibiliDanmaku(
  bvidValue: string,
  pageValue: number,
  options: { fetchImpl?: typeof fetch; force?: boolean } = {},
): Promise<BilibiliDanmakuResult> {
  if (!env.bilibiliEnabled) throw new BilibiliServiceError('bilibili_disabled', 'B站弹幕项未启用', 503, false);
  const bvid = normalizeBvid(bvidValue);
  const pageNumber = Number(pageValue);
  if (!bvid || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 10_000) {
    throw new BilibiliServiceError('bilibili_invalid_input', 'B站弹幕参数无效', 400, false);
  }
  const cacheKey = `${bvid}:${pageNumber}`;
  const cached = options.force ? null : DANMAKU_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const inFlight = DANMAKU_IN_FLIGHT.get(cacheKey);
  if (inFlight) return inFlight;

  const task = (async () => {
    const data = await getViewData({ bvid, aid: null }, options.fetchImpl);
    assertPublicVideo(data);
    const page = selectPage(data, pageNumber);
    const { response, body } = await fetchBilibili(`https://${BILIBILI_DANMAKU_HOST}/${page.cid}.xml`, {
      fetchImpl: options.fetchImpl,
      accept: 'application/xml,text/xml;q=0.9,*/*;q=0.2',
      maxBytes: env.bilibiliDanmakuMaxResponseBytes,
    });
    if (isRiskControlled(response, body)) {
      markViewLimited();
      throw viewLimitedError();
    }
    if (!response.ok) {
      throw new BilibiliServiceError('bilibili_upstream_http', `B站弹幕请求失败：HTTP ${response.status}`, 502, true, 5_000);
    }
    const items = parseBilibiliDanmakuXml(body.toString('utf8'));
    const result = { bvid, cid: page.cid, page: page.page, title: data.title, count: items.length, items };
    DANMAKU_CACHE.set(cacheKey, { expiresAt: Date.now() + env.bilibiliCacheTtlMs, result });
    if (DANMAKU_CACHE.size > 200) DANMAKU_CACHE.delete(DANMAKU_CACHE.keys().next().value || '');
    return result;
  })().finally(() => {
    if (DANMAKU_IN_FLIGHT.get(cacheKey) === task) DANMAKU_IN_FLIGHT.delete(cacheKey);
  });
  DANMAKU_IN_FLIGHT.set(cacheKey, task);
  return task;
}
