// The dashboard has no login of its own. Hanna's computer is allowed in only
// through Tailscale, and SSH is public-key only. These strings are the lock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('test-remote-access.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const installer = fs.readFileSync(path.join(root, 'scripts', 'install-remote-access.ps1'), 'utf8');
const server = fs.readFileSync(path.join(root, 'scripts', 'dashboard-server.mjs'), 'utf8');

assert.match(installer, /PasswordAuthentication no/);
assert.match(installer, /AuthenticationMethods publickey/);
assert.match(installer, /127\.0\.0\.1:4200/);
assert.match(installer, /Longterm-SSH-Tailscale/);
assert.match(installer, /InterfaceAlias \$adapter\.Name/);
assert.match(installer, /ServeOnly/);
assert.doesNotMatch(installer, /tailscale funnel/i);
assert.doesNotMatch(installer, /0\.0\.0\.0/);
assert.match(server, /server\.listen\(PORT, '127\.0\.0\.1'/);

console.log('  ok - remote access stays on Tailscale, public-key SSH, localhost dashboard');
