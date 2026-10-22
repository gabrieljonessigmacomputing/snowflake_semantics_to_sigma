# Snowflake Semantic Views → Sigma: GitHub Action — Design

Date: 2026-10-22 · Status: draft for review

## Intent

Customers who keep Snowflake semantic views in git (as native YAML or
`CREATE SEMANTIC VIEW` DDL files) get Sigma data models that stay in sync with
those files automatically. A push to the semantic-view repo updates the matching
Sigma data models. Nobody has to hand-convert anything or remember which Sigma
model belongs to which view.

This is the Snowflake counterpart of
[`sigmacomputing/dbt_semantics_to_sigma`](https://github.com/sigmacomputing/dbt_semantics_to_sigma),
and it is published the same way: a **standalone GitHub Action on the
Marketplace that customers drop into their own repos** (the user decided this).

The conversion logic already exists and is field-proven: the Snowflake
converter in [`twells89/sigma-data-model-mcp`](https://github.com/twells89/sigma-data-model-mcp)
(`src/snowflake.ts`), which wraps a pinned, vendored build of the
`sigmacomputing/semantic-tools` engine (`vendor/semantic-tools/`). This project
is mostly the CI/sync layer around that engine.

## Goals

1. On push to the default branch, convert every changed semantic-view file and
   create or update the matching Sigma data model through the Sigma REST API
   (`POST /v2/dataModels/spec`, `PUT /v2/dataModels/{id}/spec`).
2. Re-running is idempotent. The same view always updates the same Sigma data
   model and never creates a duplicate.
3. Accept both source formats, YAML and DDL. Accept several views per file
   (a DDL file with several `CREATE SEMANTIC VIEW` statements).
4. Keep the engine's correctness contract. A view containing constructs Sigma
   would answer differently (e.g. `SEMI_ADDITIVE_METRIC`, `ASOF_RELATIONSHIP`)
   is **refused** and reported with the engine's findings and remediation. It is
   never deployed half-right.
5. On pull requests, do a dry run: convert, report findings in the job summary,
   write nothing to Sigma.
6. Setup is a short workflow file plus secrets. There is no copied folder
   and no `MODE` variable to flip after the first run (both are dbt-action
   pain points).

## Non-goals (v1)

- Reading semantic views live from Snowflake (`GET_DDL`) or needing Snowflake
  credentials at all. v1 reads files in the repo only. (Live read is a candidate for v2.)
- Converting workbooks, dashboards, or anything other than data models.
- dbt semantic models. The existing action covers those.
- Cross-model relationships or dependency ordering. A Snowflake semantic view is
  self-contained (it carries its own tables and relationships), so one view maps
  to one Sigma data model and the dbt action's DAG/layer machinery is not needed.
- Deleting anything in Sigma.

## Anti-goals (failure even if it "works")

- A deployed data model whose metrics return different numbers than Snowflake.
- Duplicate data models piling up in the customer's folder across runs.
- The action destroying or overwriting customer content it does not own.
- A green run whose specs Sigma accepted but whose columns don't resolve
  (Sigma accepts structurally valid specs whose formulas fail at query time).
  The MCP repo learned this the hard way.

## Constraints

- Ships as a public repo, so the vendored engine bundle becomes public. The
  `semantic-tools` repo is INTERNAL, but its Apache-2.0 bundle is already shipped
  publicly in `twells89/sigma-data-model-mcp` (`vendor/semantic-tools/` with
  `LICENSE`, `NOTICE`, `PROVENANCE.json`). Same precedent, same files.
- Org policy: never use a non-`@sigmacomputing/*` package version released within
  the last 3 days.
- Sigma auth in CI is OAuth client credentials (`POST /v2/auth/token`). Tokens
  last about 1 hour.
- Sigma spec rules already baked into the engine and adapter must hold
  (`schemaVersion: 1`, relationship naming, `[Custom SQL/<COL>]` forms, etc. —
  see the MCP repo's `CLAUDE.md`). The action must not post-process specs in
  ways that break them.

## Decisions (made in the design conversation)

**Packaging (my call).** A real JavaScript action: `action.yml` at the repo root
with `runs.using: node24` and a single bundled `dist/index.js` (committed, as
JavaScript actions require). Customers write
`uses: <org>/snowflake_semantics_to_sigma@v1`. This replaces the dbt action's
"copy the `sigma_converter` folder into your repo" model. The README ships a
copy-paste example workflow.

**Language (my call).** TypeScript, bundled. This matches the MCP adapter
being ported.

**Engine (my call).** Vendor `vendor/semantic-tools/` from the MCP repo as-is
(the pinned `semantic-tools-embed.mjs` + `.d.mts` + `PROVENANCE.json` + license
files), and port `src/snowflake.ts` (the adapter: defaults like
`crossTableReferences: 'derived'`, `usingPaths: 'bound'`, synonyms in
descriptions, naming the model after the view). Don't shell out to the
semantic-tools CLI. It is unpublished and pre-1.0, and the MCP adapter adds
behavior verified against live Sigma. Bring the MCP repo's
`scripts/build-semantic-tools.mjs` / check script along so the pin can be bumped
the same way.

**View identity (my call).** A view is keyed by its fully qualified name
`DB.SCHEMA.VIEW`. The key is not the file path. The vendored engine only
returns the bare view name (`ir.name.parts.at(-1)`), so the action derives the
qualifiers itself and leaves the engine untouched:

- DDL: a thin pre-parse of each `CREATE [OR REPLACE] SEMANTIC VIEW [IF NOT EXISTS] <name>`
  statement reads the qualifiers. Missing parts are filled from the
  `database`/`schema` inputs.
- YAML: no qualifier exists in the file, so the key uses the
  `database`/`schema` inputs (documented as "home of the views and default for
  unqualified table refs").
- Parts still missing are left out of the key (e.g. `RETAIL_SV`), which is fine
  for a single-schema repo.

Moving or renaming a file keeps the same Sigma data model. Renaming the view
itself makes a new data model, and the old one is reported as orphaned.

The Sigma model name comes from `model_name_template`, default `{view}` (the
bare name, matching the MCP adapter). If two keys in one run would produce the
same model name, both views fail before anything deploys, with a message to set
`model_name_template: "{schema}.{view}"`.

**State (my call).** A committed lockfile, default `sigma/semantic-views.lock.json`:

```json
{
  "version": 1,
  "views": {
    "DB.SCHEMA.RETAIL_SV": {
      "dataModelId": "…",
      "sourcePath": "semantic_views/retail.yaml",
      "sourceSha256": "…",
      "engineCommit": "360eb6af…",
      "lastDeployedAt": "2026-10-22T…Z",
      "orphaned": false
    }
  }
}
```

Each lock entry also stores `specSha256`, a hash of the normalized GET-back
spec, which is used for drift detection (below).

Optionally (`save_specs`, default `true`) the spec Sigma returns from GET is
saved as `sigma/models/<VIEW>.yml`, as the dbt action does. That gives
reviewers a readable diff of what changed in Sigma.

**Writing state back (my call).** `commit_mode` input:

- `push` (default): commit the lock and specs to the branch with a `[skip ci]`
  message, rebasing and retrying once if the push races. Requires
  `contents: write`.
- `pull_request`: for protected default branches, open or update one bot PR
  (`sigma-sync/state`) carrying the state changes. Requires
  `contents: write` + `pull-requests: write`.
- `none`: write nothing back (local testing).

If the push or PR fails, the run fails, because Sigma is already updated and
state would otherwise be lost. The lockfile is uploaded as a workflow artifact
and the summary lists every view key → `dataModelId`, so a human can commit it
by hand.

**Existing models with no lock entry (my call).** If a view has no lock entry
but the target folder already holds a data model with the same name, the action
**does not overwrite it by default**. That model may be hand-built. The view
is refused with a message naming the model. With `adopt_existing: true`
(opt-in, meant for recovering a lost lockfile or re-installing), exactly one
match is adopted and recorded, and more than one match is refused (never
guess). No match: create.

**Drift (my call).** Git is the source of truth for models the action manages
(those in the lock). Before each update, the action GETs the current spec and
compares its hash with `specSha256`. If someone edited the model in the
Sigma UI, the update still goes ahead. The drift is flagged in the summary
and a warning annotation, and the pre-update spec is saved in the run's
artifact so the edit isn't lost.

**Which files run (my call).** `mode` input:

- `auto` (default): files changed in this push (diff `github.event.before..after`,
  which covers multi-commit pushes, unlike the dbt action's `HEAD~1`) **plus**
  any view with no lock entry **plus** any view whose lock `engineCommit` differs
  from the bundled engine (so an engine upgrade reconverts everything once).
- `all`: every matching file. This is the default on `workflow_dispatch`.

File discovery uses a `paths` glob input (default `**/*.{yml,yaml,sql}`) and
content detection. A file that isn't a semantic view is skipped quietly, so a
broad glob can't fail the run.

**Deleted / renamed views (my call).** Never delete in Sigma. A view that
disappears from the repo is marked `orphaned: true` in the lock and listed in
the job summary with its Sigma ID, so a human can delete it. If the view comes
back, the entry is reused.

**Refused views (my call).** Process every view, deploy those that convert,
commit state for the successes, then exit non-zero listing each refused view
with its finding codes, messages, and remediation. `best_effort` input
(default `false`) passes through to the engine. `fail_on_refused` (default
`true`) lets a team make refusals warnings instead.

**Pull requests (my call).** On `pull_request` events, `dry_run` defaults to
`true`: convert changed files, write findings and per-view stats to the job
summary, write nothing to Sigma, commit nothing. Non-zero exit on refusals, so
the PR check shows red. When Sigma credentials are available, dry run also makes
**read-only** API calls: resolve connection/folder names, confirm lock IDs still
exist, and report what would be created, updated, adopted, or refused for a
name clash. When credentials are absent (e.g. fork PRs), it runs offline,
converting and reporting findings only, and says in the summary which checks it
skipped.

**Post-deploy check (my call).** After each create/update, GET the spec back
(proves Sigma stored it). Beyond that, the anti-goal above needs a check that
columns actually resolve. Whether the REST API supports one is for the builder
to find out (see "Left to the builder"). If it does, a failed check is a
hard failure for that view, handled like this:

- Update: PUT back the pre-update spec captured for drift detection
  (rollback), leave the lock entry unchanged, report the view as failed.
- Create: delete the data model the action created moments earlier in this
  same run. This is the one narrow exception to "never delete". It only
  ever removes the action's own just-made, broken output. No lock entry is
  written.

## Inputs (sketch; builder may refine names)

| Input | Default | Purpose |
|---|---|---|
| `sigma_base_url` | required | Sigma API host |
| `sigma_client_id` / `sigma_client_secret` | required | OAuth client credentials (from secrets) |
| `connection_id` or `connection_name` | one required | Sigma connection the models point at |
| `folder_id` or `folder_name` | one required | Destination folder for new models |
| `paths` | `**/*.{yml,yaml,sql}` | Where semantic-view files live |
| `database` / `schema` | — | For table refs with fewer than 3 / 2 parts |
| `mode` | `auto` (`all` on dispatch) | Which views to process |
| `dry_run` | `true` on PRs, else `false` | Convert + report only |
| `best_effort` | `false` | Engine best-effort mode |
| `fail_on_refused` | `true` | Exit non-zero when any view is refused |
| `lock_file` | `sigma/semantic-views.lock.json` | State file path |
| `save_specs` / `specs_dir` | `true` / `sigma/models` | Save GET-back specs |
| `commit_mode` | `push` | `push` / `pull_request` / `none` |
| `adopt_existing` | `false` | Adopt a same-named model that has no lock entry |
| `model_name_template` | `{view}` | Sigma model name; `{database}`, `{schema}`, `{view}` |
| `column_types_file` | — | Optional `{ "DB.SCHEMA.TABLE": { COL: TYPE } }` for the engine's time-zone checks |

Outputs: `created`, `updated`, `refused`, `orphaned` (JSON arrays of view keys),
plus a Markdown job summary table (view, status, Sigma link, finding counts).

## Testing

- Unit: adapter + orchestration with the Sigma API mocked. Fixtures come from
  the MCP repo's `regression-corpus/snowflake/*` and
  `semantic-tools-embed/test/fixtures/*` (YAML, DDL, multi-view, refused
  cases), covering create, update, adopt-by-name, duplicate-name refusal, orphan,
  refused-view exit code, dry-run writes nothing, `engineCommit` change
  triggers reconvert.
- Golden: the converted specs for the corpus fixtures match the MCP
  converter's output for the same inputs. This proves the port is faithful.
- End-to-end: a workflow in the action's own repo runs the action against a
  test Sigma org/folder (the CSA.TJ connection
  fixtures the MCP repo uses), checks
  the models return real data, then deletes them. My call: it is **not** a
  required merge check. It runs on `workflow_dispatch` and a weekly schedule,
  and is skipped when secrets are absent (fork PRs). After the transfer to
  `sigmacomputing`, the test-org secrets have to be set up again there. Unit
  and golden suites are fully offline and are the required checks.

## Left to the builder

- **Column-resolution check.** Find what the Sigma REST API exposes for a saved
  data model's resolved column types (or a cheap query path). If something
  usable exists, fail a view whose columns come back `error`-typed. If nothing
  does, document the gap in the README and rely on the e2e test plus the
  engine's guarantees.
- Bundler choice (ncc vs esbuild), test framework, exact input names.
- Retry/backoff for Sigma API calls, and token refresh at about 50 minutes for long runs.
- Job-summary layout.
- Release mechanics: `v1` moving tag, semver tags, `dist/` freshness check in CI.

## Repository

New public repo, `snowflake_semantics_to_sigma` (naming mirrors the dbt
action). My call: build it under `twells89`, then transfer to `sigmacomputing`
for the Marketplace listing alongside the dbt action. License Apache-2.0 (matches
the vendored engine), keeping the engine's `NOTICE`. This design doc becomes
`docs/design.md` in that repo's first commit.
