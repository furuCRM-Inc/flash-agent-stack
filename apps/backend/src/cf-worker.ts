/**
 * FlashAgent — Cloudflare Workers entry point.
 * Uses Workers AI (@cf/facebook/bart-large-mnli) for zero-shot classification.
 * Zero cold starts · 100k free requests/day · Global edge network.
 *
 * Deploy: npx wrangler deploy
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { SystemOneRequest, SystemOneResponse, Answer } from './types.js';

interface Env {
  AI: {
    run(model: string, input: object): Promise<{
      labels: string[];
      scores: number[];
      sequence?: string;
    }>;
  };
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/', (c) =>
  c.json({
    name: 'FlashAgent Stack (Cloudflare Workers)',
    model: '@cf/facebook/bart-large-mnli',
    endpoints: { systemone: 'POST /v1/systemone' },
    note: 'Workers AI — zero cold starts, 100k free requests/day',
  })
);

app.get('/health', (c) => c.json({ status: 'ok', ts: new Date().toISOString() }));

app.post('/v1/systemone', async (c) => {
  let body: SystemOneRequest;
  try {
    body = await c.req.json<SystemOneRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { state, questions } = body;
  if (!state || !questions) {
    return c.json({ error: 'Missing required fields: state, questions' }, 400);
  }

  let stateText: string;
  try {
    const parsed = JSON.parse(state);
    stateText = Object.entries(parsed).map(([k, v]) => `${k}: ${v}`).join('. ');
  } catch {
    stateText = state;
  }

  const entries = Object.entries(questions);

  const results = await Promise.all(
    entries.map(async ([key, q]) => {
      const context = `${q.instructions}. Context: ${stateText}`;
      let answer: Answer;

      if (q.type === 'noul') {
        const res = await c.env.AI.run('@cf/facebook/bart-large-mnli', {
          text: context,
          candidate_labels: [q.instructions, 'This is not applicable.'],
        });
        const noul = res.labels[0] === q.instructions
          ? res.scores[0]
          : 1 - res.scores[0];
        answer = { type: 'noul', noul };

      } else if (q.type === 'choice') {
        const keys   = Object.keys(q.criteria);
        const labels = keys.map(k => q.criteria[k]);
        const res = await c.env.AI.run('@cf/facebook/bart-large-mnli', {
          text: context,
          candidate_labels: labels,
          multi_label: false,
        });
        // Map sorted result labels back to keys
        const winningLabel = res.labels[0];
        const winningIdx   = labels.indexOf(winningLabel);
        const probabilities: Record<string, number> = {};
        res.labels.forEach((lbl, i) => {
          const idx = labels.indexOf(lbl);
          if (idx >= 0) probabilities[keys[idx]] = res.scores[i];
        });
        answer = {
          type: 'choice',
          choice: keys[winningIdx] ?? keys[0],
          confidence: res.scores[0],
          probabilities,
        };

      } else if (q.type === 'score') {
        const sortedKeys = Object.keys(q.levels).sort((a, b) => Number(a) - Number(b));
        const labels     = sortedKeys.map(k => q.levels[k]);
        const res = await c.env.AI.run('@cf/facebook/bart-large-mnli', {
          text: context,
          candidate_labels: labels,
          multi_label: true,
        });
        // Build ordered probability array then compute weighted average
        const probs = sortedKeys.map(k => {
          const lbl = q.levels[k];
          const pos = res.labels.indexOf(lbl);
          return pos >= 0 ? res.scores[pos] : 0;
        });
        const sum        = probs.reduce((a, b) => a + b, 0);
        const normalized = probs.map(p => (sum > 0 ? p / sum : 1 / probs.length));
        const score      = sortedKeys.reduce((acc, k, i) => acc + Number(k) * normalized[i], 0);
        answer = { type: 'score', score, confidence: Math.max(...normalized) };

      } else {
        throw new Error(`Unknown question type: ${(q as { type: string }).type}`);
      }

      return [key, answer] as const;
    })
  );

  const answers = Object.fromEntries(results);
  const inputTokens = Math.ceil((state + entries.map(([, q]) => q.instructions).join(' ')).length / 4);

  const response: SystemOneResponse = {
    model: 'flash-cf (@cf/facebook/bart-large-mnli)',
    answers,
    usage: { input_tokens: inputTokens, output_tokens: 0 },
  };

  return c.json(response);
});

export default app;
