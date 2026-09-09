import { Router } from 'express';
import { roomStore } from '../services/room-store.service.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  const persistence = roomStore.getHealth();
  res.status(persistence.ok ? 200 : 503).json({
    ok: persistence.ok,
    service: 'together-see-server',
    persistence,
    time: new Date().toISOString(),
  });
});
