import { Router } from 'express';
import { env } from '../config/env.js';
import { parseVideoUrl } from '../services/parser.service.js';
import { getTrustedClientAddress } from '../utils/client-address.js';
import { getErrorMessage } from '../utils/http.js';
import { BoundedSlidingWindowRateLimiter } from '../utils/rate-limit.js';

export const parseRouter = Router();

const parseRateLimiter = new BoundedSlidingWindowRateLimiter();
const parseConcurrentByClient = new Map<string, number>();
let parseConcurrentTotal = 0;
const PARSE_RATE_WINDOW_MS = 60 * 1000;

function getClientKey(req: import('express').Request): string {
  return getTrustedClientAddress(req);
}

function allowParseRequest(key: string): boolean {
  return parseRateLimiter.allow(key, env.parseRateLimitPerMinute, PARSE_RATE_WINDOW_MS);
}

function acquireParseSlot(key: string): boolean {
  const clientCount = parseConcurrentByClient.get(key) || 0;
  if (clientCount >= env.parseMaxConcurrentPerClient || parseConcurrentTotal >= env.parseMaxConcurrentTotal) return false;
  parseConcurrentByClient.set(key, clientCount + 1);
  parseConcurrentTotal += 1;
  return true;
}

function releaseParseSlot(key: string): void {
  const clientCount = parseConcurrentByClient.get(key) || 0;
  if (clientCount <= 1) parseConcurrentByClient.delete(key);
  else parseConcurrentByClient.set(key, clientCount - 1);
  parseConcurrentTotal = Math.max(0, parseConcurrentTotal - 1);
}

function getParseErrorStatus(message: string): number {
  if (/超时/.test(message)) return 504;
  if (/请求失败：HTTP|解析到了/.test(message)) return 502;
  if (/安全原因|内网|本机|标准 HTTP\/HTTPS 端口|用户名或密码|HTTPS 降级/.test(message)) return 403;
  if (/仅支持 http|Invalid URL|无效/.test(message)) return 400;
  if (/请求次数超过/.test(message)) return 429;
  return 422;
}

parseRouter.post('/parse', async (req, res) => {
  const clientKey = getClientKey(req);
  if (!allowParseRequest(clientKey)) {
    res.status(429).json({ success: false, message: '解析请求太频繁，请稍后再试' });
    return;
  }

  const rawUrl = String(req.body?.url || '').trim();
  if (!rawUrl) {
    res.status(400).json({ success: false, message: '缺少 url 参数' });
    return;
  }
  if (!acquireParseSlot(clientKey)) {
    res.status(429).json({ success: false, message: '当前视频解析任务较多，请稍后再试' });
    return;
  }

  try {
    const force = req.body?.force === true || req.query.force === '1' || req.query.force === 'true';
    const result = await parseVideoUrl(rawUrl, { force });
    res.status(result.success ? 200 : 422).json(result);
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(getParseErrorStatus(message)).json({
      success: false,
      inputUrl: rawUrl,
      title: rawUrl,
      type: 'unknown',
      src: '',
      pageUrl: rawUrl,
      duration: null,
      headers: {},
      message,
      requiresClientParse: false,
      finalUrl: '',
    });
  } finally {
    releaseParseSlot(clientKey);
  }
});
