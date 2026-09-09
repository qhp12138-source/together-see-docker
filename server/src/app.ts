import cors from 'cors';
import express from 'express';
import { env, isPublicOriginAllowed } from './config/env.js';
import { bilibiliRouter } from './routes/bilibili.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { parseRouter } from './routes/parse.routes.js';
import { proxyRouter } from './routes/proxy.routes.js';
import { roomRouter } from './routes/room.routes.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxyHops);
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

  app.use('/api', (_req, res) => {
    res.status(404).json({ success: false, message: 'API 不存在' });
  });

  return app;
}
