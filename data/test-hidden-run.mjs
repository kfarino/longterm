// data/test-hidden-run.mjs
//
// The scheduled-task host (run-hidden.vbs) must pass through the child exit
// code and run the script — that is what Task Scheduler sees as success/fail.
// Window hiding is a Windows property we cannot assert here; the installer
// comments + live task Execute=wscript.exe are the other half of the contract.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('test-hidden-run.mjs');

if (process.platform !== 'win32') {
  console.log('  skip - not Windows');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const vbs = path.join(here, '..', 'scripts', 'run-hidden.vbs');
const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
assert.ok(fs.existsSync(vbs), 'run-hidden.vbs missing');
assert.ok(fs.existsSync(wscript), 'wscript.exe missing');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'longterm-hidden-run-'));
const childScript = path.join(tmp, 'child.mjs');
const marker = path.join(tmp, 'marker.txt');
fs.writeFileSync(
  childScript,
  `import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], 'ok');\nprocess.exit(7);\n`
);

const result = spawnSync(
  wscript,
  ['//nologo', '//B', vbs, process.execPath, childScript, marker],
  { encoding: 'utf8' }
);

assert.equal(result.status, 7, `wscript exit ${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
assert.equal(fs.readFileSync(marker, 'utf8'), 'ok');
console.log('  ok - hidden launcher runs node and forwards exit code');
