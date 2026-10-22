# Snowflake Semantic Views → Sigma

A GitHub Action that keeps one **Sigma data model** in sync with each
**Snowflake semantic view** in your repo. Views can be native YAML or
`CREATE SEMANTIC VIEW` DDL. On every push it converts the views that changed and
creates or updates their Sigma data models through the Sigma REST API. It then
commits a lockfile that records which data model belongs to which view.

It is the Snowflake counterpart of
[`dbt_semantics_to_sigma`](https://github.com/sigmacomputing/dbt_semantics_to_sigma).

## The conversion contract

Conversion uses the [semantic-tools](https://github.com/sigmacomputing/semantic-tools)
engine (vendored, pinned; see [Engine](#engine)). It follows one rule: **every
object it emits means exactly what the source meant, or it is not emitted.**

If a view contains something Sigma would answer differently, the view is
**refused** and never deployed half-right. Examples: a semi-additive metric, an
ASOF or range join, a metric pinned to a join path with `USING`. The job summary
lists each finding with a remediation. `best_effort: true` converts such views
anyway and reports the differences.

After each deploy the action reads the data model's columns back. If any column
did not resolve (type `error`), or the check could not run, it treats the deploy
as failed:

- A new model is deleted.
- An updated model is rolled back to its previous spec.

**Updates keep Sigma's IDs.** Sigma assigns its own IDs to every element and
column when a model is created, and workbooks reference those IDs. Before each
update, the action pairs the new spec's objects with the live ones and reuses
the live IDs, so dashboards built on the model keep working:

- elements by what they read, then by name
- columns by formula
- metrics by name, then by formula
- relationships by name

Only genuinely new objects get new IDs.

## Quick start

1. Create a Sigma API client (Administration → Developer Access). Store its id
   and secret as repository secrets `SIGMA_CLIENT_ID` and `SIGMA_CLIENT_SECRET`.
2. Add repository variables:
   - `SIGMA_BASE_URL`: your [API host](https://help.sigmacomputing.com/reference/get-started-sigma-api)
   - `SIGMA_CONNECTION_ID`: the Snowflake connection the models read from
   - `SIGMA_FOLDER_ID`: where new models go
3. Add [`examples/sync.yml`](examples/sync.yml) as `.github/workflows/sigma-semantic-sync.yml`.
   Optionally add [`examples/pr-check.yml`](examples/pr-check.yml) for a dry run on pull requests.

```yaml
- uses: actions/checkout@v4
- uses: sigmacomputing/snowflake_semantics_to_sigma@v1
  with:
    sigma_base_url: ${{ vars.SIGMA_BASE_URL }}
    sigma_client_id: ${{ secrets.SIGMA_CLIENT_ID }}
    sigma_client_secret: ${{ secrets.SIGMA_CLIENT_SECRET }}
    connection_id: ${{ vars.SIGMA_CONNECTION_ID }}
    folder_id: ${{ vars.SIGMA_FOLDER_ID }}
    paths: semantic_views/**/*.{yaml,yml,sql}
    database: ANALYTICS
    schema: SEMANTIC
```

The job needs `permissions: contents: write` to commit the lockfile. Use the
`concurrency` group from the example so two syncs never race.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `sigma_base_url` | — | Sigma API host. Required unless `dry_run`. |
| `sigma_client_id` / `sigma_client_secret` | — | OAuth client credentials (secrets). Required unless `dry_run`. |
| `connection_id` or `connection_name` | — | Sigma connection the models read from (exactly one). |
| `folder_id` or `folder_name` | — | Folder new models are created in (exactly one). |
| `paths` | `**/*.{yml,yaml,sql}` | Glob(s), one per line. Files that aren't semantic views are skipped. A file counts as one when it has a `CREATE SEMANTIC VIEW` statement outside comments, or is YAML with a top-level `name` and a `tables` list. `.github/`, `node_modules/`, the lockfile and `specs_dir` are always excluded. |
| `database` / `schema` | — | The views' database/schema (YAML has no qualifier), and the default for table references with fewer than 3 / 2 parts. |
| `mode` | `auto` (`all` on `workflow_dispatch`) | `auto`: views whose file, engine version or options changed. `all`: every view. |
| `dry_run` | `true` on pull requests | Convert and report only. Writes nothing to Sigma or the repo. |
| `best_effort` | `false` | Convert constructs that would otherwise be refused. |
| `fail_on_refused` | `true` | Fail the run when any view is refused. |
| `lock_file` | `sigma/semantic-views.lock.json` | The state file. |
| `save_specs` / `specs_dir` | `true` / `sigma/models` | Save the spec Sigma returns for each deployed model (reviewable diffs). |
| `commit_mode` | `push` | `push`, `pull_request` (bot PR, for protected branches) or `none`. |
| `adopt_existing` | `false` | Take over a same-named model the lockfile doesn't track. |
| `model_name_template` | `{view}` | Sigma model name. Placeholders `{database}`, `{schema}`, `{view}`. |
| `column_types_file` | — | JSON `{ "DB.SCHEMA.TABLE": { "COLUMN": "TYPE" } }` for the engine's time-zone checks. |
| `git_user_name` / `git_user_email` | `github-actions[bot]` | Author of state commits. |
| `github_token` | `${{ github.token }}` | Used by `commit_mode: pull_request`. |

**Outputs:** `created`, `updated` (includes adopted), `refused` and `orphaned`.
Each is a JSON array of view keys.

## How views are tracked

- **Identity.** A view is keyed by `DB.SCHEMA.VIEW`:
  - DDL: the name in `CREATE SEMANTIC VIEW`, with missing parts filled from `database` / `schema`.
  - YAML: the YAML `name`, with the `database` / `schema` inputs as its qualifiers.
  - Unquoted parts are upper-cased, as Snowflake does.
  - Moving or renaming a file keeps the same Sigma model. Renaming the *view* creates a new one, and the old one is reported as orphaned.
- **Model names.** By default a model is named after the bare view name. If
  two views would get the same name, both fail before anything deploys. Set
  `model_name_template: "{schema}.{view}"` to fix it. Changing the template
  later does not rename existing models.
- **Lockfile.** The lockfile maps each key to its data model id. It also
  stores hashes of the source file, the conversion options and the engine
  version. A view is reprocessed when any of these change, so upgrading the
  action reconverts every view once.
- **Existing models.** A model in the target folder with the same name, but
  not in the lockfile, is **not** overwritten. The view is refused unless
  `adopt_existing: true`, which is meant for recovering a lost lockfile. Two or
  more same-named models are always refused.
  - Sigma's folder listing shows a new model only about 5–6 seconds after it is created.
  - A run that has lost its lockfile and starts within those seconds of the
    model's creation can't see it, and creates a second one.
  - Normal syncs are unaffected, because they track models through the lockfile.
- **Drift.** Git is the source of truth for models in the lockfile. If someone
  edited one in Sigma, the next update overwrites it, flags the drift as a
  warning, and saves the previous spec in the run's `sigma-semantic-sync-state`
  artifact.
- **Deleted views.** Nothing is ever deleted in Sigma. A view removed from the
  repo is marked `orphaned` and listed in the summary with its id, so a person
  can delete it.
- **Deleted models.** If you delete a tracked model in Sigma, run the workflow
  manually (`mode: all`). The view is recreated with a warning.
- **Latest state first.** Before reading the lockfile, the action fetches the
  branch tip and fast-forwards to it. This unshallows `actions/checkout`'s
  depth-1 clone. A second push made while the first sync was still running
  therefore sees the first sync's lockfile.
- **Protected branches.** If the push fails, the run fails, because Sigma was
  already updated. The lockfile goes into the run artifact, and the summary
  lists every id. Use `commit_mode: pull_request` to get a `sigma-sync/state`
  PR instead (needs `pull-requests: write`).
  - Until that PR is merged, each run overlays the PR branch's lockfile, so nothing it records is lost.
  - A PR opened with the default `GITHUB_TOKEN` does not trigger other workflows. If the branch has required checks, pass a PAT or GitHub App token as `github_token`.
- **Files that stop parsing.** If a file that defined a tracked view stops
  reading as a semantic view, or defines a view twice, the run fails with an
  error. Its view is not marked orphaned.
- **Fork pull requests** get no secrets. The dry run then works offline: it
  converts the views and reports findings, and says which Sigma checks it
  skipped.

## Engine

`vendor/semantic-tools/` is a byte-for-byte copy of the bundle built from
`sigmacomputing/semantic-tools` at the commit in `semantic-tools-embed/PIN`
(see `PROVENANCE.json`). It is the same bundle and adapter that
[`sigma-data-model-mcp`](https://github.com/twells89/sigma-data-model-mcp) ships.

To bump it, you need read access to semantic-tools:

```bash
echo <new-commit> > semantic-tools-embed/PIN
npm run build:semantic-tools     # clones into .cache/, rebuilds vendor/
npm run check:semantic-tools     # upstream goldens + provenance gates
npm test && npm run build        # commit vendor/ and dist/
```

## Development

```bash
npm ci
npm test            # offline: unit, golden-parity and orchestration tests
npm run typecheck
npm run build       # dist/index.js — commit it; CI fails on a stale dist/
```

`test/golden/` holds the MCP converter's output for every fixture. It is
regenerated with `node scripts/make-goldens.mjs <built sigma-data-model-mcp checkout>`.
The `e2e` workflow runs against a real Sigma org on demand and weekly. It is not
a required check.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
