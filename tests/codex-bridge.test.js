import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexBridge } from '../src/codex-bridge.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const temporaryRoot = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted']);
async function environment(t, options = {}) {
  await fs.mkdir(temporaryRoot, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(temporaryRoot, 'codex-bridge-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return { workspace, bridge: createCodexBridge({ workspace, command: process.execPath, commandArgs: [fixture], ...options }) };
}
async function untilFinished(bridge, id) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const job = await bridge.get(id);
    if (terminal.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Fixture job did not finish');
}

test('background job captures exact argv, stdin, final answer, events and exit status', async (t) => {
  const { bridge, workspace } = await environment(t);
  const message = '中文 spaces "quotes" & | $() `not-a-command`';
  const started = await bridge.start({ prompt: JSON.stringify({ message }), taskId: 'task-1', model: 'fixture-model' });
  assert.equal(started.status, 'running');
  const job = await untilFinished(bridge, started.id);
  assert.equal(job.status, 'completed'); assert.equal(job.exitCode, 0);
  assert.equal(job.threadId, 'fixture-thread-id'); assert.equal(job.taskId, 'task-1');
  const result = JSON.parse(await fs.readFile(job.files.final, 'utf8'));
  assert.equal(result.prompt, message); assert.equal(result.cwd, await fs.realpath(workspace));
  assert.equal(result.args.at(-1), '-');
  assert.equal(result.args[result.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(result.args[result.args.indexOf('-a') + 1], 'never');
  assert.ok(!result.args.includes(message));
  assert.deepEqual(job.usage, { input_tokens: 11, output_tokens: 22 });
  assert.equal((await bridge.list()).length, 1);
  assert.match(await fs.readFile(job.files.events, 'utf8'), /turn.completed/);
});

test('write mode needs a host setting and no bypass flags are introduced', async (t) => {
  const { bridge, workspace } = await environment(t);
  await assert.rejects(bridge.start({ prompt: '{}', mode: 'workspace-write' }), { code: 'WRITE_DISABLED' });
  await assert.rejects(bridge.start({ prompt: '{}', mode: 'danger-full-access' }), { code: 'INVALID_MODE' });
  const enabled = createCodexBridge({ workspace, command: process.execPath, commandArgs: [fixture], allowWrite: true });
  const job = await untilFinished(enabled, (await enabled.start({ prompt: '{}', mode: 'workspace-write' })).id);
  assert.equal(job.status, 'completed');
  assert.equal(job.args[job.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(job.args.every((arg) => !arg.includes('bypass')));
});

test('nonzero exits and failed turns stay failed and preserve stderr', async (t) => {
  const { bridge } = await environment(t);
  const job = await untilFinished(bridge, (await bridge.start({ prompt: '{"scenario":"failure"}' })).id);
  assert.equal(job.status, 'failed'); assert.equal(job.exitCode, 7);
  assert.match(job.error, /fixture failed turn/);
  assert.equal(await fs.readFile(job.files.stderr, 'utf8'), 'fixture failure\n');
});

test('malformed JSONL and missing completion events cannot report success', async (t) => {
  const { bridge } = await environment(t);
  for (const scenario of ['malformed', 'incomplete']) {
    const job = await untilFinished(bridge, (await bridge.start({ prompt: JSON.stringify({ scenario }) })).id);
    assert.equal(job.status, 'failed');
    if (scenario === 'malformed') assert.equal(job.malformedEvents, 1);
  }
});

test('a final agent_message is retained when the CLI omits the final output file', async (t) => {
  const { bridge } = await environment(t);
  const job = await untilFinished(bridge, (await bridge.start({ prompt: '{"scenario":"event-only"}' })).id);
  assert.equal(job.status, 'completed');
  assert.ok((await fs.readFile(job.files.final, 'utf8')).includes('args'));
});

test('timeout stops the process and releases the workspace slot', async (t) => {
  const { bridge } = await environment(t, { timeoutMs: 200 });
  const job = await untilFinished(bridge, (await bridge.start({ prompt: '{"scenario":"hang"}' })).id);
  assert.equal(job.status, 'timed_out');
  assert.equal((await untilFinished(bridge, (await bridge.start({ prompt: '{}' })).id)).status, 'completed');
});

test('cancel works across bridge instances without killing an arbitrary stored pid', async (t) => {
  const { bridge, workspace } = await environment(t);
  const started = await bridge.start({ prompt: '{"scenario":"hang"}' });
  const second = createCodexBridge({ workspace, command: process.execPath, commandArgs: [fixture] });
  const cancelled = await second.cancel(started.id);
  assert.equal(cancelled.cancellationRequested, true);
  assert.equal((await untilFinished(second, started.id)).status, 'cancelled');
});

test('concurrency is enforced across independent bridge instances', async (t) => {
  const { bridge, workspace } = await environment(t);
  const started = await bridge.start({ prompt: '{"scenario":"hang"}' });
  const second = createCodexBridge({ workspace, command: process.execPath, commandArgs: [fixture] });
  await assert.rejects(second.start({ prompt: '{}' }), { code: 'CONCURRENCY_LIMIT' });
  await bridge.cancel(started.id); await untilFinished(bridge, started.id);
});

test('combined output and final-file sizes have bounded failure states', async (t) => {
  const { bridge } = await environment(t, { maxOutputBytes: 4096 });
  for (const scenario of ['flood', 'huge-final']) {
    const job = await untilFinished(bridge, (await bridge.start({ prompt: JSON.stringify({ scenario }) })).id);
    assert.equal(job.status, 'output_limit');
    assert.ok((await fs.stat(job.files.events)).size <= 4096);
  }
});

test('state path traversal and junctions are rejected', async (t) => {
  const { workspace } = await environment(t);
  const outside = await fs.mkdtemp(path.join(temporaryRoot, 'codex-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const escaped = createCodexBridge({ workspace, stateDir: outside, command: process.execPath, commandArgs: [fixture] });
  await assert.rejects(escaped.start({ prompt: '{}' }), { code: 'PATH_ESCAPE' });
  const junction = path.join(workspace, 'linked-state');
  try { await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) {
    // Some restricted Windows runners deny link creation even in temp/workspace paths.
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
      assert.deepEqual(await fs.readdir(outside), []);
      return;
    }
    throw e;
  }
  const symlinked = createCodexBridge({ workspace, stateDir: 'linked-state', command: process.execPath, commandArgs: [fixture] });
  await assert.rejects(symlinked.start({ prompt: '{}' }), { code: 'PATH_ESCAPE' });
  assert.deepEqual(await fs.readdir(outside), []);
});

test('invalid ids, prompts, models and shell wrappers fail before launching', async (t) => {
  const { bridge, workspace } = await environment(t);
  await assert.rejects(bridge.get('../job.json'), { code: 'INVALID_JOB_ID' });
  await assert.rejects(bridge.start({ prompt: '' }), { code: 'INVALID_PROMPT' });
  await assert.rejects(bridge.start({ prompt: '{}', model: '--unsafe' }), { code: 'INVALID_MODEL' });
  const wrapper = createCodexBridge({ workspace, command: 'codex.cmd' });
  await assert.rejects(wrapper.start({ prompt: '{}' }), { code: 'COMMAND_WRAPPER' });
});

test('doctor probes local flags only and does not claim authentication or a model run', async (t) => {
  const { bridge } = await environment(t);
  const report = await bridge.doctor();
  assert.equal(report.available, true); assert.match(report.version, /test-fixture/);
  assert.equal(report.authentication, 'not_checked'); assert.equal(report.modelInvocation, 'not_performed');
});
