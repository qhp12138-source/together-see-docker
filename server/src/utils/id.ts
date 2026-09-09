import { randomBytes } from 'node:crypto';

export function createId(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export function normalizeRoomCode(value: string): string {
  const clean = String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[?#&=\\/:;%]/g, '')
    .slice(0, 64)
    .trim();
  return clean || '默认房间';
}
