/**
 * Finds the semantic views in the repo: candidate files by glob, then each file's
 * format (DDL / YAML / not a semantic view) and the key of every view it defines.
 */

import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import * as glob from '@actions/glob';
import { detectFormat } from './convert.js';
import { normalizeSource, parseDdlViewNames, parseYamlViewName, viewKey, type QualifiedName } from './identity.js';

export interface ViewSource {
  key: string;
  name: QualifiedName;
  /** Repo-relative POSIX path. */
  path: string;
  format: 'ddl' | 'yaml';
  /** Statement order within the file (matches the engine's `results[]` order). */
  index: number;
  /** sha256 of the file's raw content. */
  fileSha256: string;
}

export interface Discovery {
  views: ViewSource[];
  skipped: string[];
  errors: { path: string; message: string }[];
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function withDefaults(q: QualifiedName, defaults: { database?: string; schema?: string }): QualifiedName {
  return {
    ...q,
    ...(q.database === undefined && defaults.database && { database: defaults.database }),
    ...(q.schema === undefined && defaults.schema && { schema: defaults.schema }),
  };
}

export function discoverViews(
  files: { path: string; content: string }[],
  defaults: { database?: string; schema?: string },
): Discovery {
  const found: ViewSource[] = [];
  const skipped: string[] = [];
  const errors: Discovery['errors'] = [];

  for (const file of files) {
    const text = normalizeSource(file.content);
    const format = detectFormat(text);
    if (format === undefined) {
      skipped.push(file.path);
      continue;
    }
    const fileSha256 = sha256(file.content);
    if (format === 'snowflake-semantic-view') {
      const names = parseDdlViewNames(text);
      if (names.length === 0) {
        errors.push({ path: file.path, message: 'looks like semantic view DDL but no CREATE SEMANTIC VIEW name could be read' });
        continue;
      }
      names.forEach((n, index) => {
        const name = withDefaults(n, defaults);
        found.push({ key: viewKey(name), name, path: file.path, format: 'ddl', index, fileSha256 });
      });
    } else {
      const view = parseYamlViewName(text);
      if (view === undefined) {
        errors.push({ path: file.path, message: 'semantic view YAML has no top-level name' });
        continue;
      }
      const name = withDefaults({ view }, defaults);
      found.push({ key: viewKey(name), name, path: file.path, format: 'yaml', index: 0, fileSha256 });
    }
  }

  const byKey = new Map<string, ViewSource[]>();
  for (const v of found) byKey.set(v.key, [...(byKey.get(v.key) ?? []), v]);
  const views: ViewSource[] = [];
  for (const [key, group] of byKey) {
    if (group.length === 1) {
      views.push(group[0]);
      continue;
    }
    const paths = [...new Set(group.map(v => v.path))];
    for (const path of paths) {
      errors.push({ path, message: `semantic view ${key} is defined more than once (${paths.join(', ')})` });
    }
  }
  return { views, skipped, errors };
}

/** Repo-relative POSIX paths matching `patterns` (newline-separated globs), sorted. */
export async function listCandidateFiles(patterns: string, root: string, exclude: string[]): Promise<string[]> {
  const lines = patterns
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .flatMap(expandBraces)
    .map(l => (l.startsWith('!') ? `!${root}/${l.slice(1)}` : `${root}/${l}`));
  const excludes = ['.git', 'node_modules', ...exclude].flatMap(e => [`!${root}/${e}`, `!${root}/${e}/**`, `!${root}/**/${e}/**`]);
  const globber = await glob.create([...lines, ...excludes].join('\n'), { followSymbolicLinks: false, matchDirectories: false });
  const files = await globber.glob();
  return [...new Set(files.map(f => relative(root, f).split(sep).join('/')))].sort();
}

/** `a/*.{x,y}` → `a/*.x`, `a/*.y` (@actions/glob has no brace expansion). */
function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  return m[1].split(',').flatMap(alt => expandBraces(pattern.slice(0, m.index) + alt + pattern.slice(m.index + m[0].length)));
}
