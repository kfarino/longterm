// Longterm/data/test-longterm-paths.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Locks
// in the ~/.longterm/<service>.env naming convention every credential-
// reading script in this codebase relies on. Run with:
//   node Longterm/data/test-longterm-paths.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { longtermHome, ticketmasterEnvPath } from '../scripts/longterm-paths.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
console.log('test-longterm-paths.mjs');

test('ticketmasterEnvPath returns ~/.longterm/ticketmaster.env', () => {
  const expected = path.join(os.homedir(), '.longterm', 'ticketmaster.env');
  assert.equal(ticketmasterEnvPath(), expected);
  assert.equal(ticketmasterEnvPath(), path.join(longtermHome(), 'ticketmaster.env'));
});

console.log('All longterm-paths tests passed.');
