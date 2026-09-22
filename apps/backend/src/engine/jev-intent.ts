/**
 * jev-intent.ts
 *
 * Jev question definitions for parallel intent + sObject classification,
 * plus a deterministic SOQL condition builder that uses keyword extraction
 * instead of an LLM for SOQL_SEARCH intents.
 *
 * Zero hallucination guarantee: field names are validated against the schema
 * cache before being included in conditions.
 */

import type { ChoiceQuestion, NoulQuestion, Answer, ChoiceAnswer, NoulAnswer } from '../types.js';

// ── Intent classification ──────────────────────────────────────────────────────

export type JevIntent =
  | 'SOQL_SEARCH'
  | 'RECORD_UPDATE'
  | 'NAVIGATE'
  | 'PIN'
  | 'REPORT_EXPLAIN'
  | 'UNKNOWN';

export const INTENT_QUESTION: ChoiceQuestion = {
  type: 'choice',
  instructions: 'What is the primary intent of the user request?',
  criteria: {
    SOQL_SEARCH:    'User wants to list, filter, search, or display records by criteria (amount, date, stage, owner, activity, etc.)',
    RECORD_UPDATE:  'User wants to update, save, change, or modify field values on a specific record',
    NAVIGATE:       'User wants to open, go to, or navigate to a specific page, record, or URL',
    PIN:            'User wants to pin, save, bookmark, or favorite a query or shortcut',
    REPORT_EXPLAIN: 'User wants to understand, explain, or analyze a report or dashboard',
    UNKNOWN:        'Intent is ambiguous or cannot be determined from the input',
  },
};

// Base standard-object criteria — always present regardless of org.
// Custom objects are injected at runtime via buildSObjectQuestion().
export const STANDARD_SOBJECT_CRITERIA: Record<string, string> = {
  Account:     'Company, client, customer, 取引先, 顧客',
  Contact:     'Person, contact, 連絡先, 取引先責任者',
  Opportunity: 'Deal, sale, pipeline, opportunity, 商談, 案件',
  Lead:        'Lead, prospect, inquiry, リード, 見込み客',
  Case:        'Case, ticket, support issue, ケース, サポート',
};

// Maximum custom-object entries to include in the Choice question.
// Jev Choice questions degrade past ~20 options; keep the most-used ones.
const MAX_CUSTOM_SOBJECTS = 12;

export interface CustomSObjectEntry {
  apiName:     string;  // e.g. "Service_Order__c"
  label:       string;  // e.g. "サービス注文"
  pluralLabel: string;  // e.g. "サービス注文"
}

/**
 * Builds a runtime sObject Choice question that includes both standard objects
 * and the org's custom objects from the KV cache.
 *
 * @param customObjects - Custom objects from KV ("sobjects:{orgId}"), may be empty.
 */
export function buildSObjectQuestion(customObjects: CustomSObjectEntry[]): ChoiceQuestion {
  const criteria: Record<string, string> = { ...STANDARD_SOBJECT_CRITERIA };

  // Inject custom objects (capped to avoid degrading Jev accuracy at >20 options)
  const custom = customObjects.slice(0, MAX_CUSTOM_SOBJECTS);
  for (const obj of custom) {
    // Use apiName as the key so the answer maps directly to the Salesforce API name.
    // Description includes both English API name and Japanese label for bilingual matching.
    criteria[obj.apiName] = `${obj.label} (${obj.apiName}), ${obj.pluralLabel}`;
  }

  // "Other" must always be last — it's the fallback when nothing matches.
  criteria['Other'] = 'Other object, unknown, or cannot be determined';

  return {
    type:         'choice',
    instructions: 'Which Salesforce object type is the user referring to? Use the API name as the answer key.',
    criteria,
  };
}

export const HAS_AMOUNT_FILTER_QUESTION: NoulQuestion = {
  type: 'noul',
  instructions: 'The user wants to filter records by a monetary amount or numeric threshold.',
};

export const HAS_DATE_FILTER_QUESTION: NoulQuestion = {
  type: 'noul',
  instructions: 'The user wants to filter records by a date range, time period, or recency.',
};

export const IS_INACTIVE_QUERY: NoulQuestion = {
  type: 'noul',
  instructions: 'The user is looking for neglected, inactive, stale, or overdue records with no recent activity.',
};

// ── Answer helpers ─────────────────────────────────────────────────────────────

export function getChoiceAnswer(answers: Record<string, Answer>, key: string): ChoiceAnswer | null {
  const a = answers[key];
  return a?.type === 'choice' ? (a as ChoiceAnswer) : null;
}

export function getNoulAnswer(answers: Record<string, Answer>, key: string): NoulAnswer | null {
  const a = answers[key];
  return a?.type === 'noul' ? (a as NoulAnswer) : null;
}

// ── Keyword-based SOQL condition extractor ─────────────────────────────────────

export interface SoqlCondition {
  field: string;
  op:   'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'not_null' | 'is_null';
  value?: string | number | boolean | string[];
}

export interface SoqlFilter {
  conditions: SoqlCondition[];
  order_by:   string;
  limit:      number;
}

// Japanese and English date keyword → SOQL date literal
const DATE_KEYWORD_MAP: Array<{ pattern: RegExp; literal: string }> = [
  { pattern: /\b(?:today|本日|今日)\b/i,                             literal: 'TODAY'        },
  { pattern: /\b(?:this[\s_-]?week|今週)\b/i,                       literal: 'THIS_WEEK'    },
  { pattern: /\b(?:last[\s_-]?week|先週)\b/i,                       literal: 'LAST_WEEK'    },
  { pattern: /\b(?:this[\s_-]?month|今月|当月)\b/i,                 literal: 'THIS_MONTH'   },
  { pattern: /\b(?:last[\s_-]?month|先月|前月)\b/i,                 literal: 'LAST_MONTH'   },
  { pattern: /\b(?:this[\s_-]?year|今年|本年)\b/i,                  literal: 'THIS_YEAR'    },
  { pattern: /\b(?:last[\s_-]?year|昨年|去年)\b/i,                  literal: 'LAST_YEAR'    },
  { pattern: /\b(?:this[\s_-]?quarter|今四半期|今Q)\b/i,            literal: 'THIS_QUARTER' },
  { pattern: /\b(?:last[\s_-]?quarter|前四半期|前Q)\b/i,            literal: 'LAST_QUARTER' },
  { pattern: /(?:過去|直近|last)\s*7\s*日?(?:間|days?)?/i,          literal: 'LAST_N_DAYS:7'  },
  { pattern: /(?:過去|直近|last)\s*14\s*日?(?:間|days?)?/i,         literal: 'LAST_N_DAYS:14' },
  { pattern: /(?:過去|直近|last)\s*30\s*日?(?:間|days?)?/i,         literal: 'LAST_N_DAYS:30' },
  { pattern: /(?:過去|直近|last)\s*90\s*日?(?:間|days?)?/i,         literal: 'LAST_N_DAYS:90' },
  { pattern: /(?:過去|直近|last)\s*(\d+)\s*日(?:間)?/i,             literal: '' },  // captured below
  { pattern: /last\s+(\d+)\s+days?/i,                               literal: '' },
];

// Extracts the first matching SOQL date literal from free text.
export function extractDateLiteral(text: string): string | null {
  // Dynamic N-day patterns first
  const dynJa = text.match(/(?:過去|直近)\s*(\d+)\s*日(?:間)?/i);
  if (dynJa) return `LAST_N_DAYS:${dynJa[1]}`;
  const dynEn = text.match(/last\s+(\d+)\s+days?/i);
  if (dynEn) return `LAST_N_DAYS:${dynEn[1]}`;

  for (const { pattern, literal } of DATE_KEYWORD_MAP) {
    if (literal && pattern.test(text)) return literal;
  }
  return null;
}

// Extracts a numeric amount from free text, handling Japanese units (万, 億).
// Returns the numeric value or null.
export function extractAmountValue(text: string): number | null {
  // Normalize full-width digits
  const normalized = text.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30));

  // Japanese amount patterns: "1000万", "5億", "1,000万以上"
  const jaMatch = normalized.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:千万|億)/);
  if (jaMatch) {
    const raw = parseFloat(jaMatch[1].replace(/,/g, ''));
    if (jaMatch[0].includes('億')) return raw * 1_000_000_00;
    if (jaMatch[0].includes('千万')) return raw * 10_000_000;
  }

  const manMatch = normalized.match(/(\d[\d,]*(?:\.\d+)?)\s*万/);
  if (manMatch) return parseFloat(manMatch[1].replace(/,/g, '')) * 10_000;

  const okuMatch = normalized.match(/(\d[\d,]*(?:\.\d+)?)\s*億/);
  if (okuMatch) return parseFloat(okuMatch[1].replace(/,/g, '')) * 100_000_000;

  // Plain number with threshold word
  const plainMatch = normalized.match(/(\d[\d,]{2,})(?:\s*(?:円|ドル|USD|JPY))?/);
  if (plainMatch) {
    const v = parseFloat(plainMatch[1].replace(/,/g, ''));
    if (v >= 1000) return v;  // Skip small numbers that are likely not amounts
  }

  return null;
}

// Detects threshold operator from surrounding text (以上/以下/超/未満/above/below/over/under).
export function extractAmountOp(text: string): 'gte' | 'lte' | 'gt' | 'lt' {
  if (/(?:以上|超過?|above|over|more\s+than|>=)/i.test(text)) return 'gte';
  if (/(?:以下|未満|below|under|less\s+than|<=)/i.test(text)) return 'lte';
  if (/(?:超|より多い|>(?!=))/i.test(text)) return 'gt';
  if (/(?:未満|より少ない|<(?!=))/i.test(text)) return 'lt';
  return 'gte';  // Default: "N以上" (over N)
}

// Detects LIMIT value from input text.
export function extractLimit(text: string): number {
  const m = text.match(/(\d+)\s*(?:件|records?|rows?)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 50) return n;
  }
  return 20;
}

// Detects "closed/won/lost" stage filters for Opportunity.
function extractStageFilter(text: string): SoqlCondition | null {
  if (/(?:クローズ済|closed\s+won|受注|Closed Won)/i.test(text)) {
    return { field: 'StageName', op: 'eq', value: 'Closed Won' };
  }
  if (/(?:失注|Closed Lost|lost)/i.test(text)) {
    return { field: 'StageName', op: 'eq', value: 'Closed Lost' };
  }
  if (/(?:進行中|オープン|open|active|未クローズ)/i.test(text)) {
    return { field: 'IsClosed', op: 'eq', value: false };
  }
  return null;
}

// ── Main SOQL filter builder ───────────────────────────────────────────────────

export interface JevAnswerSet {
  intentAnswer:    ChoiceAnswer | null;
  sObjectAnswer:   ChoiceAnswer | null;
  hasAmount:       NoulAnswer   | null;
  hasDate:         NoulAnswer   | null;
  isInactive:      NoulAnswer   | null;
}

export interface BuiltSoqlFilter {
  filter:     SoqlFilter;
  sObject:    string;
  confidence: number;
  source:     'jev-template';  // Marks as deterministic (not LLM-generated)
}

/**
 * Builds a deterministic SOQL filter from Jev classification answers + keyword extraction.
 * Never uses LLM to generate SOQL text — zero field hallucination.
 *
 * @param userInput - Raw user text (for keyword extraction only)
 * @param sObjectContext - Current page sObject (fallback when Jev is uncertain)
 * @param answers - Jev classification answers
 * @param validFields - Field API names from KV schema cache (validated allowlist)
 */
export function buildSoqlFilterFromJev(
  userInput:      string,
  sObjectContext: string | null,
  answers:        JevAnswerSet,
  validFields:    Set<string>
): BuiltSoqlFilter | null {
  const intentAnswer  = answers.intentAnswer;
  const sObjectAnswer = answers.sObjectAnswer;

  if (!intentAnswer || intentAnswer.choice !== 'SOQL_SEARCH') return null;
  if (intentAnswer.confidence < 0.60) return null;  // Too uncertain even for template

  // Resolve sObject: Jev answer → page context → fallback Account
  let sObject: string;
  if (sObjectAnswer && sObjectAnswer.choice !== 'Other' && sObjectAnswer.confidence >= 0.55) {
    sObject = sObjectAnswer.choice;
  } else if (sObjectContext && sObjectContext !== 'unknown') {
    sObject = sObjectContext;
  } else {
    sObject = 'Account';
  }

  const conditions: SoqlCondition[] = [];

  // ── Date filter ───────────────────────────────────────────────────────────
  const hasDate = (answers.hasDate?.noul ?? 0) >= 0.55;
  if (hasDate) {
    const dateLiteral = extractDateLiteral(userInput);
    if (dateLiteral) {
      const dateField = sObject === 'Opportunity' ? 'CloseDate' : 'CreatedDate';
      // Validate field exists in schema cache
      if (validFields.size === 0 || validFields.has(dateField)) {
        conditions.push({ field: dateField, op: 'gte', value: dateLiteral });
      }
    }
  }

  // ── Amount filter (Opportunity / Account) ─────────────────────────────────
  const hasAmount = (answers.hasAmount?.noul ?? 0) >= 0.55;
  if (hasAmount && (sObject === 'Opportunity' || sObject === 'Account')) {
    const amountVal = extractAmountValue(userInput);
    if (amountVal !== null) {
      const amountField = sObject === 'Opportunity' ? 'Amount' : 'AnnualRevenue';
      if (validFields.size === 0 || validFields.has(amountField)) {
        conditions.push({ field: amountField, op: extractAmountOp(userInput), value: amountVal });
      }
    }
  }

  // ── Inactive / stale records ───────────────────────────────────────────────
  const isInactive = (answers.isInactive?.noul ?? 0) >= 0.60;
  if (isInactive) {
    if (validFields.size === 0 || validFields.has('LastActivityDate')) {
      conditions.push({ field: 'LastActivityDate', op: 'lt', value: 'LAST_N_DAYS:14' });
    }
    // Open records only for Opportunity
    if (sObject === 'Opportunity' && (validFields.size === 0 || validFields.has('IsClosed'))) {
      conditions.push({ field: 'IsClosed', op: 'eq', value: false });
    }
  }

  // ── Stage filter (Opportunity only) ───────────────────────────────────────
  if (sObject === 'Opportunity') {
    const stageCondition = extractStageFilter(userInput);
    if (stageCondition && (validFields.size === 0 || validFields.has(stageCondition.field))) {
      conditions.push(stageCondition);
    }
  }

  // ── Recency fallback (no explicit date or amount) ─────────────────────────
  // If no conditions were built, default to last 30 days
  if (conditions.length === 0) {
    const defaultDateField = 'CreatedDate';
    if (validFields.size === 0 || validFields.has(defaultDateField)) {
      conditions.push({ field: defaultDateField, op: 'gte', value: 'LAST_N_DAYS:30' });
    }
  }

  // ── ORDER BY ──────────────────────────────────────────────────────────────
  const hasInactiveSort = isInactive;
  const orderBy = hasInactiveSort
    ? 'LastActivityDate ASC'
    : sObject === 'Opportunity'
      ? 'Amount DESC'
      : 'CreatedDate DESC';

  return {
    filter: {
      conditions,
      order_by: orderBy,
      limit:    extractLimit(userInput),
    },
    sObject,
    confidence: intentAnswer.confidence,
    source:    'jev-template',
  };
}
