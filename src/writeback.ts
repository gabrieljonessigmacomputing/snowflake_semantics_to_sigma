/**
 * Folds a run's outcomes into the lock, saves the specs Sigma returned, and
 * writes that state back to the repo (push, bot PR, or nothing).
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecOutput } from '@actions/exec';
import { stringify as toYaml } from 'yaml';
import type { ViewSource } from './discover.js';
import type { ViewOutcome } from './execute.js';
import { keyFileName } from './identity.js';
import { canonicalSha256, readLock, writeLock, type Lock } from './lock.js';

export const COMMIT_MESSAGE = 'chore(sigma): sync semantic views [skip ci]';
export const STATE_BRANCH = 'sigma-sync/state';
export const STATE_PR_TITLE = 'Sigma semantic view sync state';
export const ARTIFACT_NAME = 'sigma-semantic-sync-state';

export interface OctokitLike {
  pulls: {
    list(params: { owner: string; repo: string; head: string; base?: string; state: 'open' }): Promise<{ data: unknown[] }>;
    create(params: { owner: string; repo: string; head: string; base: string; title: string; body: string }): Promise<unknown>;
  };
}

export interface ArtifactUploader {
  uploadArtifact(name: string, files: string[], rootDirectory: string, options?: Record<string, unknown>): Promise<unknown>;
}

export interface WriteBackContext {
  cwd: string;
  /** Branch the run is on (e.g. `main`). */
  ref: string;
  repo: { owner: string; repo: string };
  token?: string;
  gitUserName: string;
  gitUserEmail: string;
  octokit?: OctokitLike;
}

export function applyOutcomes(
  lock: Lock,
  outcomes: ViewOutcome[],
  views: ViewSource[],
  ctx: { engineCommit: string; optionsSha256: string; now: string },
  orphans: string[],
): Lock {
  const next: Lock = { version: 1, views: structuredClone(lock.views) };
  const byKey = new Map(views.map(v => [v.key, v]));
  for (const o of outcomes) {
    const v = byKey.get(o.key);
    if (!v) continue;
    if ((o.status === 'created' || o.status === 'updated' || o.status === 'adopted') && o.dataModelId && o.specSha256 !== undefined) {
      next.views[o.key] = {
        dataModelId: o.dataModelId,
        modelName: o.modelName,
        sourcePath: v.path,
        sourceSha256: v.fileSha256,
        optionsSha256: ctx.optionsSha256,
        engineCommit: ctx.engineCommit,
        specSha256: o.specSha256,
        lastDeployedAt: ctx.now,
        orphaned: false,
      };
    } else if (o.status === 'failed' && o.keepInLock && o.dataModelId) {
      // Still ours: keep the id, and blank the hashes so the next run reprocesses the view.
      const prev = next.views[o.key];
      next.views[o.key] = {
        dataModelId: o.dataModelId,
        modelName: prev?.modelName ?? o.modelName,
        sourcePath: v.path,
        sourceSha256: '',
        optionsSha256: prev?.optionsSha256 ?? ctx.optionsSha256,
        engineCommit: prev?.engineCommit ?? ctx.engineCommit,
        specSha256: '',
        lastDeployedAt: ctx.now,
        orphaned: false,
      };
    } else if (o.status === 'unchanged' && next.views[o.key]) {
      next.views[o.key] = { ...next.views[o.key], sourcePath: v.path, orphaned: false };
    }
  }
  for (const key of orphans) if (next.views[key]) next.views[key] = { ...next.views[key], orphaned: true };
  return next;
}

export function saveSpecs(outcomes: ViewOutcome[], specsDir: string): string[] {
  const written: string[] = [];
  for (const o of outcomes) {
    if (!o.getBackSpec) continue;
    mkdirSync(specsDir, { recursive: true });
    const path = join(specsDir, `${keyFileName(o.key)}.yml`);
    writeFileSync(path, toYaml(o.getBackSpec));
    written.push(path);
  }
  return written;
}

async function gitRun(ctx: WriteBackContext, ...args: string[]) {
  const ident = ['-c', `user.name=${ctx.gitUserName}`, '-c', `user.email=${ctx.gitUserEmail}`, '-c', 'commit.gpgsign=false'];
  return getExecOutput('git', [...ident, ...args], { cwd: ctx.cwd, ignoreReturnCode: true, silent: true });
}

/** Stages `paths` and commits; false when there was nothing to commit. */
async function commit(ctx: WriteBackContext, paths: string[]): Promise<boolean> {
  const add = await gitRun(ctx, 'add', '--', ...paths);
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const staged = await gitRun(ctx, 'diff', '--cached', '--quiet');
  if (staged.exitCode === 0) return false;
  const c = await gitRun(ctx, 'commit', '-q', '-m', COMMIT_MESSAGE);
  if (c.exitCode !== 0) throw new Error(`git commit failed: ${c.stderr.trim()}`);
  return true;
}

async function pushWithRetry(ctx: WriteBackContext): Promise<{ ok: boolean; detail: string }> {
  const first = await gitRun(ctx, 'push', 'origin', `HEAD:${ctx.ref}`);
  if (first.exitCode === 0) return { ok: true, detail: `pushed state to ${ctx.ref}` };
  const pull = await gitRun(ctx, 'pull', '--rebase', 'origin', ctx.ref);
  if (pull.exitCode !== 0) {
    await gitRun(ctx, 'rebase', '--abort');
    return { ok: false, detail: `push to ${ctx.ref} was rejected and rebasing onto it failed: ${(pull.stderr || pull.stdout).trim()}` };
  }
  const second = await gitRun(ctx, 'push', 'origin', `HEAD:${ctx.ref}`);
  if (second.exitCode === 0) return { ok: true, detail: `pushed state to ${ctx.ref} after rebasing` };
  return { ok: false, detail: `push to ${ctx.ref} failed: ${second.stderr.trim()}` };
}

async function openStatePr(ctx: WriteBackContext, paths: string[]): Promise<{ ok: boolean; detail: string }> {
  if (!ctx.octokit) return { ok: false, detail: 'commit_mode pull_request needs a github_token' };
  const original = (await gitRun(ctx, 'symbolic-ref', '--short', '-q', 'HEAD')).stdout.trim() || (await gitRun(ctx, 'rev-parse', 'HEAD')).stdout.trim();
  const co = await gitRun(ctx, 'checkout', '-q', '-B', STATE_BRANCH);
  if (co.exitCode !== 0) return { ok: false, detail: `could not create ${STATE_BRANCH}: ${co.stderr.trim()}` };
  try {
    if (!(await commit(ctx, paths))) return { ok: true, detail: 'no state changes to propose' };
    const push = await gitRun(ctx, 'push', '--force', 'origin', STATE_BRANCH);
    if (push.exitCode !== 0) return { ok: false, detail: `push of ${STATE_BRANCH} failed: ${push.stderr.trim()}` };
    const { owner, repo } = ctx.repo;
    const open = await ctx.octokit.pulls.list({ owner, repo, head: `${owner}:${STATE_BRANCH}`, base: ctx.ref, state: 'open' });
    if (open.data.length > 0) return { ok: true, detail: `updated the open ${STATE_BRANCH} pull request` };
    await ctx.octokit.pulls.create({
      owner,
      repo,
      head: STATE_BRANCH,
      base: ctx.ref,
      title: STATE_PR_TITLE,
      body: 'Lockfile and data model specs written by snowflake_semantics_to_sigma. Merge to record which Sigma data model each semantic view owns.',
    });
    return { ok: true, detail: `opened a ${STATE_BRANCH} pull request into ${ctx.ref}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    await gitRun(ctx, 'checkout', '-q', '-f', original);
  }
}

export async function writeBack(
  mode: 'push' | 'pull_request' | 'none',
  paths: string[],
  ctx: WriteBackContext,
): Promise<{ ok: boolean; detail: string }> {
  if (mode === 'none' || paths.length === 0) return { ok: true, detail: 'state write-back disabled' };
  if (mode === 'pull_request') return openStatePr(ctx, paths);
  try {
    if (!(await commit(ctx, paths))) return { ok: true, detail: 'no state changes to commit' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  return pushWithRetry(ctx);
}

export async function uploadStateArtifact(files: string[], rootDir: string, upload?: ArtifactUploader): Promise<void> {
  const client = upload ?? new (await import('@actions/artifact')).DefaultArtifactClient();
  await client.uploadArtifact(ARTIFACT_NAME, files, rootDir, { retentionDays: 30 });
}

/** Per key, the entry deployed most recently wins. */
function mergeLocks(base: Lock, overlay: Lock): { lock: Lock; won: string[] } {
  const views = { ...base.views };
  const won: string[] = [];
  for (const [key, e] of Object.entries(overlay.views)) {
    const mine = views[key];
    if (!mine || e.lastDeployedAt > mine.lastDeployedAt) {
      views[key] = e;
      won.push(key);
    }
  }
  return { lock: { version: 1, views }, won };
}

/**
 * Brings the checkout's state up to date before the lock is read, so a run never
 * works from a stale lock: in push mode the branch is fast-forwarded to its
 * remote tip (a quick second push checks out a commit without the first run's
 * state commit); in pull_request mode the unmerged state branch's lock and specs
 * are overlaid (main never has them until the state PR is merged).
 */
export async function refreshState(
  mode: 'push' | 'pull_request' | 'none',
  ctx: WriteBackContext,
  lockFile: string,
  specsDir: string,
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  if (mode === 'none') return { warnings };
  const shallow = (await gitRun(ctx, 'rev-parse', '--is-shallow-repository')).stdout.trim() === 'true';

  if (mode === 'push') {
    const fetch = await gitRun(ctx, 'fetch', '-q', '--no-tags', ...(shallow ? ['--unshallow'] : []), 'origin', ctx.ref);
    if (fetch.exitCode !== 0) return { warnings: [`could not fetch ${ctx.ref} to refresh state: ${fetch.stderr.trim()}`] };
    if ((await gitRun(ctx, 'merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD')).exitCode !== 0) {
      return { warnings: [`${ctx.ref} has diverged from this checkout; using the checked-out lockfile`] };
    }
    const ff = await gitRun(ctx, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
    if (ff.exitCode !== 0) warnings.push(`could not fast-forward to the tip of ${ctx.ref}: ${ff.stderr.trim()}`);
    return { warnings };
  }

  // pull_request: history is needed later only for the state branch push, not for a rebase.
  const fetch = await gitRun(ctx, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', STATE_BRANCH);
  if (fetch.exitCode !== 0) return { warnings }; // no open state branch yet
  const shown = await gitRun(ctx, 'show', `FETCH_HEAD:${lockFile}`);
  if (shown.exitCode !== 0) return { warnings };
  const tmp = join(mkdtempSync(join(tmpdir(), 'sigma-state-')), 'lock.json');
  writeFileSync(tmp, shown.stdout);
  let stateLock: Lock;
  try {
    stateLock = readLock(tmp);
  } catch (e) {
    return { warnings: [`ignoring the lockfile on ${STATE_BRANCH}: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const lockPath = join(ctx.cwd, lockFile);
  const current = readLock(lockPath);
  const { lock, won } = mergeLocks(current, stateLock);
  if (canonicalSha256(lock) !== canonicalSha256(current) || !existsSync(lockPath)) writeLock(lockPath, lock);
  for (const key of won) await gitRun(ctx, 'checkout', 'FETCH_HEAD', '--', `${specsDir}/${keyFileName(key)}.yml`);
  return { warnings };
}
