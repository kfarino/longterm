// Covers scripts/longterm-paths.mjs Monarch MCP launch: Smart App Control
// blocks the unsigned pip console-script stub (monarch-mcp-jamiew.exe).
// Spawn signed venv python instead. Invented paths only — no real env files.
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveMonarchMcpLaunch, monarchMcpPythonPath, monarchMcpLaunchArgs } from '../scripts/longterm-paths.mjs';

console.log('test-longterm-paths.mjs');

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

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
