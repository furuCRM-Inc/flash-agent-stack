/**
 * FlashAgent — Cloudflare Workers entry point.
 * Uses @cf/meta/llama-3.2-3b-instruct for Noul/Choice/Score evaluation.
 * Zero cold starts · Global edge network · Free tier.
 *
 * Deploy: npx wrangler deploy
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { SystemOneRequest, SystemOneResponse, Question, Answer } from './types.js';

interface CfAiTextInput {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  max_tokens?: number;
  temperature?: number;
}

interface Env {
  AI: {
    run(model: string, input: CfAiTextInput): Promise<{ response: string }>;
  };
}

const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/', (c) =>
  c.json({
    name: 'FlashAgent Stack (Cloudflare Workers)',
    model: MODEL,
    endpoints: { systemone: 'POST /v1/systemone' },
    note: 'LLM-based Noul/Choice/Score evaluation — zero cold starts',
  })
);

app.get('/health', (c) => c.json({ status: 'ok', ts: new Date().toISOString() }));


// ── Prompt builder ─────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a precise JSON decision engine for customer support triage.
Analyze the customer context and answer evaluation questions.
Return ONLY a single valid JSON object — no markdown fences, no explanations, no extra text.

Example output format:
{
  "q_name": {"noul": 0.95},
  "q_name2": {"choice": "KEY_A", "confidence": 0.85, "probabilities": {"KEY_A": 0.85, "KEY_B": 0.10, "KEY_C": 0.05}},
  "q_name3": {"score": 2.7, "confidence": 0.90}
}`;
}

function buildUserPrompt(stateText: string, questions: Record<string, Question>): string {
  const qLines = Object.entries(questions).map(([key, q]) => {
    if (q.type === 'noul') {
      return `"${key}": How strongly does the context support this statement? (1.0 = definitely true, 0.0 = definitely false)\n  Statement: "${q.instructions}"\n  Format: {"noul": <float 0.0-1.0>}`;
    }
    if (q.type === 'choice') {
      const opts = Object.entries(q.criteria).map(([k, v]) => `    "${k}": "${v}"`).join('\n');
      const keys = Object.keys(q.criteria).join(' | ');
      return `"${key}": Best option for: "${q.instructions}"\n  Options:\n${opts}\n  → return {"choice": "${keys}", "confidence": <float 0-1>, "probabilities": {${Object.keys(q.criteria).map(k => `"${k}": <float>`).join(', ')}}}`;
    }
    if (q.type === 'score') {
      const maxLevel = Math.max(...Object.keys(q.levels).map(Number));
      const lvls = Object.entries(q.levels).map(([k, v]) => `    ${k}: "${v}"`).join('\n');
      return `"${key}": Rate 0-${maxLevel}: "${q.instructions}"\n  Levels:\n${lvls}\n  → return {"score": <float 0-${maxLevel}>, "confidence": <float 0-1>}`;
    }
    return '';
  }).join('\n\n');

  return `Context: ${stateText}

Evaluate and return ONLY this JSON object (no extra text):
{
${Object.keys(questions).map(k => `  "${k}": { ... }`).join(',\n')}
}

Questions:
${qLines}`;
}

// ── JSON extraction with fallback ──────────────────────────────────────────────

function extractJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();

  // Try direct parse first
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  // Extract first {...} block
  const start = trimmed.indexOf('{');
  const end   = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fall through */ }
  }

  return {};
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function parseAnswer(key: string, q: Question, raw: unknown): Answer {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  if (q.type === 'noul') {
    // Accept noul, probability, confidence, score, or value as the number field
    const raw_val = r.noul ?? r.probability ?? r.confidence ?? r.score ?? r.value;
    const noul = clamp(Number(raw_val ?? 0.5), 0, 1);
    return { type: 'noul', noul };
  }

  if (q.type === 'choice') {
    const keys   = Object.keys(q.criteria);
    const choice = typeof r.choice === 'string' && keys.includes(r.choice) ? r.choice : keys[0];
    const confidence = clamp(Number(r.confidence ?? 0.7), 0, 1);
    const probs = keys.reduce<Record<string, number>>((acc, k) => {
      const rp = r.probabilities as Record<string, unknown> | undefined;
      acc[k] = clamp(Number(rp?.[k] ?? (k === choice ? confidence : (1 - confidence) / (keys.length - 1))), 0, 1);
      return acc;
    }, {});
    return { type: 'choice', choice, confidence, probabilities: probs };
  }

  if (q.type === 'score') {
    const maxLevel = Math.max(...Object.keys(q.levels).map(Number));
    const score = clamp(Number(r.score ?? maxLevel / 2), 0, maxLevel);
    const confidence = clamp(Number(r.confidence ?? 0.7), 0, 1);
    return { type: 'score', score, confidence };
  }

  throw new Error(`Unknown question type for key "${key}"`);
}

// ── Main route ─────────────────────────────────────────────────────────────────

app.onError((err, c) => c.json({ error: 'Unhandled exception', detail: String(err) }, 500));


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

  let rawAiOutput: unknown;
  try {
    rawAiOutput = await c.env.AI.run(MODEL, {
      messages: [
        { role: 'system',  content: buildSystemPrompt() },
        { role: 'user',    content: buildUserPrompt(stateText, questions) },
      ],
      max_tokens: 512,
      temperature: 0.1,
    });
  } catch (e) {
    return c.json({ error: 'AI inference failed', detail: String(e) }, 500);
  }

  // CF AI returns an OpenAI-shaped object.
  // raw.response is already JSON-parsed when the model output was valid JSON.
  // raw.choices[0].message.content is always the raw string.
  const cfOutput = rawAiOutput as {
    response?: unknown;
    choices?: Array<{ message?: { content?: string } }>;
  };

  let parsed: Record<string, unknown>;
  if (cfOutput.response && typeof cfOutput.response === 'object') {
    // Already parsed — use directly
    parsed = cfOutput.response as Record<string, unknown>;
  } else {
    // Fall back to parsing the raw content string
    const rawText: string =
      cfOutput.choices?.[0]?.message?.content ??
      (typeof cfOutput.response === 'string' ? cfOutput.response : '{}');
    parsed = extractJson(rawText);
  }

  const answers: Record<string, Answer> = {};
  for (const [key, q] of Object.entries(questions)) {
    answers[key] = parseAnswer(key, q, parsed[key]);
  }

  const inputTokens = Math.ceil(
    (state + Object.values(questions).map(q => q.instructions).join(' ')).length / 4
  );

  const response: SystemOneResponse = {
    model: `flash-cf (${MODEL})`,
    answers,
    usage: { input_tokens: inputTokens, output_tokens: 0 },
  };

  return c.json(response);
});

// ── /v1/agent-action — furuAgent Bar intent routing ──────────────────────────

interface AgentActionRequest {
  user_input:   string;
  sObjectType?: string;
  recordId?:    string;
  pageType?:    string;
  field_schema?: string[];  // ["Label=ApiName", ...] from Apex schema describe
}

interface AgentActionResponse {
  intent:           string;   // NAVIGATE | UPDATE_RECORD | PREFILL | SEARCH | UNKNOWN
  message:          string;
  sObjectType?:     string;
  recordId?:        string;
  fields?:          Record<string, unknown>;
  should_save?:     boolean;
  target_record_id?: string;
  target_sobject?:  string;
  target_url?:      string;
  search_name?:     string;
  search_query?:    string;
  search_sobject?:  string;
  search_fields?:   string[];
}

function buildAgentSystemPrompt(): string {
  return `You are a Salesforce AI assistant that converts natural language user input into structured JSON actions.

Intents:
- NAVIGATE: user wants to go to a record or list (e.g. "go to", "open", "show me")
- UPDATE_RECORD: user wants to save field changes (e.g. "update", "set", "change", "save")
- PREFILL: user wants to pre-fill fields without saving (e.g. "fill in", "put", "pre-fill")
- SEARCH: user wants to find records (e.g. "find", "search", "look for", "list")
- UNKNOWN: cannot determine intent

Return ONLY valid JSON matching this schema (no markdown, no extra text):
{
  "intent": "<NAVIGATE|UPDATE_RECORD|PREFILL|SEARCH|UNKNOWN>",
  "message": "<brief human-readable summary of what you will do>",
  "sObjectType": "<API name of target sObject, or null>",
  "recordId": "<record ID to update, or null>",
  "fields": { "<FieldApiName>": <value>, ... },
  "should_save": <true|false>,
  "target_record_id": "<record ID to navigate to, or null>",
  "target_sobject": "<sObject API name for list navigation, or null>",
  "search_name": "<name/keyword to search for, or null>",
  "search_query": "<SOSL search term, or null>",
  "search_sobject": "<sObject to search in, or null>"
}

Important rules:
- Use exact Salesforce API field names from the field_schema provided (format: "Label=ApiName")
- Convert picklist values to their API values (e.g. "Closed Won" stays "Closed Won" for StageName)
- Numbers should be numbers (not strings): Amount: 500000 not "500000"
- Dates in YYYY-MM-DD format
- For NAVIGATE without a recordId, set search_name to the record name so Apex can look it up`;
}

function buildAgentUserPrompt(req: AgentActionRequest): string {
  const schema = (req.field_schema ?? []).slice(0, 80).join(', ');
  return `Current page context:
- sObject: ${req.sObjectType || 'unknown'}
- recordId: ${req.recordId || 'none'}
- pageType: ${req.pageType || 'other'}
${schema ? `\nAvailable fields (Label=ApiName):\n${schema}` : ''}

User request: "${req.user_input}"

Return the JSON action now:`;
}

async function runAgentLLM(c: Parameters<typeof app.post>[1] & { env: Env }, prompt: string, system: string): Promise<Record<string, unknown>> {
  const raw = await c.env.AI.run(MODEL, {
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: prompt },
    ],
    max_tokens: 512,
    temperature: 0.1,
  });

  const out = raw as { response?: unknown; choices?: Array<{ message?: { content?: string } }> };
  if (out.response && typeof out.response === 'object') return out.response as Record<string, unknown>;
  const text = out.choices?.[0]?.message?.content ?? (typeof out.response === 'string' ? out.response : '{}');
  return extractJson(text as string);
}

app.post('/v1/agent-action', async (c) => {
  let body: AgentActionRequest;
  try { body = await c.req.json<AgentActionRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if (!body.user_input?.trim()) return c.json({ error: 'user_input is required' }, 400);

  try {
    const result = await runAgentLLM(
      c as Parameters<typeof app.post>[1] & { env: Env },
      buildAgentUserPrompt(body),
      buildAgentSystemPrompt()
    ) as AgentActionResponse;

    // Ensure required fields have defaults
    result.intent  ??= 'UNKNOWN';
    result.message ??= 'Action processed.';
    result.fields  ??= {};

    return c.json(result);
  } catch (e) {
    return c.json({ error: 'Agent action failed', detail: String(e), intent: 'UNKNOWN', message: 'Backend error — please retry.' }, 500);
  }
});

export default app;
