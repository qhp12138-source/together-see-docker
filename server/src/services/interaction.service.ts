import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export interface InteractionAsset {
  readonly revision: string;
  readonly visualBytes: number;
  id: string;
  label: string;
  type: 'image' | 'video' | 'sprite' | 'builtin';
  readonly group: 'builtin' | 'other';
  effect?: 'heart' | 'fireworks' | 'sakura' | 'birthday';
  src?: string;
  poster?: string;
  audio?: string;
  durationMs: number;
  width?: number;
  height?: number;
  columns?: number;
  frames?: number;
}

export interface InteractionCatalog {
  version: 1;
  items: readonly Readonly<InteractionAsset>[];
}

const PREFIX = '/assets/interactions/';
const MAX_BYTES = 64 * 1024;
const MAX_ITEMS = 64;
const MAX_VISUAL_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.ogg', '.wav', '.m4a']);
const BUILTIN_EFFECTS = new Set(['heart', 'fireworks', 'sakura', 'birthday']);
const EMPTY: Readonly<InteractionCatalog> = Object.freeze({ version: 1, items: Object.freeze([]) });
const DEFAULT_DIRECTORY = fileURLToPath(new URL('../../../assets/interactions/', import.meta.url));

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function within(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function resource(root: string, value: unknown, extensions: Set<string>, signatures: string[][],
  maxBytes = MAX_VISUAL_BYTES): { url: string; bytes: number } {
  if (typeof value !== 'string' || value.length > 240) throw new Error('Invalid resource');
  const relative = value.startsWith(PREFIX) ? value.slice(PREFIX.length) : value;
  // No URL decoding or normalization: encoded separators, queries, dot segments,
  // hidden paths, Windows drive/ADS names and backslashes are all rejected.
  const segments = relative.split('/');
  if (!segments.every(segment => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(segment)
    && !segment.endsWith('.') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment))
    || !extensions.has(path.extname(relative).toLowerCase())) throw new Error('Invalid resource');
  const filename = fs.realpathSync(path.resolve(root, ...segments));
  if (!within(root, filename)) throw new Error('Invalid resource');
  const stat = fs.statSync(filename, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(maxBytes)) throw new Error('Invalid resource');
  const url = PREFIX + relative;
  signatures.push([url, String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]);
  return { url, bytes: Number(stat.size) };
}

function validate(root: string, value: unknown): Readonly<InteractionCatalog> {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) {
    throw new Error('Invalid catalog');
  }
  const ids = new Set<string>();
  const items = value.items.map((item: unknown): Readonly<InteractionAsset> => {
    if (!record(item) || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id)
      || ids.has(item.id) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 64
      || /[\u0000-\u001f\u007f]/.test(item.label) || typeof item.type !== 'string'
      || !['image', 'video', 'sprite', 'builtin'].includes(item.type)
      || !integer(item.durationMs, 1, 3000)) throw new Error('Invalid item');
    ids.add(item.id);
    const type = item.type as InteractionAsset['type'];
    const signatures: string[][] = [];
    const visual = type === 'builtin' ? null
      : resource(root, item.src, type === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS, signatures);
    const asset: Omit<InteractionAsset, 'revision'> = {
      id: item.id, label: item.label.trim(), type, group: type === 'builtin' ? 'builtin' : 'other',
      ...(visual ? { src: visual.url } : {}),
      visualBytes: visual?.bytes ?? 0,
      durationMs: item.durationMs,
    };
    if (type === 'builtin') {
      if (typeof item.effect !== 'string' || !BUILTIN_EFFECTS.has(item.effect)
        || ['src', 'poster', 'audio', 'width', 'height', 'columns', 'frames'].some(key => item[key] !== undefined)) {
        throw new Error('Invalid builtin');
      }
      asset.effect = item.effect as InteractionAsset['effect'];
    } else {
      if (item.effect !== undefined) throw new Error('Invalid effect');
    }
    if (item.poster !== undefined) asset.poster = resource(root, item.poster, IMAGE_EXTENSIONS, signatures).url;
    if (item.audio !== undefined) asset.audio = resource(root, item.audio, AUDIO_EXTENSIONS, signatures, MAX_AUDIO_BYTES).url;
    for (const key of ['width', 'height', 'columns', 'frames'] as const) {
      if (item[key] === undefined) continue;
      const maximum = key === 'columns' ? 64 : key === 'frames' ? 256 : 2048;
      if (!integer(item[key], 1, maximum)) throw new Error('Invalid dimensions');
      asset[key] = item[key];
    }
    if (type === 'sprite') {
      if (!asset.width || !asset.height || !asset.columns || !asset.frames || asset.columns > asset.frames) {
        throw new Error('Invalid sprite');
      }
    } else if (asset.columns !== undefined || asset.frames !== undefined) throw new Error('Invalid dimensions');
    // Only the public schema is copied; maintainer metadata and paths stay private.
    // Fixed field/resource order makes this independent of input JSON order and
    // private fields. Resource metadata changes invalidate caches without hashing media bytes.
    const revision = createHash('sha256').update(JSON.stringify([asset, signatures])).digest('hex').slice(0, 16);
    return Object.freeze({ ...asset, revision });
  });
  return Object.freeze({ version: 1, items: Object.freeze(items) });
}

export class InteractionCatalogService {
  private cached: Readonly<InteractionCatalog> = EMPTY;
  private signature = '';
  private checkedAt = 0;

  constructor(private readonly directory = process.env.INTERACTION_ASSET_DIR || DEFAULT_DIRECTORY) {}

  getCatalog(now = Date.now()): Readonly<InteractionCatalog> {
    let fd: number | undefined;
    let signature = '';
    try {
      const root = fs.realpathSync(this.directory);
      const filename = fs.realpathSync(path.join(root, 'catalog.json'));
      if (!within(root, filename)) throw new Error('Invalid catalog');
      const stat = fs.statSync(filename, { bigint: true });
      if (!stat.isFile() || stat.size > BigInt(MAX_BYTES)) throw new Error('Invalid catalog');
      signature = [filename, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('|');
      // Catalog edits/deletion take effect on the next call. Recheck referenced
      // files at least once per second, even when the JSON itself is unchanged.
      if (signature === this.signature && now >= this.checkedAt && now - this.checkedAt < 1000) return this.cached;
      fd = fs.openSync(filename, 'r');
      if (!fs.fstatSync(fd).isFile()) throw new Error('Invalid catalog');
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
        if (!read) break;
        count += read;
      }
      if (count > MAX_BYTES) throw new Error('Invalid catalog');
      const after = fs.fstatSync(fd, { bigint: true });
      if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs
        || after.ino !== stat.ino || after.dev !== stat.dev) throw new Error('Catalog changed while reading');
      this.cached = validate(root, JSON.parse(bytes.subarray(0, count).toString('utf8')));
      this.signature = signature;
      this.checkedAt = now;
    } catch {
      this.cached = EMPTY;
      this.signature = signature;
      this.checkedAt = now;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return this.cached;
  }
}

export const interactionCatalog = new InteractionCatalogService();
