/**
 * Semantic view identity: the `DB.SCHEMA.VIEW` key a view is tracked by, and the
 * Sigma data model name rendered from it.
 *
 * The vendored engine reports only the bare view name, so the qualifiers are read
 * here with a thin pre-parse of each `CREATE SEMANTIC VIEW` statement (DDL) or the
 * top-level `name:` (YAML), and missing parts are filled from the action inputs.
 */

import { parse as parseYaml } from 'yaml';

export interface QualifiedName {
  database?: string;
  schema?: string;
  view: string;
  /** Parts written as "quoted" identifiers keep their case in the key; unquoted parts fold to upper case, as Snowflake does. */
  quoted?: { database?: boolean; schema?: boolean; view?: boolean };
}

const PARTS = ['database', 'schema', 'view'] as const;

/** Strips a leading BOM and normalizes CRLF / CR line endings to LF. */
export function normalizeSource(content: string): string {
  return content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** Replaces comments and single-quoted / $$ strings with spaces, keeping offsets and "quoted identifiers". */
function maskNonCode(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    let end = -1;
    if (c === '-' && next === '-') {
      end = sql.indexOf('\n', i);
      if (end === -1) end = sql.length;
    } else if (c === '/' && next === '*') {
      end = sql.indexOf('*/', i + 2);
      end = end === -1 ? sql.length : end + 2;
    } else if (c === '$' && next === '$') {
      end = sql.indexOf('$$', i + 2);
      end = end === -1 ? sql.length : end + 2;
    } else if (c === "'") {
      end = i + 1;
      while (end < sql.length) {
        if (sql[end] === '\\') { end += 2; continue; }
        if (sql[end] === "'") {
          if (sql[end + 1] === "'") { end += 2; continue; }
          end += 1;
          break;
        }
        end += 1;
      }
    } else if (c === '"') {
      // Quoted identifier: copy through unchanged (with "" escapes).
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (end === -1) {
      out += c;
      i += 1;
    } else {
      out += sql.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    }
  }
  return out;
}

const IDENT = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)`;
const CREATE_RE = new RegExp(
  String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?SEMANTIC\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT}(?:\s*\.\s*${IDENT}){0,2})`,
  'gi',
);
const IDENT_RE = new RegExp(IDENT, 'g');

/** The view name of every `CREATE SEMANTIC VIEW` statement, in source order. */
export function parseDdlViewNames(sql: string): QualifiedName[] {
  const masked = maskNonCode(normalizeSource(sql));
  const names: QualifiedName[] = [];
  for (const m of masked.matchAll(CREATE_RE)) {
    const idents = m[1].match(IDENT_RE) ?? [];
    const parts = idents.map(id =>
      id.startsWith('"') ? { value: id.slice(1, -1).replace(/""/g, '"'), quoted: true } : { value: id, quoted: false },
    );
    const roles = PARTS.slice(3 - parts.length);
    const q: QualifiedName = { view: '' };
    const quoted: NonNullable<QualifiedName['quoted']> = {};
    roles.forEach((role, i) => {
      q[role] = parts[i].value;
      if (parts[i].quoted) quoted[role] = true;
    });
    if (Object.keys(quoted).length > 0) q.quoted = quoted;
    names.push(q);
  }
  return names;
}

/** The top-level `name:` of a semantic view YAML document. */
export function parseYamlViewName(yaml: string): string | undefined {
  try {
    const doc = parseYaml(normalizeSource(yaml)) as unknown;
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      const name = (doc as Record<string, unknown>).name;
      if (typeof name === 'string' && name.trim() !== '') return name.trim();
    }
  } catch {
    // Unparsable YAML has no name; the caller reports it.
  }
  return undefined;
}

/** `DB.SCHEMA.VIEW` with only the parts present; unquoted parts upper-cased, quoted parts verbatim. */
export function viewKey(q: QualifiedName): string {
  return PARTS.filter(p => q[p] !== undefined && q[p] !== '')
    .map(p => (q.quoted?.[p] ? q[p]! : q[p]!.toUpperCase()))
    .join('.');
}

/** Renders `{database}`, `{schema}`, `{view}`; a dot-separated segment that renders empty is dropped. */
export function renderModelName(template: string, q: QualifiedName): string {
  return template
    .split('.')
    .map(seg => seg.replace(/\{(database|schema|view)\}/g, (_, p: (typeof PARTS)[number]) => q[p] ?? ''))
    .filter(seg => seg !== '')
    .join('.');
}

/** Groups of view keys that would get the same Sigma model name. */
export function findNameCollisions(views: { key: string; name: QualifiedName }[], template: string): string[][] {
  const byName = new Map<string, string[]>();
  for (const v of views) {
    const name = renderModelName(template, v.name);
    byName.set(name, [...(byName.get(name) ?? []), v.key]);
  }
  return [...byName.values()].filter(keys => keys.length > 1).map(keys => keys.sort());
}
