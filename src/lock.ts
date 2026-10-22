/**
 * The committed lockfile: which Sigma data model each semantic view key maps to,
 * and the hashes that decide whether a view needs converting again.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ViewSource } from './discover.js';

export interface LockEntry {
  dataModelId: string;
  modelName: string;
  sourcePath: string;
  sourceSha256: string;
  optionsSha256: string;
  engineCommit: string;
  /** canonicalSha256 of the spec Sigma returned after the last deploy (drift detection). */
  specSha256: string;
  lastDeployedAt: string;
  orphaned: boolean;
}

export interface Lock {
  version: 1;
  views: Record<string, LockEntry>;
}

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

const ENTRY_STRINGS = ['dataModelId', 'modelName', 'sourcePath', 'sourceSha256', 'optionsSha256', 'engineCommit', 'specSha256', 'lastDeployedAt'] as const;

/** A missing file is an empty lock; anything else that isn't a valid version-1 lock throws. */
export function readLock(path: string): Lock {
  if (!existsSync(path)) return { version: 1, views: {} };
  const fail = (why: string): never => {
    throw new LockError(`lockfile ${path} is not usable (${why}); fix or restore it before syncing — nothing was changed in Sigma`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return fail(`invalid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('not a JSON object');
  const lock = parsed as Record<string, unknown>;
  if (lock.version !== 1) return fail(`unsupported version ${JSON.stringify(lock.version)}`);
  if (!lock.views || typeof lock.views !== 'object' || Array.isArray(lock.views)) return fail('missing "views" object');
  for (const [key, entry] of Object.entries(lock.views as Record<string, unknown>)) {
    const e = entry as Record<string, unknown> | null;
    if (!e || typeof e !== 'object') return fail(`entry ${key} is not an object`);
    for (const field of ENTRY_STRINGS) if (typeof e[field] !== 'string') return fail(`entry ${key} has no string "${field}"`);
    if (typeof e.orphaned !== 'boolean') return fail(`entry ${key} has no boolean "orphaned"`);
  }
  return lock as unknown as Lock;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map(k => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function writeLock(path: string, lock: Lock): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(sortKeys(lock), null, 2) + '\n');
}

/** sha256 of the value's JSON with object keys sorted recursively. */
export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortKeys(value))).digest('hex');
}

export function selectViews(
  views: ViewSource[],
  lock: Lock,
  ctx: { mode: 'auto' | 'all'; engineCommit: string; optionsSha256: string },
): { selected: ViewSource[]; unchanged: ViewSource[] } {
  const selected: ViewSource[] = [];
  const unchanged: ViewSource[] = [];
  for (const v of views) {
    const e = lock.views[v.key];
    const stale =
      ctx.mode === 'all' ||
      e === undefined ||
      e.sourceSha256 !== v.fileSha256 ||
      e.optionsSha256 !== ctx.optionsSha256 ||
      e.engineCommit !== ctx.engineCommit;
    (stale ? selected : unchanged).push(v);
  }
  return { selected, unchanged };
}

/** Lock keys no longer defined by any discovered view, sorted. */
export function findOrphans(views: ViewSource[], lock: Lock): string[] {
  const present = new Set(views.map(v => v.key));
  return Object.keys(lock.views)
    .filter(k => !present.has(k))
    .sort();
}
