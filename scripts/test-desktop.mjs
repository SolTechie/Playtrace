import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
process.chdir(resolve(import.meta.dirname, '..'));
mkdirSync('desktop/.build', { recursive: true });
execFileSync(
  'xcrun',
  [
    'swiftc',
    '-swift-version',
    '5',
    '-module-cache-path',
    'desktop/.build/module-cache',
    'desktop/Sources/Core.swift',
    'desktop/Tests/CoreTests.swift',
    '-o',
    'desktop/.build/core-tests',
  ],
  { stdio: 'inherit' },
);
execFileSync('desktop/.build/core-tests', [], { stdio: 'inherit' });
const cli = resolve('artifacts/playtrace');
const run = (args) => spawnSync(cli, args, { encoding: 'utf8' });
for (const args of [['--help'], ['--version'], ['schema', 'games'], ['schema', 'themes']]) {
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
}
for (const args of [
  ['auth', 'login', '--file', '.env.invite'],
  ['games', 'update', '../jobs'],
  ['games', 'list', '--apply'],
  ['games', 'create', '--apply', '--dry-run'],
  ['jobs', 'create'],
  ['exec', 'echo'],
  ['schema', 'invalid'],
]) {
  const result = run(args);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
}
const draft = resolve('desktop/.build/test-draft.json');
writeFileSync(draft, JSON.stringify({ title: 'CLI preview only', is_published: false }));
const preview = run(['games', 'create', '--file', draft]);
assert.equal(preview.status, 0, preview.stderr);
assert.equal(JSON.parse(preview.stdout).dry_run, true);
assert.equal(JSON.parse(preview.stdout).after.is_published, false);
const source = readFileSync('desktop/Sources/App.swift', 'utf8');
assert.ok(source.includes('frameInfo.securityOrigin'));
assert.ok(source.includes('frameInfo.request.url?.scheme == "playtrace"'));
console.log('Passed CLI help, schemas, invalid arguments, and offline mutation preview checks');
