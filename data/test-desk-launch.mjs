// Covers the Helios-style Family Planner desktop launcher: silent wscript
// wrapper, PowerShell that starts dashboard-server.mjs on 4200, shortcut
// installer pointing at that vbs. The live "open a browser" path is
// Windows-only and not asserted here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('test-desk-launch.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', 'scripts');
const vbs = fs.readFileSync(path.join(scripts, 'launch-desk.vbs'), 'utf8');
const ps1 = fs.readFileSync(path.join(scripts, 'launch-desk.ps1'), 'utf8');
const install = fs.readFileSync(path.join(scripts, 'install-desk-shortcut.ps1'), 'utf8');

assert.match(vbs, /launch-desk\.ps1/);
assert.match(vbs, /WindowStyle Hidden/);
assert.match(ps1, /dashboard-server\.mjs/);
assert.match(ps1, /\$Port = 4200/);
assert.match(ps1, /CreateNoWindow/);
assert.match(ps1, /never kill or steal 4200/);
assert.match(install, /Family Planner\.lnk/);
assert.match(install, /wscript\.exe/);
assert.match(install, /launch-desk\.vbs/);
assert.ok(fs.existsSync(path.join(scripts, 'family-planner.ico')), 'family-planner.ico missing');
console.log('  ok - desktop launcher scripts match the Helios desk contract');
