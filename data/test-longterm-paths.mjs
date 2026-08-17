// Longterm/data/test-longterm-paths.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Locks
// in the ~/.longterm/<service>.env naming convention every credential-
// reading script in this codebase relies on, plus the Monarch MCP launch
// (signed venv python, not the unsigned pip stub SAC blocks). Run with:
//   node Longterm/data/test-longterm-paths.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  longtermHome,
  ticketmasterEnvPath,
  resolveMonarchMcpLaunch,
  monarchMcpPythonPath,
  monarchMcpLaunchArgs,
} from '../scripts/longterm-paths.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
console.log('test-longterm-paths.mjs');

test('ticketmasterEnvPath returns ~/.longterm/ticketmaster.env', () => {
  const expected = path.join(os.homedir(), '.longterm', 'ticketmaster.env');
  assert.equal(ticketmasterEnvPath(), expected);
  assert.equal(ticketmasterEnvPath(), path.join(longtermHome(), 'ticketmaster.env'));
});

test('default / jamiew stub / python all launch signed venv python -c', () => {
  const expected = { command: monarchMcpPythonPath(), args: monarchMcpLaunchArgs() };
  assert.deepEqual(resolveMonarchMcpLaunch(), expected);
  assert.deepEqual(resolveMonarchMcpLaunch(path.join('C:', 'Users', 'Family', '.longterm', 'monarch-mcp-venv', 'Scripts', 'monarch-mcp-jamiew.exe')), expected);
  assert.deepEqual(resolveMonarchMcpLaunch(expected.command), expected);
  assert.equal(path.basename(expected.command).toLowerCase(), process.platform === 'win32' ? 'python.exe' : 'python');
  assert.deepEqual(expected.args, ['-c', 'from server import run; run()']);
});

test('an explicit non-python override (tests / fake server) is spawned as-is', () => {
  const fake = path.join('C:', 'tmp', 'fake-mcp-server.exe');
  assert.deepEqual(resolveMonarchMcpLaunch(fake), { command: fake, args: [] });
});

console.log('All longterm-paths tests passed.');
