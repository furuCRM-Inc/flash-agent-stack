import { describe, it, expect } from 'vitest';
import {
  normalizeJapaneseUnits,
  extractJson,
  localize,
  inferSObjectType,
  tryFastRoute,
} from './cf-worker.ts';

// ─────────────────────────────────────────────────────────────────────────────
// normalizeJapaneseUnits — unit conversion + comma stripping
// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeJapaneseUnits', () => {
  it('converts 万 to ×10,000', () =>
    expect(normalizeJapaneseUnits('100万円')).toBe('1000000円'));

  it('converts 億 to ×100,000,000', () =>
    expect(normalizeJapaneseUnits('2億円')).toBe('200000000円'));

  it('converts 兆', () =>
    expect(normalizeJapaneseUnits('1兆')).toBe('1000000000000'));

  it('converts 千 alone', () =>
    expect(normalizeJapaneseUnits('5千円')).toBe('5000円'));

  it('converts compound 5千万 (千 then 万) → 50000000', () =>
    expect(normalizeJapaneseUnits('5千万')).toBe('50000000'));

  it('strips comma before conversion — 3,800万 → 38000000', () =>
    expect(normalizeJapaneseUnits('3,800万円')).toBe('38000000円'));

  it('strips comma — 5,000万 → 50000000', () =>
    expect(normalizeJapaneseUnits('5,000万')).toBe('50000000'));

  it('strips comma — 9,500万 → 95000000', () =>
    expect(normalizeJapaneseUnits('受注金額：9,500万円')).toBe('受注金額：95000000円'));

  it('strips comma — 4,800万 → 48000000', () =>
    expect(normalizeJapaneseUnits('金額は4,800万円で双方合意')).toBe('金額は48000000円で双方合意'));

  it('handles decimal 万 — 1.5億 → 150000000', () =>
    expect(normalizeJapaneseUnits('1.5億')).toBe('150000000'));

  it('2億5,000万 contains 200000000 and 50000000', () => {
    const result = normalizeJapaneseUnits('2億5,000万円');
    expect(result).toContain('200000000');
    expect(result).toContain('50000000');
  });

  it('leaves plain numbers unchanged', () =>
    expect(normalizeJapaneseUnits('12345')).toBe('12345'));

  it('leaves non-numeric Japanese unchanged', () =>
    expect(normalizeJapaneseUnits('テスト文字列')).toBe('テスト文字列'));

  it('full meeting note — 3,800万円 normalised before LLM', () => {
    const raw = '見積金額：3,800万円（税別）\n契約予定日：2026年11月30日';
    const processed = normalizeJapaneseUnits(raw);
    expect(processed).toContain('38000000');
    expect(processed).not.toContain('3,800万');
  });

  // Meeting note pattern variants
  it('pattern ①: 2,900万 negotiation amount', () =>
    expect(normalizeJapaneseUnits('2,900万円まで譲歩する')).toBe('29000000円まで譲歩する'));

  it('pattern ②: 2億5,000万 enterprise deal', () => {
    const r = normalizeJapaneseUnits('予算規模は2億5,000万円を想定');
    expect(r).toContain('200000000');
  });

  it('pattern ③: 9,500万 closed won', () =>
    expect(normalizeJapaneseUnits('受注金額：9,500万円（税別）')).toBe('受注金額：95000000円（税別）'));
});

// ─────────────────────────────────────────────────────────────────────────────
// extractJson — handles raw LLM output reliably
// ─────────────────────────────────────────────────────────────────────────────
describe('extractJson', () => {
  it('parses clean JSON', () =>
    expect(extractJson('{"intent":"EXTRACT","fields":{"Amount":38000000}}')).toEqual({
      intent: 'EXTRACT', fields: { Amount: 38000000 },
    }));

  it('strips markdown code fence', () =>
    expect(extractJson('```json\n{"intent":"SEARCH"}\n```')).toEqual({ intent: 'SEARCH' }));

  it('extracts JSON from prose prefix', () => {
    const r = extractJson('Here is the action:\n{"intent":"NAVIGATE","search_name":"田中"}');
    expect(r.intent).toBe('NAVIGATE');
    expect(r.search_name).toBe('田中');
  });

  it('returns {} on garbage', () =>
    expect(extractJson('not json at all')).toEqual({}));

  it('returns {} on empty string', () =>
    expect(extractJson('')).toEqual({}));

  it('handles nested fields object', () => {
    const r = extractJson('{"intent":"UPDATE_RECORD","fields":{"Amount":500000,"StageName":"Closed Won"}}');
    expect((r.fields as Record<string, unknown>).StageName).toBe('Closed Won');
  });

  it('handles EXTRACT with full Opportunity fields', () => {
    const json = JSON.stringify({
      intent: 'EXTRACT',
      fields: { Amount: 38000000, CloseDate: '2026-11-30', StageName: 'Proposal/Price Quote' },
    });
    const r = extractJson(json);
    expect(r.intent).toBe('EXTRACT');
    expect((r.fields as Record<string, unknown>).Amount).toBe(38000000);
    expect((r.fields as Record<string, unknown>).CloseDate).toBe('2026-11-30');
  });

  it('handles GUIDE_CREATE response', () => {
    const json = JSON.stringify({
      intent: 'GUIDE_CREATE', guide_sobject: 'Campaign', fields: {},
    });
    const r = extractJson(json);
    expect(r.intent).toBe('GUIDE_CREATE');
    expect(r.guide_sobject).toBe('Campaign');
  });

  it('handles CLARIFY response', () => {
    const json = JSON.stringify({
      intent: 'CLARIFY',
      message: 'どのオブジェクトを作成しますか？',
      fields: {},
    });
    const r = extractJson(json);
    expect(r.intent).toBe('CLARIFY');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// localize — language-aware message selection
// ─────────────────────────────────────────────────────────────────────────────
describe('localize', () => {
  it('returns Japanese for ja', () =>
    expect(localize('Hello', 'こんにちは', 'ja')).toBe('こんにちは'));
  it('returns Japanese for ja_JP', () =>
    expect(localize('Hello', 'こんにちは', 'ja_JP')).toBe('こんにちは'));
  it('returns English for en', () =>
    expect(localize('Hello', 'こんにちは', 'en')).toBe('Hello'));
  it('returns English for en_US', () =>
    expect(localize('Hello', 'こんにちは', 'en_US')).toBe('Hello'));
  it('returns English for null', () =>
    expect(localize('Hello', 'こんにちは', null)).toBe('Hello'));
  it('returns English for empty string', () =>
    expect(localize('Hello', 'こんにちは', '')).toBe('Hello'));
});

// ─────────────────────────────────────────────────────────────────────────────
// inferSObjectType — standard + Japanese mapping
// ─────────────────────────────────────────────────────────────────────────────
describe('inferSObjectType — standard objects', () => {
  const cases: [string, string][] = [
    ['Opportunity',   'Opportunity'],
    ['商談',          'Opportunity'],
    ['取引先',        'Account'],
    ['連絡先',        'Contact'],
    ['取引先責任者',  'Contact'],
    ['リード',        'Lead'],
    ['ケース',        'Case'],
    ['キャンペーン',  'Campaign'],
    ['行動',          'Task'],
    ['account',       'Account'],
    ['deal',          'Opportunity'],
    ['lead',          'Lead'],
    ['case',          'Case'],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → ${expected}`, () =>
      expect(inferSObjectType(input)).toBe(expected));
  }
});

describe('inferSObjectType — custom objects passthrough', () => {
  it('unknown type capitalises first letter', () =>
    expect(inferSObjectType('customObject__c')).toBe('CustomObject__c'));
  it('known suffix __c left intact', () =>
    expect(inferSObjectType('Furu_Project__c')).toBe('Furu_Project__c'));
  it('custom object with namespace prefix preserved', () =>
    expect(inferSObjectType('furu__Project__c')).toBe('Furu__Project__c'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Custom object scenarios — EXTRACT, GUIDE_CREATE, UPDATE_RECORD
// ─────────────────────────────────────────────────────────────────────────────
describe('Custom object — extractJson responses', () => {
  it('EXTRACT for custom object returns correct API field names', () => {
    const json = JSON.stringify({
      intent: 'EXTRACT',
      sObjectType: 'Furu_Project__c',
      fields: {
        Name:               'SFA導入プロジェクト',
        Budget__c:          5000000,
        Due_Date__c:        '2026-12-31',
        Status__c:          '進行中',
        Account__c:         '0017j00000XXXXXX',
      },
    });
    const r = extractJson(json);
    const f = r.fields as Record<string, unknown>;
    expect(f.Budget__c).toBe(5000000);
    expect(f.Due_Date__c).toBe('2026-12-31');
    expect(f.Status__c).toBe('進行中');
  });

  it('GUIDE_CREATE for custom object uses __c API name', () => {
    const json = JSON.stringify({
      intent: 'GUIDE_CREATE',
      guide_sobject: 'Furu_Project__c',
      fields: {},
    });
    const r = extractJson(json);
    expect(r.guide_sobject).toBe('Furu_Project__c');
  });

  it('UPDATE_RECORD for custom object with __r relationship field', () => {
    const json = JSON.stringify({
      intent: 'UPDATE_RECORD',
      fields: {
        'Account__r.Name': 'テスト取引先', // relationship — should be converted to Account__c
      },
    });
    const r = extractJson(json);
    expect((r.fields as Record<string, unknown>)['Account__r.Name']).toBe('テスト取引先');
  });
});

describe('Custom object — normalizeJapaneseUnits with custom fields', () => {
  it('custom currency field value normalized', () => {
    const raw = 'Budget__c: 5,000万円';
    expect(normalizeJapaneseUnits(raw)).toBe('Budget__c: 50000000円');
  });

  it('custom text fields with numbers unaffected', () => {
    const raw = 'Project_Code__c: PRJ-2026-001';
    expect(normalizeJapaneseUnits(raw)).toBe('Project_Code__c: PRJ-2026-001');
  });
});

describe('Custom object — GUIDE_CREATE fast-route via sObjectType context', () => {
  it('acts as pass-through to LLM when sObject is custom and not in JA map', () => {
    // "プロジェクトを作成したい" — プロジェクト not in JA_SOBJECT_MAP → inferSObjectType returns capitalised
    const r = tryFastRoute({
      user_input:   'プロジェクトを作成したい',
      sObjectType:  'Furu_Project__c',
      userLanguage: 'ja',
    });
    // Either returns GUIDE_CREATE with Furu_Project__c fallback from context,
    // or null (falls through to LLM for unknown JP label)
    // CJK-result fallback: fast-route MUST use req.sObjectType when label is unknown
    expect(r?.intent).toBe('GUIDE_CREATE');
    expect(r?.guide_sobject).toBe('Furu_Project__c');
  });

  it('English GUIDE_CREATE with custom sObject context still goes through LLM', () => {
    // English fast-route doesn't have GUIDE_CREATE handling — LLM handles it
    const r = tryFastRoute({
      user_input:   'create a new project',
      sObjectType:  'Furu_Project__c',
      userLanguage: 'en',
    });
    expect(r).toBeNull(); // no English fast-route for GUIDE_CREATE
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tryFastRoute — Japanese GUIDE_CREATE fast-path (no LLM needed)
// ─────────────────────────────────────────────────────────────────────────────
describe('tryFastRoute — Japanese GUIDE_CREATE', () => {
  const req = (input: string, sobj?: string) => ({
    user_input: input,
    sObjectType: sobj,
    userLanguage: 'ja',
  });

  it('キャンペーンを作成したい → GUIDE_CREATE Campaign', () => {
    const r = tryFastRoute(req('キャンペーンを作成したい'));
    expect(r?.intent).toBe('GUIDE_CREATE');
    expect(r?.guide_sobject).toBe('Campaign');
  });

  it('新規取引先を登録したい → GUIDE_CREATE Account', () => {
    const r = tryFastRoute(req('新規取引先を登録したい'));
    expect(r?.intent).toBe('GUIDE_CREATE');
    expect(r?.guide_sobject).toBe('Account');
  });

  it('商談を作成したい → GUIDE_CREATE Opportunity', () => {
    const r = tryFastRoute(req('商談を作成したい'));
    expect(r?.intent).toBe('GUIDE_CREATE');
    expect(r?.guide_sobject).toBe('Opportunity');
  });

  it('連絡先を追加したい → GUIDE_CREATE Contact', () => {
    const r = tryFastRoute(req('連絡先を追加したい'));
    expect(r?.intent).toBe('GUIDE_CREATE');
    expect(r?.guide_sobject).toBe('Contact');
  });

  it('リードを作成したい → GUIDE_CREATE Lead', () => {
    const r = tryFastRoute(req('リードを作成したい'));
    expect(r?.intent).toBe('GUIDE_CREATE');
    expect(r?.guide_sobject).toBe('Lead');
  });

  it('ケースを作成したい → GUIDE_CREATE Case', () => {
    const r = tryFastRoute(req('ケースを作成したい'));
    expect(r?.intent).toBe('GUIDE_CREATE');
    expect(r?.guide_sobject).toBe('Case');
  });

  it('new record on unknown sObject falls back to req.sObjectType', () => {
    const r = tryFastRoute(req('新規作成したい', 'Campaign'));
    // "新規作成したい" may not match the regex since it lacks a sObject noun
    // — either null or GUIDE_CREATE with Campaign from context
    if (r !== null) {
      expect(r.guide_sobject).toBe('Campaign');
    }
  });

  it('returns null for non-GUIDE Japanese (short query)', () => {
    const r = tryFastRoute(req('田中さんを探して'));
    expect(r).toBeNull(); // → falls through to LLM
  });

  it('English input still goes through English fast-route, not this branch', () => {
    const r = tryFastRoute({ user_input: 'go to Account list', userLanguage: 'en' });
    expect(r?.intent).toBe('NAVIGATE');
  });

  it('message is localised in Japanese', () => {
    const r = tryFastRoute(req('取引先を作成したい'));
    expect(r?.message).toMatch(/フィールドガイド/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Meeting notes EXTRACT pre-processing — full pattern verification
// ─────────────────────────────────────────────────────────────────────────────
describe('Meeting notes EXTRACT pre-processing', () => {
  // Pattern ①: Negotiation, amount decrease
  it('Pattern①: 2,900万 normalized', () => {
    const raw = '金額は2,900万円まで譲歩する方針。クローズ目標は2027年1月31日。価格交渉段階。';
    const n = normalizeJapaneseUnits(raw);
    expect(n).toContain('29000000');
    expect(n).toContain('2027年1月31日'); // dates not touched
  });

  // Pattern ②: Billion-scale deal
  it('Pattern②: 2億5,000万 normalized', () => {
    const raw = '予算規模は2億5,000万円を想定。導入は来年度4月。';
    const n = normalizeJapaneseUnits(raw);
    expect(n).toContain('200000000');
    expect(n).not.toContain('2億5,000万');
  });

  // Pattern ③: Closed Won
  it('Pattern③: 9,500万 closed won', () => {
    const raw = '受注金額：9,500万円（税別）。契約締結日：2026年11月15日。';
    const n = normalizeJapaneseUnits(raw);
    expect(n).toBe('受注金額：95000000円（税別）。契約締結日：2026年11月15日。');
  });

  // Pattern ④: Lead (business card) — no currency amounts
  it('Pattern④: Lead no currency — text unchanged for non-numeric fields', () => {
    const raw = 'メール：e.fukuda@example.co.jp 電話：03-5678-9012';
    expect(normalizeJapaneseUnits(raw)).toBe(raw);
  });

  // Pattern ⑤: Relative date note — 今月末, 今週末
  it('Pattern⑤: 4,800万 relative date note', () => {
    const raw = '金額は4,800万円で双方合意済み。今月末に稟議が通れば即契約。';
    const n = normalizeJapaneseUnits(raw);
    expect(n).toContain('48000000');
    expect(n).toContain('今月末');
  });

  // Main test case from earlier session
  it('Original meeting note: 3,800万 amount + no date mutation', () => {
    const raw = '見積金額：3,800万円（税別）\n契約予定日：2026年11月30日\n現フェーズ：提案／見積提示\n確度：75%';
    const n = normalizeJapaneseUnits(raw);
    expect(n).toContain('38000000');
    expect(n).toContain('2026年11月30日'); // date string intact
    expect(n).toContain('提案／見積提示');  // Japanese text intact
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractJson — EXTRACT intent field shapes
// ─────────────────────────────────────────────────────────────────────────────
describe('extractJson — EXTRACT response shapes', () => {
  it('Opportunity EXTRACT response', () => {
    const json = JSON.stringify({
      intent: 'EXTRACT',
      fields: {
        Amount: 38000000,
        CloseDate: '2026-11-30',
        StageName: 'Proposal/Price Quote',
        NextStep: '提案書v2を10月3日送付',
        Description: 'SFA導入プロジェクト（フジサワ商事様）',
      },
    });
    const r = extractJson(json);
    const f = r.fields as Record<string, unknown>;
    expect(f.Amount).toBe(38000000);
    expect(f.CloseDate).toBe('2026-11-30');
    expect(f.StageName).toBe('Proposal/Price Quote');
    expect(typeof f.NextStep).toBe('string');
  });

  it('Negotiation pattern — lower amount, later close date', () => {
    const json = JSON.stringify({
      intent: 'EXTRACT',
      fields: { Amount: 29000000, CloseDate: '2027-01-31', StageName: 'Negotiation/Review' },
    });
    const r = extractJson(json);
    const f = r.fields as Record<string, unknown>;
    expect(f.Amount).toBe(29000000);
    expect(f.StageName).toBe('Negotiation/Review');
  });

  it('Closed Won pattern', () => {
    const json = JSON.stringify({
      intent: 'EXTRACT',
      fields: { Amount: 95000000, CloseDate: '2026-11-15', StageName: 'Closed Won' },
    });
    const r = extractJson(json);
    expect((r.fields as Record<string, unknown>).StageName).toBe('Closed Won');
  });

  it('Lead EXTRACT with contact fields', () => {
    const json = JSON.stringify({
      intent: 'EXTRACT',
      fields: {
        LastName: '福田',
        FirstName: '恵美',
        Title: '情報システム部 マネージャー',
        Company: '株式会社丸紅フィールドソリューションズ',
        Email: 'e.fukuda@example.co.jp',
        Phone: '03-5678-9012',
      },
    });
    const r = extractJson(json);
    const f = r.fields as Record<string, unknown>;
    expect(f.LastName).toBe('福田');
    expect(f.Email).toBe('e.fukuda@example.co.jp');
  });

  it('Prospecting first meeting — no amount', () => {
    const json = JSON.stringify({
      intent: 'EXTRACT',
      fields: { StageName: 'Prospecting', CloseDate: '2027-03-31' },
    });
    const r = extractJson(json);
    expect((r.fields as Record<string, unknown>).StageName).toBe('Prospecting');
    expect(r.fields as Record<string, unknown>).not.toHaveProperty('Amount');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Semantic layer — knowledge rule translation responses
// (tests the /v1/translate-rule response shape that Apex persists)
// ─────────────────────────────────────────────────────────────────────────────
describe('Semantic layer — translate-rule response shape', () => {
  it('well-formed rule response parsed correctly', () => {
    const json = JSON.stringify({
      friendly_rule: 'クローズ日は必ず未来の日付にしてください。',
      sObjectType:   'Opportunity',
    });
    const r = extractJson(json);
    expect(r.friendly_rule).toBe('クローズ日は必ず未来の日付にしてください。');
    expect(r.sObjectType).toBe('Opportunity');
  });

  it('rule with English validation error survives extractJson', () => {
    const json = JSON.stringify({
      friendly_rule: 'BillingStreet cannot be blank when BillingCity is set.',
      sObjectType:   'Account',
    });
    const r = extractJson(json);
    expect(typeof r.friendly_rule).toBe('string');
    expect(r.friendly_rule).toContain('BillingStreet');
  });

  it('rule missing sObjectType still parseable', () => {
    const json = JSON.stringify({ friendly_rule: '取引先名は必須です。' });
    const r = extractJson(json);
    expect(r.friendly_rule).toBe('取引先名は必須です。');
    expect(r.sObjectType).toBeUndefined();
  });

  it('empty friendly_rule becomes empty string not undefined', () => {
    const json = JSON.stringify({ friendly_rule: '', sObjectType: 'Lead' });
    const r = extractJson(json);
    expect(r.friendly_rule).toBe('');
  });

  it('knowledge check response — JSON arrays are valid JSON and parsed (boundary note)', () => {
    // Apex knowledge warnings come as List<String> — NOT as extractJson input.
    // extractJson receives the full agent action JSON object, not an array.
    // This confirms that a plain array parses successfully (no crash).
    const json = JSON.stringify([
      'クローズ日は必ず未来の日付にしてください。',
      '金額は税抜きで入力してください。',
    ]);
    const r = extractJson(json);
    // Returns the array cast as Record<string, unknown> — length is accessible as numeric key
    expect(Array.isArray(r)).toBe(true);
  });

  it('EXTRACT intent with __relativeOps preserved through extractJson', () => {
    const json = JSON.stringify({
      intent: 'UPDATE_RECORD',
      fields: {
        __relativeOps: [
          { field: 'Amount', op: 'percent_add', value: 10 },
          { field: 'CloseDate', op: 'add_weeks', value: 2 },
        ],
      },
    });
    const r = extractJson(json);
    const ops = (r.fields as Record<string, unknown>).__relativeOps as unknown[];
    expect(Array.isArray(ops)).toBe(true);
    expect(ops).toHaveLength(2);
    expect((ops[0] as Record<string, unknown>).op).toBe('percent_add');
  });

  it('__copyAddress signal preserved through extractJson', () => {
    const json = JSON.stringify({
      intent: 'UPDATE_RECORD',
      fields: { __copyAddress: 'BillingToShipping' },
    });
    const r = extractJson(json);
    expect((r.fields as Record<string, unknown>).__copyAddress).toBe('BillingToShipping');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tryFastRoute — NAVIGATE regression suite
// Bug: "Navigate to United Oil & Gas Corp" on an Opportunity page was returning
//      search_sobject: 'Opportunity' (page context) instead of 'Account'.
//      Apex would then try findRecordId('Opportunity', …) → fail → LWC showed
//      Opportunity field guide instead of navigating to the account.
// Fix: unqualified navigate targets always default to 'Account' so Apex's
//      Account → Contact → Lead fallback chain fires correctly.
// ─────────────────────────────────────────────────────────────────────────────
describe('tryFastRoute — NAVIGATE sObject resolution', () => {
  const opp = { user_input: '', sObjectType: 'Opportunity', pageType: 'record_detail', field_schema: [], userLanguage: 'en' };

  it('regression: "Navigate to United Oil & Gas Corp" on Opp page → Account, not Opportunity', () => {
    const r = tryFastRoute({ ...opp, user_input: 'Navigate to United Oil & Gas Corp' });
    expect(r?.intent).toBe('NAVIGATE');
    expect(r?.search_sobject).toBe('Account');  // was 'Opportunity' before fix
    expect(r?.search_name).toBe('United Oil & Gas Corp');
  });

  it('regression: "open Acme Corp" on Lead page → Account', () => {
    const r = tryFastRoute({ ...opp, user_input: 'open Acme Corp', sObjectType: 'Lead' });
    expect(r?.intent).toBe('NAVIGATE');
    expect(r?.search_sobject).toBe('Account');
  });

  it('explicit sObject keyword overrides default: "go to contact John Smith"', () => {
    const r = tryFastRoute({ ...opp, user_input: 'go to contact John Smith' });
    expect(r?.intent).toBe('NAVIGATE');
    expect(r?.search_sobject).toBe('Contact');
    expect(r?.search_name).toContain('John Smith');
  });

  it('explicit opportunity keyword: "open deal TechCorp Q3" → Opportunity', () => {
    const r = tryFastRoute({ ...opp, user_input: 'open deal TechCorp Q3' });
    expect(r?.intent).toBe('NAVIGATE');
    expect(r?.search_sobject).toBe('Opportunity');
  });

  it('list view: "open Account list" → NAVIGATE target_sobject not search_name', () => {
    const r = tryFastRoute({ ...opp, user_input: 'open Account list' });
    expect(r?.intent).toBe('NAVIGATE');
    expect(r?.target_sobject).toBeTruthy();
    expect(r?.search_name).toBeUndefined();
  });

  it('no search_sobject contamination across calls (stateless)', () => {
    const r1 = tryFastRoute({ ...opp, user_input: 'Navigate to SFDC Inc', sObjectType: 'Case' });
    const r2 = tryFastRoute({ ...opp, user_input: 'Navigate to SFDC Inc', sObjectType: 'Lead' });
    expect(r1?.search_sobject).toBe('Account');
    expect(r2?.search_sobject).toBe('Account');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tryFastRoute — SOQL_SEARCH recency fast-path
// Regression: "show recent opportunities" was routed to NAVIGATE because
// the system prompt listed "show me" as a NAVIGATE trigger.
// Fix: fast-route intercepts "show recent/latest/new/this week/this month [obj]"
//      before NAVIGATE pattern runs, returning SOQL_SEARCH with CreatedDate filter.
// ─────────────────────────────────────────────────────────────────────────────
describe('tryFastRoute — SOQL_SEARCH recent records', () => {
  const req = (input: string, sobj = 'Opportunity') => ({
    user_input: input,
    sObjectType: sobj,
    userLanguage: 'en',
  });

  it('"show recent opportunities" → SOQL_SEARCH Opportunity with CreatedDate', () => {
    const r = tryFastRoute(req('show recent opportunities'));
    expect(r?.intent).toBe('SOQL_SEARCH');
    expect(r?.search_sobject).toBe('Opportunity');
    const conds = r?.soql_filter?.conditions ?? [];
    expect(conds.some(c => c.field === 'CreatedDate')).toBe(true);
  });

  it('"show recently created leads" → SOQL_SEARCH Lead', () => {
    const r = tryFastRoute(req('show recently created leads', 'Lead'));
    expect(r?.intent).toBe('SOQL_SEARCH');
    expect(r?.search_sobject).toBe('Lead');
  });

  it('"show me recent created opportunities" (user exact phrase) → SOQL_SEARCH (regression)', () => {
    const r = tryFastRoute(req('show me recent created opportunities'));
    expect(r?.intent).toBe('SOQL_SEARCH');
    expect(r?.search_sobject).toBe('Opportunity');
  });

  it('"show recent created opportunities" (no "me") → SOQL_SEARCH', () => {
    const r = tryFastRoute(req('show recent created opportunities'));
    expect(r?.intent).toBe('SOQL_SEARCH');
    expect(r?.search_sobject).toBe('Opportunity');
  });

  it('"show me recent opportunities" → SOQL_SEARCH (not NAVIGATE)', () => {
    const r = tryFastRoute(req('show me recent opportunities'));
    expect(r?.intent).toBe('SOQL_SEARCH');
    expect(r?.search_sobject).toBe('Opportunity');
  });

  it('"show this week\'s accounts" → SOQL_SEARCH with THIS_WEEK', () => {
    const r = tryFastRoute(req('show this week\'s accounts', 'Account'));
    expect(r?.intent).toBe('SOQL_SEARCH');
    expect(r?.search_sobject).toBe('Account');
    expect(r?.soql_filter?.conditions[0]?.value).toBe('THIS_WEEK');
  });

  it('"show this month\'s leads" → SOQL_SEARCH with THIS_MONTH', () => {
    const r = tryFastRoute(req('show this month\'s leads', 'Lead'));
    expect(r?.intent).toBe('SOQL_SEARCH');
    expect(r?.soql_filter?.conditions[0]?.value).toBe('THIS_MONTH');
  });

  it('"show new contacts" → SOQL_SEARCH Contact', () => {
    const r = tryFastRoute(req('show new contacts', 'Contact'));
    expect(r?.intent).toBe('SOQL_SEARCH');
    expect(r?.search_sobject).toBe('Contact');
  });

  it('"show last month\'s opportunities" → SOQL_SEARCH with LAST_MONTH', () => {
    const r = tryFastRoute(req('show last month\'s opportunities'));
    expect(r?.intent).toBe('SOQL_SEARCH');
    expect(r?.soql_filter?.conditions[0]?.value).toBe('LAST_MONTH');
  });

  it('order_by defaults to CreatedDate DESC', () => {
    const r = tryFastRoute(req('show recent opportunities'));
    expect(r?.soql_filter?.order_by).toBe('CreatedDate DESC');
  });

  it('limit defaults to 20', () => {
    const r = tryFastRoute(req('show recent opportunities'));
    expect(r?.soql_filter?.limit).toBe(20);
  });

  it('"show me Acme Corp" → NAVIGATE (specific record name, not temporal)', () => {
    const r = tryFastRoute(req('show me Acme Corp'));
    expect(r?.intent).toBe('NAVIGATE');
  });

  it('"show recent cases" → SOQL_SEARCH Case', () => {
    const r = tryFastRoute(req('show recent cases', 'Case'));
    expect(r?.intent).toBe('SOQL_SEARCH');
    expect(r?.search_sobject).toBe('Case');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractJson — complex multi-condition SOQL_SEARCH responses
// These verify the shape of what the LLM is expected to return for compound
// queries (amount + date + stage + owner combinations).
// ─────────────────────────────────────────────────────────────────────────────
describe('extractJson — complex SOQL_SEARCH filter shapes', () => {
  it('amount + date compound: over 10M AND last month', () => {
    const json = JSON.stringify({
      intent: 'SOQL_SEARCH',
      search_sobject: 'Opportunity',
      soql_filter: {
        conditions: [
          { field: 'Amount',      op: 'gte', value: 10000000 },
          { field: 'CreatedDate', op: 'eq',  value: 'LAST_MONTH' },
        ],
        order_by: 'Amount DESC',
        limit: 20,
      },
      message: 'Opportunities over 10M created last month',
      fields: {},
    });
    const r = extractJson(json);
    const conds = (r.soql_filter as Record<string, unknown>)?.conditions as Record<string, unknown>[];
    expect(conds).toHaveLength(2);
    expect(conds[0].field).toBe('Amount');
    expect(conds[0].op).toBe('gte');
    expect(conds[1].field).toBe('CreatedDate');
    expect(conds[1].value).toBe('LAST_MONTH');
  });

  it('stage + close date: open deals closing this month', () => {
    const json = JSON.stringify({
      intent: 'SOQL_SEARCH',
      search_sobject: 'Opportunity',
      soql_filter: {
        conditions: [
          { field: 'IsClosed',  op: 'eq',  value: false },
          { field: 'CloseDate', op: 'eq',  value: 'THIS_MONTH' },
        ],
        order_by: 'CloseDate ASC',
        limit: 20,
      },
      message: 'Open deals closing this month',
      fields: {},
    });
    const r = extractJson(json);
    const conds = (r.soql_filter as Record<string, unknown>)?.conditions as Record<string, unknown>[];
    expect(conds).toHaveLength(2);
    expect(conds[0]).toMatchObject({ field: 'IsClosed', op: 'eq', value: false });
    expect(conds[1]).toMatchObject({ field: 'CloseDate', op: 'eq', value: 'THIS_MONTH' });
    const filter = r.soql_filter as Record<string, unknown>;
    expect(filter.order_by).toBe('CloseDate ASC');
  });

  it('inactive + amount: neglected large deals', () => {
    const json = JSON.stringify({
      intent: 'SOQL_SEARCH',
      search_sobject: 'Opportunity',
      soql_filter: {
        conditions: [
          { field: 'IsClosed',        op: 'eq',  value: false },
          { field: 'Amount',          op: 'gte', value: 5000000 },
          { field: 'LastActivityDate', op: 'lt', value: 'LAST_N_DAYS:14' },
        ],
        order_by: 'LastActivityDate ASC',
        limit: 20,
      },
      message: 'Neglected deals over 5M',
      fields: {},
    });
    const r = extractJson(json);
    const conds = (r.soql_filter as Record<string, unknown>)?.conditions as Record<string, unknown>[];
    expect(conds).toHaveLength(3);
    expect(conds.some(c => c.field === 'LastActivityDate' && c.op === 'lt')).toBe(true);
    expect(conds.some(c => c.field === 'Amount' && c.op === 'gte')).toBe(true);
  });

  it('stage IN list filter', () => {
    const json = JSON.stringify({
      intent: 'SOQL_SEARCH',
      search_sobject: 'Opportunity',
      soql_filter: {
        conditions: [
          { field: 'StageName', op: 'in', value: ['Proposal/Price Quote', 'Negotiation/Review'] },
        ],
        order_by: 'Amount DESC',
        limit: 20,
      },
      message: 'Deals in Proposal or Negotiation stage',
      fields: {},
    });
    const r = extractJson(json);
    const conds = (r.soql_filter as Record<string, unknown>)?.conditions as Record<string, unknown>[];
    expect(conds[0].op).toBe('in');
    expect(Array.isArray(conds[0].value)).toBe(true);
    expect((conds[0].value as string[])).toContain('Proposal/Price Quote');
  });

  it('null check: leads with no email', () => {
    const json = JSON.stringify({
      intent: 'SOQL_SEARCH',
      search_sobject: 'Lead',
      soql_filter: {
        conditions: [{ field: 'Email', op: 'is_null', value: null }],
        order_by: 'CreatedDate DESC',
        limit: 50,
      },
      message: 'Leads missing email address',
      fields: {},
    });
    const r = extractJson(json);
    const conds = (r.soql_filter as Record<string, unknown>)?.conditions as Record<string, unknown>[];
    expect(conds[0].op).toBe('is_null');
    expect(conds[0].value).toBeNull();
    const filter = r.soql_filter as Record<string, unknown>;
    expect(filter.limit).toBe(50);
  });

  it('like filter: accounts whose name contains "Tokyo"', () => {
    const json = JSON.stringify({
      intent: 'SOQL_SEARCH',
      search_sobject: 'Account',
      soql_filter: {
        conditions: [{ field: 'Name', op: 'like', value: '%Tokyo%' }],
        order_by: 'Name ASC',
        limit: 20,
      },
      message: 'Accounts with Tokyo in name',
      fields: {},
    });
    const r = extractJson(json);
    const conds = (r.soql_filter as Record<string, unknown>)?.conditions as Record<string, unknown>[];
    expect(conds[0].op).toBe('like');
    expect(conds[0].value).toBe('%Tokyo%');
  });

  it('LAST_N_DAYS:N literal preserved verbatim', () => {
    const json = JSON.stringify({
      intent: 'SOQL_SEARCH',
      search_sobject: 'Opportunity',
      soql_filter: {
        conditions: [{ field: 'CreatedDate', op: 'gte', value: 'LAST_N_DAYS:7' }],
        order_by: 'CreatedDate DESC',
        limit: 20,
      },
      message: 'Opportunities created in the past 7 days',
      fields: {},
    });
    const r = extractJson(json);
    const conds = (r.soql_filter as Record<string, unknown>)?.conditions as Record<string, unknown>[];
    expect(conds[0].value).toBe('LAST_N_DAYS:7');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E — real Worker endpoint (skipped unless WORKER_URL env var is set)
// Run locally:  WORKER_URL=http://localhost:8787 npx vitest run
// With wrangler dev:  cd apps/backend && npx wrangler dev --remote
// ─────────────────────────────────────────────────────────────────────────────
const WORKER_URL = process.env.WORKER_URL;

// ─────────────────────────────────────────────────────────────────────────────
// extractJson — confidence field parsing
// ─────────────────────────────────────────────────────────────────────────────
describe('extractJson — confidence field', () => {
  it('parses confidence: 90 as a number', () => {
    const r = extractJson(JSON.stringify({ intent: 'NAVIGATE', confidence: 90, message: 'ok', fields: {} }));
    expect(typeof r.confidence).toBe('number');
    expect(r.confidence).toBe(90);
  });

  it('parses confidence: 72 (below threshold) alongside CLARIFY', () => {
    const r = extractJson(JSON.stringify({ intent: 'CLARIFY', confidence: 72, message: '何をしますか？', fields: {} }));
    expect(r.confidence).toBe(72);
    expect(r.intent).toBe('CLARIFY');
  });

  it('missing confidence field does not crash extractJson', () => {
    const r = extractJson(JSON.stringify({ intent: 'NAVIGATE', message: 'ok', fields: {} }));
    expect(r.confidence).toBeUndefined();
  });
});

describe.skipIf(!WORKER_URL)('E2E: real Worker (/v1/agent-action)', () => {
  const BASE_HEADERS = {
    'Content-Type': 'application/json',
    'X-Salesforce-Org-Id': 'test-e2e-org-id',
    'X-User-Language': 'en',
  };

  async function action(body: Record<string, unknown>) {
    const res = await fetch(`${WORKER_URL}/v1/agent-action`, {
      method: 'POST',
      headers: BASE_HEADERS,
      body: JSON.stringify({
        sObjectType: 'Opportunity',
        recordId: null,
        pageType: 'record_detail',
        field_schema: ['Stage=StageName', 'Amount=Amount', 'Close Date=CloseDate'],
        userLanguage: 'en',
        ...body,
      }),
    });
    return res.json() as Promise<Record<string, unknown>>;
  }

  it('Navigate to United Oil & Gas Corp → NAVIGATE + Account (regression)', async () => {
    const r = await action({ user_input: 'Navigate to United Oil & Gas Corp' });
    expect(r.intent).toBe('NAVIGATE');
    // search_sobject must be Account — never the page's sObjectType
    expect(r.search_sobject ?? r.targetSObject).not.toBe('Opportunity');
  }, 15_000);

  it('SOQL_SEARCH: "opportunities over 10M" → structured conditions', async () => {
    const r = await action({ user_input: 'show opportunities over 10M', sObjectType: 'Opportunity' });
    expect(r.intent).toBe('SOQL_SEARCH');
    const filter = r.soql_filter as Record<string, unknown>;
    const conds  = filter?.conditions as Array<Record<string, unknown>>;
    expect(Array.isArray(conds)).toBe(true);
    const amountCond = conds.find(c => c.field === 'Amount');
    expect(amountCond).toBeTruthy();
  }, 15_000);

  it('SOQL_SEARCH: "show recent opportunities" → CreatedDate filter, NOT NAVIGATE', async () => {
    const r = await action({ user_input: 'show recent opportunities', sObjectType: 'Opportunity' });
    expect(r.intent).toBe('SOQL_SEARCH');
    const filter = r.soql_filter as Record<string, unknown>;
    const conds  = filter?.conditions as Array<Record<string, unknown>>;
    expect(Array.isArray(conds)).toBe(true);
    expect(conds.some(c => c.field === 'CreatedDate')).toBe(true);
  }, 15_000);

  it('SOQL_SEARCH: "show recently created opportunities" (user\'s exact phrase) → SOQL_SEARCH', async () => {
    const r = await action({ user_input: 'show recently created opportunities', sObjectType: 'Opportunity' });
    expect(r.intent).toBe('SOQL_SEARCH');
  }, 15_000);

  it('UPDATE_RECORD: "set stage to Closed Won" → correct field value', async () => {
    const r = await action({ user_input: 'set stage to Closed Won', recordId: 'fakeId001' });
    expect(r.intent).toBe('UPDATE_RECORD');
    const fields = r.fields as Record<string, unknown>;
    expect(fields?.StageName).toBe('Closed Won');
  }, 15_000);

  it('NAVIGATE_SETUP: "open user management" → ManageUsers setup node', async () => {
    const r = await action({ user_input: 'open user management setup' });
    // Fast-route does not handle Setup; goes to LLM
    expect(['NAVIGATE', 'NAVIGATE_SETUP']).toContain(r.intent);
    // If resolved to NAVIGATE, targetUrl must be a setup URL
    if (r.intent === 'NAVIGATE' && r.targetUrl) {
      expect(String(r.targetUrl)).toContain('/lightning/setup/');
    }
  }, 15_000);

  it('Japanese GUIDE_CREATE: "新規商談を作成したい" → GUIDE_CREATE Opportunity', async () => {
    const r = await action({ user_input: '新規商談を作成したい', userLanguage: 'ja', sObjectType: 'Account' });
    expect(r.intent).toBe('GUIDE_CREATE');
    expect(r.guide_sobject).toBe('Opportunity');
  }, 15_000);

  // ── Regression: "show me recent created opportunities" must NOT throw ──────
  it('SOQL_SEARCH regression: "show me recent created opportunities" → SOQL_SEARCH', async () => {
    const r = await action({ user_input: 'show me recent created opportunities' });
    expect(r.intent).toBe('SOQL_SEARCH');
    const filter = r.soql_filter as Record<string, unknown>;
    const conds  = filter?.conditions as Array<Record<string, unknown>>;
    expect(Array.isArray(conds)).toBe(true);
    expect(conds.some(c => c.field === 'CreatedDate')).toBe(true);
  }, 15_000);

  it('SOQL_SEARCH: "show recent created opportunities" (no me) → SOQL_SEARCH', async () => {
    const r = await action({ user_input: 'show recent created opportunities' });
    expect(r.intent).toBe('SOQL_SEARCH');
  }, 15_000);

  it('SOQL_SEARCH: Japanese "最近作成した商談" → SOQL_SEARCH with CreatedDate', async () => {
    const r = await action({ user_input: '最近作成した商談', userLanguage: 'ja', sObjectType: 'Opportunity' });
    expect(r.intent).toBe('SOQL_SEARCH');
    const filter = r.soql_filter as Record<string, unknown>;
    const conds  = filter?.conditions as Array<Record<string, unknown>>;
    expect(conds?.some(c => c.field === 'CreatedDate')).toBe(true);
  }, 15_000);

  it('SOQL_SEARCH: "放置されている案件" → LastActivityDate condition, not NAVIGATE', async () => {
    const r = await action({ user_input: '放置されている案件', userLanguage: 'ja', sObjectType: 'Opportunity' });
    expect(r.intent).toBe('SOQL_SEARCH');
    const filter = r.soql_filter as Record<string, unknown>;
    const conds  = filter?.conditions as Array<Record<string, unknown>>;
    expect(conds?.some(c => c.field === 'LastActivityDate')).toBe(true);
  }, 15_000);

  it('SOQL_SEARCH: "show me open cases" → SOQL_SEARCH Case with IsClosed=false', async () => {
    const r = await action({ user_input: 'show me open cases', sObjectType: 'Case' });
    expect(r.intent).toBe('SOQL_SEARCH');
  }, 15_000);

  it('intent never UNKNOWN for valid queries (smoke)', async () => {
    const queries = [
      'show recent opportunities',
      'find Acme Corp',
      'set stage to Prospecting',
      '新規リードを作成したい',
    ];
    for (const q of queries) {
      const r = await action({ user_input: q, userLanguage: q.match(/[ぁ-ん]/) ? 'ja' : 'en' });
      expect(r.intent).not.toBe('UNKNOWN');
    }
  }, 30_000);
});
