/** GitHub Action entry point. */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { parseInputs } from './inputs.js';
import { run } from './run.js';
import { SigmaClient } from './sigma/client.js';
import { renderSummary } from './summary.js';
import { refreshState, uploadStateArtifact, writeBack, type OctokitLike } from './writeback.js';

async function main(): Promise<void> {
  const cfg = parseInputs(name => core.getInput(name), { name: github.context.eventName });
  if (cfg.sigma) core.setSecret(cfg.sigma.clientSecret);
  const client = cfg.sigma ? new SigmaClient(cfg.sigma) : undefined;
  const octokit = cfg.commitMode === 'pull_request' && cfg.githubToken ? (github.getOctokit(cfg.githubToken).rest as unknown as OctokitLike) : undefined;

  const cwd = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const ref = (github.context.ref ?? '').replace(/^refs\/heads\//, '');
  const repo = process.env.GITHUB_REPOSITORY ? github.context.repo : { owner: '', repo: '' };
  const gitCtx = { cwd, ref, repo, token: cfg.githubToken, gitUserName: cfg.gitUserName, gitUserEmail: cfg.gitUserEmail, octokit };
  const result = await run(cfg, {
    cwd,
    client,
    writeBack,
    upload: (files, root) => uploadStateArtifact(files, root),
    ref,
    repo,
    refreshState: () => refreshState(cfg.commitMode, gitCtx, cfg.lockFile, cfg.specsDir),
    now: () => new Date().toISOString(),
    ...(process.env.RUNNER_TEMP && { tempDir: process.env.RUNNER_TEMP }),
    octokit,
  });

  const keys = (...statuses: string[]) => JSON.stringify(result.outcomes.filter(o => statuses.includes(o.status)).map(o => o.key));
  core.setOutput('created', keys('created'));
  core.setOutput('updated', keys('updated', 'adopted'));
  core.setOutput('refused', keys('refused'));
  core.setOutput('orphaned', JSON.stringify(result.orphans.map(o => o.key)));

  for (const o of result.outcomes.filter(o => o.drift)) core.warning(`${o.key}: data model ${o.dataModelId} was edited in Sigma since the last sync; overwritten from git (previous spec saved in the run artifact)`);
  for (const w of result.warnings) core.warning(w);
  await core.summary.addRaw(renderSummary(result)).write();

  if (result.exitCode === 1) {
    const n = (s: string) => result.outcomes.filter(o => o.status === s).length;
    core.setFailed(`sync finished with ${n('failed')} failed, ${n('refused')} refused view(s), ${result.errors.length} error(s)${result.writeBack?.ok === false ? ', state not saved' : ''}; see the job summary`);
  }
}

main().catch(e => core.setFailed(e instanceof Error ? e.message : String(e)));
