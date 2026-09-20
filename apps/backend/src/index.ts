import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import systemoneRoute from './routes/systemone.js';
import completionsRoute from './routes/completions.js';
import { getClassifier } from './engine/classifier.js';

const app = new Hono();

app.use('*', cors());
app.use('*', logger());

// Health + model status
app.get('/', (c) =>
  c.json({
    name: 'FlashAgent Stack',
    version: '0.1.0',
    description: 'Local drop-in for TypeSafe AI Jev — Noul/Choice/Score via Transformers.js',
    endpoints: {
      systemone: 'POST /v1/systemone',
      completions: 'POST /v1/chat/completions',
      health: 'GET /health',
    },
  })
);

app.get('/health', (c) => c.json({ status: 'ok', ts: new Date().toISOString() }));

// Jev-compatible structured decision endpoint
app.route('/v1/systemone', systemoneRoute);

// OpenAI-compatible chat completions
app.route('/v1/chat/completions', completionsRoute);

const PORT = Number(process.env.PORT ?? 3000);

function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ⚡ FlashAgent Stack — Community Edition (MIT License)       ║
║  Noul · Choice · Score at 10–50ms · Zero hallucination       ║
║                                                              ║
║  For Enterprise SLA, custom Salesforce LWC, HIPAA/GDPR,     ║
║  and managed infra → https://furucrm.com                     ║
║  or email: support@furucrm.com                              ║
╚══════════════════════════════════════════════════════════════╝
`);
}

printBanner();

// Warm the model on startup so first request is fast
getClassifier().catch(err => console.error('[FlashAgent] Model warm-up failed:', err));

// Bun entry point
export default {
  port: PORT,
  fetch: app.fetch,
};

// Node.js fallback (npm run start:node)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isBun = typeof (globalThis as any).Bun !== 'undefined';
if (!isBun) {
  // @ts-expect-error — @hono/node-server available after npm install
  import('@hono/node-server').then(({ serve }: { serve: (opts: { fetch: typeof app.fetch; port: number }) => void }) => {
    serve({ fetch: app.fetch, port: PORT });
    console.log(`[FlashAgent] Listening on http://localhost:${PORT}`);
  });
} else {
  console.log(`[FlashAgent] Listening on http://localhost:${PORT}`);
}
