import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

if (process.platform !== 'darwin') throw new Error('macOS + Xcode is required.');
const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const build = resolve('desktop/.build');
const out = resolve('artifacts');
const app = join(out, 'Playtrace.app');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
mkdirSync(build, { recursive: true });
mkdirSync(out, { recursive: true });
run(process.execPath, ['--import', 'tsx', 'scripts/desktop-schema.ts']);
run('npx', ['vite', 'build', '--mode', 'desktop', '--config', 'vite.desktop.config.ts']);
const flags = [
  '-swift-version',
  '5',
  '-O',
  '-target',
  'arm64-apple-macos13.0',
  '-module-cache-path',
  join(build, 'module-cache'),
];
run('xcrun', [
  'swiftc',
  ...flags,
  'desktop/Sources/Core.swift',
  'desktop/.build/Schema.swift',
  'desktop/Sources/CLI.swift',
  '-o',
  join(out, 'playtrace'),
]);
// Remove only the generated application; no project data or credentials are copied.
rmSync(app, { recursive: true, force: true });
for (const dir of ['MacOS', 'Resources', 'Helpers'])
  mkdirSync(join(app, 'Contents', dir), { recursive: true });
run('xcrun', [
  'swiftc',
  ...flags,
  'desktop/Sources/Core.swift',
  'desktop/Sources/App.swift',
  '-o',
  join(app, 'Contents/MacOS/Playtrace'),
]);
run('xcrun', [
  'swiftc',
  ...flags,
  '-parse-as-library',
  'desktop/Sources/Icon.swift',
  '-o',
  join(build, 'make-icon'),
]);
run(join(build, 'make-icon'), [join(build, 'Playtrace.iconset')]);
run('iconutil', [
  '-c',
  'icns',
  join(build, 'Playtrace.iconset'),
  '-o',
  join(app, 'Contents/Resources/Playtrace.icns'),
]);
cpSync('desktop/Info.plist', join(app, 'Contents/Info.plist'));
cpSync('dist/desktop-web', join(app, 'Contents/Resources/Web'), { recursive: true });
cpSync(join(out, 'playtrace'), join(app, 'Contents/Helpers/playtrace'));
cpSync(join(build, 'schema.json'), join(app, 'Contents/Resources/schema.json'));
cpSync('desktop/CLI-Guide.html', join(app, 'Contents/Resources/CLI-Guide.html'));
let htmlPath = join(app, 'Contents/Resources/Web/index.html');
let html = readFileSync(htmlPath, 'utf8');
// Native bridge is the only API transport. External images/fonts can render;
// frames, remote scripts, forms and network fetch are not granted.
html = html.replace(
  '<head>',
  `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src https: data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'">`,
);
writeFileSync(htmlPath, html);
run('codesign', [
  '--force',
  '--sign',
  '-',
  '--options',
  'runtime',
  join(app, 'Contents/Helpers/playtrace'),
]);
run('codesign', [
  '--force',
  '--sign',
  '-',
  '--options',
  'runtime',
  '--entitlements',
  'desktop/entitlements.plist',
  app,
]);
run('codesign', ['--verify', '--deep', '--strict', app]);
run('codesign', ['--force', '--sign', '-', '--options', 'runtime', join(out, 'playtrace')]);
if (!process.argv.includes('--skip-dmg')) {
  const stage = join(build, 'dmg-stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  cpSync(app, join(stage, 'Playtrace.app'), { recursive: true });
  cpSync(join(out, 'playtrace'), join(stage, 'playtrace'));
  cpSync('desktop/Install CLI.command', join(stage, 'Install CLI.command'));
  cpSync('desktop/CLI-Guide.html', join(stage, '先读我.html'));
  symlinkSync('/Applications', join(stage, 'Applications'));
  const dmg = join(out, 'Playtrace-0.4.0-arm64.dmg');
  run('hdiutil', [
    'create',
    '-volname',
    'Playtrace',
    '-srcfolder',
    stage,
    '-ov',
    '-format',
    'UDZO',
    dmg,
  ]);
  writeFileSync(
    join(out, 'SHA256SUMS.txt'),
    ['Playtrace-0.4.0-arm64.dmg', 'playtrace']
      .map(
        (name) =>
          `${createHash('sha256')
            .update(readFileSync(join(out, name)))
            .digest('hex')}  ${name}`,
      )
      .join('\n') + '\n',
  );
}
console.log(
  `Built: ${app}\nCLI: ${join(out, 'playtrace')}\nApple Silicon · macOS 13+ · ad-hoc signed (not notarized)`,
);
