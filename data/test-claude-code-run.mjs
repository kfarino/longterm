// Covers scripts/claude-code-run.mjs: detached launcher spawn + request
// status transitions. Never invokes a real `claude` binary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnDetachedLauncher, runCapabilityRequest, buildCapabilityPrompt } from '../scripts/claude-code-run.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-run-test-'));

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

async function asyncTest(name, fn) {
  await fn();
  console.log(`  ok - ${name}`);
}

console.log('test-claude-code-run.mjs');

test('buildCapabilityPrompt names the ask and the privacy rules', () => {
  const prompt = buildCapabilityPrompt({
    ask: 'weekly recurring reminders',
    whyCant: 'add_reminder is one-off',
    proposedChange: 'add recurrenceWeeks',
  });
  assert.match(prompt, /weekly recurring reminders/);
  assert.match(prompt, /add_reminder is one-off/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /gitignored/);
});

test('spawnDetachedLauncher starts the runner detached with the request id', () => {
  const calls = [];
  const fakeChild = { pid: 4242, unref() { calls.push('unref'); } };
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return fakeChild;
  };
  const result = spawnDetachedLauncher({
    execPath: '/fake/node',
    launcherPath: '/fake/claude-code-run.mjs',
    requestId: 'c1',
    requestsPath: '/tmp/requests.json',
    spawnFn,
  });
  assert.equal(result.pid, 4242);
  assert.equal(calls[0].cmd, '/fake/node');
  assert.ok(calls[0].args.includes('--request-id'));
  assert.ok(calls[0].args.includes('c1'));
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.ok(calls.includes('unref'));
});

await asyncTest('runCapabilityRequest marks the item done after a successful claude run', async () => {
  const dir = path.join(tmpRoot, 'success');
  fs.mkdirSync(dir, { recursive: true });
  const requestsPath = path.join(dir, 'requests.json');
  fs.writeFileSync(requestsPath, JSON.stringify({
    items: [{ id: 'c1', ask: 'weekly reminders', status: 'launched' }],
  }));
  const notices = [];
  await runCapabilityRequest({
    requestId: 'c1',
    requestsPath,
    repoRoot: dir,
    claudeFn: async () => ({ ok: true }),
    notifyFn: async (text) => { notices.push(text); },
  });
  const onDisk = JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
  assert.equal(onDisk.items[0].status, 'done');
  assert.ok(onDisk.items[0].resolvedAt);
  assert.match(notices[0], /finished/i);
});

await asyncTest('runCapabilityRequest marks the item failed when claude exits poorly, and still notifies', async () => {
  const dir = path.join(tmpRoot, 'fail');
  fs.mkdirSync(dir, { recursive: true });
  const requestsPath = path.join(dir, 'requests.json');
  fs.writeFileSync(requestsPath, JSON.stringify({
    items: [{ id: 'c1', ask: 'weekly reminders', status: 'launched' }],
  }));
  const notices = [];
  await runCapabilityRequest({
    requestId: 'c1',
    requestsPath,
    repoRoot: dir,
    claudeFn: async () => ({ ok: false, error: 'exit 1' }),
    notifyFn: async (text) => { notices.push(text); },
  });
  const onDisk = JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
  assert.equal(onDisk.items[0].status, 'failed');
  assert.match(onDisk.items[0].error, /exit 1/);
  assert.match(notices[0], /failed/i);
});

console.log('All claude-code-run tests passed.');
