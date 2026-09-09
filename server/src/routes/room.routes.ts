import { Router } from 'express';
import { env } from '../config/env.js';
import { roomService } from '../services/room.service.js';
import { getTrustedClientAddress } from '../utils/client-address.js';
import { normalizeRoomCode } from '../utils/id.js';
import { BoundedSlidingWindowRateLimiter } from '../utils/rate-limit.js';

export const roomRouter = Router();
const ROOM_CREATE_RATE_WINDOW_MS = 60_000;
const roomCreateRateLimiter = new BoundedSlidingWindowRateLimiter();

function allowRoomCreation(key: string): boolean {
  return roomCreateRateLimiter.allow(key, env.roomCreateRateLimitPerMinute, ROOM_CREATE_RATE_WINDOW_MS);
}

function toAccessSummary(room: ReturnType<typeof roomService.getRoom>) {
  if (!room) return null;
  return {
    roomCode: room.roomCode,
    roomName: room.roomName,
    security: room.security,
  };
}

roomRouter.get('/rooms/:room', (req, res) => {
  const roomCode = normalizeRoomCode(req.params.room);
  const room = roomService.getRoom(roomCode);
  res.json({ success: true, exists: Boolean(room), room: toAccessSummary(room) });
});

roomRouter.post('/rooms/:room', async (req, res) => {
  const roomCode = normalizeRoomCode(req.params.room);
  const roomName = String(req.body?.roomName || '').trim() || undefined;
  const password = String(req.body?.password || '').trim().slice(0, 80);
  const adminToken = String(req.body?.adminToken || '').trim();
  const recoveryCode = String(req.body?.recoveryCode || '').trim().toUpperCase();
  const cleanRecoveryCode = recoveryCode.replace(/\s+/g, '').replace(/-/g, '');
  if (!/^[A-Za-z0-9_-]{32,120}$/.test(adminToken) || !/^[A-Z0-9_]{20,80}$/.test(cleanRecoveryCode)) {
    res.status(400).json({ success: false, code: 'creation_credentials_invalid', message: '房间创建凭据无效，请刷新页面后重试' });
    return;
  }
  if (password && password.length < 4) {
    res.status(400).json({ success: false, code: 'password_too_short', message: '房间密码至少需要 4 个字符，或留空不设置密码' });
    return;
  }
  if (!allowRoomCreation(getTrustedClientAddress(req))) {
    res.status(429).json({ success: false, code: 'room_create_rate_limited', message: '创建房间过于频繁，请稍后再试' });
    return;
  }

  const creation = roomService.createRoom(roomCode, roomName, { adminToken, recoveryCode });
  if (!creation) {
    if (!roomService.getRoom(roomCode)) {
      res.status(503).json({ success: false, code: 'room_limit_reached', message: '当前活动房间已达上限，请稍后再试' });
      return;
    }
    res.status(409).json({ success: false, code: 'room_exists', message: '同名房间已存在，请重新输入或者加入房间' });
    return;
  }

  let room = creation.state;
  if (password && !room.security.hasPassword) {
    try {
      room = await roomService.setRoomPassword(roomCode, password, { memberId: 'system', memberName: 'System' }) || room;
    } catch {
      res.status(503).json({ success: false, code: 'password_hash_failed', message: '房间密码暂时无法安全保存，请稍后重试创建' });
      return;
    }
  }
  res.status(creation.created ? 201 : 200).json({
    success: true,
    room: toAccessSummary(room),
    adminToken: creation.credentials.adminToken,
    recoveryCode: creation.credentials.recoveryCode,
  });
});
