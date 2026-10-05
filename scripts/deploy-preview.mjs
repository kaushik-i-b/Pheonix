#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function run(command, args) {
  return spawnSync(command, args, { cwd: root, stdio: 'inherit' });
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const auth = spawnSync('npx', ['--yes', 'vercel', 'whoami'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
});
if (auth.error) {
  fail(`Could not run the Vercel CLI: ${auth.error.message}`);
}
if (auth.status !== 0) {
  console.error(
    'Vercel CLI is not authenticated. Run `npx vercel login` in a terminal, then re-run `node scripts/deploy-preview.mjs`.',
  );
  process.exit(2);
}

let result = run('pnpm', ['--filter', '@phoenix/web', 'build']);
if (result.status !== 0) fail('Web build failed; refusing to deploy.');

result = run(process.execPath, [resolve(here, 'scan-public-bundle.mjs'), 'apps/web/out']);
if (result.status !== 0) fail('Bundle scan failed; refusing to deploy.');

if (!existsSync(resolve(root, '.vercel'))) {
  result = run('npx', ['--yes', 'vercel', 'link', '--yes', '--project', 'phoenix-run-inspector']);
  if (result.status !== 0) fail('vercel link failed; refusing to deploy.');
}

result = run('npx', ['--yes', 'vercel', 'build', '--yes']);
if (result.status !== 0) fail('vercel build failed; refusing to deploy.');

result = run(process.execPath, [resolve(here, 'scan-public-bundle.mjs'), '.vercel/output/static']);
if (result.status !== 0) fail('Prebuilt-output scan failed; refusing to deploy.');

const deploy = spawnSync('npx', ['--yes', 'vercel', 'deploy', '--prebuilt', '--yes'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
});
if (deploy.stdout) process.stdout.write(deploy.stdout);
if (deploy.stderr) process.stderr.write(deploy.stderr);
if (deploy.error) {
  fail(`Could not run the Vercel CLI: ${deploy.error.message}`);
}
if (deploy.status !== 0) fail('Preview deployment failed.');

const urls = (deploy.stdout ?? '').match(/https:\/\/\S*\.vercel\.app\S*/g);
if (!urls || urls.length === 0) {
  fail('The Vercel CLI printed no deployment URL; nothing to report.');
}
console.log(`Preview deployment: ${urls[urls.length - 1]}`);
