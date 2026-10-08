import cors from 'cors';
import express from 'express';
import { posix } from 'node:path';
import { env, isPublicOriginAllowed } from './config/env.js';
import { bilibiliRouter } from './routes/bilibili.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { parseRouter } from './routes/parse.routes.js';
import { proxyRouter } from './routes/proxy.routes.js';
import { roomRouter } from './routes/room.routes.js';
import { interactionCatalog } from './services/interaction.service.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxyHops);
  // Also guards static middleware attached by local/E2E hosts after createApp.
  app.use((req, res, next) => {
    let pathname: string;
    try {
      pathname = posix.normalize(decodeURIComponent(req.path).replace(/\\/g, '/'))
        .split('/').map(segment => segment.replace(/[ .]+$/g, '')).join('/');
    } catch {
      res.status(400).end();
      return;
    }
    if (/^\/assets\/interactions\/catalog\.json(?:\/|$)/i.test(pathname)) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).end();
      return;
    }
    next();
  });
  app.use(cors({
    origin: (origin, callback) => {
      callback(null, isPublicOriginAllowed(origin));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', healthRouter);
  app.use('/api', bilibiliRouter);
  app.use('/api', parseRouter);
  app.use('/api', proxyRouter);
  app.use('/api', roomRouter);

  app.get('/api/interactions', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(interactionCatalog.getCatalog());
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ success: false, message: 'API 不存在' });
  });

  return app;
}
