import { Hono } from 'hono';
import { evaluateNoul, evaluateChoice, evaluateScore } from '../engine/evaluators.js';
import type { SystemOneRequest, SystemOneResponse, Answer } from '../types.js';

const app = new Hono();

app.post('/', async (c) => {
  let body: SystemOneRequest;
  try {
    body = await c.req.json<SystemOneRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { model, state, questions } = body;
  if (!state || !questions || typeof questions !== 'object') {
    return c.json({ error: 'Missing required fields: state, questions' }, 400);
  }

  // Build a single context string: question instructions + state
  let stateText: string;
  try {
    const parsed = JSON.parse(state);
    stateText = Object.entries(parsed)
      .map(([k, v]) => `${k}: ${v}`)
      .join('. ');
  } catch {
    stateText = state;
  }

  // Evaluate all questions in parallel
  const entries = Object.entries(questions);
  const results = await Promise.all(
    entries.map(async ([key, q]) => {
      const context = `${q.instructions}. Context: ${stateText}`;
      let answer: Answer;

      if (q.type === 'noul') {
        answer = await evaluateNoul(context, q);
      } else if (q.type === 'choice') {
        answer = await evaluateChoice(context, q);
      } else if (q.type === 'score') {
        answer = await evaluateScore(context, q);
      } else {
        throw new Error(`Unknown question type: ${(q as { type: string }).type}`);
      }

      return [key, answer] as const;
    })
  );

  const answers: Record<string, Answer> = Object.fromEntries(results);

  // Approximate token count (state + all instructions)
  const inputText = state + entries.map(([, q]) => q.instructions).join(' ');
  const inputTokens = Math.ceil(inputText.length / 4);

  const response: SystemOneResponse = {
    model: `flash-local (${model})`,
    answers,
    usage: {
      input_tokens: inputTokens,
      output_tokens: 0,
    },
  };

  return c.json(response);
});

export default app;
