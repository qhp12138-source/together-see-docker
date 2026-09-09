import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(serverRoot, '..');
const port = Number(process.env.PLAYWRIGHT_TEST_PORT || 4173);
const origin = `http://127.0.0.1:${port}`;

Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: String(port),
  PUBLIC_ORIGIN: origin,
  ROOM_STORE_ENABLED: 'false',
  ROOM_CREATE_RATE_LIMIT_PER_MINUTE: '0',
  PARSE_RATE_LIMIT_PER_MINUTE: '0',
});

const [{ createApp }, { attachSocketServer }] = await Promise.all([
  import('../dist/app.js'),
  import('../dist/sockets/index.js'),
]);

const app = createApp();
const noStore = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

app.get(['/', '/index.html'], noStore, (_req, res) => {
  res.sendFile(path.join(projectRoot, 'index.html'));
});
app.get(['/room', '/room.html'], noStore, (_req, res) => {
  res.sendFile(path.join(projectRoot, 'room.html'));
});
app.use('/assets', noStore, express.static(path.join(projectRoot, 'assets'), {
  dotfiles: 'deny',
  fallthrough: false,
  index: false,
}));

const httpServer = createServer(app);
const io = attachSocketServer(httpServer);
function shutdown(exitCode = 0) {
  io.close();
  httpServer.close();
  process.exit(exitCode);
}

app.post('/api/e2e/shutdown', (_req, res) => {
  res.status(204).end();
  setImmediate(() => shutdown(0));
});

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));
process.once('uncaughtException', (error) => {
  console.error(error);
  shutdown(1);
});
process.once('unhandledRejection', (error) => {
  console.error(error);
  shutdown(1);
});

httpServer.listen(port, '127.0.0.1', () => {
  console.log(`[together-see-e2e] listening at ${origin}`);
});
