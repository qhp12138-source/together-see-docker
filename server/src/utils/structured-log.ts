import { createHmac, randomBytes } from 'node:crypto';

type StructuredLogValue = string | number | boolean | null | undefined;
type StructuredLogLevel = 'info' | 'warn' | 'error';

interface SuppressionEntry {
  until: number;
  count: number;
  record: Record<string, string | number | boolean | null>;
  level: StructuredLogLevel;
  timer: NodeJS.Timeout | null;
}

const diagnosticSecret = randomBytes(32);
const suppressionWindowMs = 10_000;
const suppressionLimit = 1000;
const suppressedEvents = new Map<string, SuppressionEntry>();

const approvedFields = {
  playback_decision: [
    'roomFingerprint', 'actorFingerprint', 'clientType', 'action', 'decision', 'reason',
    'baseRevision', 'currentRevision', 'nextRevision', 'sourceMatch', 'clientReady',
    'clientSeeking', 'leaseOwnerChanged', 'previousSourceFingerprint',
    'nextSourceFingerprint', 'deltaBucket', 'suppressedCount',
  ],
  playlist_decision: [
    'roomFingerprint', 'actorFingerprint', 'clientType', 'action', 'decision', 'reason',
    'sourceFingerprint', 'sourceType', 'countBefore', 'countAfter', 'activeSourceChanged',
    'suppressedCount',
  ],
  proxy_grant_decision: [
    'roomFingerprint', 'actorFingerprint', 'sourceFingerprint', 'clientType', 'routeName',
    'decision', 'reason', 'playlistMatched', 'grantMode', 'revalidationAttempted',
    'suppressedCount',
  ],
  proxy_fetch_decision: [
    'sourceFingerprint', 'routeName', 'decision', 'reason', 'statusClass', 'bytesBucket',
    'elapsedBucket', 'suppressedCount',
  ],
  room_store_decision: [
    'operation', 'decision', 'reason', 'errorCode', 'generation', 'generationLag',
    'roomCountBucket', 'bytesBucket', 'elapsedBucket', 'suppressedCount',
  ],
} as const;

export type StructuredEventName = keyof typeof approvedFields;

const clientTypes = ['android_webview', 'android_browser', 'ios_browser', 'automation', 'mobile_other', 'desktop_browser', 'unknown'];
const allowedStringValues: Record<StructuredEventName, Record<string, ReadonlySet<string>>> = {
  playback_decision: {
    clientType: new Set(clientTypes),
    action: new Set(['play', 'pause', 'seek', 'rate', 'source', 'periodic', 'buffering', 'legacy', 'unknown']),
    decision: new Set(['accepted', 'rejected']),
    reason: new Set([
      'accepted', 'not_controller', 'rate_limited', 'action_required', 'room_not_found',
      'stale_revision', 'source_not_found', 'lease_not_owner', 'client_not_ready',
      'client_seeking', 'source_mismatch', 'room_not_playing', 'room_buffering',
      'timeline_outlier', 'timeline_reanchored',
    ]),
    deltaBucket: new Set(['unknown', '<-10s', '-10--2.5s', '-2.5-2.5s', '2.5-10s', '>10s']),
  },
  playlist_decision: {
    clientType: new Set(clientTypes),
    action: new Set(['add', 'rename', 'danmaku_toggle', 'autoplay_next', 'delete', 'move']),
    decision: new Set(['accepted', 'rejected']),
    reason: new Set([
      'accepted', 'not_controller', 'rate_limited', 'capacity', 'invalid_payload',
      'remote_address_denied', 'store_capacity', 'item_not_found', 'boundary',
    ]),
    sourceType: new Set(['hls', 'video', 'dash', 'page', 'local', 'unknown']),
  },
  proxy_grant_decision: {
    clientType: new Set(clientTypes),
    routeName: new Set(['hls', 'media']),
    decision: new Set(['accepted', 'rejected']),
    reason: new Set([
      'granted', 'room_access_required', 'parse_option_missing', 'parse_option_disabled',
      'parse_authorization_busy', 'parse_source_denied', 'parse_authorization_failed',
      'authorization_failed',
    ]),
    grantMode: new Set(['none', 'allowlist', 'verified_direct', 'revalidated_direct']),
  },
  proxy_fetch_decision: {
    routeName: new Set(['hls', 'media']),
    decision: new Set(['accepted', 'rejected']),
    reason: new Set([
      'disabled', 'rate_limited', 'invalid_or_expired_grant', 'invalid_request',
      'concurrency_limited', 'upstream_status', 'upstream_timeout', 'upstream_error',
      'client_cancelled',
    ]),
    statusClass: new Set(['1xx', '2xx', '3xx', '4xx', '5xx']),
    bytesBucket: new Set(['0', '<1MiB', '1-16MiB', '16-64MiB', '64MiB+']),
    elapsedBucket: new Set(['<25ms', '25-100ms', '100-500ms', '500ms+']),
  },
  room_store_decision: {
    operation: new Set(['load', 'write', 'shutdown']),
    decision: new Set(['accepted', 'rejected']),
    reason: new Set([
      'loaded', 'slow_write', 'large_snapshot', 'flushed', 'flush_failed',
      'prepare_directory', 'open_temp', 'write_header', 'prepare_room', 'write_room',
      'write_footer', 'sync_file', 'replace_file', 'sync_directory',
      'room_store_invalid', 'room_store_too_large', 'room_store_read_failed',
      'room_store_write_failed',
    ]),
    errorCode: new Set([
      'room_store_invalid', 'room_store_too_large', 'room_store_read_failed',
      'room_store_write_failed',
    ]),
    roomCountBucket: new Set(['0', '1-20', '21-100', '101-500', '500+']),
    bytesBucket: new Set(['0', '<1MiB', '1-16MiB', '16-64MiB', '64MiB+']),
    elapsedBucket: new Set(['<25ms', '25-100ms', '100-500ms', '500ms+']),
  },
};

const fingerprintFields = new Set(['roomFingerprint', 'actorFingerprint', 'sourceFingerprint', 'previousSourceFingerprint', 'nextSourceFingerprint']);

export function diagnosticFingerprint(scope: 'room' | 'actor' | 'source', value: unknown): string | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) return undefined;
  return createHmac('sha256', diagnosticSecret)
    .update(`${scope}:${normalized}`)
    .digest('hex')
    .slice(0, 12);
}

export function countBucket(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value <= 20) return '1-20';
  if (value <= 100) return '21-100';
  if (value <= 500) return '101-500';
  return '500+';
}

export function bytesBucket(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1024 * 1024) return '<1MiB';
  if (value < 16 * 1024 * 1024) return '1-16MiB';
  if (value < 64 * 1024 * 1024) return '16-64MiB';
  return '64MiB+';
}

export function elapsedBucket(value: number): string {
  if (!Number.isFinite(value) || value < 25) return '<25ms';
  if (value < 100) return '25-100ms';
  if (value < 500) return '100-500ms';
  return '500ms+';
}

function writeRecord(record: Record<string, string | number | boolean | null>, level: StructuredLogLevel): void {
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function flushSuppressedEvent(key: string, entry: SuppressionEntry): void {
  if (suppressedEvents.get(key) !== entry) return;
  suppressedEvents.delete(key);
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.count > 0) writeRecord({ ...entry.record, suppressedCount: entry.count }, entry.level);
}

function cleanSuppressionMap(now: number): void {
  for (const [key, entry] of suppressedEvents.entries()) {
    if (entry.until <= now) flushSuppressedEvent(key, entry);
  }
  while (suppressedEvents.size > suppressionLimit) {
    const firstKey = suppressedEvents.keys().next().value as string | undefined;
    if (!firstKey) break;
    const entry = suppressedEvents.get(firstKey);
    if (entry) flushSuppressedEvent(firstKey, entry);
  }
}

function sanitizeStructuredValue(event: StructuredEventName, field: string, value: StructuredLogValue): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : undefined;
  if (typeof value !== 'string') return undefined;
  if (fingerprintFields.has(field)) return /^[a-f0-9]{12}$/.test(value) ? value : undefined;
  return allowedStringValues[event][field]?.has(value) ? value : undefined;
}

export function logStructuredEvent(
  event: StructuredEventName,
  fields: Record<string, StructuredLogValue>,
  options: { level?: StructuredLogLevel; suppressKey?: string; suppressWindowMs?: number } = {},
): void {
  const record: Record<string, string | number | boolean | null> = { event };
  for (const field of approvedFields[event]) {
    if (field === 'suppressedCount') continue;
    const value = sanitizeStructuredValue(event, field, fields[field]);
    if (value !== undefined) record[field] = value;
  }

  const level = options.level || 'info';
  if (!options.suppressKey) {
    writeRecord(record, level);
    return;
  }

  const now = Date.now();
  const key = `${event}:${options.suppressKey}`;
  const existing = suppressedEvents.get(key);
  if (existing && existing.until > now) {
    existing.count += 1;
    return;
  }
  if (existing) flushSuppressedEvent(key, existing);
  const windowMs = Math.min(300_000, Math.max(5, Number(options.suppressWindowMs) || suppressionWindowMs));
  const entry: SuppressionEntry = {
    until: now + windowMs,
    count: 0,
    record,
    level,
    timer: null,
  };
  entry.timer = setTimeout(() => flushSuppressedEvent(key, entry), windowMs);
  entry.timer.unref?.();
  suppressedEvents.set(key, entry);
  cleanSuppressionMap(now);
  writeRecord(record, level);
}
