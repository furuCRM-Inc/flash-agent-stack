import { describe, it, expect } from 'vitest';
import { compileQuery, type CompilerInput } from './soqlCompiler.js';

// Previously this module had zero direct unit tests covering SOQL injection
// safety or LIMIT bounds — those guarantees existed in the code but were
// never pinned down, so a future refactor could silently regress them.

function baseInput(overrides: Partial<CompilerInput> = {}): CompilerInput {
  return {
    intent:     'SOQL_SEARCH',
    sObject:    'Account',
    conditions: [],
    ...overrides,
  };
}

describe('compileQuery — SOQL injection safety (single-quote escaping)', () => {
  it('escapes a single quote in a LIKE value (e.g. "O\'Reilly")', () => {
    const result = compileQuery(baseInput({
      conditions: [{ field: 'Name', op: 'like', value: "%O'Reilly%" }],
    }));
    expect(result.query).toContain("LIKE '%O\\'Reilly%'");
    expect(result.query).not.toContain("LIKE '%O'Reilly%'");
  });

  it('escapes a single quote in an eq value used for record updates/filters', () => {
    const result = compileQuery(baseInput({
      conditions: [{ field: 'Name', op: 'eq', value: "D'Angelo Corp" }],
    }));
    expect(result.query).toContain("= 'D\\'Angelo Corp'");
  });

  it('escapes single quotes inside an IN clause', () => {
    const result = compileQuery(baseInput({
      conditions: [{ field: 'Name', op: 'in', value: ["O'Reilly", "D'Angelo"] }],
    }));
    expect(result.query).toContain("'O\\'Reilly'");
    expect(result.query).toContain("'D\\'Angelo'");
  });
});

describe('compileQuery — LIMIT bounds safety', () => {
  it('caps an explicit huge LIMIT at the grammar max_limit (2000), never runs unbounded', () => {
    const result = compileQuery(baseInput({ limit: 100_000 }));
    expect(result.query).toContain('LIMIT 2000');
  });

  it('defaults a negative LIMIT to the grammar default_limit (20), not clamped to 1', () => {
    // Bug: Math.max(1, n) turned any negative/zero input into LIMIT 1 instead
    // of falling back to a sane default page size.
    const result = compileQuery(baseInput({ limit: -5 }));
    expect(result.query).toContain('LIMIT 20');
  });

  it('defaults a zero LIMIT to the grammar default_limit (20)', () => {
    const result = compileQuery(baseInput({ limit: 0 }));
    expect(result.query).toContain('LIMIT 20');
  });

  it('passes through a normal in-range LIMIT unchanged', () => {
    const result = compileQuery(baseInput({ limit: 50 }));
    expect(result.query).toContain('LIMIT 50');
  });
});

describe('compileQuery — null/blank condition serialization', () => {
  it('serializes is_null as "= null" (no quotes, no injection surface)', () => {
    const result = compileQuery(baseInput({
      conditions: [{ field: 'Phone', op: 'is_null' }],
    }));
    expect(result.query).toContain('Phone = null');
  });

  it('serializes not_null as "!= null"', () => {
    const result = compileQuery(baseInput({
      conditions: [{ field: 'Website', op: 'not_null' }],
    }));
    expect(result.query).toContain('Website != null');
  });
});
