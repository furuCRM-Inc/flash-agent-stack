import { describe, it, expect } from 'vitest';
import {
  extractAmountValue,
  extractAmountOp,
  extractLimit,
  extractDateLiteral,
  extractSimpleUpdate,
  extractNullCheckFilter,
  buildSoqlFilterFromJev,
  FIELD_SYNONYM_MAP,
  type JevAnswerSet,
} from './jev-intent.js';
import type { ChoiceAnswer, NoulAnswer } from '../types.js';

// Previously this module had zero direct unit tests — everything was only
// exercised indirectly (if at all) through cf-worker.test.ts's higher-level
// tryFastRoute tests, none of which import from jev-intent.ts at all.

function choice(value: string, confidence = 0.9): ChoiceAnswer {
  return { type: 'choice', choice: value, confidence, probabilities: {} };
}
function noul(value: number): NoulAnswer {
  return { type: 'noul', noul: value };
}
function highConfidenceAnswers(sObject: string, opts: { hasDate?: number; hasAmount?: number; isInactive?: number } = {}): JevAnswerSet {
  return {
    intentAnswer:  choice('SOQL_SEARCH', 0.95),
    sObjectAnswer: choice(sObject, 0.95),
    hasDate:       noul(opts.hasDate ?? 0),
    hasAmount:     noul(opts.hasAmount ?? 0),
    isInactive:    noul(opts.isInactive ?? 0),
  };
}

describe('extractAmountValue — compound Japanese numerals', () => {
  it('sums a compound 億+万 amount instead of dropping the 万 remainder', () => {
    // Bug: "1億5000万" used to match only "1億" (100,000,000), silently
    // dropping "5000万" (50,000,000) — should be 150,000,000.
    expect(extractAmountValue('1億5000万円の商談')).toBe(150_000_000);
  });

  it('handles a single 億 amount (no compounding needed)', () => {
    expect(extractAmountValue('5億円以上の商談')).toBe(500_000_000);
  });

  it('handles a single 万 amount', () => {
    expect(extractAmountValue('500万円の商談')).toBe(5_000_000);
  });

  it('handles a single 千万 amount', () => {
    expect(extractAmountValue('3千万円の商談')).toBe(30_000_000);
  });

  it('does not fold two unrelated 万 figures far apart in the same sentence', () => {
    // Two distinct concepts, not a compound number — should only take the first.
    const v = extractAmountValue('従業員500万人以上、収益とは無関係の会社概要のみ確認');
    expect(v).toBe(5_000_000);
  });
});

describe('extractAmountValue — English magnitude words (previously unimplemented)', () => {
  it('parses "$X million"', () => {
    expect(extractAmountValue('opportunities over $3 million')).toBe(3_000_000);
  });

  it('parses "Xk"', () => {
    expect(extractAmountValue('deals worth 50k or more')).toBe(50_000);
  });

  it('still handles a plain large number with a currency symbol', () => {
    expect(extractAmountValue('opportunities over $500,000')).toBe(500_000);
  });
});

describe('extractAmountOp', () => {
  it('detects "ちょうど"/"exactly" as an equality operator', () => {
    expect(extractAmountOp('ちょうど500万円の商談')).toBe('eq');
    expect(extractAmountOp('exactly $500,000 deals')).toBe('eq');
  });

  it('still detects gte/lte as before', () => {
    expect(extractAmountOp('500万円以上')).toBe('gte');
    expect(extractAmountOp('500万円以下')).toBe('lte');
    expect(extractAmountOp('over 500000')).toBe('gte');
    expect(extractAmountOp('under 500000')).toBe('lte');
  });

  it('"超" alone matches the gte branch (超過? is optional) — pre-existing behavior, not this pass\'s change', () => {
    expect(extractAmountOp('500万円超')).toBe('gte');
  });
});

describe('extractLimit', () => {
  it('recognizes "all"/"every"/"すべて"/"全て" as a max-page request', () => {
    expect(extractLimit('show all 200 open cases')).toBe(200);
    expect(extractLimit('show every case')).toBe(200);
    expect(extractLimit('未解決ケースをすべて見せて')).toBe(200);
    expect(extractLimit('全てのケースを見せて')).toBe(200);
  });

  it('parses an explicit count within the practical ceiling', () => {
    expect(extractLimit('5件見せて')).toBe(5);
    expect(extractLimit('show me 30 records')).toBe(30);
  });

  it('clamps an explicit count above the ceiling instead of silently resetting to the default', () => {
    // Previously: anything outside 1-50 fell through to the unconditional
    // default of 20, discarding the user's explicit larger number entirely.
    expect(extractLimit('show me 500 rows')).toBe(100);
  });

  it('falls back to the default of 20 when no count is present', () => {
    expect(extractLimit('show opportunities')).toBe(20);
  });
});

describe('extractDateLiteral — sanity (regression baseline)', () => {
  it('resolves common named periods in both languages', () => {
    expect(extractDateLiteral('this month')).toBe('THIS_MONTH');
    expect(extractDateLiteral('今月')).toBe('THIS_MONTH');
    expect(extractDateLiteral('来月')).toBe('NEXT_MONTH');
    expect(extractDateLiteral('先月')).toBe('LAST_MONTH');
  });

  it('resolves dynamic N-day windows', () => {
    expect(extractDateLiteral('過去45日間')).toBe('LAST_N_DAYS:45');
    expect(extractDateLiteral('last 45 days')).toBe('LAST_N_DAYS:45');
  });
});

describe('buildSoqlFilterFromJev — CreatedDate vs CloseDate heuristic', () => {
  it('"new deals this month" (EN, no "creat*") now correctly maps to CreatedDate', () => {
    // Bug: isCreatedIntent required "new" to co-occur with "creat*" — bare
    // "new" alone fell through to CloseDate, disagreeing with the Japanese
    // "新規" branch, which matched on its own for the equivalent phrasing.
    const result = buildSoqlFilterFromJev(
      'show new deals this month', null, highConfidenceAnswers('Opportunity', { hasDate: 0.9 }), new Set()
    );
    const dateCond = result?.filter.conditions.find(c => c.field === 'CreatedDate' || c.field === 'CloseDate');
    expect(dateCond?.field).toBe('CreatedDate');
  });

  it('"新規商談" (JA) still maps to CreatedDate (control)', () => {
    const result = buildSoqlFilterFromJev(
      '今月の新規商談', null, highConfidenceAnswers('Opportunity', { hasDate: 0.9 }), new Set()
    );
    const dateCond = result?.filter.conditions.find(c => c.field === 'CreatedDate' || c.field === 'CloseDate');
    expect(dateCond?.field).toBe('CreatedDate');
  });

  it('"opportunities closing this month" still maps to CloseDate (control)', () => {
    const result = buildSoqlFilterFromJev(
      'opportunities closing this month', null, highConfidenceAnswers('Opportunity', { hasDate: 0.9 }), new Set()
    );
    const dateCond = result?.filter.conditions.find(c => c.field === 'CreatedDate' || c.field === 'CloseDate');
    expect(dateCond?.field).toBe('CloseDate');
  });

  it('"deals added this month" (EN "added") maps to CreatedDate', () => {
    const result = buildSoqlFilterFromJev(
      'deals added this month', null, highConfidenceAnswers('Opportunity', { hasDate: 0.9 }), new Set()
    );
    const dateCond = result?.filter.conditions.find(c => c.field === 'CreatedDate' || c.field === 'CloseDate');
    expect(dateCond?.field).toBe('CreatedDate');
  });

  it('"今月追加された商談" (JA "追加") now maps to CreatedDate', () => {
    // Bug: 追加 (added) had no equivalent in the JA branch at all.
    const result = buildSoqlFilterFromJev(
      '今月追加された商談', null, highConfidenceAnswers('Opportunity', { hasDate: 0.9 }), new Set()
    );
    const dateCond = result?.filter.conditions.find(c => c.field === 'CreatedDate' || c.field === 'CloseDate');
    expect(dateCond?.field).toBe('CreatedDate');
  });
});

describe('buildSoqlFilterFromJev — Case status negation fix', () => {
  it('"クローズしていないケース" resolves to IsClosed = false, not true', () => {
    // Bug: the closed-branch regex's 済? is optional, so it matched the bare
    // substring "クローズ" regardless of a following negation — "クローズして
    // いない" (NOT closed) was silently classified as IsClosed = true.
    const result = buildSoqlFilterFromJev(
      'クローズしていないケース', null, highConfidenceAnswers('Case'), new Set()
    );
    const statusCond = result?.filter.conditions.find(c => c.field === 'IsClosed');
    expect(statusCond?.value).toBe(false);
  });

  it('"クローズ済みのケース" (control, still positive) resolves to IsClosed = true', () => {
    const result = buildSoqlFilterFromJev(
      'クローズ済みのケース', null, highConfidenceAnswers('Case'), new Set()
    );
    const statusCond = result?.filter.conditions.find(c => c.field === 'IsClosed');
    expect(statusCond?.value).toBe(true);
  });
});

describe('buildSoqlFilterFromJev — Lead IsConverted (previously unimplemented)', () => {
  it('"converted leads" resolves to IsConverted = true', () => {
    const result = buildSoqlFilterFromJev(
      'converted leads', null, highConfidenceAnswers('Lead'), new Set()
    );
    const cond = result?.filter.conditions.find(c => c.field === 'IsConverted');
    expect(cond?.value).toBe(true);
  });

  it('"未変換のリード" resolves to IsConverted = false', () => {
    const result = buildSoqlFilterFromJev(
      '未変換のリード', null, highConfidenceAnswers('Lead'), new Set()
    );
    const cond = result?.filter.conditions.find(c => c.field === 'IsConverted');
    expect(cond?.value).toBe(false);
  });
});

describe('buildSoqlFilterFromJev — English parent-account context (previously unimplemented)', () => {
  it('"Acme Corp\'s opportunities" resolves an Account.Name LIKE filter', () => {
    const result = buildSoqlFilterFromJev(
      "Acme Corp's opportunities", null, highConfidenceAnswers('Opportunity'), new Set()
    );
    const cond = result?.filter.conditions.find(c => c.field === 'Account.Name');
    expect(cond?.value).toBe('%Acme Corp%');
  });

  it('"opportunities for Acme Corp" resolves an Account.Name LIKE filter', () => {
    const result = buildSoqlFilterFromJev(
      'opportunities for Acme Corp', null, highConfidenceAnswers('Opportunity'), new Set()
    );
    const cond = result?.filter.conditions.find(c => c.field === 'Account.Name');
    expect(cond?.value).toBe('%Acme Corp%');
  });

  it('escapes literal % and _ in the extracted account name', () => {
    const result = buildSoqlFilterFromJev(
      "100%_Growth Inc's opportunities", null, highConfidenceAnswers('Opportunity'), new Set()
    );
    const cond = result?.filter.conditions.find(c => c.field === 'Account.Name');
    expect(cond?.value).toBe('%100\\%\\_Growth Inc%');
  });
});

describe('extractSimpleUpdate — English patterns (previously unimplemented)', () => {
  it('"change the amount to 5000000" resolves Amount without a record name', () => {
    const result = extractSimpleUpdate('change the amount to 5000000', null, new Set());
    expect(result?.fields).toEqual({ Amount: 5_000_000 });
    expect(result?.searchName).toBeNull();
  });

  it('"set stage to Closed Won" resolves StageName', () => {
    const result = extractSimpleUpdate('set stage to Closed Won', null, new Set());
    expect(result?.fields).toEqual({ StageName: 'Closed Won' });
  });

  it("\"change Acme Corp's amount to 5000000\" resolves both record name and field", () => {
    const result = extractSimpleUpdate("change Acme Corp's amount to 5000000", null, new Set());
    expect(result?.searchName).toBe('Acme Corp');
    expect(result?.fields).toEqual({ Amount: 5_000_000 });
  });

  it('Japanese pattern still works (control)', () => {
    const result = extractSimpleUpdate('A社の金額を1000万に変更', null, new Set());
    expect(result?.searchName).toBe('A社');
    expect(result?.fields).toEqual({ Amount: 10_000_000 });
  });
});

describe('FIELD_SYNONYM_MAP — English entries exist', () => {
  it('maps common English field words to API names', () => {
    expect(FIELD_SYNONYM_MAP['amount']).toBe('Amount');
    expect(FIELD_SYNONYM_MAP['stage']).toBe('StageName');
    expect(FIELD_SYNONYM_MAP['owner']).toBe('OwnerId');
  });
});

describe('extractAmountValue — full-width and comma-separated numbers', () => {
  it('parses a full-width compound amount ("１００万")', () => {
    expect(extractAmountValue('１００万円の商談')).toBe(1_000_000);
  });

  it('parses a full-width digit + comma amount ("１，０００，０００")', () => {
    expect(extractAmountValue('１，０００，０００円の商談')).toBe(1_000_000);
  });

  it('parses a plain comma-separated number ("100,000")', () => {
    expect(extractAmountValue('deals worth 100,000 or more')).toBe(100_000);
  });

  it('parses a $-prefixed comma number combined with a magnitude word ("$1,500,000")', () => {
    expect(extractAmountValue('opportunities over $1,500,000')).toBe(1_500_000);
  });

  it('parses a comma number combined with 万 ("5,000万")', () => {
    expect(extractAmountValue('5,000万円の商談')).toBe(50_000_000);
  });
});

describe('extractNullCheckFilter — null/blank value detection (previously unimplemented)', () => {
  it('"no phone number" resolves Phone IS NULL', () => {
    const cond = extractNullCheckFilter('leads with no phone number', new Set());
    expect(cond).toEqual({ field: 'Phone', op: 'is_null' });
  });

  it('"accounts without a website" resolves Website IS NULL', () => {
    const cond = extractNullCheckFilter('accounts without a website', new Set());
    expect(cond).toEqual({ field: 'Website', op: 'is_null' });
  });

  it('"missing email" resolves Email IS NULL', () => {
    const cond = extractNullCheckFilter('contacts missing email', new Set());
    expect(cond).toEqual({ field: 'Email', op: 'is_null' });
  });

  it('"電話番号が未設定の取引先" resolves Phone IS NULL', () => {
    const cond = extractNullCheckFilter('電話番号が未設定の取引先', new Set());
    expect(cond).toEqual({ field: 'Phone', op: 'is_null' });
  });

  it('"ウェブサイトがない会社" resolves Website IS NULL', () => {
    const cond = extractNullCheckFilter('ウェブサイトがない会社', new Set());
    expect(cond).toEqual({ field: 'Website', op: 'is_null' });
  });

  it('returns null (no throw) when no recognizable field is mentioned', () => {
    expect(extractNullCheckFilter('show me all accounts', new Set())).toBeNull();
  });

  it('respects validFields when a schema is provided', () => {
    expect(extractNullCheckFilter('no phone number', new Set(['Website']))).toBeNull();
    expect(extractNullCheckFilter('no phone number', new Set(['Phone']))).toEqual({ field: 'Phone', op: 'is_null' });
  });

  it('wires through buildSoqlFilterFromJev end-to-end', () => {
    const result = buildSoqlFilterFromJev(
      'leads with no phone number', null, highConfidenceAnswers('Lead'), new Set()
    );
    const cond = result?.filter.conditions.find(c => c.field === 'Phone');
    expect(cond).toEqual({ field: 'Phone', op: 'is_null' });
  });
});

describe('extractDateLiteral — relative date edge cases (previously unmapped)', () => {
  it('resolves "yesterday"/"昨日" (previously entirely absent from the extraction layer)', () => {
    expect(extractDateLiteral('yesterday')).toBe('YESTERDAY');
    expect(extractDateLiteral('昨日')).toBe('YESTERDAY');
  });

  it('resolves "tomorrow"/"明日"', () => {
    expect(extractDateLiteral('tomorrow')).toBe('TOMORROW');
    expect(extractDateLiteral('明日')).toBe('TOMORROW');
  });

  it('resolves "一昨日" (the day before yesterday) to a 2-day window, does not throw', () => {
    expect(() => extractDateLiteral('一昨日')).not.toThrow();
    expect(extractDateLiteral('一昨日')).toBe('LAST_N_DAYS:2');
  });

  it('resolves "一昨々日" (three days ago) to a 3-day window, does not throw', () => {
    expect(() => extractDateLiteral('一昨々日')).not.toThrow();
    expect(extractDateLiteral('一昨々日')).toBe('LAST_N_DAYS:3');
  });

  it('a YESTERDAY/TOMORROW literal compiles safely through buildSoqlFilterFromJev without throwing', () => {
    expect(() => buildSoqlFilterFromJev(
      'cases created yesterday', null, highConfidenceAnswers('Case', { hasDate: 0.9 }), new Set()
    )).not.toThrow();
    const result = buildSoqlFilterFromJev(
      'cases created yesterday', null, highConfidenceAnswers('Case', { hasDate: 0.9 }), new Set()
    );
    const dateCond = result?.filter.conditions.find(c => c.field === 'CreatedDate');
    expect(dateCond?.value).toBe('YESTERDAY');
  });
});
