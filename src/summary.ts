/** The Markdown job summary for a run. */

import type { RunResult } from './run.js';

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderSummary(r: RunResult): string {
  const out: string[] = ['## Snowflake semantic views → Sigma', ''];
  if (r.offline) {
    out.push(
      '> Ran **offline** (no Sigma credentials, e.g. a fork pull request): views were converted and checked, but connection/folder names were not resolved, name clashes in the target folder were not checked, and lockfile data model IDs were not confirmed.',
      '',
    );
  }

  out.push('| View | Status | Sigma data model | Errors | Warnings |', '| --- | --- | --- | --- | --- |');
  for (const o of r.outcomes) {
    const errors = o.findings.filter(f => f.severity === 'error').length;
    const warnings = o.findings.length - errors;
    out.push(`| ${cell(o.key)} | ${o.status}${o.drift ? ' (drift)' : ''} | ${o.dataModelId ?? ''} | ${errors} | ${warnings} |`);
  }
  if (r.outcomes.length === 0) out.push('| _no semantic views found_ | | | | |');

  const refused = r.outcomes.filter(o => o.status === 'refused');
  if (refused.length > 0) {
    out.push('', '### Refused', '');
    for (const o of refused) {
      out.push(`**${o.key}**${o.error ? `: ${o.error}` : ''}`);
      for (const f of o.findings.filter(f => f.severity === 'error')) {
        out.push(`- \`${f.code}\` (${f.object.kind} ${f.object.name}): ${f.message}${f.remediation ? ` — ${f.remediation}` : ''}`);
      }
      out.push('');
    }
  }

  const failed = r.outcomes.filter(o => o.status === 'failed');
  if (failed.length > 0) {
    out.push('', '### Failed', '');
    for (const o of failed) {
      out.push(`**${o.key}**: ${o.error ?? 'unknown error'}`);
      for (const c of o.errorColumns ?? []) out.push(`- column \`${c.label}\` (element ${c.elementId}): \`${c.formula}\` did not resolve`);
      out.push('');
    }
  }

  const drifted = r.outcomes.filter(o => o.drift);
  if (drifted.length > 0) {
    out.push('', '### Drift', '', 'These data models were edited in Sigma since the last sync. The previous spec is in the `sigma-semantic-sync-state` artifact (`pre-update/`).', '');
    for (const o of drifted) out.push(`- ${o.key} (${o.dataModelId}): ${o.status === 'updated' || o.status === 'adopted' ? 'overwritten from git' : 'not changed by this run'}`);
  }

  if (r.orphans.length > 0) {
    out.push('', '### Orphaned', '', 'These views are no longer defined in the repo. Their Sigma data models were **never deleted**; delete them in Sigma if they are no longer needed.', '');
    for (const o of r.orphans) out.push(`- ${o.key}: ${o.dataModelId}`);
  }

  if (r.errors.length > 0) {
    out.push('', '### Errors', '');
    for (const e of r.errors) out.push(`- \`${e.path}\`: ${e.message}`);
  }

  if (r.warnings.length > 0) {
    out.push('', '### Warnings', '');
    for (const w of r.warnings) out.push(`- ${w}`);
  }

  if (r.writeBack && !r.writeBack.ok) {
    out.push(
      '', '### State was not saved', '',
      `Writing the lockfile back failed: ${r.writeBack.detail}. Sigma **was** updated. Commit the lockfile from the \`sigma-semantic-sync-state\` artifact, or record these IDs by hand:`, '',
      '| View | Sigma data model |', '| --- | --- |',
      ...Object.entries(r.lockAfter?.views ?? {}).map(([k, e]) => `| ${cell(k)} | ${e.dataModelId} |`),
    );
  }

  if (r.skipped.length > 0) out.push('', `<details><summary>${r.skipped.length} file(s) skipped (not semantic views)</summary>`, '', ...r.skipped.map(s => `- ${s}`), '', '</details>');
  return out.join('\n') + '\n';
}

/** One warning per drifted model, saying whether this run overwrote it. */
export function driftWarnings(r: RunResult): string[] {
  return r.outcomes
    .filter(o => o.drift)
    .map(o =>
      `${o.key}: data model ${o.dataModelId} was edited in Sigma since the last sync; ` +
      (o.status === 'updated' || o.status === 'adopted'
        ? 'overwritten from git (previous spec saved in the run artifact)'
        : 'it was not changed by this run (previous spec saved in the run artifact)'),
    );
}
