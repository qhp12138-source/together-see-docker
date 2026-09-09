import { Router } from 'express';
import { env } from '../config/env.js';
import { getBilibiliDanmaku, toBilibiliPublicError } from '../services/bilibili.service.js';
import { getTrustedClientAddress } from '../utils/client-address.js';
import { BoundedSlidingWindowRateLimiter } from '../utils/rate-limit.js';

export const bilibiliRouter = Router();

const rateLimiter = new BoundedSlidingWindowRateLimiter();
const RATE_WINDOW_MS = 60_000;

function allowRequest(key: string): boolean {
  return rateLimiter.allow(key, env.bilibiliRateLimitPerMinute, RATE_WINDOW_MS);
}

bilibiliRouter.get('/bilibili/danmaku', async (req, res) => {
  const clientKey = getTrustedClientAddress(req);
  if (!allowRequest(clientKey)) {
    res.status(429).json({
      success: false,
      code: 'bilibili_rate_limited',
      message: 'B站弹幕请求太频繁，请稍后再试',
      recoverable: true,
      retryAfterMs: RATE_WINDOW_MS,
    });
    return;
  }
  try {
    const result = await getBilibiliDanmaku(String(req.query.bvid || ''), Number(req.query.page || 1));
    res.json({ success: true, ...result });
  } catch (error) {
    const failure = toBilibiliPublicError(error);
    res.status(failure.status).json({
      success: false,
      code: failure.code,
      message: failure.message,
      recoverable: failure.recoverable,
      retryAfterMs: failure.retryAfterMs,
    });
  }
});
