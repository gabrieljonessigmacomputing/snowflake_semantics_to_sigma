/** Action inputs → a validated run configuration. */

import { canonicalSha256 } from './lock.js';
import type { SigmaCredentials } from './sigma/client.js';

export interface Config {
  /** undefined when the client id / secret / base URL are not all set (offline dry run). */
  sigma?: SigmaCredentials;
  connection: { id?: string; name?: string };
  folder: { id?: string; name?: string };
  paths: string;
  database?: string;
  schema?: string;
  mode: 'auto' | 'all';
  dryRun: boolean;
  bestEffort: boolean;
  failOnRefused: boolean;
  lockFile: string;
  saveSpecs: boolean;
  specsDir: string;
  commitMode: 'push' | 'pull_request' | 'none';
  adoptExisting: boolean;
  modelNameTemplate: string;
  columnTypesFile?: string;
  gitUserName: string;
  gitUserEmail: string;
  githubToken?: string;
}

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);

export function parseInputs(get: (name: string) => string, event: { name: string }): Config {
  const str = (name: string) => get(name).trim() || undefined;
  const bool = (name: string, fallback: boolean) => {
    const v = get(name).trim().toLowerCase();
    if (v === '') return fallback;
    if (v === 'true') return true;
    if (v === 'false') return false;
    throw new Error(`input ${name} must be true or false, got "${get(name)}"`);
  };
  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const v = get(name).trim();
    if (v === '') return fallback;
    if ((allowed as readonly string[]).includes(v)) return v as T;
    throw new Error(`input ${name} must be one of ${allowed.join(', ')}, got "${v}"`);
  };
  const exactlyOne = (a: string, b: string, required: boolean) => {
    const pair = { ...(str(a) && { id: str(a) }), ...(str(b) && { name: str(b) }) };
    const count = Object.keys(pair).length;
    if (count === 2 || (count === 0 && required)) throw new Error(`set exactly one of ${a} or ${b}`);
    return pair;
  };

  const dryRun = bool('dry_run', PR_EVENTS.has(event.name));
  const baseUrl = str('sigma_base_url');
  const clientId = str('sigma_client_id');
  const clientSecret = str('sigma_client_secret');
  const sigma = baseUrl && clientId && clientSecret ? { baseUrl, clientId, clientSecret } : undefined;
  if (!dryRun && !sigma) throw new Error('sigma_client_id, sigma_client_secret and sigma_base_url are required unless dry_run is true');

  return {
    sigma,
    connection: exactlyOne('connection_id', 'connection_name', !dryRun),
    folder: exactlyOne('folder_id', 'folder_name', !dryRun),
    paths: str('paths') ?? '**/*.{yml,yaml,sql}',
    database: str('database'),
    schema: str('schema'),
    mode: oneOf('mode', ['auto', 'all'] as const, event.name === 'workflow_dispatch' ? 'all' : 'auto'),
    dryRun,
    bestEffort: bool('best_effort', false),
    failOnRefused: bool('fail_on_refused', true),
    lockFile: str('lock_file') ?? 'sigma/semantic-views.lock.json',
    saveSpecs: bool('save_specs', true),
    specsDir: str('specs_dir') ?? 'sigma/models',
    commitMode: oneOf('commit_mode', ['push', 'pull_request', 'none'] as const, 'push'),
    adoptExisting: bool('adopt_existing', false),
    modelNameTemplate: str('model_name_template') ?? '{view}',
    columnTypesFile: str('column_types_file'),
    gitUserName: str('git_user_name') ?? 'github-actions[bot]',
    gitUserEmail: str('git_user_email') ?? '41898282+github-actions[bot]@users.noreply.github.com',
    githubToken: str('github_token'),
  };
}

/** Hash of the inputs that change conversion output; uses the raw connection input, never the resolved id. */
export function optionsSha256(cfg: Config, columnTypes?: unknown): string {
  return canonicalSha256({
    connection: cfg.connection,
    database: cfg.database ?? null,
    schema: cfg.schema ?? null,
    bestEffort: cfg.bestEffort,
    columnTypes: columnTypes ?? null,
  });
}
