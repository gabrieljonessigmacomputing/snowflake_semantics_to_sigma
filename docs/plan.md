# Snowflake Semantic Views → Sigma GitHub Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Marketplace-publishable JavaScript GitHub Action that keeps one Sigma data model in sync with each Snowflake semantic view file (YAML or DDL) in a customer repo.

**Architecture:** A TypeScript action bundled to `dist/index.js` (`runs.using: node24`). Each run does the following:
- Discovers every semantic view in the repo and keys each one by `DB.SCHEMA.VIEW`.
- Picks the views whose content, engine, or options changed against a committed lockfile.
- Converts them with the vendored semantic-tools engine through a port of the MCP adapter.
- Decides per view whether to create, update, adopt, or refuse.
- Executes against the Sigma REST API, with drift detection, a column-resolution check, and rollback.
- Writes state back by push, PR, or not at all.

Pure decision logic is kept separate from I/O so most behavior is unit-tested offline.

**Tech Stack:** Node 24, TypeScript 5.7, `node:test` via `tsx`, esbuild bundle, `@actions/core` / `@actions/github` / `@actions/glob` / `@actions/exec` / `@actions/artifact`, `yaml`.

**Spec:** `docs/design.md` (copied from `2026-10-22-snowflake-semantics-to-sigma-design.md`; read it alongside this plan).

**Repo:** new local repo at `snowflake_semantics_to_sigma/`. Creating the GitHub repo and pushing is Task 9 and needs the user's explicit OK.

**Source repos to copy from** (read-only clones):
- MCP: `https://github.com/twells89/sigma-data-model-mcp` (`src/snowflake.ts`, `vendor/semantic-tools/`, `semantic-tools-embed/`, `scripts/*semantic-tools*`, `scripts/yaml-key-drift.mjs`, `regression-corpus/snowflake/`)
- Sigma API reference implementation: `https://github.com/sigmacomputing/semantic-tools` `packages/connectors/src/sigma.ts` (internal repo)

## Global Constraints

- Org policy: never use a non-`@sigmacomputing/*` package version released within the last 3 days. Before adding any dependency, run `npm view <pkg>@<version> time --json` and confirm the publish date is older than 3 days.
- Pinned versions:
  - devDependencies `esbuild@0.27.7`, `yaml@2.9.0`, `typescript@5.7.3`, `tsx@4.19.2`, `@types/node@22.10.2`
  - dependencies `@actions/core@1.11.1`, `@actions/github@6.0.0`, `@actions/glob@0.5.0`, `@actions/exec@1.1.1`, `@actions/artifact@2.3.2`
  - If a pin doesn't resolve, use the newest release older than 3 days and record it in `package.json`.
- `action.yml`: `runs.using: node24`, `runs.main: dist/index.js`. `dist/` is committed.
- Default lockfile `sigma/semantic-views.lock.json`; default specs dir `sigma/models`; lock `version: 1`.
- Default `paths` glob `**/*.{yml,yaml,sql}`.
- Never delete anything in Sigma, except a data model created by this run, in this run, that failed the column check.
- The vendored engine (`vendor/semantic-tools/*`) is copied byte-for-byte and never edited. Keep `LICENSE`, `NOTICE`, `PROVENANCE.json`.
- Repo license Apache-2.0.
- Spec rules the action must not break: `schemaVersion: 1` at root; specs are POSTed as the engine/adapter emits them, plus `name` + `folderId` on create only.
- Sigma auth: OAuth client credentials `POST {base}/v2/auth/token`. Refresh proactively at 50 minutes; refresh once and retry on a 401.
- Git commit message for state: `chore(sigma): sync semantic views [skip ci]`. Default identity `github-actions[bot]` / `41898282+github-actions[bot]@users.noreply.github.com`.
- Tests are offline. No test may call Sigma or GitHub except the e2e workflow in Task 9.

**Deviations from the spec (flagged for the user):**
1. **Change detection.** The spec selects views by `git diff before..after`. This plan instead reprocesses a view when its lock entry is missing, or when its `sourceSha256`, `optionsSha256` or `engineCommit` differs. That covers every case the diff covers, plus force-pushes, first pushes (`before = 000…`), previously failed runs, and changed action inputs. No git history is needed.
2. **Column check.** The spec left this to the builder. It is now pinned: `GET /v2/dataModels/{id}/columns` (paginated `entries[]`), and the check fails when any `entries[].type.type === "error"`. This is the guard the sibling migration skills already use.

## Review Focus

1. **CRLF / BOM in source files.** Files saved on Windows must produce the same keys and specs as LF files. Pinned in Task 2.
2. **Quoted, mixed-case or dotted identifiers** in view names (`"Sales"."my.view"`) must yield the right key, not a split on the inner dot. Pinned in Task 2.
3. **A lock `dataModelId` deleted in Sigma by hand.** Expected: warn and fall through to name-match/create, not crash or refuse. Pinned in Task 5.
4. **Pagination.** A folder with more than one page of files (or connections, or columns) must still find the same-named model, or a duplicate is created. Pinned in Task 4.
5. **A corrupt lockfile** (merge-conflict markers, bad JSON, unknown `version`) must stop the run before any Sigma write, not be treated as empty. Pinned in Task 3.

---

### Task 1: Repo scaffold, vendored engine, adapter port with golden parity

**Files:**
- Create: `package.json` (`"type": "module"`; scripts `test`, `build`, `build:semantic-tools`, `check:semantic-tools`), `tsconfig.json` (strict, `module: nodenext`), `.gitignore` (`node_modules`, `.cache`), `LICENSE` (Apache-2.0), `NOTICE`, `docs/design.md`, `docs/plan.md`
- Copy verbatim from MCP: `vendor/semantic-tools/*`, `semantic-tools-embed/**`, `scripts/build-semantic-tools.mjs`, `scripts/check-semantic-tools.mjs`, `scripts/semantic-tools-source-hash.mjs`, `scripts/yaml-key-drift.mjs`
- Create: `src/convert.ts` (port of MCP `src/snowflake.ts`)
- Create: `scripts/make-goldens.mjs`, `test/fixtures/**`, `test/golden/*.json`
- Test: `test/convert.test.ts`

**Interfaces:**
- Produces:
  - `convertSnowflakeSemanticView(source: string, options?: SnowflakeConvertOptions): SnowflakeConversionResult`
  - `CONNECTION_PLACEHOLDER = '<CONNECTION_ID>'`
  - `ENGINE` re-export `{ semanticToolsCommit: string; embedVersion: string }`
  - `detectFormat` re-export
  - Types `SnowflakeConvertOptions`, `SnowflakeViewResult` (`{ viewName, ok, model?, stats?, findings: EmbedFinding[], bestEffortWouldConvert, needs?, overriddenErrors: string[] }`) and `SnowflakeConversionResult`, exactly as in MCP `src/snowflake.ts`
  - Minimal `SigmaDataModel` type `{ name?: string; schemaVersion?: number; pages: unknown[] }` in `src/types.ts`

- [ ] **Step 1:** `git init`. Copy the files listed above. Write `docs/design.md` from the design doc and this plan as `docs/plan.md`. `npm install` the pinned devDependencies (check the 3-day rule first).
- [ ] **Step 2:** Copy fixtures into `test/fixtures/`:
  - MCP `regression-corpus/snowflake/<case>/input.{sql,yaml}` → `test/fixtures/<case>.{sql,yaml}`
  - MCP `semantic-tools-embed/test/fixtures/*` → `test/fixtures/embed/`
- [ ] **Step 3: Generate goldens from the MCP converter.**
  - `scripts/make-goldens.mjs <path-to-built-MCP-repo>` imports `<mcp>/build/snowflake.js`.
  - It converts every fixture with `{ connectionId: '00000000-0000-4000-8000-000000000000', database: 'ANALYTICS', schema: 'MODELS' }`, plus `bestEffort: true` for `retail_analytics_sv_best_effort`.
  - It writes `test/golden/<name>.json` = `{ refused, refusedViews, results: results.map(r => ({ viewName, ok, model, findingCodes: r.findings.map(f => f.code) })) }`.
  - Build the MCP clone first: `npm ci && npm run build`. Commit goldens.
- [ ] **Step 4: Write the failing test** `test/convert.test.ts`. One test per golden: `port output equals MCP output for <name>`. It runs the same options through `convertSnowflakeSemanticView` and asserts `assert.deepEqual(project(result), golden)` with the same projection. Add three more tests:
  - `retail_analytics_sv_best_effort refuses without bestEffort`: `refused === true` and the findings include `METRIC_JOIN_PATH_SELECTOR`.
  - `blank connectionId uses placeholder`: the model JSON contains `<CONNECTION_ID>`.
  - `ENGINE.semanticToolsCommit matches vendor PROVENANCE.json`.
- [ ] **Step 5:** Run `npm test`. Expected: FAIL (`src/convert.ts` missing).
- [ ] **Step 6:** Port MCP `src/snowflake.ts` to `src/convert.ts`. Change only import paths, and replace `ConversionResult`/`SigmaDataModel` imports with `src/types.ts`. Keep every default (`crossTableReferences: 'derived'`, `usingPaths: 'bound'`, synonyms on, model named after the view). Also re-export `ENGINE` and `detectFormat`.
- [ ] **Step 7:** Run `npm test` and `node scripts/check-semantic-tools.mjs`. Expected: all PASS; the check prints the vendor hashes OK.
- [ ] **Step 8:** Commit `feat: vendor semantic-tools engine and port MCP Snowflake adapter`.

### Task 2: View discovery and identity

**Files:**
- Create: `src/identity.ts`, `src/discover.ts`
- Test: `test/identity.test.ts`, `test/discover.test.ts`

**Interfaces:**
- Consumes: `detectFormat` (Task 1).
- Produces:
  - `interface QualifiedName { database?: string; schema?: string; view: string }`
  - `interface ViewSource { key: string; name: QualifiedName; path: string; format: 'ddl' | 'yaml'; index: number /* statement order in file */; fileSha256: string }`
  - `parseDdlViewNames(sql: string): QualifiedName[]` (statement order)
  - `parseYamlViewName(yaml: string): string | undefined`
  - `viewKey(q: QualifiedName): string`: present parts joined by `.`, unquoted parts upper-cased, quoted parts kept verbatim without quotes
  - `renderModelName(template: string, q: QualifiedName): string`: `{database}`, `{schema}`, `{view}`; a missing part renders empty, and empty segments with their adjacent `.` are dropped
  - `findNameCollisions(views: ViewSource[], template: string): string[][]`: groups of keys sharing a rendered name
  - `discoverViews(files: { path: string; content: string }[], defaults: { database?: string; schema?: string }): { views: ViewSource[]; skipped: string[]; errors: { path: string; message: string }[] }`
  - `listCandidateFiles(patterns: string, root: string, exclude: string[]): Promise<string[]>` (uses `@actions/glob`; always excludes `.git/**`, `node_modules/**`, the lock file and the specs dir; returns repo-relative POSIX paths, sorted)

- [ ] **Step 1: Write failing tests** in `test/identity.test.ts`:
  - `parses qualified and unqualified DDL names`: `parseDdlViewNames('CREATE OR REPLACE SEMANTIC VIEW ANALYTICS.MODELS.SALES_VIEW ...')` → `[{database:'ANALYTICS',schema:'MODELS',view:'SALES_VIEW'}]`. `create semantic view if not exists s.v` → `{schema:'s',view:'v'}`, and `viewKey` → `'S.V'`.
  - `quoted identifiers keep case and inner dots`: `CREATE SEMANTIC VIEW "Sales"."my.view"` → key `'Sales.my.view'` with `schema:'Sales'`, `view:'my.view'`.
  - `multi-statement DDL keeps order`: two statements → two names in source order.
  - `ignores names inside comments and string literals`: `-- create semantic view X` and `'create semantic view Y'` yield nothing.
  - `renderModelName`: `('{view}', {schema:'S',view:'V'})` → `'V'`. `('{schema}.{view}', {view:'V'})` → `'V'`. `('{database}.{schema}.{view}', full)` → `'D.S.V'`.
  - `findNameCollisions`: keys `A.S.V` and `B.S.V` with `{view}` → `[['A.S.V','B.S.V']]`; with `{database}.{view}` → `[]`.
- [ ] **Step 2: Write failing tests** in `test/discover.test.ts`:
  - `discovers DDL and YAML fixtures with defaults applied`: `star_schema_ddl.sql` → key `ANALYTICS.MODELS.SALES_VIEW`. `embed/tpch.yaml` with defaults `{database:'D',schema:'S'}` → key `D.S.TPCH_SALES`. YAML with no defaults → key `TPCH_SALES`.
  - `skips non-semantic files quietly`: a dbt `models:` YAML and a plain `select 1;` SQL file go in `skipped`, not `errors`.
  - `CRLF and BOM produce the same keys and fileSha256 differs only by content`: the fixture rewritten with `\r\n` plus a leading `﻿` yields the same `key` list.
  - `duplicate key across files is an error`: two files defining `S.V` → both paths in `errors`, neither in `views`.
- [ ] **Step 3:** Run `npm test`. Expected: FAIL (modules missing).
- [ ] **Step 4:** Implement `src/identity.ts`.
  - Use a small tokenizer that skips `--`/`/* */` comments and `'…'` strings, then matches `CREATE [OR REPLACE] SEMANTIC VIEW [IF NOT EXISTS] <ident>(.<ident>){0,2}`, where `<ident>` is an unquoted `[A-Za-z_][A-Za-z0-9_$]*` or a `"…"` with `""` escapes.
  - Use `yaml` for `parseYamlViewName` (top-level `name`).
  - Strip a leading BOM and normalize CRLF before parsing.
- [ ] **Step 5:** Implement `src/discover.ts`:
  - `detectFormat` decides ddl/yaml/skip.
  - Fill missing parts from `defaults`.
  - `fileSha256` is the sha256 of the raw bytes.
  - `index` is the statement position.
- [ ] **Step 6:** Run `npm test`. Expected: PASS.
- [ ] **Step 7:** Commit `feat: discover semantic views and derive DB.SCHEMA.VIEW keys`.

### Task 3: Lockfile and view selection

**Files:**
- Create: `src/lock.ts`
- Test: `test/lock.test.ts`

**Interfaces:**
- Consumes: `ViewSource` (Task 2).
- Produces:
  - `interface LockEntry { dataModelId: string; modelName: string; sourcePath: string; sourceSha256: string; optionsSha256: string; engineCommit: string; specSha256: string; lastDeployedAt: string; orphaned: boolean }`
  - `interface Lock { version: 1; views: Record<string, LockEntry> }`
  - `class LockError extends Error`
  - `readLock(path: string): Lock`: missing file → `{version:1,views:{}}`; anything unparsable or `version !== 1` → throws `LockError` naming the path
  - `writeLock(path: string, lock: Lock): void`: keys sorted recursively, 2-space indent, trailing newline
  - `canonicalSha256(value: unknown): string`: sha256 of JSON with object keys sorted recursively
  - `selectViews(views: ViewSource[], lock: Lock, ctx: { mode: 'auto' | 'all'; engineCommit: string; optionsSha256: string }): { selected: ViewSource[]; unchanged: ViewSource[] }`
  - `findOrphans(views: ViewSource[], lock: Lock): string[]`: lock keys not present in `views` (sorted)

- [ ] **Step 1: Write failing tests**:
  - `missing lock is empty`.
  - `corrupt lock throws LockError`: content `<<<<<<< HEAD`, `{`, and `{"version":2,"views":{}}` each throw `LockError`.
  - `writeLock is stable`: writing then reading round-trips, and two writes of differently-ordered input are byte-identical.
  - `canonicalSha256 ignores key order`: `{a:1,b:{c:2,d:3}}` and `{b:{d:3,c:2},a:1}` hash equal.
  - `selectViews auto picks new, changed source, changed options, changed engine`: one view per reason is selected, and a view matching on all three hashes is `unchanged`.
  - `selectViews all selects everything`.
  - `a moved file with the same key and content is unchanged`: `sourcePath` differs, `sourceSha256` equal → `unchanged` (the caller rewrites `sourcePath`).
  - `findOrphans lists keys missing from discovery`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/lock.ts`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: lockfile state and content-hash view selection`.

### Task 4: Sigma API client

**Files:**
- Create: `src/sigma/client.ts`
- Test: `test/sigma-client.test.ts`

**Interfaces:**
- Produces:
  - `interface SigmaCredentials { baseUrl: string; clientId: string; clientSecret: string }`
  - `class SigmaApiError extends Error { status: number; operation: string; body: string }`
  - `class SigmaClient`:
    - `constructor(creds: SigmaCredentials, deps?: { fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> })`
    - `resolveConnectionId(name: string): Promise<string>`: paginated `GET /v2/connections`, exact name match, else throws
    - `resolveFolderId(name: string): Promise<string>`: paginated `GET /v2/files?typeFilters=folder`, exact name match; more than one match throws
    - `listDataModelsInFolder(folderId: string): Promise<{ id: string; name: string }[]>`: paginated `GET /v2/files?parentId={folderId}&limit=200`, keeping entries whose `type` is `"data-model"` (verify the string live in Task 9)
    - `getDataModelSpec(id: string): Promise<Record<string, unknown> | null>`: `GET /v2/dataModels/{id}/spec`; 404 → `null`
    - `createDataModel(spec: Record<string, unknown>, name: string, folderId: string): Promise<string>`: `POST /v2/dataModels/spec` with `{...spec, name, folderId}`, returns `dataModelId`
    - `updateDataModel(id: string, spec: Record<string, unknown>): Promise<void>`: `PUT /v2/dataModels/{id}/spec`
    - `deleteFile(id: string): Promise<void>`: `DELETE /v2/files/{id}`
    - `listDataModelColumns(id: string): Promise<{ elementId: string; columnId: string; label: string; formula: string; type: string }[]>`: paginated `GET /v2/dataModels/{id}/columns`, `type` read from `entries[].type.type`
- Pagination: follow `nextPage` (pass it as `page=`) until absent. Treat `hasMore: false` as the end.

- [ ] **Step 1: Write failing tests** with a fake `fetch` that records calls:
  - `token is fetched once and reused`.
  - `token refreshes after 50 minutes`: `now` advanced by `50*60*1000` → a second token POST.
  - `401 refreshes once then retries; second 401 throws SigmaApiError(status 401)`.
  - `429 and 5xx retry with backoff up to 3 attempts honoring Retry-After`: the recorded `sleep` args are `[1000, 2000]` for two 503s then a 200, and `Retry-After: 5` → `5000`.
  - `listDataModelsInFolder follows nextPage`: page 1 has 200 non-model entries and `nextPage:'p2'`; page 2 holds the model → returned.
  - `listDataModelColumns follows nextPage and maps type.type`.
  - `getDataModelSpec returns null on 404`.
  - `SigmaApiError never contains the client secret`: a failed token exchange's message and `body` don't include `clientSecret`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/sigma/client.ts`. Use `semantic-tools` `packages/connectors/src/sigma.ts` as the reference for the token and create/update shapes.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: Sigma REST client with refresh, retry and pagination`.

### Task 5: Per-view decisions (pure)

**Files:**
- Create: `src/decide.ts`
- Test: `test/decide.test.ts`

**Interfaces:**
- Consumes: `SnowflakeViewResult` (Task 1), `LockEntry` (Task 3).
- Produces:
  - `type Decision =`
    - `| { kind: 'create' }`
    - `| { kind: 'update'; dataModelId: string }`
    - `| { kind: 'adopt'; dataModelId: string }`
    - `| { kind: 'refuse-conversion' }`
    - `| { kind: 'refuse-name-clash'; reason: 'exists-not-adopted' | 'multiple-matches'; matches: string[] }`
  - `interface DecideInput { conversion: SnowflakeViewResult; modelName: string; lockEntry?: LockEntry; lockModelExists?: boolean /* undefined = offline */; folderModels?: { id: string; name: string }[] /* undefined = offline */; adoptExisting: boolean }`
  - `decideView(input: DecideInput): { decision: Decision; verified: boolean; warnings: string[] }`. `verified` is false when offline, meaning the name-clash check was skipped.

Rules, in order:
1. `!conversion.ok` → `refuse-conversion`.
2. If `lockEntry` exists and `lockModelExists !== false` → `update`.
3. If `lockEntry` exists and `lockModelExists === false` → warning `"<key>: data model <id> no longer exists in Sigma; recreating"`, then continue to rule 4 as if there were no lock entry.
4. Folder models named `modelName`: 0 → `create`; 1 → `adopt` if `adoptExisting`, else `refuse-name-clash/exists-not-adopted`; 2 or more → `refuse-name-clash/multiple-matches`.
5. Offline (`folderModels === undefined`) with no lock entry → `create` with `verified:false`.

- [ ] **Step 1: Write failing tests**, one per rule:
  - `refused conversion wins`
  - `lock entry updates`
  - `deleted lock model falls through and warns`
  - `name clash refuses by default`
  - `adoptExisting adopts single match`
  - `multiple matches always refuse even with adoptExisting`
  - `no match creates`
  - `offline creates unverified`
  - `offline with lock updates unverified`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `decideView`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: per-view create/update/adopt/refuse decisions`.

### Task 6: Per-view execution (writes, drift, column check, rollback)

**Files:**
- Create: `src/execute.ts`
- Test: `test/execute.test.ts` (a fake `SigmaClient` implementing the Task 4 methods in memory)

**Interfaces:**
- Consumes: `SigmaClient` (Task 4), `Decision` (Task 5), `canonicalSha256` / `LockEntry` (Task 3), `ViewSource` (Task 2).
- Produces:
  - `type Status = 'created' | 'updated' | 'adopted' | 'unchanged' | 'refused' | 'failed' | 'would-create' | 'would-update' | 'would-adopt'`
  - `interface ViewOutcome { key: string; status: Status; dataModelId?: string; modelName: string; drift: boolean; findings: EmbedFinding[]; errorColumns?: { elementId: string; label: string; formula: string }[]; error?: string; getBackSpec?: Record<string, unknown>; specSha256?: string }`
  - `executeView(client: SigmaClient | undefined, args: { view: ViewSource; decision: Decision; spec?: Record<string, unknown>; modelName: string; folderId?: string; lockEntry?: LockEntry; dryRun: boolean; preUpdateDir: string }): Promise<ViewOutcome>`

Sequences:
- **Dry run:** no client writes. Map `create`/`update`/`adopt` → `would-*`; refusals → `refused`.
- **Create:** `createDataModel` → `listDataModelColumns`. Any `type === 'error'` → `deleteFile(newId)` → `failed` with `errorColumns`. Otherwise `getDataModelSpec` → `created`, with `specSha256 = canonicalSha256(getBack)`.
- **Update / adopt:**
  1. `pre = getDataModelSpec(id)`.
  2. For update, `drift = canonicalSha256(pre) !== lockEntry.specSha256`. On drift or adopt, write `pre` to `<preUpdateDir>/<key>.json`.
  3. `updateDataModel` → `listDataModelColumns`. Any error-typed column → `updateDataModel(id, pre)` (rollback) → `failed`.
  4. Otherwise GET back → `updated` / `adopted`.
- Any `SigmaApiError` → `failed` with `error = message`, and no further writes for that view. If the error happens after a create succeeded but before the column check, the view is `failed` and its `dataModelId` is kept on the outcome so the summary shows it.

- [ ] **Step 1: Write failing tests**:
  - `dry run never calls write methods`: the fake records zero `create`/`update`/`delete` calls, for each decision kind.
  - `create happy path`: status `created`, `specSha256` set.
  - `create with error column deletes the new model`: `deleteFile` called once with the new id, status `failed`, `errorColumns.length === 1`.
  - `update detects drift and saves pre-spec`: lock `specSha256` ≠ current → `drift: true`, and the file `<preUpdateDir>/<key>.json` exists.
  - `update without drift saves nothing`.
  - `update with error column rolls back`: the second `updateDataModel` call's body deep-equals `pre`, and status is `failed`.
  - `adopt saves pre-spec`.
  - `api error marks failed without further writes`.
  - `refusals pass through`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `executeView`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: execute per-view deploys with drift, column check and rollback`.

### Task 7: State write-back and artifacts

**Files:**
- Create: `src/writeback.ts`
- Test: `test/writeback.test.ts` (uses a real temporary git repo with a bare `origin`; no network)

**Interfaces:**
- Consumes: `ViewOutcome` (Task 6), `Lock`/`writeLock` (Task 3).
- Produces:
  - `applyOutcomes(lock: Lock, outcomes: ViewOutcome[], views: ViewSource[], ctx: { engineCommit: string; optionsSha256: string; now: string }, orphans: string[]): Lock`
    - `created`/`updated`/`adopted` write full entries.
    - `unchanged` entries get `sourcePath` refreshed.
    - Orphans get `orphaned: true`.
    - A rediscovered orphan gets `orphaned: false`.
    - `failed`/`refused` leave their entry untouched.
  - `saveSpecs(outcomes: ViewOutcome[], specsDir: string): string[]`: writes `getBackSpec` as YAML to `<specsDir>/<key>.yml` (key path-sanitized: `/`, `\` and `..` replaced with `_`), returns the written paths
  - `writeBack(mode: 'push' | 'pull_request' | 'none', paths: string[], ctx: { cwd: string; ref: string; repo: { owner: string; repo: string }; token?: string; gitUserName: string; gitUserEmail: string; octokit?: OctokitLike }): Promise<{ ok: boolean; detail: string }>`
  - `uploadStateArtifact(files: string[], rootDir: string, upload?: ArtifactUploader): Promise<void>`: artifact name `sigma-semantic-sync-state`

Write-back behavior:
- **push:** `git add` the paths. If there's nothing to commit → ok. Otherwise commit with the Global Constraints message and identity, then `git push origin HEAD:<ref>`. On rejection, run `git pull --rebase origin <ref>` once and push again. A rebase conflict → `git rebase --abort` → `{ok:false}`.
- **pull_request:** commit onto branch `sigma-sync/state` (created from `HEAD`), `git push --force origin sigma-sync/state`. Open a PR titled `Sigma semantic view sync state` into `<ref>` unless one is already open from that head.
- **none:** no-op, ok.

- [ ] **Step 1: Write failing tests**:
  - `applyOutcomes` cases, one per bullet above.
  - `saveSpecs sanitizes keys`: key `../X` writes inside `specsDir`.
  - `push commits and pushes`: the bare origin has the commit, and its message is `chore(sigma): sync semantic views [skip ci]`.
  - `push with nothing to commit is ok and makes no commit`.
  - `push retries after a racing commit`: a second clone pushes an unrelated file first, and the result is ok with both commits on origin.
  - `push with rebase conflict fails cleanly`: the racing commit edits the lockfile → `ok:false`, and the working tree is not mid-rebase.
  - `pull_request opens a PR once`: a fake octokit sees `pulls.create` on the first run and not on the second.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/writeback.ts`. Run git via `@actions/exec` (`getExecOutput`, `ignoreReturnCode: true`). `OctokitLike` and `ArtifactUploader` are minimal interfaces satisfied by `@actions/github`'s `getOctokit(token).rest` and `@actions/artifact`'s `DefaultArtifactClient`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: commit/PR state write-back and failure artifact`.

### Task 8: Orchestration, inputs, summary, action.yml, bundle

**Files:**
- Create: `src/inputs.ts`, `src/run.ts`, `src/summary.ts`, `src/main.ts`, `action.yml`, `scripts/bundle.mjs`, `dist/index.js` (generated)
- Test: `test/inputs.test.ts`, `test/run.test.ts`, `test/summary.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `interface Config { sigma?: SigmaCredentials /* undefined when id/secret blank */; connection: { id?: string; name?: string }; folder: { id?: string; name?: string }; paths: string; database?: string; schema?: string; mode: 'auto' | 'all'; dryRun: boolean; bestEffort: boolean; failOnRefused: boolean; lockFile: string; saveSpecs: boolean; specsDir: string; commitMode: 'push' | 'pull_request' | 'none'; adoptExisting: boolean; modelNameTemplate: string; columnTypesFile?: string; gitUserName: string; gitUserEmail: string; githubToken?: string }`
  - `parseInputs(get: (name: string) => string, event: { name: string }): Config`
    - Empty `mode` → `all` on `workflow_dispatch`, else `auto`.
    - Empty `dry_run` → `true` on `pull_request` / `pull_request_target`.
    - Throws when not dry-run and `sigma` is undefined, or both/neither of `connection_id`/`connection_name`, or both/neither of `folder_id`/`folder_name`.
  - `optionsSha256(cfg: Config, columnTypes?: unknown): string` = `canonicalSha256({ connection: cfg.connection, database, schema, bestEffort, columnTypes })`
  - `run(cfg: Config, deps: { cwd: string; client?: SigmaClient; writeBack: typeof writeBack; upload: typeof uploadStateArtifact; ref: string; repo: {owner: string; repo: string}; now: () => string }): Promise<RunResult>`
  - `interface RunResult { outcomes: ViewOutcome[]; orphans: { key: string; dataModelId: string }[]; skipped: string[]; errors: { path: string; message: string }[]; warnings: string[]; offline: boolean; writeBack?: { ok: boolean; detail: string }; exitCode: 0 | 1 }`
  - `renderSummary(result: RunResult): string`: Markdown table `View | Status | Sigma data model | Errors | Warnings`, then sections for refused findings (code, message, remediation), orphans (key + id), drift, skipped checks when offline, and write-back failure (every key → `dataModelId` from the lock)

`run` sequence:
1. `readLock` (a `LockError` stops the run here).
2. `listCandidateFiles` → `discoverViews`.
3. `findNameCollisions`; colliding views become `failed` with a message to set `model_name_template: "{schema}.{view}"`.
4. Resolve connection and folder (online only). Offline, use `CONNECTION_PLACEHOLDER`.
5. `selectViews`. Load `columnTypesFile` as JSON if set. Convert each file that has a selected view once with `convertSnowflakeSemanticView(content, { connectionId, database, schema, bestEffort, columnTypes })`, mapping results to views by `index`. A result whose `viewName` doesn't match the parsed `name.view` (case-insensitive) → `failed`. Views not selected get an `unchanged` outcome carrying their lock `dataModelId`.
6. Online: fetch `listDataModelsInFolder` once, plus `getDataModelSpec` existence for each lock id involved.
7. `decideView` → `executeView` sequentially.
8. `applyOutcomes` → `writeLock` and `saveSpecs`, unless dry-run.
9. `writeBack`, unless dry-run.
10. On write-back failure or drift, `uploadStateArtifact` (lockfile + `preUpdateDir`).

`exitCode` is 1 when any outcome is `failed`, when there are discovery `errors`, when write-back fails, or when `failOnRefused` and any outcome is `refused`.

`main.ts`:
- `parseInputs(core.getInput, { name: github.context.eventName })`.
- Build the client only if `cfg.sigma` is set.
- `run`, then set outputs `created`, `updated` (includes adopted), `refused`, `orphaned` as JSON arrays of keys.
- `core.summary.addRaw(renderSummary(r)).write()`.
- Emit a `core.warning` per drift and per run warning.
- `core.setFailed` when `exitCode === 1`.

`action.yml`: declare every input in the spec's Inputs table plus `commit_mode`, `adopt_existing`, `model_name_template`, `git_user_name`, `git_user_email`, and `github_token` (default `${{ github.token }}`), with the spec's defaults. `dry_run` and `mode` default to `''`. Declare the four outputs. Set `branding: { icon: 'database', color: 'blue' }`.

- [ ] **Step 1: Write failing tests**:
  - `inputs.test.ts`: the defaults per event, every throw case, and `optionsSha256 ignores the resolved connection id` (it uses raw inputs).
  - `run.test.ts`: uses a temp dir with fixtures, a fake client, and fake writeBack/upload.
    - `first run creates every view and writes lock`
    - `second run with no changes is all unchanged and makes no Sigma writes`
    - `editing one file updates only its views`
    - `deleted file reports orphan and never calls deleteFile`
    - `refused view fails run but others deploy and lock records them`
    - `failOnRefused false exits 0 with refusals`
    - `name collision fails both views before any write`
    - `dry run offline converts and writes nothing` (no lock or spec files written, writeBack not called, `offline: true`)
    - `corrupt lock exits before discovery with zero client calls`
    - `write-back failure uploads artifact and exits 1`
  - `summary.test.ts`:
    - `summary lists refused remediation, orphans and offline skipped checks`: substring asserts.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/inputs.ts`, `src/run.ts`, `src/summary.ts`, `src/main.ts`, and `action.yml`.
- [ ] **Step 4:** Write `scripts/bundle.mjs`: esbuild `src/main.ts` → `dist/index.js`, `platform: 'node'`, `target: 'node24'`, `format: 'esm'`, `bundle: true`, with a `createRequire` banner for CJS deps. Add `"build": "node scripts/bundle.mjs"`.
- [ ] **Step 5:** Run `npm test && npm run build && node dist/index.js`. Expected: tests PASS. The bare run with no `INPUT_*` env fails fast with the missing-credentials message (proves the bundle loads the vendored engine).
- [ ] **Step 6:** Commit `src/`, `test/`, `action.yml`, `scripts/bundle.mjs` and `dist/index.js` as `feat: orchestrate sync run, inputs, job summary and bundled action`.

### Task 9: CI, docs, live verification, publish

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/e2e.yml`, `examples/sync.yml`, `examples/pr-check.yml`, `README.md`, `test/e2e/fixtures/retail_csa_tj.yaml`

**Interfaces:**
- Consumes: the built action at `./` (`uses: ./`).

- [ ] **Step 1: Write `ci.yml`.** It runs on push and pull_request: `npm ci`, `npm test`, `node scripts/check-semantic-tools.mjs`, `npm run build`, then `git diff --exit-code dist/` (dist freshness). This is the required check.
- [ ] **Step 2: Write `e2e.yml`.**
  - Triggers: `workflow_dispatch` and `schedule: cron '0 6 * * 1'`. Skip when `secrets.SIGMA_CLIENT_ID == ''`.
  - It runs `uses: ./` with `commit_mode: none` against `test/e2e/fixtures` (copied from MCP `regression-corpus/snowflake/retail_csa_tj/input.yaml`), with `database: CSA`, `schema: TJ` and `connection_id: ${{ secrets.SIGMA_E2E_CONNECTION_ID }}` into `folder_id: ${{ secrets.SIGMA_E2E_FOLDER_ID }}`.
  - It runs the action a second time and asserts `outputs.updated == '[]'` and `created == '[]'` (idempotence through the lock it wrote).
  - It then deletes the created models via `DELETE /v2/files/{id}` in an `always()` step.
- [ ] **Step 3: Write `README.md`.** Cover:
  - What it does, with the conversion contract (refuse rather than guess).
  - The quick-start workflow (`examples/sync.yml`: `on: push` to the default branch, `permissions: contents: write`, `concurrency: { group: sigma-semantic-sync, cancel-in-progress: false }`, `actions/checkout@v4`, `uses: <org>/snowflake_semantics_to_sigma@v1`).
  - The PR check (`examples/pr-check.yml`).
  - The inputs and outputs tables.
  - Identity rules and `model_name_template`.
  - Lockfile, `adopt_existing`, drift, orphans (never deleted), protected branches → `commit_mode: pull_request`.
  - Fork PRs run offline.
  - Engine provenance and how to bump the pin (`npm run build:semantic-tools`, which needs access to `sigmacomputing/semantic-tools`).
- [ ] **Step 4: Run a live verification locally** (needs Sigma creds in env; confirm with the user before creating models in their org). Run `node dist/index.js` with `INPUT_*` env against the e2e fixture into a test folder. Confirm:
  - The `/v2/files` entry `type` string for data models is `data-model`. If not, fix `listDataModelsInFolder` plus its test.
  - `/v2/dataModels/{id}/columns` returns `entries[].type.type`.
  - Every column has a concrete type, and the job summary renders.
  - A second run is all `unchanged`.

  Then delete the test models.
- [ ] **Step 5:** Commit `ci: tests, dist freshness, e2e; docs: README and example workflows`. Tag `v0.1.0`.
- [ ] **Step 6: Publish (STOP and ask the user first).** On their explicit OK:
  - `gh repo create twells89/snowflake_semantics_to_sigma --public --source . --push`, then push tags.
  - Add e2e secrets.
  - Later, transfer to `sigmacomputing` and list the action on the Marketplace. Someone at Sigma must first confirm that shipping the `semantic-tools` bundle publicly is fine.
