#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = import.meta.dirname;
const generatedServer = join(root, 'dist', 'standalone', 'server.js');
const vinextCli = join(root, 'node_modules', 'vinext', 'dist', 'cli.js');

if (!existsSync(vinextCli)) {
  console.error('Hunt Assist dependencies are missing. Run `npm install` once while online.');
  process.exit(1);
}

if (!existsSync(generatedServer)) {
  console.log('No production build found; building Hunt Assist now…');
  const build = spawnSync(process.execPath, [vinextCli, 'build'], {
    cwd: root,
    stdio: 'inherit',
  });

  if (build.status !== 0 || !existsSync(generatedServer)) {
    console.error('Hunt Assist could not create its production build.');
    process.exit(build.status ?? 1);
  }
}

process.env.HUNT_ASSIST_OFFLINE ??= '1';
process.env.HOST ??= '127.0.0.1';
process.env.PORT ??= '4317';

console.log(`Opening Hunt Assist offline at http://${process.env.HOST}:${process.env.PORT}/#bear-targets`);
await import(pathToFileURL(generatedServer).href);
