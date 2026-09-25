/**
 * FlashBar for Salesforce — Cloudflare Workers entry point.
 * Uses @cf/meta/llama-3.2-3b-instruct for Noul/Choice/Score evaluation.
 * Zero cold starts · Global edge network · Free tier.
 *
 * Deploy: npx wrangler deploy
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { SystemOneRequest, SystemOneResponse, Question, Answer } from './types.js';
import {
  INTENT_QUESTION,
  HAS_AMOUNT_FILTER_QUESTION,
  HAS_DATE_FILTER_QUESTION,
  IS_INACTIVE_QUERY,
  buildSObjectQuestion,
  buildSoqlFilterFromJev,
  extractSimpleUpdate,
  getChoiceAnswer,
  getNoulAnswer,
  STANDARD_SYNONYM_MAP,
  type JevIntent,
  type CustomSObjectEntry,
} from './engine/jev-intent.js';

import {
  compileQuery,
  shouldUseSosl,
  DEFAULT_GRAMMAR_RULES,
  type GrammarRules,
  type FieldTypeSchema,
  type ChildRelationship,
  type CompilerInput,
} from './engine/soqlCompiler.js';

import {
  detectQueryEngine,
  compileDataCloudQuery,
  type DataCloudObjectMeta,
  type DataCloudCompilerInput,
} from './engine/dataCloudSqlCompiler.js';

interface CfAiTextInput {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  max_tokens?: number;
  temperature?: number;
}

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface KVNamespace {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface AiCredits {
  totalGranted: number;
  remaining:    number;
  resetDate:    string;  // ISO 8601
}

interface TenantConfig {
  orgId:             string;
  plan:              'FREE_TRIAL' | 'STARTER' | 'ENTERPRISE' | 'DEV_SANDBOX';
  defaultLanguage:   string;
  maxLicensedSeats?: number;
  assignedUserIds?:  string[];
  aiCredits?:        AiCredits;
  features: {
    autoAddressJP:         boolean;
    selfLearningKnowledge: boolean;
  };
  customRules?: Array<{ sObject: string; rule: string }>;
}

interface Env {
  AI: {
    run(model: string, input: CfAiTextInput): Promise<{ response: string }>;
  };
  TENANT_KV?:             KVNamespace;   // Cloudflare KV — tenant profiles by Org ID
  RATE_LIMITER?:          RateLimiter;   // Cloudflare rate limiting — per Org ID
  ANTHROPIC_CLIENT_ID?:   string;        // Registered Anthropic OAuth client ID
  ANTHROPIC_CLIENT_SECRET?: string;      // Registered Anthropic OAuth client secret
  WORKER_BASE_URL?:       string;        // Public base URL of this Worker (e.g. https://flash-agent-stack.*.workers.dev)
}

const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

// Used only for endpoints generating longer free-text reasoning (Case Triage,
// Lead Qualify) — the 8B model's Japanese output can degrade into a repeated-
// phrase loop or garbled mixed-script text. The 70B "fast" variant has much
// stronger multilingual generation at the cost of higher latency/neuron usage,
// which is an acceptable trade here since these aren't the sub-second NLU/SOQL
// classification paths (agent-action, jev-classify, etc. stay on MODEL).
const REASONING_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/', (c) =>
  c.json({
    name: 'FlashBar for Salesforce — Backend',
    model: MODEL,
    endpoints: {
      systemone:      'POST /v1/systemone',
      agentAction:    'POST /v1/agent-action',
      explainFormula: 'POST /v1/explain-formula',
      translateRule:  'POST /v1/translate-rule',
      jpAddress:      'POST /v1/jp-address',
      csvMap:         'POST /v1/csv-map',
    },
    note: 'LLM-based evaluation + FlashBar intent routing',
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

export function extractJson(raw: string): Record<string, unknown> {
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

// ── Multi-tenant resolver ──────────────────────────────────────────────────────
// Extracts Salesforce Org ID from the request header, enforces per-tenant rate
// limiting, and loads (or auto-provisions) the tenant config from KV.
// Returns null when no org ID header is present (dev/anonymous callers proceed).

// Free actions consume 0 credits (no LLM call)
const FREE_ACTION_PATHS = new Set(['/v1/jp-address']);
const FREE_TRIAL_CREDITS = 500;

function nextMonthIso(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

export function localize(enMsg: string, jaMsg: string, lang: string | null): string {
  return (lang && lang.startsWith('ja')) ? jaMsg : enMsg;
}

async function resolveTenant(
  req: Request,
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  { consumeCredit = false } = {}
): Promise<{ orgId: string; config: TenantConfig } | null> {
  const orgId = req.headers.get('X-Salesforce-Org-Id');
  if (!orgId) return null;

  const lang = req.headers.get('X-User-Language');

  // Rate-limit per Org ID (no-op if binding not provisioned)
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: orgId });
    if (!success) {
      throw Object.assign(new Error(localize(
        'Rate limit exceeded for your Salesforce Org.',
        'リクエストが多すぎます。しばらくしてから再試行してください。',
        lang
      )), { status: 429 });
    }
  }

  // Detect Developer / Sandbox orgs.
  // The org-ID pattern alone is unreliable (15-char IDs never embed "dev"/"sand").
  // Cross-check with the instance URL header sent by Apex (System.Url.getOrgDomainUrl).
  const instanceUrl = req.headers.get('X-Salesforce-Instance-Url') ?? '';
  const isDevSandbox = /^00D[a-zA-Z0-9]{9}(sand|dev|scratch)/i.test(orgId)
    || /\.(develop|sandbox|scratch|partial|trailblaze|demo)\./i.test(instanceUrl)
    || /\.cloudforce\.com/i.test(instanceUrl);

  // Load tenant config from KV, auto-provision on first request
  let config: TenantConfig | null = null;
  if (env.TENANT_KV) {
    config = (await env.TENANT_KV.get(`tenant:${orgId}`, 'json')) as TenantConfig | null;
    if (!config) {
      config = {
        orgId,
        plan:            isDevSandbox ? 'DEV_SANDBOX' : 'FREE_TRIAL',
        defaultLanguage: req.headers.get('X-User-Language') ?? 'en',
        features:        { autoAddressJP: true, selfLearningKnowledge: isDevSandbox },
        aiCredits:       isDevSandbox
          ? { totalGranted: 999999, remaining: 999999, resetDate: '2099-01-01T00:00:00Z' }
          : { totalGranted: FREE_TRIAL_CREDITS, remaining: FREE_TRIAL_CREDITS, resetDate: nextMonthIso() },
      };
      ctx.waitUntil(env.TENANT_KV.put(`tenant:${orgId}`, JSON.stringify(config)));
    } else if (isDevSandbox && config.plan === 'FREE_TRIAL') {
      // Promote stale FREE_TRIAL configs when instance URL now reveals this is a dev/sandbox org.
      // This fixes the case where the config was provisioned before the instance URL header was sent.
      config.plan     = 'DEV_SANDBOX';
      config.aiCredits = { totalGranted: 999999, remaining: 999999, resetDate: '2099-01-01T00:00:00Z' };
      config.features  = { ...config.features, selfLearningKnowledge: true };
      ctx.waitUntil(env.TENANT_KV.put(`tenant:${orgId}`, JSON.stringify(config)));
    }

    // Seat auto-assignment
    const userId = req.headers.get('X-Salesforce-User-Id');
    if (userId && config.maxLicensedSeats != null) {
      const seats = config.assignedUserIds ?? [];
      if (!seats.includes(userId)) {
        if (seats.length >= config.maxLicensedSeats) {
          throw Object.assign(new Error(localize(
            'Seat limit reached for FlashBar. Contact your Salesforce Admin to add seats.',
            'FlashBar のシート数上限に達しました。Salesforce 管理者にご連絡ください。',
            lang
          )), { status: 403 });
        }
        config.assignedUserIds = [...seats, userId];
        ctx.waitUntil(env.TENANT_KV.put(`tenant:${orgId}`, JSON.stringify(config)));
      }
    }

    // Credit enforcement for AI actions
    if (consumeCredit && config.plan === 'FREE_TRIAL' && config.aiCredits) {
      if (config.aiCredits.remaining <= 0) {
        throw Object.assign(new Error(localize(
          'Your org has used all 500 free AI credits. Upgrade to continue using FlashBar AI actions.',
          '無料 AI クレジット 500 件をすべて使用しました。引き続きご利用いただくにはアップグレードをご検討ください。',
          lang
        )), { status: 402 });
      }
      config.aiCredits.remaining -= 1;
      ctx.waitUntil(env.TENANT_KV.put(`tenant:${orgId}`, JSON.stringify(config)));
    }
  } else {
    config = {
      orgId,
      plan:            isDevSandbox ? 'DEV_SANDBOX' : 'FREE_TRIAL',
      defaultLanguage: req.headers.get('X-User-Language') ?? 'en',
      features:        { autoAddressJP: true, selfLearningKnowledge: true },
    };
  }

  return { orgId, config };
}

// ── Main route ─────────────────────────────────────────────────────────────────

app.onError((err, c) => {
  const status = (err as { status?: number }).status ?? 500;
  return c.json({ error: err.message ?? 'Unhandled exception' }, status as 400 | 402 | 403 | 429 | 500 | 502);
});


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

// ── KV schema cache helpers ────────────────────────────────────────────────────
// Workers cache sObject field API names (TTL 1 h) so the SOQL template builder
// can validate fields without a round-trip to Salesforce.

const SCHEMA_KV_TTL = 3600;  // 1 hour

async function loadSchemaFromKv(orgId: string, sObject: string, kv: KVNamespace | undefined): Promise<Set<string>> {
  if (!kv) return new Set();
  try {
    const cached = (await kv.get(`schema:${orgId}:${sObject}`, 'json')) as string[] | null;
    if (Array.isArray(cached)) return new Set(cached);
  } catch { /* KV miss — return empty set, template will skip field validation */ }
  return new Set();
}

async function cacheSchemaInKv(orgId: string, sObject: string, fields: string[], kv: KVNamespace | undefined): Promise<void> {
  if (!kv || fields.length === 0) return;
  await kv.put(`schema:${orgId}:${sObject}`, JSON.stringify(fields), { expirationTtl: SCHEMA_KV_TTL });
}

// ── Field type + relationship KV helpers ──────────────────────────────────────
// Apex seeds per-sObject field descriptors (type + relationshipName + referenceTo)
// and childRelationships so the SOQL compiler can validate and construct
// cross-object fields and nested subqueries without calling Salesforce.

async function loadFieldTypesFromKv(orgId: string, sObject: string, kv: KVNamespace | undefined): Promise<FieldTypeSchema> {
  if (!kv) return {};
  try {
    const cached = (await kv.get(`ftypes:${orgId}:${sObject}`, 'json')) as FieldTypeSchema | null;
    return cached && typeof cached === 'object' ? cached : {};
  } catch { return {}; }
}

async function cacheFieldTypesInKv(orgId: string, sObject: string, schema: FieldTypeSchema, kv: KVNamespace | undefined): Promise<void> {
  if (!kv || Object.keys(schema).length === 0) return;
  await kv.put(`ftypes:${orgId}:${sObject}`, JSON.stringify(schema), { expirationTtl: SCHEMA_KV_TTL });
}

async function loadChildRelsFromKv(orgId: string, sObject: string, kv: KVNamespace | undefined): Promise<Record<string, ChildRelationship>> {
  if (!kv) return {};
  try {
    const cached = (await kv.get(`crels:${orgId}:${sObject}`, 'json')) as Record<string, ChildRelationship> | null;
    return cached && typeof cached === 'object' ? cached : {};
  } catch { return {}; }
}

async function cacheChildRelsInKv(orgId: string, sObject: string, rels: Record<string, ChildRelationship>, kv: KVNamespace | undefined): Promise<void> {
  if (!kv || Object.keys(rels).length === 0) return;
  await kv.put(`crels:${orgId}:${sObject}`, JSON.stringify(rels), { expirationTtl: SCHEMA_KV_TTL });
}

async function loadGrammarRulesFromKv(kv: KVNamespace | undefined): Promise<GrammarRules> {
  if (!kv) return DEFAULT_GRAMMAR_RULES;
  try {
    const cached = (await kv.get('soql_sosl_grammar_rules', 'json')) as GrammarRules | null;
    return cached ?? DEFAULT_GRAMMAR_RULES;
  } catch { return DEFAULT_GRAMMAR_RULES; }
}

// ── Custom sObject KV helpers ──────────────────────────────────────────────────
// Apex seeds the org's custom object list once per session.
// Worker uses it to build dynamic Jev Choice criteria at classification time.

async function loadCustomSObjectsFromKv(orgId: string, kv: KVNamespace | undefined): Promise<CustomSObjectEntry[]> {
  if (!kv) return [];
  try {
    const cached = (await kv.get(`sobjects:${orgId}`, 'json')) as CustomSObjectEntry[] | null;
    return Array.isArray(cached) ? cached : [];
  } catch { return []; }
}

async function cacheCustomSObjectsInKv(orgId: string, objects: CustomSObjectEntry[], kv: KVNamespace | undefined): Promise<void> {
  if (!kv || objects.length === 0) return;
  await kv.put(`sobjects:${orgId}`, JSON.stringify(objects), { expirationTtl: SCHEMA_KV_TTL });
}

// ── Data Cloud DMO/DLO catalog KV helpers ─────────────────────────────────────
// Apex seeds the org's Data Cloud object catalog once per session.
// Worker uses it to route queries to the DC SQL compiler instead of SOQL.

async function loadDataCloudCatalogFromKv(orgId: string, kv: KVNamespace | undefined): Promise<Record<string, DataCloudObjectMeta>> {
  if (!kv) return {};
  try {
    const cached = (await kv.get(`datacloud:${orgId}`, 'json')) as Record<string, DataCloudObjectMeta> | null;
    return cached && typeof cached === 'object' ? cached : {};
  } catch { return {}; }
}

async function cacheDataCloudCatalogInKv(orgId: string, catalog: Record<string, DataCloudObjectMeta>, kv: KVNamespace | undefined): Promise<void> {
  if (!kv || Object.keys(catalog).length === 0) return;
  await kv.put(`datacloud:${orgId}`, JSON.stringify(catalog), { expirationTtl: SCHEMA_KV_TTL });
}

// ── Synonym KV helpers ─────────────────────────────────────────────────────────
// Apex can seed org-specific synonym aliases (e.g. "注文" → "Purchase_Order__c")
// into KV so the Worker resolves them before the lexical keyword scan.

async function loadSynonymsFromKv(orgId: string, kv: KVNamespace | undefined): Promise<Record<string, string>> {
  if (!kv) return {};
  try {
    const cached = (await kv.get(`synonyms:${orgId}`, 'json')) as Record<string, string> | null;
    return cached && typeof cached === 'object' ? cached : {};
  } catch { return {}; }
}

async function cacheSynonymsInKv(orgId: string, synonyms: Record<string, string>, kv: KVNamespace | undefined): Promise<void> {
  if (!kv || Object.keys(synonyms).length === 0) return;
  await kv.put(`synonyms:${orgId}`, JSON.stringify(synonyms), { expirationTtl: SCHEMA_KV_TTL });
}

// ── sObject keyword fallback for Jev 'Other' answers ─────────────────────────
// Resolution order:
//   1. STANDARD_SYNONYM_MAP (hardcoded standard-object JP aliases)
//   2. KV org-specific synonyms (seeded by Apex via /v1/synonyms-seed)
//   3. Lexical scan of full custom-object catalog (apiStem, label, pluralLabel)
// First match wins; returns null if nothing found.

function matchSObjectByKeyword(
  userInput: string,
  allObjects: CustomSObjectEntry[],
  orgSynonyms: Record<string, string> = {}
): string | null {
  const lower = userInput.toLowerCase();

  // 1. Standard synonym map (word boundary check for short terms to avoid false positives)
  for (const [synonym, apiName] of Object.entries(STANDARD_SYNONYM_MAP)) {
    if (synonym.length >= 3 && lower.includes(synonym.toLowerCase())) return apiName;
  }

  // 2. Org-specific KV synonyms
  for (const [synonym, apiName] of Object.entries(orgSynonyms)) {
    if (lower.includes(synonym.toLowerCase())) return apiName;
  }

  // 3. Lexical scan of full custom-object catalog
  if (allObjects.length === 0) return null;
  for (const obj of allObjects) {
    const apiStem   = obj.apiName.toLowerCase().replace(/__c$/, '').replace(/_/g, ' ');
    const labelLow  = obj.label.toLowerCase();
    const pluralLow = obj.pluralLabel.toLowerCase();
    if (lower.includes(apiStem) || lower.includes(labelLow) || lower.includes(pluralLow)) {
      return obj.apiName;
    }
  }
  return null;
}

// ── Jev parallel intent + sObject classification ───────────────────────────────
// Replaces the monolithic LLM call for SOQL_SEARCH intents. Runs 2 Jev Choice
// questions + 3 Noul questions in a SINGLE LLM call (serialized JSON payload),
// achieving parallel semantic evaluation in one round-trip.

interface JevClassifyResult {
  intent:    JevIntent;
  sObject:   string | null;
  confidence: number;
  hasAmount: number;
  hasDate:   number;
  isInactive: number;
}

async function classifyWithJev(
  c: Parameters<typeof app.post>[1] & { env: Env },
  userInput: string,
  sObjectContext: string | null,
  customObjects: CustomSObjectEntry[] = [],
  orgSynonyms: Record<string, string> = {}
): Promise<JevClassifyResult> {
  const state = JSON.stringify({
    user_input:       userInput,
    sobject_context:  sObjectContext ?? 'unknown',
  });

  // Build sObject question dynamically — includes org custom objects from KV.
  const sObjectQuestion = buildSObjectQuestion(customObjects);

  const questions: Record<string, Question> = {
    intent:      INTENT_QUESTION,
    sobject:     sObjectQuestion,
    has_amount:  HAS_AMOUNT_FILTER_QUESTION,
    has_date:    HAS_DATE_FILTER_QUESTION,
    is_inactive: IS_INACTIVE_QUERY,
  };

  const raw = await c.env.AI.run(MODEL, {
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user',   content: buildUserPrompt(state, questions) },
    ],
    max_tokens: 400,
    temperature: 0.05,
  });

  const cfOut = raw as { response?: unknown; choices?: Array<{ message?: { content?: string } }> };
  let parsed: Record<string, unknown>;
  if (cfOut.response && typeof cfOut.response === 'object') {
    parsed = cfOut.response as Record<string, unknown>;
  } else {
    const text = cfOut.choices?.[0]?.message?.content ?? (typeof cfOut.response === 'string' ? cfOut.response : '{}');
    parsed = extractJson(text as string);
  }

  const answers: Record<string, Answer> = {};
  for (const [key, q] of Object.entries(questions)) {
    answers[key] = parseAnswer(key, q, parsed[key]);
  }

  const intentAns  = getChoiceAnswer(answers, 'intent');
  const sObjAns    = getChoiceAnswer(answers, 'sobject');
  const hasAmtAns  = getNoulAnswer(answers,   'has_amount');
  const hasDateAns = getNoulAnswer(answers,   'has_date');
  const inactiveAns = getNoulAnswer(answers,  'is_inactive');

  // When Jev answers 'Other', try synonym map + keyword scan before giving up.
  const jevSObject = sObjAns?.choice !== 'Other' ? (sObjAns?.choice ?? null) : null;
  const resolvedSObject = jevSObject ?? matchSObjectByKeyword(userInput, customObjects, orgSynonyms);

  return {
    intent:     (intentAns?.choice ?? 'UNKNOWN') as JevIntent,
    sObject:    resolvedSObject,
    confidence: intentAns?.confidence ?? 0,
    hasAmount:  hasAmtAns?.noul  ?? 0,
    hasDate:    hasDateAns?.noul ?? 0,
    isInactive: inactiveAns?.noul ?? 0,
  };
}

// ── /v1/agent-action — FlashBar intent routing ───────────────────────────────

interface AgentActionRequest {
  user_input:    string;
  sObjectType?:  string;
  recordId?:     string;
  pageType?:     string;
  field_schema?: string[];   // ["Label=ApiName", ...] from Apex schema describe
  userLanguage?: string;     // e.g. "ja", "en_US"
}

interface SoqlCondition {
  field: string;
  op:    'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'not_in' | 'is_null' | 'not_null';
  value?: string | number | boolean | string[] | null;
}

interface AgentActionResponse {
  intent:           string;   // NAVIGATE | UPDATE_RECORD | PREFILL | SEARCH | SOQL_SEARCH | ADD_FIELDS | GUIDE_CREATE | EXPLAIN_FIELD | EXPLAIN_FORMULA | NAVIGATE_SETUP | CLARIFY | UNKNOWN
  confidence?:      number;   // 0–100: model's self-assessed confidence. Below 85 → auto-promote to CLARIFY
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
  guide_sobject?:   string;   // GUIDE_CREATE: sObject to guide on
  field_name?:      string;   // EXPLAIN_FIELD / EXPLAIN_FORMULA: field label or API name
  soql_filter?: {
    conditions: SoqlCondition[];
    order_by?:  string;       // e.g. "Amount DESC"
    limit?:     number;       // 1–50, default 20
  };
  fields_to_add?:   string[]; // ADD_FIELDS: additional field API names to show in results
  setup_node?:      string;   // NAVIGATE_SETUP: Salesforce Lightning Setup node name (e.g. "ManageUsers")
  setup_search_term?: string; // NAVIGATE_SETUP: fallback search term if setup_node is unknown
  analytics_request?: string; // CREATE_DASHBOARD / CREATE_REPORT: user's original request (passed through for Claude)
}

function buildAgentSystemPrompt(userLanguage = 'en'): string {
  const isJa = userLanguage.startsWith('ja');
  return `You are a Salesforce AI assistant that converts natural language user input into structured JSON actions.
${isJa ? 'The user is writing in Japanese. Return "message" field in Japanese.' : ''}

Intents:
- NAVIGATE: user wants to open a SPECIFIC record, URL, or named page (e.g. "go to", "open", "show me [specific record name]", "開く", "移動"). NAVIGATE is for navigation only — NOT for displaying a list of filtered records.
- UPDATE_RECORD: user wants to save field changes (e.g. "update", "set", "change", "save", "更新", "変更", "保存")
- PREFILL: user wants to pre-fill fields without saving (e.g. "fill in", "put", "pre-fill", "入力", "記入")
- EXTRACT: user pasted unstructured text (email body, meeting notes, business card) — extract entities as field values (also acceptable: EXTRACT_AND_PREFILL)
- SEARCH: user wants a text-based record lookup by name (e.g. "find XYZ Corp", "search for Tanaka", "探す", "検索")
- SOQL_SEARCH: user wants to display a filtered list of records — amounts, dates, recency, activity, stage, owner, or any field condition (e.g. "先月の1000万以上の商談", "放置されている案件", "今月のヨミ", "要フォローのリード", "未連絡の大型案件", "show opportunities over 10M from last month", "show recent opportunities", "show recently created leads", "show this week's accounts", "list open cases"). Use this whenever the user says "show [object type]" without referencing a specific record by name.
  → Return soql_filter with structured conditions (NOT raw SOQL text). Ops: eq, neq, gt, gte, lt, lte, like, in, not_in, is_null, not_null. Safe date literals: TODAY, THIS_WEEK, THIS_MONTH, LAST_MONTH, THIS_YEAR, LAST_WEEK, LAST_N_DAYS:N. Use LAST_N_DAYS:14 for "放置" / "未連絡" / "inactive" (LastActivityDate lt LAST_N_DAYS:14).
- ADD_FIELDS: user wants to add display columns to the current search results (e.g. "電話番号も見せて", "担当者も追加して", "競合他社を追加", "show phone too"). Only valid when search results are already showing.
  → Return fields_to_add as field API names from field_schema. Do NOT re-issue a new soql_filter.
- GUIDE_CREATE: user wants to create a new record and needs a field checklist (e.g. "how do I create a Lead?", "what do I need for an Opportunity?", "新規リードを作成するには?", "新規取引先を登録したい", "取引先を追加したい")
- EXPLAIN_FIELD: user asks about a specific field's meaning, purpose, or requirements (e.g. "what is ACV?", "what does Stage mean?", "ARRとは何ですか?", "why is Amount required?")
- EXPLAIN_FORMULA: user asks how a calculated field is derived (e.g. "how is Expected Revenue calculated?", "explain the Margin formula", "期待収益はどう計算されますか?")
- NAVIGATE_SETUP: user wants to open a Salesforce Setup/管理メニュー page (e.g. "ユーザー追加したい", "プロファイルを開いて", "フローを確認したい", "設定を開いて", "open Setup", "go to object manager")
  → Set setup_node to the matching Lightning Setup node name. If uncertain, omit setup_node and set setup_search_term to the key Japanese/English keyword so the user can search manually.
  Salesforce Setup node dictionary (use EXACT spelling):
  ユーザー管理/ユーザー追加/パスワードリセット → ManageUsers
  プロファイル/権限プロファイル → Profiles
  権限セット/パーミッションセット → PermSets
  ロール/ロール階層 → Roles
  オブジェクトマネージャ/カスタムオブジェクト/カスタム項目/フィールド追加 → ObjectManager
  フロー/フロービルダー/プロセスビルダー/自動化 → ProcessAutomations
  ワークフロールール → LegacyWorkflows
  承認プロセス/承認申請 → ApprovalProcesses
  会社情報/組織情報/組織ID/ライセンス → CompanyProfile
  セッション設定/セキュリティ設定 → SessionSettings
  パスワードポリシー → PasswordPolicies
  ネットワークアクセス/IP制限 → NetworkAccess
  リモートサイト設定/外部連携 → RemoteSiteSetting
  カスタム設定 → CustomSettings
  カスタムメタデータ型 → CustomMetadataTypes
  接続アプリケーション/OAuth/API連携 → ConnectedApplication
  ドメイン/マイドメイン → MyDomain
  アプリケーションマネージャ/アプリ管理 → AppManager
  メールテンプレート → EmailTemplates
  レポートタイプ → ReportTypes
  Apexクラス/Apex → ApexClasses
  Visualforceページ → ApexPages
  デバッグログ/ログ確認 → ApexSystemLog
  翻訳設定/多言語 → ExpressionSetObjectAlias (note: use search_term fallback for translations)
  データインポートウィザード/データ移行 → DataManagementDataImporter
  ストレージ使用状況/データ容量 → CompanyProfile
- CREATE_REPORT: user wants to create a new Salesforce report (e.g. "フェーズ別の商談レポートを作って", "リードの月次レポート", "create a report for opportunities by stage", "レポートを作成して")
  → Set analytics_request to the user's full verbatim request. Set sObjectType to the relevant object.
- CREATE_DASHBOARD: user wants to create a new Salesforce dashboard (e.g. "ダッシュボードを作って", "今月の売上ダッシュボード", "create a sales dashboard", "KPIダッシュボードが欲しい")
  → Set analytics_request to the user's full verbatim request. Set sObjectType to the primary relevant object.
- UNKNOWN: cannot determine intent, OR the target sObject cannot be determined with high confidence — ask the user to clarify

Japanese → Salesforce API name mapping (ALWAYS use API names in your response, never Japanese labels):
取引先 → Account | 連絡先 / 取引先責任者 → Contact | リード → Lead | 商談 → Opportunity | ケース → Case | キャンペーン → Campaign | 行動 / タスク → Task

Clarification rule:
- If the target sObject or action is AMBIGUOUS and cannot be inferred with high confidence,
  return intent: "CLARIFY" with message as a short question in the user's language.
- Example: "新しいのを作りたい" (ambiguous, no sObject)
  → { "intent": "CLARIFY", "message": "どのオブジェクトを新規作成しますか？（取引先・連絡先・商談・リードなど）", "fields": {} }

Confidence rule:
- After choosing the intent, assign a "confidence" score (0–100) reflecting how certain you are.
- If confidence < 85 AND intent is not already CLARIFY or UNKNOWN: set intent to "CLARIFY" and write a short clarifying question in "message".
- Always include "confidence" in your response.

Return ONLY valid JSON matching this schema (no markdown, no extra text):
{
  "intent": "<NAVIGATE|UPDATE_RECORD|PREFILL|EXTRACT|SEARCH|SOQL_SEARCH|ADD_FIELDS|GUIDE_CREATE|EXPLAIN_FIELD|EXPLAIN_FORMULA|NAVIGATE_SETUP|CREATE_REPORT|CREATE_DASHBOARD|CLARIFY|UNKNOWN>",
  "confidence": <0–100>,
  "message": "<brief summary OR clarifying question in the user's language>",
  "sObjectType": "<API name of target sObject, or null>",
  "recordId": "<record ID to update, or null>",
  "fields": { "<FieldApiName>": <value>, ... },
  "should_save": <true|false>,
  "target_record_id": "<record ID to navigate to, or null>",
  "target_sobject": "<sObject API name for list navigation, or null>",
  "search_name": "<name/keyword to search for, or null>",
  "search_query": "<SOSL search term, or null>",
  "search_sobject": "<sObject to search in, or null>",
  "guide_sobject": "<sObject API name for GUIDE_CREATE, or null>",
  "field_name": "<field label or API name for EXPLAIN_FIELD/EXPLAIN_FORMULA, or null>",
  "soql_filter": { "conditions": [{"field":"<ApiName>","op":"<op>","value":<val>}], "order_by": "<field> DESC", "limit": 20 },
  "fields_to_add": ["<ApiName>", ...],
  "setup_node": "<Lightning Setup node name, or null>",
  "setup_search_term": "<keyword for Setup search fallback, or null>",
  "analytics_request": "<verbatim user request for CREATE_REPORT/CREATE_DASHBOARD, or null>"
}

NAVIGATE_SETUP examples (Japanese):
"ユーザーを追加したい" → {"intent":"NAVIGATE_SETUP","setup_node":"ManageUsers","setup_search_term":null,"message":"ユーザー管理設定を開きます","fields":{}}
"フローを確認したい" → {"intent":"NAVIGATE_SETUP","setup_node":"ProcessAutomations","setup_search_term":null,"message":"フロービルダーを開きます","fields":{}}
"シングルサインオンの設定を開いて" → {"intent":"NAVIGATE_SETUP","setup_node":null,"setup_search_term":"シングルサインオン","message":"Salesforce設定を開きました。検索バーで「シングルサインオン」を検索してください。","fields":{}}

SOQL_SEARCH examples (Japanese):
"先月作成した1000万以上の商談" (Opportunity context) → {"intent":"SOQL_SEARCH","search_sobject":"Opportunity","soql_filter":{"conditions":[{"field":"Amount","op":"gte","value":10000000},{"field":"CreatedDate","op":"eq","value":"LAST_MONTH"}],"order_by":"Amount DESC","limit":20},"message":"先月作成した1,000万以上の商談を検索します","fields":{}}
"今月完了予定の商談" (Opportunity context) → {"intent":"SOQL_SEARCH","search_sobject":"Opportunity","soql_filter":{"conditions":[{"field":"CloseDate","op":"eq","value":"THIS_MONTH"}],"order_by":"CloseDate ASC","limit":20},"message":"今月完了予定の商談を検索します","fields":{}}
"来月クローズ予定の案件" (Opportunity context) → {"intent":"SOQL_SEARCH","search_sobject":"Opportunity","soql_filter":{"conditions":[{"field":"CloseDate","op":"eq","value":"NEXT_MONTH"}],"order_by":"CloseDate ASC","limit":20},"message":"来月クローズ予定の商談を検索します","fields":{}}
"放置されている案件" (Opportunity context) → {"intent":"SOQL_SEARCH","search_sobject":"Opportunity","soql_filter":{"conditions":[{"field":"IsClosed","op":"eq","value":false},{"field":"LastActivityDate","op":"lt","value":"LAST_N_DAYS:14"}],"order_by":"LastActivityDate ASC","limit":20},"message":"14日以上活動のない商談を検索します","fields":{}}
"show recent opportunities" → {"intent":"SOQL_SEARCH","search_sobject":"Opportunity","soql_filter":{"conditions":[{"field":"CreatedDate","op":"gte","value":"LAST_N_DAYS:30"}],"order_by":"CreatedDate DESC","limit":20},"message":"Recently created opportunities","fields":{}}
"show recently created leads" → {"intent":"SOQL_SEARCH","search_sobject":"Lead","soql_filter":{"conditions":[{"field":"CreatedDate","op":"gte","value":"LAST_N_DAYS:30"}],"order_by":"CreatedDate DESC","limit":20},"message":"Recently created leads","fields":{}}
"show this week's accounts" → {"intent":"SOQL_SEARCH","search_sobject":"Account","soql_filter":{"conditions":[{"field":"CreatedDate","op":"gte","value":"THIS_WEEK"}],"order_by":"CreatedDate DESC","limit":20},"message":"Accounts created this week","fields":{}}
"how many closed cases" → {"intent":"SOQL_SEARCH","search_sobject":"Case","soql_filter":{"conditions":[{"field":"IsClosed","op":"eq","value":true}],"order_by":"CreatedDate DESC","limit":20},"message":"Closed cases","fields":{}}
"show open cases" → {"intent":"SOQL_SEARCH","search_sobject":"Case","soql_filter":{"conditions":[{"field":"IsClosed","op":"eq","value":false}],"order_by":"CreatedDate DESC","limit":20},"message":"Open cases","fields":{}}
"クローズしたケース" → {"intent":"SOQL_SEARCH","search_sobject":"Case","soql_filter":{"conditions":[{"field":"IsClosed","op":"eq","value":true}],"order_by":"CreatedDate DESC","limit":20},"message":"クローズ済みのケースを検索します","fields":{}}
ADD_FIELDS example:
"電話番号と担当者も追加で見せて" (results already showing) → {"intent":"ADD_FIELDS","fields_to_add":["Phone","OwnerId"],"message":"電話番号と担当者を追加します","fields":{}}

Field rules:
- Use exact Salesforce API field names from field_schema (format: "Label=ApiName")
- Numbers must be numbers: Amount: 500000 not "500000"
- Japanese number units: 万=10000, 億=100000000 (e.g. "100万" → 1000000, "5000万" → 50000000)
- Dates in YYYY-MM-DD format
- Picklist values use their API values (e.g. "Closed Won" for StageName)

Navigation rules:
- For NAVIGATE: ALWAYS set search_name AND search_sobject
  - Company/org names → search_sobject: "Account"
  - Person names → search_sobject: "Contact"
  - Deal names → search_sobject: "Opportunity"
  - Case subjects → search_sobject: "Case"
  - Lead names → search_sobject: "Lead"
  - List only (no specific record) → set target_sobject instead of search_name
- For SEARCH: set search_query and search_sobject

Address field rules (CRITICAL):
- NEVER use: BillingAddress, ShippingAddress, MailingAddress, OtherAddress (not writable)
- Use component fields: BillingStreet, BillingCity, BillingPostalCode, BillingCountryCode, BillingStateCode
- Copy billing→shipping: fields: { "__copyAddress": "BillingToShipping" }
- Copy shipping→billing: fields: { "__copyAddress": "ShippingToBilling" }
- Server resolves __copyAddress — do NOT fill individual values

Relative field operations ("add X%", "increase by", "push date by N days/weeks"):
- Return __relativeOps array — do NOT guess current values:
  fields: { "__relativeOps": [{ "field": "ApiName", "op": "<op>", "value": <number> }] }
- Ops: "percent_add", "add", "subtract" (numeric) | "add_days", "subtract_days", "add_weeks", "subtract_weeks", "add_months", "subtract_months" (date)
- Mix with regular fields: { "StageName": "Negotiation", "__relativeOps": [{ "field": "Amount", "op": "percent_add", "value": 10 }] }
- Example: "Add 10% to Amount and push Close Date by 2 weeks"
  → fields: { "__relativeOps": [{"field":"Amount","op":"percent_add","value":10},{"field":"CloseDate","op":"add_weeks","value":2}] }

Paste-to-record / EXTRACT (meeting notes, emails, business cards):
- Trigger EXTRACT when input is unstructured text longer than ~30 words, or explicitly pasted content
- Extract ALL business-relevant values: names, email, phone, title, company, dates, amounts, stage/status
- Use today's date (from context) to resolve relative dates:
  - "来年3月末" with today=2026-09-21 → "2027-03-31"
  - "来月末" → last day of next month
  - "今月末" → last day of current month
  - "11月末" → YYYY-11-30 using current year (or next year if already past)
- Date extraction rules (CRITICAL):
  - IGNORE meeting/event header dates (日時: / 開催日 / 実施日) — those are when the meeting happened, NOT CloseDate
  - Use ONLY deal-specific dates for CloseDate: 契約予定日 / クローズ予定 / 導入目標 / 納入予定 / 契約締結予定
- Japanese meeting note patterns to extract:
  - "見積金額" / "見積額" / "予算規模" / "〜万円" / "〜億円" → Amount (numeric; 万=×10000, 億=×100000000)
  - "契約予定日" / "クローズは〜" / "〜年〜月末" / "導入目標は〜" → CloseDate
  - "提案／見積提示" / "見積提示" / "提案依頼を受領" / "RFP作成段階" → StageName: "Proposal/Price Quote"
  - "提案書送付" / "提案中" → StageName: "Value Proposition"
  - "価格交渉" / "最終調整" → StageName: "Negotiation/Review"
  - "検討中" / "初回面談" → StageName: "Prospecting"
  - "契約締結" / "受注" → StageName: "Closed Won"
  - "次のアクション" / "■ネクストステップ" / アクションテーブルの内容 → NextStep field (summarize as plain text)
  - Overview/summary paragraph → Description field
- Do NOT extract: 場所/開催場所/会議室/Zoom URL → these are meeting venues, NOT record fields
- Map extracted company name to AccountId lookup if Account field is in schema; otherwise skip
- Return intent: "EXTRACT" with ALL matched fields populated (omit fields with null/empty values)
- Example (Japanese meeting note):
  "見積金額 3,800万円（税別）、契約予定日：2026年11月30日、現フェーズ：提案／見積提示"
  → { "intent": "EXTRACT", "fields": { "Amount": 38000000, "CloseDate": "2026-11-30", "StageName": "Proposal/Price Quote" } }`;
}

export function normalizeJapaneseUnits(text: string): string {
  // Strip thousand-separating commas before unit conversion so "5,000万" → "5000万" → "50000000"
  const stripped = text.replace(/(\d),(\d{3})/g, '$1$2');
  // Order: 兆→億→千→万 so compound "5千万" → "5000万" → "50000000"
  return stripped
    .replace(/(\d+(?:\.\d+)?)\s*兆/g, (_, n) => String(parseFloat(n) * 1_000_000_000_000))
    .replace(/(\d+(?:\.\d+)?)\s*億/g, (_, n) => String(parseFloat(n) * 100_000_000))
    .replace(/(\d+(?:\.\d+)?)\s*千/g, (_, n) => String(parseFloat(n) * 1_000))
    .replace(/(\d+(?:\.\d+)?)\s*万/g, (_, n) => String(parseFloat(n) * 10_000));
}

const INPUT_CHAR_LIMIT = 3000;

function buildAgentUserPrompt(req: AgentActionRequest): string {
  const schema = (req.field_schema ?? []).slice(0, 80).join(', ');
  const lang   = req.userLanguage ?? 'en';
  let   raw    = normalizeJapaneseUnits(req.user_input);  // "5,000万" → "50000000" before LLM
  const truncated = raw.length > INPUT_CHAR_LIMIT;
  if (truncated) raw = raw.slice(0, INPUT_CHAR_LIMIT) + '\n[... 文書が長いため前半のみ抽出対象]';
  const today  = new Date().toISOString().split('T')[0];   // YYYY-MM-DD for relative date resolution
  return `Current page context:
- sObject: ${req.sObjectType || 'unknown'}
- recordId: ${req.recordId || 'none'}
- pageType: ${req.pageType || 'other'}
- userLanguage: ${lang}
- today: ${today}
${schema ? `\nAvailable fields (Label=ApiName):\n${schema}` : ''}

User request: "${raw}"

Return the JSON action now:`;
}

async function runAgentLLM(c: Parameters<typeof app.post>[1] & { env: Env }, prompt: string, system: string): Promise<Record<string, unknown>> {
  const raw = await c.env.AI.run(MODEL, {
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: prompt },
    ],
    max_tokens: 1024,
    temperature: 0.1,
  });

  const out = raw as { response?: unknown; choices?: Array<{ message?: { content?: string } }> };
  if (out.response && typeof out.response === 'object') return out.response as Record<string, unknown>;
  const text = out.choices?.[0]?.message?.content ?? (typeof out.response === 'string' ? out.response : '{}');
  return extractJson(text as string);
}

// ── sObject inference helper ──────────────────────────────────────────────────

// Salesforce API name mappings — English keywords and Japanese labels
// API name → Japanese label (for fast-route messages)
const JA_SOBJECT_LABEL: Record<string, string> = {
  Account:     '取引先',
  Contact:     '連絡先',
  Lead:        'リード',
  Opportunity: '商談',
  Case:        'ケース',
  Campaign:    'キャンペーン',
  Task:        '行動',
};

const JA_SOBJECT_MAP: Record<string, string> = {
  '取引先':       'Account',
  '取引先責任者': 'Contact',
  '連絡先':       'Contact',
  'リード':       'Lead',
  '商談':         'Opportunity',
  'ケース':       'Case',
  'キャンペーン': 'Campaign',
  '行動':         'Task',
  'todo':         'Task',
  'タスク':       'Task',
};

export function inferSObjectType(raw: string): string {
  const lower = raw.toLowerCase().trim();
  // Japanese label exact match
  if (JA_SOBJECT_MAP[raw.trim()]) return JA_SOBJECT_MAP[raw.trim()];
  // English keyword match
  if (/account|company|client|firm|取引先/.test(lower))   return 'Account';
  if (/contact|person|連絡先|取引先責任者/.test(lower))    return 'Contact';
  if (/lead|リード/.test(lower))                           return 'Lead';
  if (/opportunit|deal|opp|商談/.test(lower))              return 'Opportunity';
  if (/case|ticket|issue|ケース/.test(lower))              return 'Case';
  if (/campaign|キャンペーン/.test(lower))                 return 'Campaign';
  if (/task|todo|行動|タスク/.test(lower))                 return 'Task';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ── Hybrid fast-route — skips LLM for high-confidence English patterns ────────

export function tryFastRoute(req: AgentActionRequest): AgentActionResponse | null {
  const input = req.user_input.trim();
  if (!input) return null;

  // ── Japanese GUIDE_CREATE fast-route (before CJK guard) ──────────────────
  // "〜を作成したい" / "新規〜" / "〜を登録したい" → never needs LLM
  if (/[　-鿿가-힯＀-￯]/.test(input)) {
    const jaGuide = input.match(
      /(?:新規|新しい)?(.+?)(?:を作成|を登録|の登録|の新規作成|を追加)(?:したい|します|したいです|してください|方法|手順)?/
    );
    if (jaGuide) {
      const rawObj  = jaGuide[1].trim();
      const inferred = inferSObjectType(rawObj);
      // If inferSObjectType returned a CJK string it didn't map — fall back to page context
      const sobj = /[　-鿿가-힯＀-￯]/.test(inferred)
        ? (req.sObjectType || null)
        : inferred;
      if (sobj) {
        const isJa = (req.userLanguage ?? 'en').startsWith('ja');
        const lbl  = JA_SOBJECT_LABEL[sobj] ?? sobj;
        return {
          intent:        'GUIDE_CREATE',
          message:       isJa ? `${lbl} のフィールドガイド` : `Field guide for ${sobj}`,
          guide_sobject: sobj,
          fields:        {},
        };
      }
    }
    // other CJK → LLM
    return null;
  }

  const lower = input.toLowerCase();

  // ── SOQL_SEARCH: "show recent/new/latest/this week's/this month's [object]" ─
  // Handles "show recent opportunities", "show recently created leads", etc.
  // Must be checked BEFORE the NAVIGATE pattern to prevent misrouting.
  const soqlRecentMatch = lower.match(
    /^show(?:\s+me)?\s+(?:recent(?:ly)?(?:\s+created)?|latest|new|today'?s?|this\s+week'?s?|this\s+month'?s?|last\s+week'?s?|last\s+month'?s?)\s+(opportunit(?:ies|y)|accounts?|contacts?|leads?|cases?)/i
  );
  if (soqlRecentMatch) {
    const sobjRaw = soqlRecentMatch[1].replace(/ies$/i, 'y').replace(/s$/i, '');
    const sobj    = inferSObjectType(sobjRaw);
    const timeLit = /this\s+week/i.test(lower)  ? 'THIS_WEEK'
      : /this\s+month/i.test(lower) ? 'THIS_MONTH'
      : /last\s+week/i.test(lower)  ? 'LAST_WEEK'
      : /last\s+month/i.test(lower) ? 'LAST_MONTH'
      : /today/i.test(lower)        ? 'TODAY'
      : 'LAST_N_DAYS:30';
    const isJa = (req.userLanguage ?? 'en').startsWith('ja');
    return {
      intent: 'SOQL_SEARCH',
      message: isJa ? `最近作成した${sobj}を表示します` : `Recently created ${sobj}s`,
      search_sobject: sobj,
      soql_filter: {
        conditions: [{ field: 'CreatedDate', op: 'gte', value: timeLit }],
        order_by: 'CreatedDate DESC',
        limit: 20,
      },
      fields: {},
    };
  }

  // ── SOQL_SEARCH: "show/list/how many [closed|open] cases" ─────────────────
  // Handles status-based Case queries without LLM overhead.
  const caseStatusMatch = lower.match(
    /^(?:show(?:\s+me)?|list(?:\s+all)?|how\s+many)\s+(closed|open|escalated|pending)\s+(?:cases?|tickets?)/i
  );
  if (caseStatusMatch) {
    const statusToken = caseStatusMatch[1].toLowerCase();
    const isClosed    = statusToken === 'closed';
    const isJa        = (req.userLanguage ?? 'en').startsWith('ja');
    const msg         = isJa
      ? (isClosed ? 'クローズ済みのケースを表示します' : 'オープンなケースを表示します')
      : (isClosed ? 'Closed cases' : `${caseStatusMatch[1]} cases`);
    return {
      intent: 'SOQL_SEARCH',
      message: msg,
      search_sobject: 'Case',
      soql_filter: {
        conditions: [{ field: 'IsClosed', op: 'eq', value: isClosed }],
        order_by: 'CreatedDate DESC',
        limit: 20,
      },
      fields: {},
    };
  }

  // ── NAVIGATE ──────────────────────────────────────────────────────────────
  // "show me" only if followed by a specific record name — not temporal/filter keywords
  const navMatch = lower.match(/^(?:go\s+to|open|navigate\s+to)\s+(.+)/)
    ?? (lower.startsWith('show me ') && !/\b(?:recent|latest|new|today|this\s+week|this\s+month|last\s+week|last\s+month|over|above|below|open|closed)\b/.test(lower)
      ? lower.match(/^show\s+me\s+(.+)/)
      : null);
  if (navMatch) {
    const prefixLen = lower.length - navMatch[1].length;
    const target    = input.substring(prefixLen).trim();

    // "open Account list" / "show all Opportunities" → list view
    const listMatch = target.match(/^(\w+)\s+list$/i) ?? target.match(/^all\s+(\w+?)s?$/i);
    if (listMatch) {
      const raw  = listMatch[1];
      const sobj = raw.charAt(0).toUpperCase() + raw.slice(1).replace(/s$/, '');
      return { intent: 'NAVIGATE', message: `Opening ${sobj} list`, target_sobject: sobj, fields: {} };
    }

    const sobj = lower.includes('account') || lower.includes('company') ? 'Account'
      : lower.includes('contact') ? 'Contact'
      : lower.includes('lead')    ? 'Lead'
      : lower.includes('opportunit') || lower.includes('deal') ? 'Opportunity'
      : lower.includes('case')    ? 'Case'
      : 'Account'; // Default to Account for unqualified names — enables Account→Contact→Lead fallback in Apex

    const searchName = target.replace(/\b(?:account|contact|lead|opportunit\w*|deal|case)\b/gi, '').trim() || target;
    return { intent: 'NAVIGATE', message: `Navigating to ${searchName}`, search_name: searchName, search_sobject: sobj, fields: {} };
  }

  // ── SEARCH ────────────────────────────────────────────────────────────────
  const searchMatch = lower.match(/^(?:find|search(?:\s+for)?|look(?:\s+for)?|list\s+all?)\s+(.+)/);
  if (searchMatch) {
    const prefixLen  = lower.length - searchMatch[1].length;
    const query      = input.substring(prefixLen).trim();
    const sobj       = lower.includes('account')     ? 'Account'
      : lower.includes('contact')     ? 'Contact'
      : lower.includes('lead')        ? 'Lead'
      : lower.includes('opportunit')  ? 'Opportunity'
      : lower.includes('case')        ? 'Case'
      : req.sObjectType               ?? null;
    const cleanQ = query.replace(/\b(?:accounts?|contacts?|leads?|opportunities|opportunity|cases?)\b/gi, '').trim() || query;
    return { intent: 'SEARCH', message: `Searching for: ${cleanQ}`, search_query: cleanQ, search_sobject: sobj, fields: {} };
  }

  // ── GUIDE_CREATE ──────────────────────────────────────────────────────────
  // e.g. "how do I create a Lead", "what fields for Opportunity", "new Lead guide"
  const guideMatch = lower.match(
    /^(?:how\s+(?:do\s+i\s+)?(?:create|add|make|fill|input)|what\s+(?:fields?|do\s+i\s+need)\s+(?:for|to)|(?:guide|steps?)\s+(?:for|to)?\s*(?:creat(?:ing|e)?|new)?)\s+(?:a\s+(?:new\s+)?|an?\s+(?:new\s+)?)?(\w+)/i
  );
  if (guideMatch) {
    const rawObj = guideMatch[1];
    const sobj   = inferSObjectType(rawObj);
    return { intent: 'GUIDE_CREATE', message: `Guide: creating a new ${rawObj}`, guide_sobject: sobj, fields: {} };
  }

  return null;  // fall through to LLM
}

// ── /v1/agent-action ─────────────────────────────────────────────────────────

app.post('/v1/agent-action', async (c) => {
  let body: AgentActionRequest;
  try { body = await c.req.json<AgentActionRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if (!body.user_input?.trim()) return c.json({ error: 'user_input is required' }, 400);

  // Resolve tenant: rate-limit + KV config + credit deduction for LLM calls
  let tenant: { orgId: string; config: TenantConfig } | null = null;
  try {
    tenant = await resolveTenant(c.req.raw, c.env, c.executionCtx, { consumeCredit: true });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? 'Tenant error' }, (err.status ?? 500) as 400 | 402 | 403 | 429 | 500 | 502);
  }

  const lang = body.userLanguage ?? 'en';

  const isJaLang = lang.startsWith('ja');
  const defaultMsg = isJaLang ? '処理しました。' : 'Action processed.';

  // Try regex fast-route first (no LLM cost, ~0ms)
  const fast = tryFastRoute(body);
  if (fast) {
    fast.intent  ??= 'UNKNOWN';
    fast.message ??= defaultMsg;
    fast.fields  ??= {};
    return c.json(fast);
  }

  // ── Jev classification tier (before full LLM) ──────────────────────────────
  // Runs parallel intent + sObject + filter questions in one LLM call.
  // For SOQL_SEARCH with confidence ≥ 0.72: deterministic template → skip LLM.
  // For low confidence or non-SOQL intents: fall through to full LLM below.
  const orgId = c.req.raw.headers.get('X-Salesforce-Org-Id') ?? 'anon';

  try {
    const [customObjects, orgSynonyms] = await Promise.all([
      loadCustomSObjectsFromKv(orgId, c.env.TENANT_KV),
      loadSynonymsFromKv(orgId, c.env.TENANT_KV),
    ]);
    const jev = await classifyWithJev(
      c as Parameters<typeof app.post>[1] & { env: Env },
      body.user_input,
      body.sObjectType ?? null,
      customObjects,
      orgSynonyms
    );

    const effectiveSObject = jev.sObject ?? body.sObjectType ?? null;

    // ── SOQL_SEARCH / SOSL / Data Cloud fast-route ────────────────────────
    // Threshold 0.85: below this, full LLM is used with field_schema context
    // so the model can dynamically pick the correct date/amount field for any
    // sObject (including custom objects) rather than relying on hard-coded maps.
    if (jev.intent === 'SOQL_SEARCH' && jev.confidence >= 0.85) {
      const sObjectForQuery = effectiveSObject ?? 'Account';
      const queryEngine = detectQueryEngine(sObjectForQuery);

      // ── Data Cloud SQL path ──────────────────────────────────────────────
      if (queryEngine === 'DATACLOUD_SQL') {
        const dcCatalog = await loadDataCloudCatalogFromKv(orgId, c.env.TENANT_KV);
        const dcInput: DataCloudCompilerInput = {
          intent:     'DATACLOUD_QUERY',
          baseObject: sObjectForQuery,
          limit:      20,
        };
        const compiled = compileDataCloudQuery(dcInput, dcCatalog);
        const response: AgentActionResponse = {
          intent:         'SOQL_SEARCH',
          message:        isJaLang ? `Data Cloud: ${sObjectForQuery} を照会…` : `Data Cloud: querying ${sObjectForQuery}…`,
          search_sobject: sObjectForQuery,
          soql_filter:    { conditions: [], order_by: '', limit: 20 },
          search_query:   compiled.sql,   // ANSI SQL — routed to DC Query API v2 by Apex
          fields:         {},
          ...(compiled.warnings.length ? { warnings: compiled.warnings } : {}),
        };
        if (tenant?.config?.aiCredits) {
          (response as Record<string, unknown>).remaining_credits = tenant.config.aiCredits.remaining;
        }
        return c.json(response);
      }

      const [validFields, fieldTypes, childRels, grammar] = await Promise.all([
        loadSchemaFromKv(orgId, sObjectForQuery, c.env.TENANT_KV),
        loadFieldTypesFromKv(orgId, sObjectForQuery, c.env.TENANT_KV),
        loadChildRelsFromKv(orgId, sObjectForQuery, c.env.TENANT_KV),
        loadGrammarRulesFromKv(c.env.TENANT_KV),
      ]);

      // Check if SOSL is more appropriate (cross-object / no sObject resolved)
      if (shouldUseSosl(body.user_input, effectiveSObject, grammar)) {
        const soslInput: CompilerInput = {
          intent:   'SOSL_SEARCH',
          sObject:  null,
          conditions: [],
          soslTerm: body.user_input,
          soslGroup: 'ALL FIELDS',
          limit:    body.field_schema?.length ? 10 : 20,
        };
        const compiled = compileQuery(soslInput, validFields, fieldTypes, childRels, grammar);
        const sObjectLabel = JA_SOBJECT_LABEL[effectiveSObject ?? ''] ?? effectiveSObject ?? '全体';
        const response: AgentActionResponse = {
          intent:   'SOQL_SEARCH',
          message:  isJaLang ? `${sObjectLabel}を横断検索…` : 'Searching across objects…',
          search_sobject: effectiveSObject ?? undefined,
          soql_filter:    { conditions: [], order_by: '', limit: 20 },
          fields:         {},
          ...(compiled.query ? { search_query: compiled.query } : {}),
        };
        if (tenant?.config?.aiCredits) {
          (response as Record<string, unknown>).remaining_credits = tenant.config.aiCredits.remaining;
        }
        return c.json(response);
      }

      const built = buildSoqlFilterFromJev(
        body.user_input,
        effectiveSObject,
        {
          intentAnswer:  { type: 'choice', choice: 'SOQL_SEARCH', confidence: jev.confidence, probabilities: {} },
          sObjectAnswer: jev.sObject ? { type: 'choice', choice: jev.sObject, confidence: jev.confidence, probabilities: {} } : null,
          hasAmount:     { type: 'noul', noul: jev.hasAmount },
          hasDate:       { type: 'noul', noul: jev.hasDate },
          isInactive:    { type: 'noul', noul: jev.isInactive },
        },
        validFields
      );

      if (built) {
        // Run conditions through the SOQL compiler for field-type validation
        // and non-filterable field stripping.
        const compilerInput: CompilerInput = {
          intent:     'SOQL_SEARCH',
          sObject:    built.sObject,
          conditions: built.filter.conditions as CompilerInput['conditions'],
          orderBy:    built.filter.order_by,
          limit:      built.filter.limit,
        };
        const compiled = compileQuery(compilerInput, validFields, fieldTypes, childRels, grammar);

        const sObjectLabel = JA_SOBJECT_LABEL[built.sObject] ?? built.sObject;
        const msg = isJaLang
          ? `${sObjectLabel}を検索しています…`
          : `Searching ${built.sObject}…`;

        const response: AgentActionResponse = {
          intent:         'SOQL_SEARCH',
          message:        msg,
          search_sobject: built.sObject,
          soql_filter:    built.filter,   // structured conditions for LWC re-use
          fields:         {},
          // Compiled validated SOQL string surfaced for Apex direct execution
          ...(compiled.query ? { search_query: compiled.query } : {}),
          ...(compiled.warnings.length ? { warnings: compiled.warnings } : {}),
        };
        if (tenant?.config?.aiCredits) {
          (response as Record<string, unknown>).remaining_credits = tenant.config.aiCredits.remaining;
        }
        return c.json(response);
      }
    }

    // ── NAVIGATE fast-route ────────────────────────────────────────────────
    // List-view navigation: "〇〇一覧を開いて", "〇〇リストを表示"
    if (jev.intent === 'NAVIGATE' && jev.confidence >= 0.72 && effectiveSObject) {
      const sObjectLabel = JA_SOBJECT_LABEL[effectiveSObject] ?? effectiveSObject;
      const response: AgentActionResponse = {
        intent:         'NAVIGATE',
        message:        isJaLang ? `${sObjectLabel}一覧を開きます` : `Opening ${effectiveSObject} list`,
        target_sobject: effectiveSObject,
        fields:         {},
      };
      if (tenant?.config?.aiCredits) {
        (response as Record<string, unknown>).remaining_credits = tenant.config.aiCredits.remaining;
      }
      return c.json(response);
    }

    // ── RECORD_UPDATE fast-route ───────────────────────────────────────────
    // Simple single-field update: "フェーズを Closed Won に変更" (current record context)
    if ((jev.intent === 'RECORD_UPDATE') && jev.confidence >= 0.72) {
      const validFields = await loadSchemaFromKv(orgId, effectiveSObject ?? '', c.env.TENANT_KV);
      const upd = extractSimpleUpdate(body.user_input, effectiveSObject, validFields);

      if (upd && Object.keys(upd.fields).length > 0) {
        const response: AgentActionResponse = {
          intent:       'UPDATE_RECORD',
          message:      isJaLang ? '項目を更新します' : 'Updating record field',
          sObjectType:  upd.sObject ?? undefined,
          fields:       upd.fields,
          should_save:  false,    // LWC shows prefill card; user confirms before DML
          ...(upd.searchName ? { search_name: upd.searchName, search_sobject: upd.sObject ?? undefined } : {}),
        };
        if (tenant?.config?.aiCredits) {
          (response as Record<string, unknown>).remaining_credits = tenant.config.aiCredits.remaining;
        }
        return c.json(response);
      }
    }

    // REPORT_EXPLAIN → pass through to LLM (rare, needs full context)
  } catch {
    // Jev classification failed → fall through to full LLM silently
  }

  // Fall back to LLM for complex / Japanese / relative-op / extract inputs
  try {
    const result = await runAgentLLM(
      c as Parameters<typeof app.post>[1] & { env: Env },
      buildAgentUserPrompt(body),
      buildAgentSystemPrompt(lang)
    ) as AgentActionResponse;

    result.intent  ??= 'UNKNOWN';
    result.message ??= defaultMsg;
    result.fields  ??= {};

    // Confidence threshold: if model is under 85% sure, promote to CLARIFY so the
    // LWC surfaces a confirmation question instead of executing a wrong action.
    const confidence = typeof result.confidence === 'number' ? result.confidence : 100;
    const NON_CLARIFY = new Set(['CLARIFY', 'UNKNOWN', 'EXTRACT']);
    if (confidence < 85 && !NON_CLARIFY.has(result.intent)) {
      const original = result.intent;
      result.intent  = 'CLARIFY';
      // If the model didn't already write a question, generate one
      if (!result.message.includes('?') && !result.message.includes('？')) {
        result.message = isJaLang
          ? `「${original}」の操作でよろしいですか？詳しく教えていただけますか？`
          : `Did you mean to ${original.toLowerCase().replace('_', ' ')}? Could you clarify?`;
      }
    }

    // Surface free-trial credit balance so LWC can display the counter
    if (tenant?.config?.aiCredits) {
      (result as Record<string, unknown>).remaining_credits = tenant.config.aiCredits.remaining;
    }

    return c.json(result);
  } catch (e) {
    return c.json({ error: 'Agent action failed', detail: String(e), intent: 'UNKNOWN', message: 'Backend error — please retry.' }, 500);
  }
});

// ── /v1/jev-classify — standalone intent + sObject classification ─────────────
// Called directly from Apex / LWC when intent classification is needed without
// a full agent-action round-trip. Sends ZERO customer record data to the Worker;
// only abstract utterances and sObject context are evaluated.

interface JevClassifyRequest {
  user_input:     string;
  sobject_context?: string;  // Current page sObject API name (hint, not data)
  userLanguage?:  string;
}

interface JevClassifyResponse {
  intent:         string;
  sObject:        string | null;
  confidence:     number;
  soql_filter?:   { conditions: unknown[]; order_by: string; limit: number };
  message:        string;
  source:         'jev-template' | 'jev-low-confidence';
}

app.post('/v1/jev-classify', async (c) => {
  let body: JevClassifyRequest;
  try { body = await c.req.json<JevClassifyRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if (!body.user_input?.trim()) return c.json({ error: 'user_input is required' }, 400);

  let tenant: { orgId: string; config: TenantConfig } | null = null;
  try {
    tenant = await resolveTenant(c.req.raw, c.env, c.executionCtx, { consumeCredit: true });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? 'Tenant error' }, (err.status ?? 500) as 400 | 402 | 403 | 429 | 500 | 502);
  }

  const orgId  = tenant?.orgId ?? c.req.raw.headers.get('X-Salesforce-Org-Id') ?? 'anon';
  const lang   = body.userLanguage ?? 'en';
  const isJa   = lang.startsWith('ja');

  try {
    const customObjects = await loadCustomSObjectsFromKv(orgId, c.env.TENANT_KV);
    const jev = await classifyWithJev(
      c as Parameters<typeof app.post>[1] & { env: Env },
      body.user_input,
      body.sobject_context ?? null,
      customObjects
    );

    if (jev.confidence < 0.72) {
      const resp: JevClassifyResponse = {
        intent:     jev.intent,
        sObject:    jev.sObject,
        confidence: jev.confidence,
        message:    isJa
          ? 'もう少し詳しく教えていただけますか？'
          : 'Please clarify your request.',
        source: 'jev-low-confidence',
      };
      if (tenant?.config?.aiCredits) (resp as Record<string, unknown>).remaining_credits = tenant.config.aiCredits.remaining;
      return c.json(resp);
    }

    const validFields = await loadSchemaFromKv(orgId, jev.sObject ?? 'Account', c.env.TENANT_KV);

    const built = jev.intent === 'SOQL_SEARCH'
      ? buildSoqlFilterFromJev(
          body.user_input,
          jev.sObject ?? body.sobject_context ?? null,
          {
            intentAnswer:  { type: 'choice', choice: 'SOQL_SEARCH', confidence: jev.confidence, probabilities: {} },
            sObjectAnswer: jev.sObject ? { type: 'choice', choice: jev.sObject, confidence: jev.confidence, probabilities: {} } : null,
            hasAmount:     { type: 'noul', noul: jev.hasAmount },
            hasDate:       { type: 'noul', noul: jev.hasDate },
            isInactive:    { type: 'noul', noul: jev.isInactive },
          },
          validFields
        )
      : null;

    const sObjectLabel = JA_SOBJECT_LABEL[jev.sObject ?? ''] ?? jev.sObject ?? '';
    const resp: JevClassifyResponse = {
      intent:     jev.intent,
      sObject:    jev.sObject,
      confidence: jev.confidence,
      message:    isJa ? `${sObjectLabel}を分類しました` : `Classified as ${jev.intent}`,
      source:     'jev-template',
      ...(built ? { soql_filter: built.filter } : {}),
    };

    if (tenant?.config?.aiCredits) (resp as Record<string, unknown>).remaining_credits = tenant.config.aiCredits.remaining;
    return c.json(resp);
  } catch (e) {
    return c.json({ error: 'Jev classification failed', detail: String(e) }, 500);
  }
});

// ── /v1/schema-seed — Worker KV schema seeding from Apex ─────────────────────
// Apex calls this after getObjectFieldInsights() to cache valid field API names
// so the Worker SOQL template builder can validate without calling Salesforce.

interface SchemaSeedRequest {
  sObjectType: string;
  fieldApiNames: string[];  // Accessible fields from Apex Schema.describe
}

app.post('/v1/schema-seed', async (c) => {
  let body: SchemaSeedRequest;
  try { body = await c.req.json<SchemaSeedRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if (!body.sObjectType || !Array.isArray(body.fieldApiNames)) {
    return c.json({ error: 'sObjectType and fieldApiNames required' }, 400);
  }

  const orgId = c.req.raw.headers.get('X-Salesforce-Org-Id');
  if (!orgId) return c.json({ error: 'X-Salesforce-Org-Id header required' }, 400);

  await cacheSchemaInKv(orgId, body.sObjectType, body.fieldApiNames, c.env.TENANT_KV);
  return c.json({ ok: true, cached: body.fieldApiNames.length });
});

// ── /v1/sobjects-seed — org custom object list for Jev dynamic criteria ───────
// Apex calls this once per session with the org's custom object catalog so
// the Jev sObject Choice question includes org-specific objects at runtime.

interface SObjectsSeedRequest {
  objects: CustomSObjectEntry[];  // [{apiName, label, pluralLabel}]
}

app.post('/v1/sobjects-seed', async (c) => {
  let body: SObjectsSeedRequest;
  try { body = await c.req.json<SObjectsSeedRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if (!Array.isArray(body.objects)) {
    return c.json({ error: 'objects array required' }, 400);
  }

  const orgId = c.req.raw.headers.get('X-Salesforce-Org-Id');
  if (!orgId) return c.json({ error: 'X-Salesforce-Org-Id header required' }, 400);

  await cacheCustomSObjectsInKv(orgId, body.objects, c.env.TENANT_KV);
  return c.json({ ok: true, cached: body.objects.length });
});

// ── /v1/synonyms-seed — org-specific JP synonym → API name mapping ────────────
// Apex or admin seeds aliases for custom objects / non-standard JP label usage.
// e.g. { "注文": "Purchase_Order__c", "プロジェクト": "Project__c" }
// Merged with STANDARD_SYNONYM_MAP at classification time; TTL 1 hour.

interface SynonymsSeedRequest {
  synonyms: Record<string, string>;  // { jpAlias: 'SObject_API_Name__c' }
}

app.post('/v1/synonyms-seed', async (c) => {
  let body: SynonymsSeedRequest;
  try { body = await c.req.json<SynonymsSeedRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if (!body.synonyms || typeof body.synonyms !== 'object') {
    return c.json({ error: 'synonyms object required' }, 400);
  }

  const orgId = c.req.raw.headers.get('X-Salesforce-Org-Id');
  if (!orgId) return c.json({ error: 'X-Salesforce-Org-Id header required' }, 400);

  await cacheSynonymsInKv(orgId, body.synonyms, c.env.TENANT_KV);
  return c.json({ ok: true, cached: Object.keys(body.synonyms).length });
});

// ── /v1/field-types-seed — field descriptors with type + relationship info ────
// Apex seeds the enriched field schema (type + relationshipName + referenceTo)
// so the SOQL compiler can validate field types and resolve parent-lookup paths.

interface FieldTypesSeedRequest {
  sObjectType: string;
  fields:      FieldTypeSchema;  // { "ApiName": { type, filterable, relationshipName, referenceTo } }
}

app.post('/v1/field-types-seed', async (c) => {
  let body: FieldTypesSeedRequest;
  try { body = await c.req.json<FieldTypesSeedRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if (!body.sObjectType || !body.fields) return c.json({ error: 'sObjectType and fields required' }, 400);
  const orgId = c.req.raw.headers.get('X-Salesforce-Org-Id');
  if (!orgId) return c.json({ error: 'X-Salesforce-Org-Id header required' }, 400);

  await cacheFieldTypesInKv(orgId, body.sObjectType, body.fields, c.env.TENANT_KV);
  return c.json({ ok: true, cached: Object.keys(body.fields).length });
});

// ── /v1/child-rels-seed — child relationship metadata for nested SOQL ─────────
// Apex seeds childRelationships (relationshipName → childObject + field) so the
// SOQL compiler can emit validated Parent-to-Child nested subqueries.

interface ChildRelsSeedRequest {
  sObjectType:        string;
  childRelationships: Record<string, ChildRelationship>;  // relName → { childObject, field }
}

app.post('/v1/child-rels-seed', async (c) => {
  let body: ChildRelsSeedRequest;
  try { body = await c.req.json<ChildRelsSeedRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if (!body.sObjectType || !body.childRelationships) return c.json({ error: 'sObjectType and childRelationships required' }, 400);
  const orgId = c.req.raw.headers.get('X-Salesforce-Org-Id');
  if (!orgId) return c.json({ error: 'X-Salesforce-Org-Id header required' }, 400);

  await cacheChildRelsInKv(orgId, body.sObjectType, body.childRelationships, c.env.TENANT_KV);
  return c.json({ ok: true, cached: Object.keys(body.childRelationships).length });
});

// ── /v1/grammar-rules-seed — SOQL/SOSL structural rules (global, not per-org) ─
// Allows the Apex admin tool to update date literals, non-filterable types,
// and SOSL returning defaults without a Worker redeploy.

app.post('/v1/grammar-rules-seed', async (c) => {
  let body: Partial<GrammarRules>;
  try { body = await c.req.json<Partial<GrammarRules>>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if (!c.env.TENANT_KV) return c.json({ error: 'KV not configured' }, 500);
  const merged = { ...DEFAULT_GRAMMAR_RULES, ...body };
  await c.env.TENANT_KV.put('soql_sosl_grammar_rules', JSON.stringify(merged), { expirationTtl: 86400 });
  return c.json({ ok: true });
});

// ── /v1/datacloud-catalog-seed — Data Cloud DMO/DLO metadata ─────────────────
// Apex seeds the org's Data Cloud object catalog so the Worker can detect DC
// objects and route to the ANSI SQL compiler instead of SOQL.
// Catalog keyed by object API name (e.g. "ssot__Individual__dlm").

interface DataCloudCatalogSeedRequest {
  catalog: Record<string, DataCloudObjectMeta>;  // apiName → { label, type, fields, relationships }
}

app.post('/v1/datacloud-catalog-seed', async (c) => {
  let body: DataCloudCatalogSeedRequest;
  try { body = await c.req.json<DataCloudCatalogSeedRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if (!body.catalog || typeof body.catalog !== 'object') {
    return c.json({ error: 'catalog object required' }, 400);
  }
  const orgId = c.req.raw.headers.get('X-Salesforce-Org-Id');
  if (!orgId) return c.json({ error: 'X-Salesforce-Org-Id header required' }, 400);

  await cacheDataCloudCatalogInKv(orgId, body.catalog, c.env.TENANT_KV);
  return c.json({ ok: true, cached: Object.keys(body.catalog).length });
});

// ── /v1/translate-rule — convert raw DML error into friendly guidance ────────

interface TranslateRuleRequest {
  sObjectType:     string;
  raw_error:       string;
  fields_involved?: string[];
  userLanguage?:   string;
}

app.post('/v1/translate-rule', async (c) => {
  let body: TranslateRuleRequest;
  try { body = await c.req.json<TranslateRuleRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if (!body.raw_error || !body.sObjectType) {
    return c.json({ error: 'sObjectType and raw_error are required' }, 400);
  }

  try { await resolveTenant(c.req.raw, c.env, c.executionCtx, { consumeCredit: true }); }
  catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? 'Tenant error' }, (err.status ?? 500) as 400 | 402 | 403 | 429 | 500 | 502);
  }

  const isJa = (body.userLanguage ?? 'en').startsWith('ja');
  const fields = body.fields_involved?.join(', ') ?? 'unknown';

  const system = `You translate raw Salesforce validation error messages into short, friendly guidance${isJa ? ' in Japanese' : ''} for sales reps.
Return ONLY valid JSON: {"friendly_rule": "<1-2 sentence plain language guidance on what the user needs to do>"}
Focus on the actionable requirement, not the technical error code.`;

  const user = `Salesforce object: ${body.sObjectType}
Fields being updated: ${fields}
Validation error: ${body.raw_error}

Write a friendly 1-2 sentence guidance rule for a sales rep to avoid this error next time.`;

  try {
    const result = await runAgentLLM(
      c as Parameters<typeof app.post>[1] & { env: Env },
      user,
      system,
    );
    const friendly = typeof result.friendly_rule === 'string'
      ? result.friendly_rule
      : body.raw_error.slice(0, 200);
    return c.json({ friendly_rule: friendly });
  } catch (e) {
    return c.json({ error: 'Translate failed', detail: String(e) }, 500);
  }
});

// ── /v1/explain-formula — plain-language formula breakdown ───────────────────

interface ExplainFormulaRequest {
  formula:      string;
  field_label:  string;
  sobject_type: string;
  userLanguage?: string;
}

app.post('/v1/explain-formula', async (c) => {
  let body: ExplainFormulaRequest;
  try { body = await c.req.json<ExplainFormulaRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if (!body.formula || !body.field_label) {
    return c.json({ error: 'formula and field_label are required' }, 400);
  }

  try { await resolveTenant(c.req.raw, c.env, c.executionCtx, { consumeCredit: true }); }
  catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? 'Tenant error' }, (err.status ?? 500) as 400 | 402 | 403 | 429 | 500 | 502);
  }

  const isJa = (body.userLanguage ?? 'en').startsWith('ja');
  const system = `You explain Salesforce formula fields in plain language${isJa ? ' in Japanese' : ''}.
Return ONLY valid JSON: {"explanation": "<your explanation>"}
Keep it 1-3 sentences. Include a numeric example (e.g. "If Amount is ¥500,000 and Probability is 80%, Expected Revenue = ¥400,000.").`;

  const user = `Salesforce field: "${body.field_label}" on ${body.sobject_type ?? 'an object'}
Formula: ${body.formula}

Explain what this calculates in plain language with a numeric example.`;

  try {
    const result = await runAgentLLM(
      c as Parameters<typeof app.post>[1] & { env: Env },
      user,
      system,
    );
    const explanation = typeof result.explanation === 'string'
      ? result.explanation
      : body.formula;   // fallback: show the raw formula if LLM fails to parse
    return c.json({ explanation });
  } catch (e) {
    return c.json({ error: 'Explain failed', detail: String(e) }, 500);
  }
});

// ── /v1/jp-address — Zipcloud postal code proxy ──────────────────────────────

interface JpAddressRequest {
  zipcode: string;   // 7 digits, no hyphen
}

interface ZipcloudResult {
  address1: string;  // prefecture
  address2: string;  // city/ward
  address3: string;  // town
  kana1:    string;  // prefecture kana
  kana2:    string;  // city kana
  kana3:    string;  // town kana
  zipcode:  string;
}

app.post('/v1/jp-address', async (c) => {
  let body: JpAddressRequest;
  try { body = await c.req.json<JpAddressRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  const zip = (body.zipcode ?? '').replace(/\D/g, '');
  if (zip.length !== 7) {
    return c.json({ error: 'zipcode must be exactly 7 digits' }, 400);
  }

  try { await resolveTenant(c.req.raw, c.env, c.executionCtx); }
  catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message ?? 'Tenant error' }, (err.status ?? 500) as 400 | 429 | 500 | 502);
  }

  let resp: Response;
  try {
    resp = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${zip}`);
  } catch (e) {
    return c.json({ error: 'Zipcloud fetch failed', detail: String(e) }, 502);
  }

  if (!resp.ok) {
    return c.json({ error: 'Zipcloud error', status: resp.status }, 502);
  }

  const data = await resp.json() as { status: number; results: ZipcloudResult[] | null; message: string | null };

  if (data.status !== 200 || !data.results?.length) {
    return c.json({ error: 'No address found for this postal code' }, 404);
  }

  const r = data.results[0];
  const postalCode = `${zip.slice(0, 3)}-${zip.slice(3)}`;

  return c.json({
    postalCode,
    prefecture:     r.address1,
    city:           r.address2,
    town:           r.address3,
    prefectureKana: r.kana1,
    cityKana:       r.kana2,
    townKana:       r.kana3,
    fullAddress:    r.address1 + r.address2 + r.address3,
  });
});

// ── /v1/csv-map — AI-assisted CSV header → Salesforce field mapping ──────────

type TransformType = 'none' | 'fullwidth_to_half' | 'normalize_phone' | 'normalize_postal' | 'date_format';

interface CsvMapping {
  csvHeader:  string;
  sfApiName:  string | null;
  confidence: number;
  transform:  TransformType;
}

// Dictionary: normalised header key → Salesforce field + transform
// Key is lowercase, spaces and full-width spaces removed
const HEADER_DICT: Record<string, { sfApi: string; tf: TransformType }> = {
  // Account
  '会社名': { sfApi: 'Name',               tf: 'none' },
  '社名':   { sfApi: 'Name',               tf: 'none' },
  '取引先名':{ sfApi: 'Name',               tf: 'none' },
  '顧客名': { sfApi: 'Name',               tf: 'none' },
  'companyname': { sfApi: 'Name',          tf: 'none' },
  'company': { sfApi: 'Name',              tf: 'none' },
  // Contact / Lead name
  '名前':   { sfApi: 'Name',               tf: 'none' },
  '氏名':   { sfApi: 'LastName',           tf: 'none' },
  '姓':     { sfApi: 'LastName',           tf: 'none' },
  '名':     { sfApi: 'FirstName',          tf: 'none' },
  'lastname':  { sfApi: 'LastName',        tf: 'none' },
  'firstname': { sfApi: 'FirstName',       tf: 'none' },
  // Phone / Fax
  '電話':       { sfApi: 'Phone',          tf: 'normalize_phone' },
  '電話番号':   { sfApi: 'Phone',          tf: 'normalize_phone' },
  'tel':         { sfApi: 'Phone',         tf: 'normalize_phone' },
  '携帯':        { sfApi: 'MobilePhone',   tf: 'normalize_phone' },
  '携帯電話':    { sfApi: 'MobilePhone',   tf: 'normalize_phone' },
  'mobile':      { sfApi: 'MobilePhone',   tf: 'normalize_phone' },
  'fax':         { sfApi: 'Fax',           tf: 'normalize_phone' },
  'ファックス':  { sfApi: 'Fax',           tf: 'normalize_phone' },
  // Email
  'メール':      { sfApi: 'Email',         tf: 'none' },
  'メールアドレス': { sfApi: 'Email',      tf: 'none' },
  'email':       { sfApi: 'Email',         tf: 'none' },
  'mail':        { sfApi: 'Email',         tf: 'none' },
  // Address (Account — Billing)
  '郵便番号':    { sfApi: 'BillingPostalCode', tf: 'normalize_postal' },
  '〒':          { sfApi: 'BillingPostalCode', tf: 'normalize_postal' },
  'zip':         { sfApi: 'BillingPostalCode', tf: 'normalize_postal' },
  'postalcode':  { sfApi: 'BillingPostalCode', tf: 'normalize_postal' },
  '都道府県':    { sfApi: 'BillingState',  tf: 'none' },
  '市区町村':    { sfApi: 'BillingCity',   tf: 'none' },
  '住所':        { sfApi: 'BillingStreet', tf: 'none' },
  '番地':        { sfApi: 'BillingStreet', tf: 'none' },
  '国':          { sfApi: 'BillingCountry',tf: 'none' },
  // Lead-specific address
  '郵便番号（リード）': { sfApi: 'PostalCode', tf: 'normalize_postal' },
  '都道府県（リード）': { sfApi: 'State',      tf: 'none' },
  '市区町村（リード）': { sfApi: 'City',       tf: 'none' },
  '住所（リード）':     { sfApi: 'Street',     tf: 'none' },
  // Account metadata
  '業種':        { sfApi: 'Industry',      tf: 'none' },
  '従業員数':    { sfApi: 'NumberOfEmployees', tf: 'fullwidth_to_half' },
  '年収':        { sfApi: 'AnnualRevenue', tf: 'fullwidth_to_half' },
  '売上高':      { sfApi: 'AnnualRevenue', tf: 'fullwidth_to_half' },
  'ウェブサイト': { sfApi: 'Website',     tf: 'none' },
  'url':         { sfApi: 'Website',       tf: 'none' },
  'hp':          { sfApi: 'Website',       tf: 'none' },
  '備考':        { sfApi: 'Description',   tf: 'none' },
  'メモ':        { sfApi: 'Description',   tf: 'none' },
  'note':        { sfApi: 'Description',   tf: 'none' },
  'description': { sfApi: 'Description',   tf: 'none' },
  // Contact
  '役職':        { sfApi: 'Title',         tf: 'none' },
  'タイトル':    { sfApi: 'Title',         tf: 'none' },
  '部署':        { sfApi: 'Department',    tf: 'none' },
  'title':       { sfApi: 'Title',         tf: 'none' },
  'department':  { sfApi: 'Department',    tf: 'none' },
  // Lead
  'リード元':    { sfApi: 'LeadSource',    tf: 'none' },
  '会社（リード）': { sfApi: 'Company',   tf: 'none' },
  // Opportunity
  '商談名':      { sfApi: 'Name',          tf: 'none' },
  '金額':        { sfApi: 'Amount',        tf: 'fullwidth_to_half' },
  '見積金額':    { sfApi: 'Amount',        tf: 'fullwidth_to_half' },
  '完了予定日':  { sfApi: 'CloseDate',     tf: 'date_format' },
  'クローズ日':  { sfApi: 'CloseDate',     tf: 'date_format' },
  'フェーズ':    { sfApi: 'StageName',     tf: 'none' },
  // Generic
  'name':        { sfApi: 'Name',          tf: 'none' },
  'phone':       { sfApi: 'Phone',         tf: 'normalize_phone' },
  'amount':      { sfApi: 'Amount',        tf: 'fullwidth_to_half' },
  'closedate':   { sfApi: 'CloseDate',     tf: 'date_format' },
  'stagename':   { sfApi: 'StageName',     tf: 'none' },
  'industry':    { sfApi: 'Industry',      tf: 'none' },
};

function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/[　\s\-_\/]+/g, '');
}

function matchCsvHeader(header: string): Omit<CsvMapping, 'csvHeader'> {
  const k = normKey(header);
  // Exact match
  const exact = HEADER_DICT[k] ?? HEADER_DICT[header.trim()];
  if (exact) return { sfApiName: exact.sfApi, confidence: 0.95, transform: exact.tf };
  // Substring match: dictionary key is contained in header (e.g. "担当者電話" contains "電話")
  for (const [dk, dv] of Object.entries(HEADER_DICT)) {
    if (k.includes(dk) && dk.length >= 2) {
      return { sfApiName: dv.sfApi, confidence: 0.70, transform: dv.tf };
    }
  }
  return { sfApiName: null, confidence: 0, transform: 'none' };
}

interface CsvMapRequest {
  sObjectType: string;
  headers:     string[];
  sampleRows?: string[][];
}

app.post('/v1/csv-map', async (c) => {
  let body: CsvMapRequest;
  try { body = await c.req.json<CsvMapRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  const { headers = [] } = body;
  if (!Array.isArray(headers) || headers.length === 0) {
    return c.json({ error: 'headers array required' }, 400);
  }

  const mappings: CsvMapping[] = headers.map(h => ({
    csvHeader: h,
    ...matchCsvHeader(h),
  }));

  return c.json({ mappings });
});

// ── Claude API Key (org-level) & Dashboard Builder ───────────────────────────
// Anthropic OAuth for third-party apps is not available (blocked Feb 2026).
// Solution: Salesforce admin enters ONE Anthropic API key in FlashBar settings.
// Key stored at org level in KV — all users in the org can use Dashboard Builder.
// Regular users never see or touch an API key.

// POST /claude/save-key  { orgId, apiKey }  — admin only, validated server-side
app.post('/claude/save-key', async (c) => {
  let body: { orgId?: string; apiKey?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  const { orgId, apiKey } = body;
  if (!orgId || !apiKey)              return c.json({ error: 'orgId and apiKey required' }, 400);
  if (!apiKey.startsWith('sk-ant-'))  return c.json({ error: 'Invalid key — must start with sk-ant-' }, 400);

  // Validate key before storing (cheap 1-token call)
  const check = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  }).catch(() => null);

  if (check?.status === 401) return c.json({ error: 'API key is invalid or revoked' }, 400);

  await c.env.TENANT_KV?.put(
    `claude_apikey:${orgId}`,
    apiKey,
    { expirationTtl: 365 * 24 * 3600 }  // refreshed on each save
  );

  return c.json({ ok: true });
});

// GET /claude/status?orgId=
app.get('/claude/status', async (c) => {
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ connected: false });
  const key = await c.env.TENANT_KV?.get(`claude_apikey:${orgId}`);
  return c.json({ connected: !!key });
});

// DELETE /claude/disconnect?orgId=  — admin only
app.delete('/claude/disconnect', async (c) => {
  const orgId = c.req.query('orgId');
  if (orgId) await c.env.TENANT_KV?.delete(`claude_apikey:${orgId}`);
  return c.json({ ok: true });
});

// POST /v1/dashboard-builder — generate report / dashboard metadata via org-level Anthropic API key
interface DashboardBuilderRequest {
  orgId:   string;
  request: string;                      // user's natural language request
  intent:  'CREATE_REPORT' | 'CREATE_DASHBOARD';
  schema:  Record<string, string>;      // { apiName: label }
}

app.post('/v1/dashboard-builder', async (c) => {
  let body: DashboardBuilderRequest;
  try { body = await c.req.json() as DashboardBuilderRequest; }
  catch { return c.json({ error: 'Invalid JSON' }, 400); }

  const { orgId, request, intent, schema } = body;
  if (!orgId || !request) return c.json({ error: 'orgId and request are required' }, 400);

  // Look up org-level Anthropic API key set by admin
  const apiKey = await c.env.TENANT_KV?.get(`claude_apikey:${orgId}`);
  if (!apiKey) return c.json({ error: 'CLAUDE_AUTH_REQUIRED' }, 401);

  const wantDashboard = intent === 'CREATE_DASHBOARD';
  const schemaStr     = JSON.stringify(schema, null, 2);

  const system = `You are a Salesforce Analytics expert. Generate metadata for a Salesforce ${wantDashboard ? 'report and dashboard' : 'report'}.

Return ONLY valid JSON (no markdown, no code fences) with this structure:
{
  "reportName":     "string — concise English/Japanese name",
  "reportMetadata": { /* Salesforce Analytics REST API POST /analytics/reports body */ },
  ${wantDashboard ? '"dashboardName":  "string — concise name",\n  "dashboardBody":  { /* Salesforce Analytics REST API POST /analytics/dashboards body — reference the report */ },' : ''}
}

Available field schema (apiName → label):
${schemaStr}

Rules:
- reportMetadata must include: name, reportType.type (e.g. "Opportunity"), reportFormat ("SUMMARY" or "TABULAR"), reportMetadata object with groupingsDown or groupingsAcross for SUMMARY
- Use ONLY apiNames present in the schema above
- For Japanese requests, keep names in Japanese but use English API names
- dashboardBody components should reference the report; use GAUGE or METRIC for KPI, BAR_CHART / LINE_CHART / DONUT_CHART for trends, TABLE for lists
- Keep the design simple and immediately useful`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'Content-Type':      'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-opus-4-7',
        max_tokens: 8192,
        system,
        messages: [{ role: 'user', content: request }],
      }),
    });

    if (!aiRes.ok) {
      if (aiRes.status === 401 || aiRes.status === 403) {
        return c.json({ error: 'CLAUDE_AUTH_REQUIRED' }, 401);
      }
      const detail = await aiRes.text();
      return c.json({ error: `Claude API error (${aiRes.status}): ${detail}` }, 502);
    }

    const aiData = await aiRes.json() as { content: Array<{ text: string }> };
    let raw = aiData.content[0]?.text ?? '{}';
    raw = raw.replace(/^```[a-z]*\n?/m, '').replace(/\n?```$/m, '').trim();

    const metadata = JSON.parse(raw);
    return c.json(metadata);
  } catch (e) {
    return c.json({ error: `Generation failed: ${String(e)}` }, 502);
  }
});

// ── Task 2: Case Triage — /api/jev/triage ────────────────────────────────────

interface CaseTriageRequest {
  caseId?:        string;
  subject?:       string;
  description?:   string;
  accountSlaTier?: string;
  userLanguage?:  string;
}

app.post('/api/jev/triage', async (c) => {
  let body: CaseTriageRequest;
  try { body = await c.req.json() as CaseTriageRequest; }
  catch { return c.json({ error: 'Invalid JSON' }, 400); }

  const { subject = '', description = '', accountSlaTier = 'Standard', userLanguage = 'en' } = body;
  const languageLine = userLanguage.startsWith('ja')
    ? 'Write "reasoning" and "recommendedQueueLabel" in Japanese (日本語).'
    : 'Write "reasoning" and "recommendedQueueLabel" in English.';

  const system = `You are a CRM support triage AI. Given a Salesforce Case, evaluate urgency and assign to the best support queue.
Return ONLY valid JSON (no markdown, no code fences) matching exactly this structure:
{
  "status": "SUCCESS",
  "confidence": <0.0–1.0>,
  "score": {
    "urgency":   <0.0–1.0>,
    "churnRisk": <0.0–1.0>
  },
  "choice": {
    "recommendedQueueDeveloperName": "<snake_case_api_name>",
    "recommendedQueueLabel":         "<Human Readable Name>",
    "reasoning": "<1–2 sentence explanation>"
  },
  "noul": {
    "isImmediateEscalationRequired": <true|false>,
    "confidence": <0.0–1.0>
  }
}
SLA tiers: Gold (highest priority), Silver, Bronze, Standard (lowest).
Escalation = true when urgency >= 0.85 AND SLA is Gold or Silver.
${languageLine}`;

  const prompt = `Case Subject: ${subject}
Description: ${description}
Account SLA Tier: ${accountSlaTier}`;

  try {
    const raw = await c.env.AI.run(REASONING_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 512,
      temperature: 0.3,
      // llama-3.1-8b-instruct-fp8 (quantized, weaker non-English generation) would
      // occasionally spiral into a repeated-phrase loop for Japanese reasoning text
      // at temperature 0.1 (near-greedy decoding compounds the effect). Penalizing
      // repeated tokens fixes it without meaningfully hurting scoring consistency.
      repetition_penalty: 1.3,
    });
    const out  = raw as { response?: unknown; choices?: Array<{ message?: { content?: string } }> };
    const text = out.choices?.[0]?.message?.content ?? (typeof out.response === 'string' ? out.response : '{}');
    const parsed = extractJson(text as string);
    return c.json(parsed);
  } catch (e) {
    return c.json({ error: `Triage failed: ${String(e)}` }, 502);
  }
});

// ── Task 3: Lead Qualification Batch — /api/jev/qualify-batch ─────────────────

interface LeadQualifyRequest {
  leads: Array<{
    leadId:      string;
    firstName?:  string;
    lastName?:   string;
    company?:    string;
    title?:      string;
    email?:      string;
    annualRevenue?: number;
    numberOfEmployees?: number;
    industry?:   string;
    leadSource?: string;
    description?: string;
  }>;
  userLanguage?: string;
}

interface LeadScore {
  leadId:     string;
  icpScore:   number;
  tier:       'HOT' | 'WARM' | 'COLD';
  reasoning:  string;
}

app.post('/api/jev/qualify-batch', async (c) => {
  let body: LeadQualifyRequest;
  try { body = await c.req.json() as LeadQualifyRequest; }
  catch { return c.json({ error: 'Invalid JSON' }, 400); }

  const { leads, userLanguage = 'en' } = body;
  if (!Array.isArray(leads) || leads.length === 0) {
    return c.json({ error: 'leads array is required' }, 400);
  }
  const languageLine = userLanguage.startsWith('ja')
    ? 'Write each "reasoning" in Japanese (日本語).'
    : 'Write each "reasoning" in English.';

  const system = `You are a B2B lead qualification AI. Score each lead for Ideal Customer Profile (ICP) fit.
Return ONLY valid JSON (no markdown, no code fences):
{
  "status": "SUCCESS",
  "scores": [
    {
      "leadId":    "<id>",
      "icpScore":  <0.0–1.0>,
      "tier":      "HOT" | "WARM" | "COLD",
      "reasoning": "<1-sentence explanation>"
    }
  ]
}
Scoring guide:
- HOT (0.75–1.0): Strong fit — decision-maker title, revenue >10M, SMB–Mid-market, relevant industry
- WARM (0.50–0.74): Moderate fit — some signals present
- COLD (0.0–0.49): Weak fit — missing key signals
Use annualRevenue, numberOfEmployees, title, industry, leadSource as signals.
${languageLine}`;

  const leadsText = leads.map((l, i) =>
    `Lead ${i + 1} (id: ${l.leadId}): ${l.firstName ?? ''} ${l.lastName ?? ''}, ${l.title ?? 'Unknown title'}, ${l.company ?? ''}, Revenue: ${l.annualRevenue ?? 'unknown'}, Employees: ${l.numberOfEmployees ?? 'unknown'}, Industry: ${l.industry ?? 'unknown'}, Source: ${l.leadSource ?? 'unknown'}`
  ).join('\n');

  try {
    const raw = await c.env.AI.run(REASONING_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: `Score these leads:\n${leadsText}` },
      ],
      max_tokens: 1024,
      temperature: 0.3,
      // See the /api/jev/triage comment above — same repetition-loop fix.
      repetition_penalty: 1.3,
    });
    const out  = raw as { response?: unknown; choices?: Array<{ message?: { content?: string } }> };
    const text = out.choices?.[0]?.message?.content ?? (typeof out.response === 'string' ? out.response : '{}');
    const parsed = extractJson(text as string);
    return c.json(parsed);
  } catch (e) {
    return c.json({ error: `Qualification failed: ${String(e)}` }, 502);
  }
});

export default app;
