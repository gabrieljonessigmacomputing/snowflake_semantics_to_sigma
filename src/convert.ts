/**
 * Snowflake semantic view → Sigma data model.
 *
 * The sync, lockfile, and deploy path are unchanged. Conversion itself is the
 * semantic-view converter in `converter/` (physical column names, real
 * relationship keys, semi-additive latest/earliest values). It does not call
 * Sigma or Snowflake, and it does not read credentials.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SigmaDataModel, ConversionResult } from './types.js';

/** One level up from both `src/convert.ts` and the bundled `dist/index.js`. */
const ACTION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ENGINE = {
  semanticToolsCommit: 'semantic-view-converter@4860ebc',
  embedVersion: '1.0.0',
} as const;

export type SourceFormat = 'snowflake-semantic-view' | 'snowflake-semantic-view-yaml';

export interface EmbedFinding {
  code: string;
  severity: string;
  message: string;
  remediation?: string;
  line?: number;
  object: { kind: string; name: string; owner?: string };
  source?: 'embed';
}

export interface SnowflakeConvertOptions {
  /** Sigma connection UUID. Empty/omitted -> placeholder + warning. */
  connectionId?: string;
  /** Needed only when the view has table refs with fewer than 3 parts. */
  database?: string;
  /** Needed only when the view has table refs with fewer than 2 parts. */
  schema?: string;
  /** `{ 'DB.SCHEMA.TABLE': { COL: 'TYPE' } }` — physical spelling and number formats. */
  columnTypes?: Record<string, Record<string, string>>;
  /**
   * Accepted so existing workflows keep parsing. This converter already translates
   * the constructs the previous engine refused, so the flag does not change the spec.
   */
  bestEffort?: boolean;
  /** Append "Also called: a, b" to descriptions (default true). */
  synonymsInDescription?: boolean;
  /** Add number formats to metrics / calculated columns. */
  inferNumberFormats?: boolean;
  /**
   * Accepted and unused. Column formulas name the physical column on its own
   * table, so there is no derived `__joined` element.
   */
  crossTableReferences?: 'derived' | 'engine';
  /** Accepted and unused. A USING pin is reported and the metric is still translated. */
  usingPaths?: 'bound' | 'engine';
  /** Accepted and unused. */
  multiFactWarning?: boolean;
  /** @deprecated Accepted and ignored: metrics now come only from the view's own definitions. */
  autoMetrics?: boolean;
}

export interface SnowflakeViewResult {
  viewName: string;
  ok: boolean;
  /** Parsed spec (present only when ok). */
  model?: SigmaDataModel;
  /** Spec counts for this view (present only when ok). */
  stats?: Record<string, number>;
  findings: EmbedFinding[];
  bestEffortWouldConvert: boolean;
  needs?: { database: string[]; schema: string[] };
  overriddenErrors: string[];
}

export interface SnowflakeConversionResult extends Omit<ConversionResult, 'model'> {
  /** Spec of the first successfully converted view (back-compat; with several views read `results[].model`); absent when every view was refused (never a partial/failed model). */
  model?: SigmaDataModel;
  /** True when ANY view was refused (a partial result is still a refusal: check `refusedViews`). */
  refused: boolean;
  /** True when NO view converted. */
  allRefused: boolean;
  /** Names of the refused views. */
  refusedViews: string[];
  /** `stats` is the SUM over every converted view; per-view counts are in `results[].stats`. */
  /** True when at least one refused view would convert with bestEffort. */
  bestEffortWouldConvert: boolean;
  /** database/schema the caller must supply (merged across views); absent when nothing is needed. */
  needs?: { database: string[]; schema: string[] };
  findings: EmbedFinding[];
  results: SnowflakeViewResult[];
  engine: { semanticToolsCommit: string; embedVersion: string };
}

export const CONNECTION_PLACEHOLDER = '<CONNECTION_ID>';
export const CONNECTION_WARNING = '⚠ Connection ID not set — update in JSON before saving to Sigma';
export const AUTO_METRICS_DEPRECATION =
  'auto_metrics is no longer supported: metrics now come only from the semantic view\'s own definitions';

interface PythonFinding {
  level?: string;
  code?: string;
  message?: string;
}

interface PythonResult {
  ok?: boolean;
  viewName?: string;
  spec?: SigmaDataModel | null;
  findings?: PythonFinding[];
  needs?: { database?: string[]; schema?: string[] };
  aiContext?: string;
  verifiedQueries?: unknown[];
}

const BRIDGE = `
import json, sys
from converter.build import convert
req = json.load(sys.stdin)
out = convert(
    req["source"],
    connection_id=req.get("connectionId") or None,
    catalog=req.get("columnTypes"),
    facts_as_metrics=False,
    synonyms_in_description=bool(req.get("synonymsInDescription", True)),
    infer_number_formats=bool(req.get("inferNumberFormats", False)),
    database=req.get("database") or None,
    schema=req.get("schema") or None,
)
json.dump(out, sys.stdout)
`;

/**
 * DDL opens with CREATE [OR REPLACE] SEMANTIC VIEW; native YAML opens with a
 * top-level `name:` key. Header comments are handled by the file scanner.
 */
export function detectFormat(source: string): SourceFormat | undefined {
  const head = source.slice(0, 2000);
  if (/^\s*CREATE\s+(OR\s+REPLACE\s+)?SEMANTIC\s+VIEW\b/i.test(head)) {
    return 'snowflake-semantic-view';
  }
  if (/^\s*name\s*:/m.test(head)) {
    return 'snowflake-semantic-view-yaml';
  }
  return undefined;
}

function specStats(model: SigmaDataModel | undefined): Record<string, number> {
  const elements: any[] = (model?.pages ?? []).flatMap((p: any) => p.elements ?? []);
  const sum = (key: string) => elements.reduce((n, e) => n + (e[key]?.length ?? 0), 0);
  return {
    tables: elements.filter(e => e.source?.kind === 'warehouse-table').length,
    elements: elements.length,
    columns: sum('columns'),
    metrics: sum('metrics'),
    relationships: sum('relationships'),
  };
}

function sumStats(all: (Record<string, number> | undefined)[]): Record<string, number> {
  const out = specStats(undefined);
  for (const st of all) for (const [k, v] of Object.entries(st ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
}

function mergeNeeds(results: SnowflakeViewResult[]): { database: string[]; schema: string[] } | undefined {
  const database = new Set<string>();
  const schema = new Set<string>();
  for (const r of results) {
    r.needs?.database.forEach(x => database.add(x));
    r.needs?.schema.forEach(x => schema.add(x));
  }
  return database.size || schema.size ? { database: [...database], schema: [...schema] } : undefined;
}

/** One Python call per CREATE SEMANTIC VIEW. YAML stays one document. */
function statements(source: string): string[] {
  if (detectFormat(source) === 'snowflake-semantic-view-yaml') return [source];
  const re = /\bCREATE\s+(?:OR\s+REPLACE\s+)?SEMANTIC\s+VIEW\b/gi;
  const starts = [...source.matchAll(re)].map(m => m.index).filter((i): i is number => i !== undefined);
  if (starts.length <= 1) return [source];
  return starts.map((start, i) => source.slice(start, starts[i + 1] ?? source.length));
}

function toFindings(viewName: string, raw: PythonResult): EmbedFinding[] {
  const findings: EmbedFinding[] = (raw.findings ?? []).map(f => ({
    code: String(f.code ?? 'CONVERTER'),
    severity: f.level === 'error' ? 'error' : f.level === 'warning' ? 'warning' : 'info',
    message: String(f.message ?? ''),
    object: { kind: 'view', name: viewName || '(unnamed)' },
  }));
  if (typeof raw.aiContext === 'string' && raw.aiContext.includes('## Instructions from the semantic view')) {
    findings.push({
      code: 'AI_CONTEXT',
      severity: 'info',
      message: 'AI instructions were read. They are not stored on the model: Sigma has no API for model AI context.',
      object: { kind: 'view', name: viewName || '(unnamed)' },
    });
  }
  if (Array.isArray(raw.verifiedQueries) && raw.verifiedQueries.length > 0) {
    findings.push({
      code: 'VERIFIED_QUERIES',
      severity: 'info',
      message: `${raw.verifiedQueries.length} verified question(s) were read. They are not stored on the model.`,
      object: { kind: 'view', name: viewName || '(unnamed)' },
    });
  }
  return findings;
}

function callConverter(payload: Record<string, unknown>): PythonResult {
  const run = spawnSync('python3', ['-c', BRIDGE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: ACTION_ROOT,
    env: { ...process.env, PYTHONPATH: ACTION_ROOT, PYTHONDONTWRITEBYTECODE: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) throw new Error(`python3 could not be started (${run.error.message}). GitHub-hosted runners include it.`);
  if (run.status !== 0) {
    const detail = (run.stderr || 'the converter failed').trim().slice(0, 2000);
    throw new Error(detail);
  }
  return JSON.parse(run.stdout) as PythonResult;
}

function convertOne(source: string, options: SnowflakeConvertOptions, connectionId: string): SnowflakeViewResult {
  const raw = callConverter({
    source,
    connectionId,
    ...(options.database?.trim() && { database: options.database.trim() }),
    ...(options.schema?.trim() && { schema: options.schema.trim() }),
    ...(options.columnTypes && { columnTypes: options.columnTypes }),
    synonymsInDescription: options.synonymsInDescription !== false,
    inferNumberFormats: options.inferNumberFormats === true,
  });
  const viewName = raw.viewName || '(unnamed)';
  const findings = toFindings(viewName, raw);
  const needs = raw.needs && (raw.needs.database?.length || raw.needs.schema?.length)
    ? { database: raw.needs.database ?? [], schema: raw.needs.schema ?? [] }
    : undefined;
  const ok = raw.ok === true && raw.spec != null && !needs;
  return {
    viewName,
    ok,
    ...(ok && raw.spec ? { model: raw.spec, stats: specStats(raw.spec) } : {}),
    findings,
    bestEffortWouldConvert: false,
    ...(needs && { needs }),
    overriddenErrors: [],
  };
}

function failed(message: string): SnowflakeConversionResult {
  const findings: EmbedFinding[] = [{
    code: 'CONVERTER',
    severity: 'error',
    message,
    object: { kind: 'view', name: '(unnamed)' },
  }];
  const result: SnowflakeViewResult = {
    viewName: '(unnamed)', ok: false, findings, bestEffortWouldConvert: false, overriddenErrors: [],
  };
  return {
    warnings: [`CONVERTER: ${message}`],
    stats: specStats(undefined),
    refused: true,
    allRefused: true,
    refusedViews: ['(unnamed)'],
    bestEffortWouldConvert: false,
    findings,
    results: [result],
    engine: { ...ENGINE },
  };
}

export function convertSnowflakeSemanticView(
  source: string,
  options: SnowflakeConvertOptions = {},
): SnowflakeConversionResult {
  const connectionId = (options.connectionId ?? '').trim() || CONNECTION_PLACEHOLDER;
  let results: SnowflakeViewResult[];
  try {
    results = statements(source).map(part => convertOne(part, options, connectionId));
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }

  const firstOk = results.find(r => r.ok && r.model !== undefined);
  const findings = results.flatMap(r => r.findings);
  const warnings: string[] = [];
  if (!(options.connectionId ?? '').trim()) warnings.push(CONNECTION_WARNING);
  if (options.autoMetrics !== undefined) warnings.push(AUTO_METRICS_DEPRECATION);
  const multi = results.length > 1;
  for (const r of results) {
    for (const f of r.findings) {
      warnings.push(`${multi ? `[${r.viewName || 'view'}] ` : ''}${f.code}: ${f.message}`);
    }
  }
  const needs = mergeNeeds(results);
  return {
    ...(firstOk && { model: firstOk.model }),
    warnings,
    stats: sumStats(results.map(r => r.stats)),
    refused: results.some(r => !r.ok) || results.length === 0,
    allRefused: firstOk === undefined,
    refusedViews: results.filter(r => !r.ok).map(r => r.viewName || '(unnamed)'),
    bestEffortWouldConvert: false,
    ...(needs && { needs }),
    findings,
    results,
    engine: { ...ENGINE },
  };
}
