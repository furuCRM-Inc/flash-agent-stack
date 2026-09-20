import { Hono } from 'hono';
import { classify } from '../engine/classifier.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../types.js';

const app = new Hono();

/**
 * OpenAI-compatible chat completions endpoint.
 * Detects structured decision requests in the last user message
 * and returns a classification-based response.
 *
 * For general text prompts, returns a stub that signals the agent
 * to use /v1/systemone for structured decisions instead.
 */
app.post('/', async (c) => {
  let body: ChatCompletionRequest;
  try {
    body = await c.req.json<ChatCompletionRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { messages, model } = body;
  if (!messages?.length) {
    return c.json({ error: 'messages is required' }, 400);
  }

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const prompt = lastUser?.content ?? '';

  // Try to detect intent categories for a classification-based response
  const intents = ['urgent action required', 'needs escalation', 'standard processing', 'information request'];
  const result = await classify(prompt, intents);

  const topIntent = result.labels[0];
  const confidence = result.scores[0];

  const reply =
    `Detected intent: "${topIntent}" (confidence: ${(confidence * 100).toFixed(1)}%). ` +
    `For structured decisions (noul/choice/score), use POST /v1/systemone directly.`;

  const response: ChatCompletionResponse = {
    id: `chatcmpl-flash-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: `flash-local (${model})`,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: reply },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: Math.ceil(prompt.length / 4),
      completion_tokens: Math.ceil(reply.length / 4),
      total_tokens: Math.ceil((prompt.length + reply.length) / 4),
    },
  };

  return c.json(response);
});

export default app;
