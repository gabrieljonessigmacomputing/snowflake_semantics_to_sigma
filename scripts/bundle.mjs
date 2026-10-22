#!/usr/bin/env node
// Bundles the action into a single dist/index.js (committed; JavaScript actions run it directly).
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [join(ROOT, 'src/main.ts')],
  outfile: join(ROOT, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  legalComments: 'linked',
  // CommonJS dependencies (@actions/*) call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});
