import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { applyOutcomes, saveSpecs, writeBack, uploadStateArtifact, refreshState, COMMIT_MESSAGE } from '../src/writeback.js';
import type { ViewOutcome } from '../src/execute.js';
import type { Lock, LockEntry } from '../src/lock.js';
import type { ViewSource } from '../src/discover.js';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...args: string[]) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repos() {
  const root = mkdtempSync(join(tmpdir(), 'ssv-git-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(root, 'seed');
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' });
  mkdirSync(join(seed, 'sigma'), { recursive: true });
  writeFileSync(join(seed, 'sigma/semantic-views.lock.json'), '{"version":1,"views":{}}\n');
  writeFileSync(join(seed, 'README.md'), 'hi\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const work = join(root, 'work');
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
  return { root, origin, seed, work };
}
const ctxFor = (cwd: string, octokit?: unknown) => ({ cwd, ref: 'main', repo: { owner: 'acme', repo: 'views' }, gitUserName: 'github-actions[bot]', gitUserEmail: '41898282+github-actions[bot]@users.noreply.github.com', octokit: octokit as any });

const view = (key: string, path = `${key}.sql`): ViewSource => ({ key, name: { view: key }, path, format: 'ddl', index: 0, fileSha256: `sha-${key}` });
const entry = (over: Partial<LockEntry> = {}): LockEntry => ({ dataModelId: 'old', modelName: 'M', sourcePath: 'old.sql', sourceSha256: 'old', optionsSha256: 'old', engineCommit: 'old', specSha256: 'old', lastDeployedAt: '2020-01-01T00:00:00Z', orphaned: false, ...over });
const outcome = (key: string, status: ViewOutcome['status'], over: Partial<ViewOutcome> = {}): ViewOutcome => ({ key, status, modelName: key, drift: false, findings: [], ...over });
const ctx = { engineCommit: 'eng', optionsSha256: 'opt', now: '2026-10-22T12:00:00Z' };

test('applyOutcomes writes full entries for created, updated and adopted', () => {
  const lock: Lock = { version: 1, views: { U: entry() } };
  const out = applyOutcomes(lock, [
    outcome('C', 'created', { dataModelId: 'c1', specSha256: 's1' }),
    outcome('U', 'updated', { dataModelId: 'old', specSha256: 's2' }),
    outcome('A', 'adopted', { dataModelId: 'a1', specSha256: 's3' }),
  ], [view('C'), view('U'), view('A')], ctx, []);
  assert.deepEqual(out.views.C, { dataModelId: 'c1', modelName: 'C', sourcePath: 'C.sql', sourceSha256: 'sha-C', optionsSha256: 'opt', engineCommit: 'eng', specSha256: 's1', specHashVersion: 2, lastDeployedAt: ctx.now, orphaned: false });
  assert.equal(out.views.U.specSha256, 's2');
  assert.equal(out.views.U.sourceSha256, 'sha-U');
  assert.equal(out.views.A.dataModelId, 'a1');
  assert.equal(lock.views.U.specSha256, 'old', 'input lock is not mutated');
});

test('applyOutcomes refreshes sourcePath for unchanged and leaves failed/refused alone', () => {
  const lock: Lock = { version: 1, views: { K: entry({ sourcePath: 'old/k.sql' }), F: entry(), R: entry() } };
  const out = applyOutcomes(lock, [outcome('K', 'unchanged'), outcome('F', 'failed'), outcome('R', 'refused')], [view('K', 'new/k.sql'), view('F'), view('R')], ctx, []);
  assert.equal(out.views.K.sourcePath, 'new/k.sql');
  assert.equal(out.views.K.lastDeployedAt, entry().lastDeployedAt);
  assert.deepEqual(out.views.F, entry());
  assert.deepEqual(out.views.R, entry());
  assert.equal(applyOutcomes({ version: 1, views: {} }, [outcome('N', 'failed')], [view('N')], ctx, []).views.N, undefined);
});

test('applyOutcomes records a created model with unknown spec hash and keeps a failed-but-owned model for a retry', () => {
  const lock: Lock = { version: 1, views: { K: entry({ dataModelId: 'k1' }) } };
  const out = applyOutcomes(lock, [
    outcome('C', 'created', { dataModelId: 'c1', specSha256: '' }),
    outcome('K', 'failed', { dataModelId: 'k1', keepInLock: true }),
    outcome('N', 'failed', { dataModelId: 'n1', keepInLock: true }),
  ], [view('C'), view('K'), view('N')], ctx, []);
  assert.equal(out.views.C.dataModelId, 'c1');
  assert.equal(out.views.C.specSha256, '');
  assert.equal(out.views.K.dataModelId, 'k1');
  assert.equal(out.views.K.sourceSha256, '', 'forces the view to be reprocessed next run');
  assert.equal(out.views.N.dataModelId, 'n1');
  assert.equal(out.views.N.sourceSha256, '');
});

test('applyOutcomes marks orphans and clears a rediscovered orphan', () => {
  const lock: Lock = { version: 1, views: { GONE: entry(), BACK: entry({ orphaned: true }) } };
  const out = applyOutcomes(lock, [outcome('BACK', 'unchanged')], [view('BACK')], ctx, ['GONE']);
  assert.equal(out.views.GONE.orphaned, true);
  assert.equal(out.views.GONE.dataModelId, 'old');
  assert.equal(out.views.BACK.orphaned, false);
});

test('saveSpecs sanitizes keys', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'ssv-specs-')), 'sigma/models');
  const paths = saveSpecs([
    outcome('D.S.V', 'created', { getBackSpec: { schemaVersion: 1, pages: [{ id: 'p' }] } }),
    outcome('../X', 'updated', { getBackSpec: { pages: [] } }),
    outcome('F', 'failed'),
  ], dir);
  assert.deepEqual(paths, [join(dir, 'D.S.V.yml'), join(dir, '__X.yml')]);
  assert.deepEqual(parseYaml(readFileSync(paths[0], 'utf8')), { schemaVersion: 1, pages: [{ id: 'p' }] });
  for (const p of paths) assert.ok(p.startsWith(dir + '/'));
});

test('push commits and pushes', async () => {
  const r = repos();
  writeFileSync(join(r.work, 'sigma/semantic-views.lock.json'), '{"version":1,"views":{"A":{}}}\n');
  const res = await writeBack('push', ['sigma/semantic-views.lock.json'], ctxFor(r.work));
  assert.equal(res.ok, true, res.detail);
  assert.equal(git(r.origin, 'log', '-1', '--format=%s', 'main'), COMMIT_MESSAGE);
  assert.equal(COMMIT_MESSAGE, 'chore(sigma): sync semantic views [skip ci]');
  assert.equal(git(r.origin, 'log', '-1', '--format=%an <%ae>', 'main'), 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>');
});

test('push with nothing to commit is ok and makes no commit', async () => {
  const r = repos();
  const before = git(r.origin, 'rev-parse', 'main');
  const res = await writeBack('push', ['sigma/semantic-views.lock.json'], ctxFor(r.work));
  assert.equal(res.ok, true);
  assert.equal(git(r.origin, 'rev-parse', 'main'), before);
});

test('push retries after a racing commit', async () => {
  const r = repos();
  writeFileSync(join(r.seed, 'other.txt'), 'racing\n');
  git(r.seed, 'add', '-A');
  git(r.seed, 'commit', '-qm', 'racing commit');
  git(r.seed, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(r.work, 'sigma/semantic-views.lock.json'), '{"version":1,"views":{"A":{}}}\n');
  const res = await writeBack('push', ['sigma/semantic-views.lock.json'], ctxFor(r.work));
  assert.equal(res.ok, true, res.detail);
  const subjects = git(r.origin, 'log', '--format=%s', 'main').split('\n');
  assert.deepEqual(subjects.slice(0, 2), [COMMIT_MESSAGE, 'racing commit']);
});

test('push with rebase conflict fails cleanly', async () => {
  const r = repos();
  writeFileSync(join(r.seed, 'sigma/semantic-views.lock.json'), '{"version":1,"views":{"B":{}}}\n');
  git(r.seed, 'commit', '-qam', 'racing lock edit');
  git(r.seed, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(r.work, 'sigma/semantic-views.lock.json'), '{"version":1,"views":{"A":{}}}\n');
  const res = await writeBack('push', ['sigma/semantic-views.lock.json'], ctxFor(r.work));
  assert.equal(res.ok, false);
  assert.equal(existsSync(join(r.work, '.git/rebase-merge')), false);
  assert.equal(existsSync(join(r.work, '.git/rebase-apply')), false);
  assert.equal(git(r.origin, 'log', '-1', '--format=%s', 'main'), 'racing lock edit');
});

test('pull_request opens a PR once', async () => {
  const r = repos();
  const created: unknown[] = [];
  const open: unknown[] = [];
  const octokit = {
    pulls: {
      list: async (p: Record<string, unknown>) => { assert.equal(p.head, 'acme:sigma-sync/state'); return { data: open }; },
      create: async (p: Record<string, unknown>) => { created.push(p); open.push({ number: 1 }); return { data: { number: 1, html_url: 'https://github.test/pr/1' } }; },
    },
  };
  writeFileSync(join(r.work, 'sigma/semantic-views.lock.json'), '{"version":1,"views":{"A":{}}}\n');
  const first = await writeBack('pull_request', ['sigma/semantic-views.lock.json'], ctxFor(r.work, octokit));
  assert.equal(first.ok, true, first.detail);
  assert.equal(git(r.origin, 'log', '-1', '--format=%s', 'sigma-sync/state'), COMMIT_MESSAGE);
  assert.deepEqual(created.map((p: any) => [p.head, p.base, p.title]), [['sigma-sync/state', 'main', 'Sigma semantic view sync state']]);
  writeFileSync(join(r.work, 'sigma/semantic-views.lock.json'), '{"version":1,"views":{"A":{"x":1}}}\n');
  const second = await writeBack('pull_request', ['sigma/semantic-views.lock.json'], ctxFor(r.work, octokit));
  assert.equal(second.ok, true, second.detail);
  assert.equal(created.length, 1);
});

test('none writes nothing', async () => {
  const r = repos();
  writeFileSync(join(r.work, 'sigma/semantic-views.lock.json'), '{"version":1,"views":{"A":{}}}\n');
  const before = git(r.origin, 'rev-parse', 'main');
  assert.equal((await writeBack('none', ['sigma/semantic-views.lock.json'], ctxFor(r.work))).ok, true);
  assert.equal(git(r.origin, 'rev-parse', 'main'), before);
});

test('uploadStateArtifact uses the fixed artifact name', async () => {
  const calls: unknown[][] = [];
  await uploadStateArtifact(['/w/sigma/semantic-views.lock.json'], '/w', { uploadArtifact: async (...a: unknown[]) => { calls.push(a); return {}; } });
  assert.deepEqual(calls[0].slice(0, 3), ['sigma-semantic-sync-state', ['/w/sigma/semantic-views.lock.json'], '/w']);
});

const LOCK = 'sigma/semantic-views.lock.json';
const lockWith = (views: Record<string, Partial<LockEntry>>) => JSON.stringify({ version: 1, views: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, entry(v)])) }, null, 2) + '\n';
const pushLock = (r: ReturnType<typeof repos>, content: string, branch = 'main') => {
  writeFileSync(join(r.seed, LOCK), content);
  git(r.seed, 'add', '-A');
  git(r.seed, 'commit', '-qm', `state on ${branch}`);
  git(r.seed, 'push', '-q', 'origin', `HEAD:${branch}`);
};

test('refreshState fast-forwards a stale checkout in push mode', async () => {
  const r = repos();
  pushLock(r, lockWith({ A: { dataModelId: 'a1' } }));
  const res = await refreshState('push', ctxFor(r.work), LOCK, 'sigma/models');
  assert.deepEqual(res.warnings, []);
  assert.equal(readFileSync(join(r.work, LOCK), 'utf8'), lockWith({ A: { dataModelId: 'a1' } }));
  assert.equal(git(r.work, 'rev-parse', 'HEAD'), git(r.origin, 'rev-parse', 'main'));
});

test('refreshState and a racing push work from a shallow checkout', async () => {
  const r = repos();
  const shallow = join(r.root, 'shallow');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${r.origin}`, shallow], { stdio: 'ignore' });
  pushLock(r, lockWith({ A: { dataModelId: 'a1' } }));
  assert.deepEqual((await refreshState('push', ctxFor(shallow), LOCK, 'sigma/models')).warnings, []);
  assert.match(readFileSync(join(shallow, LOCK), 'utf8'), /a1/);
  writeFileSync(join(r.seed, 'other.txt'), 'racing\n');
  git(r.seed, 'add', '-A');
  git(r.seed, 'commit', '-qm', 'racing commit');
  git(r.seed, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(shallow, LOCK), lockWith({ A: { dataModelId: 'a1' }, B: { dataModelId: 'b1' } }));
  const wb = await writeBack('push', [LOCK], ctxFor(shallow));
  assert.equal(wb.ok, true, wb.detail);
});

test('pull_request mode overlays the unmerged state branch lock and specs', async () => {
  const r = repos();
  git(r.seed, 'checkout', '-q', '-b', 'sigma-sync/state');
  mkdirSync(join(r.seed, 'sigma/models'), { recursive: true });
  writeFileSync(join(r.seed, 'sigma/models/A.yml'), 'pages: []\n');
  pushLock(r, lockWith({ A: { dataModelId: 'a1', lastDeployedAt: '2026-10-22T10:00:00Z' }, B: { dataModelId: 'b-old', lastDeployedAt: '2026-10-01T00:00:00Z' } }), 'sigma-sync/state');
  writeFileSync(join(r.work, LOCK), lockWith({ B: { dataModelId: 'b-new', lastDeployedAt: '2026-10-20T00:00:00Z' } }));
  const res = await refreshState('pull_request', ctxFor(r.work), LOCK, 'sigma/models');
  assert.deepEqual(res.warnings, []);
  const lock = JSON.parse(readFileSync(join(r.work, LOCK), 'utf8'));
  assert.equal(lock.views.A.dataModelId, 'a1');
  assert.equal(lock.views.B.dataModelId, 'b-new', 'the newer entry wins');
  assert.equal(readFileSync(join(r.work, 'sigma/models/A.yml'), 'utf8'), 'pages: []\n');
});

test('two runs in pull_request mode keep both runs state', async () => {
  const r = repos();
  const octokit = { pulls: { list: async () => ({ data: [] as unknown[] }), create: async () => ({}) } };
  writeFileSync(join(r.work, LOCK), lockWith({ A: { dataModelId: 'a1', lastDeployedAt: '2026-10-22T10:00:00Z' } }));
  assert.equal((await writeBack('pull_request', [LOCK], ctxFor(r.work, octokit))).ok, true);
  const run2 = join(r.root, 'run2');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${r.origin}`, run2], { stdio: 'ignore' });
  await refreshState('pull_request', ctxFor(run2, octokit), LOCK, 'sigma/models');
  const lock = JSON.parse(readFileSync(join(run2, LOCK), 'utf8'));
  lock.views.B = entry({ dataModelId: 'b1', lastDeployedAt: '2026-10-22T11:00:00Z' });
  writeFileSync(join(run2, LOCK), JSON.stringify(lock, null, 2) + '\n');
  assert.equal((await writeBack('pull_request', [LOCK], ctxFor(run2, octokit))).ok, true);
  const state = JSON.parse(git(r.origin, 'show', `sigma-sync/state:${LOCK}`));
  assert.deepEqual(Object.keys(state.views).sort(), ['A', 'B']);
});

test('a corrupt state-branch lock is ignored with a warning', async () => {
  const r = repos();
  git(r.seed, 'checkout', '-q', '-b', 'sigma-sync/state');
  pushLock(r, '<<<<<<< HEAD\n', 'sigma-sync/state');
  const before = readFileSync(join(r.work, LOCK), 'utf8');
  const res = await refreshState('pull_request', ctxFor(r.work), LOCK, 'sigma/models');
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /sigma-sync\/state/);
  assert.equal(readFileSync(join(r.work, LOCK), 'utf8'), before);
});

test('refreshState in none mode does nothing', async () => {
  const r = repos();
  pushLock(r, lockWith({ A: {} }));
  const before = git(r.work, 'rev-parse', 'HEAD');
  assert.deepEqual((await refreshState('none', ctxFor(r.work), LOCK, 'sigma/models')).warnings, []);
  assert.equal(git(r.work, 'rev-parse', 'HEAD'), before);
});
