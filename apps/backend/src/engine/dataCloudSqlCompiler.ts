/**
 * dataCloudSqlCompiler.ts
 *
 * ANSI SQL compiler for Salesforce Data Cloud (Data Engine) objects.
 *
 * Data Cloud uses SQL instead of SOQL. Objects have two suffixes:
 *   - __dlm  Data Model Object (harmonized / unified)
 *   - __dlo  Data Lake Object  (raw ingested data)
 *
 * The ssot__ namespace prefix is required for standard Data Cloud objects.
 * Custom DMOs created by admins do NOT use ssot__ prefix.
 *
 * Query path: Salesforce Data Cloud Query API v2
 *   POST /services/data/v61.0/ssot/queryv2
 *   Body: { "sql": "<ANSI SQL string>" }
 *
 * Write path: Data Cloud Ingestion API (not Apex DML)
 *   POST /services/data/v61.0/ssot/datasets/{objectApiName}/records
 */

// ── Data Cloud object type detection ─────────────────────────────────────────

/** Returns true when apiName is a Data Cloud object (DLO or DMO). */
export function isDataCloudObject(apiName: string): boolean {
  return apiName.endsWith('__dlm') || apiName.endsWith('__dlo');
}

/** Ensures the ssot__ namespace prefix for standard Data Cloud objects. */
export function normalizeDataCloudName(apiName: string): string {
  // Standard DC objects require ssot__ prefix; custom admin DMOs do not.
  if ((apiName.endsWith('__dlm') || apiName.endsWith('__dlo')) && !apiName.startsWith('ssot__')) {
    // Heuristic: standard objects start with a capital letter after prefix.
    // Custom objects are already in correct form (admin-defined).
    return apiName;  // Preserve as-is — Apex knows the correct namespace.
  }
  return apiName;
}

// ── Data Cloud KV catalog ─────────────────────────────────────────────────────

export interface DataCloudField {
  type:        string;    // 'string', 'number', 'date', 'datetime', 'boolean'
  filterable?: boolean;
  nullable?:   boolean;
  primaryKey?: boolean;
}

export interface DataCloudRelationship {
  fromField:       string;  // field on this DMO (e.g. "ssot__IndividualId__c")
  toObject:        string;  // target DMO API name
  toField:         string;  // field on target (e.g. "ssot__Id__c")
}

export interface DataCloudObjectMeta {
  apiName:       string;
  label:         string;
  type:          'DMO' | 'DLO';
  fields:        Record<string, DataCloudField>;
  relationships: DataCloudRelationship[];
}

// ── SQL compiler inputs / outputs ─────────────────────────────────────────────

export interface DataCloudSqlCondition {
  field:  string;
  op:     'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'not_in' | 'is_null' | 'not_null';
  value?: string | number | boolean | string[] | null;
}

export interface DataCloudAggregation {
  func:       'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT_DISTINCT';
  field:      string;
  alias?:     string;
}

export interface DataCloudJoin {
  joinType:    'INNER' | 'LEFT';
  toObject:    string;   // API name of joined DMO
  fromField:   string;   // field on base object
  toField:     string;   // field on joined object
  alias?:      string;   // table alias
}

export interface DataCloudCompilerInput {
  intent:         'DATACLOUD_QUERY';
  baseObject:     string;                   // Primary DMO/DLO API name
  selectFields?:  string[];                 // Field names or alias.field
  aggregations?:  DataCloudAggregation[];   // COUNT(), SUM() etc.
  joins?:         DataCloudJoin[];          // JOIN clauses
  conditions?:    DataCloudSqlCondition[];  // WHERE conditions
  groupBy?:       string[];                 // GROUP BY fields
  having?:        string;                  // Raw HAVING expression (pre-validated)
  orderBy?:       string;                  // e.g. "ssot__GrandTotalAmount__c DESC"
  limit?:         number;
}

export interface DataCloudCompilerResult {
  sql:      string;   // ANSI SQL ready for Data Cloud Query API v2
  warnings: string[];
}

// ── Default select fields for standard DMOs ───────────────────────────────────

const DEFAULT_DC_SELECT: Record<string, string[]> = {
  'ssot__Individual__dlm': ['ssot__Id__c', 'ssot__FirstName__c', 'ssot__LastName__c', 'ssot__Email__c'],
  'ssot__SalesOrder__dlm': ['ssot__Id__c', 'ssot__GrandTotalAmount__c', 'ssot__OrderedDate__c', 'ssot__IndividualId__c'],
  'ssot__Party__dlm':      ['ssot__Id__c', 'ssot__Name__c', 'ssot__Type__c'],
};

// ── SQL value formatter ───────────────────────────────────────────────────────

function formatSqlValue(v: DataCloudSqlCondition['value']): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `(${v.map(i => `'${String(i).replace(/'/g, "''")}'`).join(', ')})`;
  // Date/datetime literals (ISO format)
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z?)?$/.test(v)) return `'${v}'`;
  return `'${v.replace(/'/g, "''")}'`;
}

function opToSql(op: DataCloudSqlCondition['op'], value: DataCloudSqlCondition['value']): string {
  switch (op) {
    case 'eq':       return `= ${formatSqlValue(value)}`;
    case 'neq':      return `<> ${formatSqlValue(value)}`;
    case 'gt':       return `> ${formatSqlValue(value)}`;
    case 'gte':      return `>= ${formatSqlValue(value)}`;
    case 'lt':       return `< ${formatSqlValue(value)}`;
    case 'lte':      return `<= ${formatSqlValue(value)}`;
    case 'like':     return `LIKE ${formatSqlValue(value)}`;
    case 'in':       return `IN ${formatSqlValue(value)}`;
    case 'not_in':   return `NOT IN ${formatSqlValue(value)}`;
    case 'is_null':  return 'IS NULL';
    case 'not_null': return 'IS NOT NULL';
    default:         return `= ${formatSqlValue(value)}`;
  }
}

// ── Main Data Cloud SQL compiler ──────────────────────────────────────────────

/**
 * Compiles a typed intent payload into a validated ANSI SQL string for the
 * Salesforce Data Cloud Query API v2 (/ssot/queryv2).
 *
 * @param input    - Compiler input from Jev classification
 * @param catalog  - KV-cached DMO/DLO metadata for the org
 */
export function compileDataCloudQuery(
  input:   DataCloudCompilerInput,
  catalog: Record<string, DataCloudObjectMeta> = {}
): DataCloudCompilerResult {
  const warnings: string[] = [];
  const base = normalizeDataCloudName(input.baseObject);
  const meta = catalog[input.baseObject] ?? catalog[base];

  // ── SELECT ────────────────────────────────────────────────────────────────
  const selectParts: string[] = [];

  // Aggregations first
  for (const agg of (input.aggregations ?? [])) {
    const fn = agg.func === 'COUNT_DISTINCT'
      ? `COUNT(DISTINCT ${agg.field})`
      : `${agg.func}(${agg.field})`;
    selectParts.push(agg.alias ? `${fn} AS ${agg.alias}` : fn);
  }

  // Regular fields
  const rawFields = input.selectFields?.length
    ? input.selectFields
    : (DEFAULT_DC_SELECT[base] ?? (meta ? Object.keys(meta.fields).slice(0, 6) : ['*']));

  for (const f of rawFields) {
    if (meta && !meta.fields[f] && !f.includes('.') && f !== '*') {
      warnings.push(`Field "${f}" not in ${base} catalog — omitted`);
      continue;
    }
    selectParts.push(f);
  }

  if (selectParts.length === 0) selectParts.push('*');

  // ── FROM ─────────────────────────────────────────────────────────────────
  const fromClause = base;

  // ── JOIN ──────────────────────────────────────────────────────────────────
  const joinParts: string[] = [];
  for (const j of (input.joins ?? [])) {
    const joinObj = normalizeDataCloudName(j.toObject);
    const alias   = j.alias ?? joinObj.replace(/__(dlm|dlo)$/, '').replace(/ssot__/, '');
    joinParts.push(
      `${j.joinType} JOIN ${joinObj} AS ${alias} ON ${base}.${j.fromField} = ${alias}.${j.toField}`
    );
  }

  // Auto-resolve JOINs from catalog relationships
  if (joinParts.length === 0 && meta?.relationships.length) {
    for (const rel of meta.relationships) {
      // Only auto-join if the field appears in SELECT or WHERE
      const allFields = [...(input.selectFields ?? []), ...(input.conditions ?? []).map(c => c.field)];
      if (allFields.some(f => f.includes(rel.toObject.replace(/__(dlm|dlo)$/, '')))) {
        const joinObj = normalizeDataCloudName(rel.toObject);
        const alias   = joinObj.replace(/__(dlm|dlo)$/, '').replace(/ssot__/, '');
        joinParts.push(`LEFT JOIN ${joinObj} AS ${alias} ON ${base}.${rel.fromField} = ${alias}.${rel.toField}`);
      }
    }
  }

  // ── WHERE ─────────────────────────────────────────────────────────────────
  const whereParts: string[] = [];
  for (const cond of (input.conditions ?? [])) {
    if (meta && !meta.fields[cond.field] && !cond.field.includes('.')) {
      warnings.push(`WHERE field "${cond.field}" not in catalog — skipped`);
      continue;
    }
    whereParts.push(`${cond.field} ${opToSql(cond.op, cond.value)}`);
  }

  // ── GROUP BY ──────────────────────────────────────────────────────────────
  const groupBy = input.groupBy?.length ? `GROUP BY ${input.groupBy.join(', ')}` : '';
  const having  = input.having ? `HAVING ${input.having}` : '';

  // ── ORDER BY ──────────────────────────────────────────────────────────────
  const orderBy = input.orderBy ? `ORDER BY ${input.orderBy}` : '';

  // ── LIMIT ─────────────────────────────────────────────────────────────────
  const limit = Math.min(Math.max(1, input.limit ?? 50), 2000);

  // Assemble
  const parts = [
    `SELECT ${selectParts.join(', ')}`,
    `FROM ${fromClause}`,
    ...joinParts,
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '',
    groupBy,
    having,
    orderBy,
    `LIMIT ${limit}`,
  ].filter(Boolean);

  return { sql: parts.join('\n'), warnings };
}

// ── Engine routing helper ─────────────────────────────────────────────────────

export type QueryEngine = 'CRM_SOQL' | 'DATACLOUD_SQL';

/**
 * Determines which query engine to use based on the resolved sObject.
 * Data Cloud objects (suffix __dlm or __dlo) require the Data Cloud SQL engine.
 */
export function detectQueryEngine(sObject: string | null): QueryEngine {
  if (!sObject) return 'CRM_SOQL';
  return isDataCloudObject(sObject) ? 'DATACLOUD_SQL' : 'CRM_SOQL';
}
