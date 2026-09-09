import type { BilibiliSourceMeta } from '../types/room.js';

const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function normalizeBvid(value: unknown): string | null {
  const clean = String(value || '').trim();
  const match = clean.match(/^bv([0-9a-z]{10})$/i);
  return match ? `BV${match[1]}` : null;
}

export function isValidBvid(value: unknown): boolean {
  return BVID_PATTERN.test(String(value || ''));
}

export function isBilibiliPageUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com'));
  } catch {
    return false;
  }
}

export function sanitizeBilibiliSourceMeta(value: unknown): BilibiliSourceMeta | undefined {
  if (!isPlainObject(value)) return undefined;
  const bvid = normalizeBvid(value.bvid);
  const cid = Number(value.cid);
  const page = Number(value.page);
  if (!bvid || !Number.isSafeInteger(cid) || cid <= 0 || !Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    return undefined;
  }
  return {
    bvid,
    cid,
    page,
    quality: Number.isFinite(Number(value.quality)) ? Math.max(0, Math.trunc(Number(value.quality))) : 0,
    qualityLabel: String(value.qualityLabel || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '自动清晰度',
    danmakuAvailable: value.danmakuAvailable !== false,
    danmakuEnabled: value.danmakuEnabled === true,
  };
}
