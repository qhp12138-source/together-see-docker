export type SourceType = 'hls' | 'video' | 'dash' | 'page' | 'local' | 'unknown';

export interface BilibiliSourceMeta {
  bvid: string;
  cid: number;
  page: number;
  quality: number;
  qualityLabel: string;
  danmakuAvailable: boolean;
  danmakuEnabled: boolean;
}

export interface BilibiliDanmakuItem {
  id: string;
  time: number;
  mode: 'scroll' | 'top' | 'bottom';
  fontSize: number;
  color: string;
  text: string;
}

export interface ParsedVideoSource {
  success: boolean;
  inputUrl: string;
  title: string;
  type: SourceType;
  src: string;
  pageUrl: string;
  duration: number | null;
  headers: Record<string, string>;
  message?: string;
  requiresClientParse?: boolean;
  finalUrl?: string;
  refererUrl?: string;
  bilibili?: BilibiliSourceMeta;
}

export interface LocalFileMeta {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface PlaylistItem {
  id: string;
  title: string;
  pageUrl: string;
  sourceUrl: string;
  sourceType: SourceType;
  createdAt: number;
  addedBy?: string;
  localFile?: LocalFileMeta | null;
  requiresClientParse?: boolean;
  parseMessage?: string;
  finalUrl?: string;
  refererUrl?: string;
  bilibili?: BilibiliSourceMeta;
}

export interface RoomMember {
  id: string;
  name: string;
  role: 'host' | 'follower';
  joinedAt: number;
  latencyMs: number | null;
}

export type PlaybackAction = 'play' | 'pause' | 'seek' | 'rate' | 'source' | 'periodic' | 'buffering';

export interface PlaybackState {
  activeSourceId: string | null;
  playing: boolean;
  buffering: boolean;
  currentTime: number;
  duration: number | null;
  playbackRate?: number;
  revision: number;
  controlLeaseUntil: number | null;
  updatedAt: number;
  updatedBy: string | null;
}

export interface ChatMessage {
  id: string;
  kind: 'user' | 'system';
  senderId: string;
  senderName: string;
  text: string;
  createdAt: number;
  memberId?: string;
  systemEvent?: 'member_joined' | 'member_left' | 'member_kicked';
}

export type RoomAuditAction =
  | 'room_created'
  | 'host_transferred'
  | 'host_failed_over'
  | 'host_reclaimed'
  | 'admin_failed_over'
  | 'admin_reclaimed'
  | 'room_locked'
  | 'room_unlocked'
  | 'password_set'
  | 'password_cleared'
  | 'member_kicked'
  | 'admin_token_recovered'
  | 'control_policy_updated'
  | 'autoplay_next_updated';

export interface RoomAuditEntry {
  id: string;
  action: RoomAuditAction;
  actorId: string;
  actorName: string;
  targetId?: string;
  targetName?: string;
  detail?: string;
  createdAt: number;
}

export interface RoomSecurity {
  locked: boolean;
  hasPassword: boolean;
  controlPolicy: 'host_only' | 'everyone';
}

export interface RoomState {
  roomCode: string;
  roomName: string;
  hostMemberId: string | null;
  createdAt: number;
  updatedAt: number;
  playlist: PlaylistItem[];
  playback: PlaybackState;
  members: RoomMember[];
  chat: ChatMessage[];
  audit: RoomAuditEntry[];
  security: RoomSecurity;
  autoPlayNext: boolean;
}
