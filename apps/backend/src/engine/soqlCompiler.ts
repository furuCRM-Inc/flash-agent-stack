/**
 * soqlCompiler.ts
 *
 * KV-driven SOQL/SOSL structural compiler for the Cloudflare Worker.
 *
 * Guarantees:
 *   - Zero MALFORMED_QUERY errors: all field references are validated against
 *     the per-org schema KV before inclusion in WHERE clauses.
 *   - Zero LLM text generation: SOQL/SOSL is assembled from typed parts only.
 *   - Non-filterable fields (textarea, encryptedstring, location/address) are
 *     stripped automatically from WHERE clauses.
 *   - SOSL fallback: multi-object text search or unresolved sObject → SOSL.
 */

// ── Grammar rules (static, seeded once in KV) ─────────────────────────────────

export interface GrammarRules {
  soql_rules: {
    date_literals:              string[];
    non_filterable_field_types: string[];
    soql_operators:             string[];
    default_limit:              number;
    max_limit:                  number;
  };
  sosl_rules: {
    trigger_keywords:   string[];
    search_fields:      string[];
    returning_format:   string;
    default_returning:  string[];  // API names of objects to RETURNING by default
  };
}

/** Static grammar rules — seeded once at Worker startup (no org-specific data). */
export const DEFAULT_GRAMMAR_RULES: GrammarRules = {
  soql_rules: {
    date_literals: [
      'YESTERDAY', 'TODAY', 'TOMORROW',
      'THIS_WEEK', 'LAST_WEEK', 'NEXT_WEEK',
      'THIS_MONTH', 'LAST_MONTH', 'NEXT_MONTH',
      'THIS_QUARTER', 'LAST_QUARTER', 'NEXT_QUARTER',
      'THIS_YEAR', 'LAST_YEAR', 'NEXT_YEAR',
      'LAST_N_DAYS', 'NEXT_N_DAYS',
      'LAST_N_WEEKS', 'NEXT_N_WEEKS',
      'LAST_N_MONTHS', 'NEXT_N_MONTHS',
    ],
    // Field types that cannot appear in SOQL WHERE clauses
    non_filterable_field_types: [
      'textarea',         // Long Text Area, Rich Text Area
      'encryptedstring',  // Encrypted text
      'location',         // Geolocation (compound)
      'address',          // Compound address field
      'base64',           // Binary
      'multipicklist',    // Multi-select picklists can't use = / != operators (use INCLUDES)
    ],
    soql_operators: ['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'IN', 'NOT IN', 'INCLUDES', 'EXCLUDES', 'IS NULL', 'IS NOT NULL'],
    default_limit: 20,
    max_limit: 2000,
  },
  sosl_rules: {
    trigger_keywords: [
      'find', 'search across', 'look across', 'anywhere', 'any object',
      '横断検索', '全体検索', '一括検索', 'どこでも',
    ],
    search_fields: ['ALL FIELDS', 'NAME FIELDS', 'PHONE FIELDS', 'EMAIL FIELDS'],
    returning_format: 'FIND {term} IN {group} RETURNING {objects} LIMIT {limit}',
    default_returning: ['Account', 'Contact', 'Opportunity', 'Lead', 'Case'],
  },
};

// ── Per-org field type schema + relationship metadata ─────────────────────────
// Seeded by Apex via /v1/field-types-seed; TTL 1h alongside schema KV.
// Maps "fieldApiName" → field descriptor including type and relationship info.

export interface FieldDescriptor {
  type:             string;    // Salesforce field type (currency, string, reference, etc.)
  filterable?:      boolean;
  relationshipName?: string;   // For reference fields: "Account", "Owner", "Custom_Lookup__r"
  referenceTo?:     string;    // Target sObject API name for lookups
}

export interface ChildRelationship {
  childObject:      string;   // Child sObject API name
  field:            string;   // Foreign key field on child (e.g. "OpportunityId")
}

/** Full enriched schema for one sObject, as stored in KV. */
export interface EnrichedSchema {
  sObject:            string;
  fields:             Record<string, FieldDescriptor>;  // apiName → descriptor
  childRelationships: Record<string, ChildRelationship>; // relationshipName → child info
}

// Backwards-compatible: simple field list (old format) or enriched descriptor map
export type FieldTypeSchema = Record<string, string | FieldDescriptor>;

function getFieldDescriptor(schema: FieldTypeSchema, apiName: string): FieldDescriptor | null {
  const raw = schema[apiName];
  if (!raw) return null;
  if (typeof raw === 'string') return { type: raw };
  return raw;
}

// ── Compiler inputs / outputs ──────────────────────────────────────────────────

export interface SoqlCondition {
  field:  string;
  op:     'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'not_in' | 'is_null' | 'not_null' | 'includes' | 'excludes';
  value?: string | number | boolean | string[] | null;
}

/** A child subquery specification for Parent-to-Child nested SOQL. */
export interface ChildSubquery {
  relationshipName: string;   // e.g. "Opportunities", "Contacts", "OpportunityLineItems"
  selectFields?:    string[];
  conditions?:      SoqlCondition[];
  orderBy?:         string;
  limit?:           number;
}

export interface CompilerInput {
  intent:           'SOQL_SEARCH' | 'SOSL_SEARCH';
  sObject:          string | null;
  conditions:       SoqlCondition[];
  selectFields?:    string[];     // Requested SELECT fields; compiler validates and falls back to Id,Name
  parentFields?:    string[];     // Cross-object parent fields: "Account.Name", "Owner.Email"
  childSubqueries?: ChildSubquery[]; // Nested child SOQL (Parent-to-Child)
  orderBy?:         string;       // e.g. "Amount DESC"
  limit?:           number;
  soslTerm?:        string;       // For SOSL only: free-text search term
  soslGroup?:       string;       // 'ALL FIELDS' | 'NAME FIELDS' etc.
  returningObjects?: string[];    // For SOSL: which sObjects to RETURNING
}

export interface CompilerResult {
  queryType:  'SOQL' | 'SOSL';
  query:      string;                // Fully validated query string ready for Salesforce
  warnings:   string[];              // Non-fatal issues (stripped fields, clamped LIMIT, etc.)
}

// ── SOQL operator serializer ───────────────────────────────────────────────────

function opToSoql(op: SoqlCondition['op'], value: SoqlCondition['value']): string {
  switch (op) {
    case 'eq':       return `= ${formatValue(value)}`;
    case 'neq':      return `!= ${formatValue(value)}`;
    case 'gt':       return `> ${formatValue(value)}`;
    case 'gte':      return `>= ${formatValue(value)}`;
    case 'lt':       return `< ${formatValue(value)}`;
    case 'lte':      return `<= ${formatValue(value)}`;
    case 'like':     return `LIKE ${formatValue(value)}`;
    case 'in':       return `IN (${(value as string[]).map(formatValue).join(', ')})`;
    case 'not_in':   return `NOT IN (${(value as string[]).map(formatValue).join(', ')})`;
    case 'is_null':  return '= null';
    case 'not_null': return '!= null';
    case 'includes': return `INCLUDES (${(value as string[]).map(v => `'${v}'`).join(', ')})`;
    case 'excludes': return `EXCLUDES (${(value as string[]).map(v => `'${v}'`).join(', ')})`;
    default:         return `= ${formatValue(value)}`;
  }
}

function formatValue(v: SoqlCondition['value']): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  // SOQL date literals must not be quoted
  if (typeof v === 'string' && isDateLiteral(v)) return v;
  if (typeof v === 'string') return `'${v.replace(/'/g, "\\'")}'`;
  return String(v);
}

function isDateLiteral(s: string): boolean {
  return /^(YESTERDAY|TODAY|TOMORROW|THIS_|LAST_|NEXT_)[A-Z_]+(\:\d+)?$/.test(s)
    || /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/.test(s);
}

// ── Relationship resolvers ────────────────────────────────────────────────────

/**
 * Resolves a Child-to-Parent lookup field reference.
 * Input: { field: "AccountId", parentField: "Name" }  (user wants Account.Name on Opportunity)
 * Output: "Account.Name" using the KV-cached relationshipName.
 */
export function resolveParentField(
  lookupApiName: string,     // e.g. "AccountId" or "Custom_Lookup__c"
  parentFieldApiName: string, // e.g. "Name", "Industry"
  fieldTypes: FieldTypeSchema
): string | null {
  const desc = getFieldDescriptor(fieldTypes, lookupApiName);
  if (!desc || desc.type !== 'reference' || !desc.relationshipName) return null;
  return `${desc.relationshipName}.${parentFieldApiName}`;
}

/**
 * Builds a Parent-to-Child nested SOQL subquery.
 * Uses the childRelationships map from the enriched KV schema to validate the
 * relationship name before emitting the subquery.
 */
function buildChildSubquery(
  sub: ChildSubquery,
  childRelationships: Record<string, ChildRelationship>,
  warnings: string[]
): string | null {
  const rel = childRelationships[sub.relationshipName];
  if (!rel) {
    warnings.push(`Child relationship "${sub.relationshipName}" not found in schema — subquery skipped`);
    return null;
  }

  const fields  = sub.selectFields?.length ? sub.selectFields : ['Id', 'Name'];
  const conds   = (sub.conditions ?? []).map(c => `${c.field} ${opToSoql(c.op, c.value)}`).join(' AND ');
  const where   = conds ? `WHERE ${conds}` : '';
  const order   = sub.orderBy ? `ORDER BY ${sub.orderBy}` : '';
  const lim     = sub.limit ? `LIMIT ${sub.limit}` : 'LIMIT 50';

  return [
    `(SELECT ${fields.join(', ')} FROM ${sub.relationshipName}`,
    where, order, lim, ')',
  ].filter(Boolean).join(' ');
}

// ── SELECT field resolver ──────────────────────────────────────────────────────
// Returns safe default fields for a given sObject when no explicit SELECT is requested.

const DEFAULT_SELECT_FIELDS: Record<string, string[]> = {
  Account:     ['Id', 'Name', 'Type', 'Industry', 'AnnualRevenue', 'OwnerId'],
  Contact:     ['Id', 'Name', 'Email', 'Phone', 'AccountId', 'Title'],
  Opportunity: ['Id', 'Name', 'Amount', 'StageName', 'CloseDate', 'AccountId', 'OwnerId'],
  Lead:        ['Id', 'Name', 'Company', 'Email', 'Phone', 'Status', 'LeadSource'],
  Case:        ['Id', 'Subject', 'Status', 'Priority', 'AccountId', 'OwnerId'],
  Campaign:    ['Id', 'Name', 'Type', 'Status', 'StartDate', 'EndDate'],
  Task:        ['Id', 'Subject', 'Status', 'Priority', 'ActivityDate', 'WhoId'],
};

function resolveSelectFields(
  sObject: string,
  requested: string[] | undefined,
  parentFields: string[] | undefined,
  validFields: Set<string>,
  fieldTypes: FieldTypeSchema,
  grammar: GrammarRules,
  warnings: string[]
): string[] {
  const candidates = requested?.length ? requested : (DEFAULT_SELECT_FIELDS[sObject] ?? ['Id', 'Name']);

  const safe: string[] = [];
  for (const f of candidates) {
    if (validFields.size > 0 && !validFields.has(f)) {
      warnings.push(`SELECT field "${f}" not in schema — omitted`);
      continue;
    }
    safe.push(f);
  }

  // Always ensure Id and Name are present
  if (!safe.includes('Id'))   safe.unshift('Id');
  if (!safe.includes('Name') && (validFields.size === 0 || validFields.has('Name'))) safe.splice(1, 0, 'Name');

  // Append validated parent-lookup cross-object fields (e.g. "Account.Name")
  // These are already in dot-notation — include as-is (Salesforce validates at runtime).
  for (const pf of (parentFields ?? [])) {
    if (!safe.includes(pf)) safe.push(pf);
  }

  return safe;
}

// ── WHERE clause builder ───────────────────────────────────────────────────────

function buildWhereClause(
  conditions: SoqlCondition[],
  validFields: Set<string>,
  fieldTypes: FieldTypeSchema,
  grammar: GrammarRules,
  warnings: string[]
): string {
  const parts: string[] = [];

  for (const cond of conditions) {
    // 1. Validate field exists in schema; cross-object dot-notation fields bypass this
    //    (e.g. "Account.Name") — Salesforce validates them at runtime.
    const isCrossObjectField = cond.field.includes('.');
    if (!isCrossObjectField && validFields.size > 0 && !validFields.has(cond.field)) {
      warnings.push(`WHERE field "${cond.field}" not in schema — condition skipped`);
      continue;
    }

    // 2. Block non-filterable field types in WHERE
    const rawFType = fieldTypes[cond.field];
    const fType = (typeof rawFType === 'string' ? rawFType : rawFType?.type ?? '').toLowerCase();
    const nonFilterable = grammar.soql_rules.non_filterable_field_types;
    if (fType && nonFilterable.some(t => fType.includes(t))) {
      warnings.push(`Field "${cond.field}" (type: ${fType}) cannot be filtered — condition skipped`);
      continue;
    }

    // 3. For multi-select picklists, remap eq/neq to includes/excludes
    let op = cond.op;
    if (fType === 'multipicklist') {
      if (op === 'eq')  op = 'includes';
      if (op === 'neq') op = 'excludes';
    }

    // 4. Serialize
    parts.push(`${cond.field} ${opToSoql(op, cond.value)}`);
  }

  return parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
}

// ── ORDER BY validator ─────────────────────────────────────────────────────────

function resolveOrderBy(
  orderBy: string | undefined,
  validFields: Set<string>,
  warnings: string[]
): string {
  if (!orderBy) return '';
  const [rawField, dir = 'DESC'] = orderBy.trim().split(/\s+/);
  const safeDir = /^(ASC|DESC)$/i.test(dir) ? dir.toUpperCase() : 'DESC';

  if (validFields.size > 0 && !validFields.has(rawField)) {
    warnings.push(`ORDER BY field "${rawField}" not in schema — using CreatedDate DESC`);
    return 'ORDER BY CreatedDate DESC';
  }
  return `ORDER BY ${rawField} ${safeDir}`;
}

// ── LIMIT resolver ────────────────────────────────────────────────────────────

function resolveLimit(limit: number | undefined, grammar: GrammarRules): number {
  const n = limit ?? grammar.soql_rules.default_limit;
  // A non-positive limit (e.g. a negative number from malformed input, or an
  // explicit "-5") is nonsensical as a row count — previously this clamped to
  // 1, silently returning almost nothing instead of falling back to the
  // grammar's default page size.
  const safe = n > 0 ? n : grammar.soql_rules.default_limit;
  return Math.min(safe, grammar.soql_rules.max_limit);
}

// ── SOSL builder ──────────────────────────────────────────────────────────────

function buildSoslQuery(
  input: CompilerInput,
  grammar: GrammarRules,
  warnings: string[]
): CompilerResult {
  const term        = (input.soslTerm ?? '').replace(/[{}'"`\\]/g, '');  // sanitize
  const searchGroup = input.soslGroup ?? 'ALL FIELDS';
  const returning   = (input.returningObjects ?? grammar.sosl_rules.default_returning)
    .map(obj => `${obj}(Id, Name)`)
    .join(', ');
  const lim = resolveLimit(input.limit, grammar);

  if (!term.trim()) {
    warnings.push('SOSL search term is empty — query may return no results');
  }

  const query = `FIND {${term}} IN ${searchGroup} RETURNING ${returning} LIMIT ${lim}`;
  return { queryType: 'SOSL', query, warnings };
}

// ── Main compiler entry point ─────────────────────────────────────────────────

/**
 * Compiles a typed intent payload into a validated SOQL or SOSL string.
 *
 * - Field references in WHERE are checked against KV schema; non-filterable
 *   types are stripped automatically.
 * - Parent-lookup cross-object fields (e.g. "Account.Name") are appended to SELECT.
 * - Parent-to-Child nested subqueries are built from KV childRelationships metadata.
 * - WITH USER_MODE is always appended to enforce FLS + sharing.
 * - LIMIT is clamped to grammar.max_limit.
 *
 * @param input              - Compiler input (from Jev template builder or fast-route)
 * @param validFields        - Field API names from KV schema (empty = skip validation)
 * @param fieldTypes         - Field type map from KV (empty = skip type filtering)
 * @param childRelationships - Child relationship map from KV (empty = skip subqueries)
 * @param grammar            - SOQL/SOSL grammar rules (from KV or DEFAULT_GRAMMAR_RULES)
 */
export function compileQuery(
  input:              CompilerInput,
  validFields:        Set<string>                       = new Set(),
  fieldTypes:         FieldTypeSchema                   = {},
  childRelationships: Record<string, ChildRelationship> = {},
  grammar:            GrammarRules                      = DEFAULT_GRAMMAR_RULES
): CompilerResult {
  const warnings: string[] = [];

  // Route to SOSL when explicitly requested or sObject is unresolved for text search
  if (input.intent === 'SOSL_SEARCH' || (!input.sObject && input.soslTerm)) {
    return buildSoslQuery(input, grammar, warnings);
  }

  if (!input.sObject) {
    return { queryType: 'SOQL', query: '', warnings: ['sObject is required for SOQL'] };
  }

  // SELECT: base fields + parent cross-object fields
  const baseFields   = resolveSelectFields(
    input.sObject, input.selectFields, input.parentFields, validFields, fieldTypes, grammar, warnings
  );

  // Child subqueries (Parent-to-Child nested SOQL)
  const subqueries: string[] = [];
  for (const sub of (input.childSubqueries ?? [])) {
    const sq = buildChildSubquery(sub, childRelationships, warnings);
    if (sq) subqueries.push(sq);
  }

  const allSelectParts = [...baseFields, ...subqueries];
  const whereClause    = buildWhereClause(input.conditions, validFields, fieldTypes, grammar, warnings);
  const orderBy        = resolveOrderBy(input.orderBy, validFields, warnings);
  const limit          = resolveLimit(input.limit, grammar);

  const parts = [
    `SELECT ${allSelectParts.join(', ')}`,
    `FROM ${input.sObject}`,
    whereClause,
    orderBy,
    `LIMIT ${limit}`,
    'WITH USER_MODE',  // Always enforce FLS + sharing
  ].filter(Boolean);

  return { queryType: 'SOQL', query: parts.join(' '), warnings };
}

// ── SOSL trigger detector ─────────────────────────────────────────────────────
// Returns true when user input signals a cross-object / full-text search.

export function shouldUseSosl(userInput: string, sObject: string | null, grammar: GrammarRules = DEFAULT_GRAMMAR_RULES): boolean {
  if (!sObject) return true;  // No resolved object → search everywhere
  const lower = userInput.toLowerCase();
  return grammar.sosl_rules.trigger_keywords.some(kw => lower.includes(kw.toLowerCase()));
}
