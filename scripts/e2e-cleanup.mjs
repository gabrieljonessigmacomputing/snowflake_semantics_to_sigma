#!/usr/bin/env node
// Deletes every data model recorded in a lockfile. Used only by the e2e workflow
// on the models it just created in the test folder.
//
//   SIGMA_BASE_URL=… SIGMA_CLIENT_ID=… SIGMA_CLIENT_SECRET=… node scripts/e2e-cleanup.mjs <lockfile>

import { existsSync, readFileSync } from 'node:fs';

const [lockPath] = process.argv.slice(2);
const { SIGMA_BASE_URL: base, SIGMA_CLIENT_ID: id, SIGMA_CLIENT_SECRET: secret } = process.env;
if (!lockPath || !base || !id || !secret) { console.error('usage: e2e-cleanup.mjs <lockfile> (with SIGMA_* env)'); process.exit(2); }
if (!existsSync(lockPath)) { console.log(`no lockfile at ${lockPath}; nothing to clean up`); process.exit(0); }

const tokenRes = await fetch(`${base}/v2/auth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
});
if (!tokenRes.ok) { console.error(`token exchange failed: ${tokenRes.status}`); process.exit(1); }
const { access_token: token } = await tokenRes.json();

let failed = 0;
for (const [key, entry] of Object.entries(JSON.parse(readFileSync(lockPath, 'utf8')).views)) {
  const res = await fetch(`${base}/v2/files/${encodeURIComponent(entry.dataModelId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  console.log(`${res.ok ? 'deleted' : `FAILED (${res.status})`} ${key} → ${entry.dataModelId}`);
  if (!res.ok) failed++;
}
process.exit(failed ? 1 : 0);
