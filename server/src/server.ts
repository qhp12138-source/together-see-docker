import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { flushRoomPersistence } from './services/room.service.js';
import { attachSocketServer } from './sockets/index.js';
import { logStructuredEvent } from './utils/structured-log.js';

const app = createApp();
const httpServer = createServer(app);
const io = attachSocketServer(httpServer);
let shuttingDown = false;

httpServer.listen(env.port, () => {
  console.log(`[together-see-server] listening on :${env.port}`);
});

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;
  const timeout = setTimeout(() => {
    console.error(JSON.stringify({ event: 'server_shutdown_failed', reason: 'timeout' }));
    process.exit(1);
  }, env.roomStoreShutdownTimeoutMs);

  try {
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await flushRoomPersistence();
    clearTimeout(timeout);
    logStructuredEvent('room_store_decision', {
      operation: 'shutdown',
      decision: 'accepted',
      reason: 'flushed',
    });
    console.log(JSON.stringify({ event: 'server_shutdown_complete', signal }));
    process.exit(0);
  } catch {
    clearTimeout(timeout);
    logStructuredEvent('room_store_decision', {
      operation: 'shutdown',
      decision: 'rejected',
      reason: 'flush_failed',
    }, { level: 'error' });
    console.error(JSON.stringify({ event: 'server_shutdown_failed', reason: 'persistence' }));
    process.exit(1);
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
