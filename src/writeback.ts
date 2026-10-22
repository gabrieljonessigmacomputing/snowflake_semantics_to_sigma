/**
 * Folds a run's outcomes into the lock, saves the specs Sigma returned, and
 * writes that state back to the repo (push, bot PR, or nothing).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getExecOutput } from '@actions/exec';
import { stringify as toYaml } from 'yaml';
import type { ViewSource } from './discover.js';
import type { ViewOutcome } from './execute.js';
import { keyFileName } from './identity.js';
import type { Lock } from './lock.js';

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
    if ((o.status === 'created' || o.status === 'updated' || o.status === 'adopted') && o.dataModelId && o.specSha256) {
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
