#!/usr/bin/env node
// Deletes every data model recorded in the given lockfiles (each id once). Used
// only by the e2e workflow on the models it just created in the test folder.
//
//   SIGMA_BASE_URL=… SIGMA_CLIENT_ID=… SIGMA_CLIENT_SECRET=… node scripts/e2e-cleanup.mjs <lockfile>...

import { existsSync, readFileSync } from 'node:fs';

const lockPaths = process.argv.slice(2);
const { SIGMA_BASE_URL: base, SIGMA_CLIENT_ID: id, SIGMA_CLIENT_SECRET: secret } = process.env;
if (lockPaths.length === 0 || !base || !id || !secret) { console.error('usage: e2e-cleanup.mjs <lockfile>... (with SIGMA_* env)'); process.exit(2); }
const models = new Map();
for (const p of lockPaths) {
  if (!existsSync(p)) { console.log(`no lockfile at ${p}`); continue; }
  for (const [key, entry] of Object.entries(JSON.parse(readFileSync(p, 'utf8')).views)) models.set(entry.dataModelId, key);
}
if (models.size === 0) { console.log('nothing to clean up'); process.exit(0); }

const tokenRes = await fetch(`${base}/v2/auth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
});
if (!tokenRes.ok) { console.error(`token exchange failed: ${tokenRes.status}`); process.exit(1); }
const { access_token: token } = await tokenRes.json();

let failed = 0;
for (const [dataModelId, key] of models) {
  const res = await fetch(`${base}/v2/files/${encodeURIComponent(dataModelId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  console.log(`${res.ok ? 'deleted' : `FAILED (${res.status})`} ${key} → ${dataModelId}`);
  if (!res.ok) failed++;
}
process.exit(failed ? 1 : 0);
