import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLock, writeLock, canonicalSha256, specHash, selectViews, findOrphans, LockError, type Lock, type LockEntry } from '../src/lock.js';
import type { ViewSource } from '../src/discover.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ssv-lock-'));
const view = (key: string, fileSha256 = 'src', path = `${key}.sql`): ViewSource => ({ key, name: { view: key }, path, format: 'ddl', index: 0, fileSha256 });
const entry = (over: Partial<LockEntry> = {}): LockEntry => ({
  dataModelId: 'dm', modelName: 'M', sourcePath: 'p.sql', sourceSha256: 'src', optionsSha256: 'opt', engineCommit: 'eng',
  specSha256: 'spec', lastDeployedAt: '2026-10-22T00:00:00Z', orphaned: false, ...over,
});
const ctx = { mode: 'auto' as const, engineCommit: 'eng', optionsSha256: 'opt' };

test('missing lock is empty', () => {
  assert.deepEqual(readLock(join(tmp(), 'nope.json')), { version: 1, views: {} });
});

test('corrupt lock throws LockError', () => {
  for (const content of ['<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n', '{', '{"version":2,"views":{}}', '[]', '{"version":1}']) {
    const p = join(tmp(), 'lock.json');
    writeFileSync(p, content);
    assert.throws(() => readLock(p), (e: unknown) => e instanceof LockError && e.message.includes(p), content);
  }
});

test('writeLock is stable', () => {
  const d = tmp();
  const a: Lock = { version: 1, views: { 'B.V': entry({ dataModelId: 'b' }), 'A.V': entry({ dataModelId: 'a' }) } };
  const b: Lock = { version: 1, views: { 'A.V': entry({ dataModelId: 'a' }), 'B.V': entry({ dataModelId: 'b' }) } };
  writeLock(join(d, 'a.json'), a);
  writeLock(join(d, 'sub/b.json'), b);
  const textA = readFileSync(join(d, 'a.json'), 'utf8');
  assert.equal(textA, readFileSync(join(d, 'sub/b.json'), 'utf8'));
  assert.ok(textA.endsWith('}\n'));
  assert.deepEqual(readLock(join(d, 'a.json')), a);
  assert.ok(textA.indexOf('"A.V"') < textA.indexOf('"B.V"'));
});

test('specHashVersion is optional but must be a number when present', () => {
  const p = join(tmp(), 'lock.json');
  writeFileSync(p, JSON.stringify({ version: 1, views: { A: { ...entry(), specHashVersion: 2 }, B: entry() } }));
  assert.equal(readLock(p).views.A.specHashVersion, 2);
  writeFileSync(p, JSON.stringify({ version: 1, views: { A: { ...entry(), specHashVersion: 'two' } } }));
  assert.throws(() => readLock(p), LockError);
});

test('canonicalSha256 ignores key order', () => {
  assert.equal(canonicalSha256({ a: 1, b: { c: 2, d: 3 } }), canonicalSha256({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(canonicalSha256({ a: [1, 2] }), canonicalSha256({ a: [2, 1] }));
});

test('selectViews auto picks new, changed source, changed options, changed engine', () => {
  const lock: Lock = { version: 1, views: {
    SAME: entry(), SRC: entry(), OPT: entry({ optionsSha256: 'old' }), ENG: entry({ engineCommit: 'old' }),
  } };
  const views = [view('SAME'), view('NEW'), view('SRC', 'changed'), view('OPT'), view('ENG')];
  const r = selectViews(views, lock, ctx);
  assert.deepEqual(r.selected.map(v => v.key).sort(), ['ENG', 'NEW', 'OPT', 'SRC']);
  assert.deepEqual(r.unchanged.map(v => v.key), ['SAME']);
});

test('selectViews all selects everything', () => {
  const lock: Lock = { version: 1, views: { SAME: entry() } };
  const r = selectViews([view('SAME'), view('NEW')], lock, { ...ctx, mode: 'all' });
  assert.deepEqual(r.selected.map(v => v.key), ['SAME', 'NEW']);
  assert.deepEqual(r.unchanged, []);
});

test('a moved file with the same key and content is unchanged', () => {
  const lock: Lock = { version: 1, views: { K: entry({ sourcePath: 'old/place.sql' }) } };
  const r = selectViews([view('K', 'src', 'new/place.sql')], lock, ctx);
  assert.deepEqual(r.unchanged.map(v => v.key), ['K']);
});

test('findOrphans lists keys missing from discovery', () => {
  const lock: Lock = { version: 1, views: { Z: entry(), A: entry(), KEEP: entry() } };
  assert.deepEqual(findOrphans([view('KEEP')], lock), ['A', 'Z']);
});

test('specHash covers the model content and ignores Sigma metadata', () => {
  const base = { schemaVersion: 1, pages: [{ id: 'p', elements: [] }] };
  assert.equal(
    specHash({ ...base, documentVersion: 1, updatedAt: '2026-10-22T17:14:25Z', name: 'A', folderId: 'f1' }),
    specHash({ ...base, documentVersion: 5, updatedAt: '2026-10-22T17:20:00Z', name: 'Renamed', folderId: 'f2' }),
  );
  assert.notEqual(specHash(base), specHash({ ...base, pages: [{ id: 'p', elements: [{ id: 'e' }] }] }));
});
