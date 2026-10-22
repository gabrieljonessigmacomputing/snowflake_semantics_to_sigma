# Snowflake Semantic Views → Sigma

A GitHub Action that keeps one **Sigma data model** in sync with each
**Snowflake semantic view** in your repo. Views can be native YAML or
`CREATE SEMANTIC VIEW` DDL. On every push it converts the views that changed and
creates or updates their Sigma data models through the Sigma REST API. It then
commits a lockfile that records which data model belongs to which view.

It is the Snowflake counterpart of
[`dbt_semantics_to_sigma`](https://github.com/sigmacomputing/dbt_semantics_to_sigma).

## The conversion contract

Conversion uses the semantic-view converter in [`converter/`](converter)
(pinned as `semantic-view-converter@4860ebc`; see [Engine](#engine)). It does
not call Sigma or Snowflake, and it does not read credentials.

- Column formulas use the physical warehouse name (`[LINEITEM/L_QUANTITY]`).
- Relationships point at the real key column.
- `NON ADDITIVE BY (date asc)` becomes `Sum(If([As of Date] = Max([As of Date]), [Measure]))`. `desc` uses `Min`.
- `CURRENT_TIMESTAMP()` becomes `Now()`. `DATEDIFF` becomes `DateDiff`. `IS NULL` / `IS NOT NULL` become `IsNull` / `IsNotNull`.
- A metric pinned with `USING` is translated and reported. Sigma has no join-path selector.
- Metrics come from the semantic view. Facts stay columns.
- Table synonyms go in the description (`Also called:`), not the element name.
- AI instructions and verified questions are reported in the job summary. Sigma's API cannot store them on the model.

A view is **refused**, and never deployed, when the source cannot be parsed, a
table path is missing its database or schema, or an expression cannot be
translated. `best_effort` is accepted so existing workflows keep parsing. It
does not change the spec. The job summary lists each finding.

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
- uses: gabrieljonessigmacomputing/snowflake_semantics_to_sigma@v1
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

## Versions and pinning

| Reference | What you get |
|---|---|
| `@v1` | The latest 1.x release. The `v1` tag moves forward with each release, and nothing within v1 breaks your workflow. |
| `@v1.0.0` | That exact release. |
| `@<full commit SHA>` | Exactly that code, and nothing can change it. **Recommended for security-conscious teams.** |

A tag can be moved and a commit SHA can't, so pinning to a SHA is the only way
to guarantee the code you reviewed is the code that runs. Keep the version in a
comment so people can tell what's pinned:

```yaml
- uses: gabrieljonessigmacomputing/snowflake_semantics_to_sigma@<full-40-character-sha> # v1.0.0
```

Look up a release's commit SHA on the
[releases page](https://github.com/gabrieljonessigmacomputing/snowflake_semantics_to_sigma/releases), or with:

```bash
gh api repos/gabrieljonessigmacomputing/snowflake_semantics_to_sigma/commits/v1.0.0 -q .sha
```

To keep a SHA pin current, let Dependabot propose updates. It rewrites the SHA
and the version comment together:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

There's no need to fork this repo to control updates: a SHA pin does that.
Forks don't inherit any secrets, and their scheduled workflows stay off until
you enable them.

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
| `best_effort` | `false` | Accepted for existing workflows. Semi-additive metrics and `USING` pins are already translated, so this flag does not change the spec. |
| `fail_on_refused` | `true` | Fail the run when any view is refused. |
| `lock_file` | `sigma/semantic-views.lock.json` | The state file. |
| `save_specs` / `specs_dir` | `true` / `sigma/models` | Save the spec Sigma returns for each deployed model (reviewable diffs). |
| `commit_mode` | `push` | `push`, `pull_request` (bot PR, for protected branches) or `none`. |
| `adopt_existing` | `false` | Take over a same-named model the lockfile doesn't track. |
| `model_name_template` | `{view}` | Sigma model name. Placeholders `{database}`, `{schema}`, `{view}`. |
| `column_types_file` | — | JSON `{ "DB.SCHEMA.TABLE": { "COLUMN": "TYPE" } }` used to spell physical columns and infer number formats. |
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

`converter/` is the semantic-view converter. `src/convert.ts` calls it with
`python3` (already on GitHub-hosted runners) and passes the connection id on
stdin. The lockfile records `semantic-view-converter@4860ebc`, so the first run
of this action reconverts every view.

`vendor/semantic-tools/` remains in the tree under its Apache-2.0 license. The
action does not call it.

```bash
npm test && npm run build        # commit converter/ and dist/
```

## Development

```bash
npm ci
npm test            # offline: unit, golden-parity and orchestration tests
npm run typecheck
npm run build       # dist/index.js — commit it; CI fails on a stale dist/
```

`test/golden/` locks this converter's output for every fixture. Regenerate it
with `node --import tsx/esm scripts/refresh-goldens.mjs`.
The `e2e` workflow runs against a real Sigma org on demand and weekly. It is not
a required check. Without Sigma secrets it skips itself, as it does on forks
and on this public repo.

### Releasing

Versions follow [semver](https://semver.org). The major tag (`v1`) always points
at the latest release with that major version.

```bash
# on main, with package.json "version" bumped and dist/ rebuilt and merged
git tag -a v1.2.3 -m "v1.2.3"
git tag -f v1 v1.2.3
git push origin v1.2.3
git push -f origin v1
gh release create v1.2.3 --title v1.2.3 --notes "..."
```

A breaking change, such as a renamed or removed input or a lockfile change that
existing repos can't read, gets a new major version (`v2`). `v1` stays where it was.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
