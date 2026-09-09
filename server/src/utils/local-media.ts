import type { LocalFileMeta } from '../types/room.js';

export function createLocalPlaceholderUrl(meta: LocalFileMeta): string {
  const name = encodeURIComponent(meta.name || 'video');
  const size = encodeURIComponent(String(meta.size || 0));
  return `local://together-see/${name}?size=${size}`;
}

export function hasUsableLocalFileMeta(meta: LocalFileMeta | null | undefined): meta is LocalFileMeta {
  return Boolean(meta?.name && Number.isFinite(meta.size) && meta.size > 0);
}
