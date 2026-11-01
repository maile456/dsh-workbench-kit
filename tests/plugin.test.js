import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bundledSkillProvider, commandForShell, createNativeRunner, registerWorkbench } from '../src/plugin-runtime.js';

async function fixture(t, overrides = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-plugin-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspace = await realpath(temp);
  const skillsRoot = join(workspace, 'skills');
  await mkdir(join(skillsRoot, 'workbench-test'), { recursive: true });
  await writeFile(join(skillsRoot, 'workbench-test', 'SKILL.md'), '---\nname: workbench-test\ndescription: Test skill\n---\nVerify the generated file.\n');
  const calls = [];
  const tools = new Map();
  const providers = [];
  let policy = { mode: 'workspace-write', workspaceRoot: workspace };
  const ctx = {
    workingDirectory: { ensure: async () => workspace },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); }, schemas: () => [...tools.values()] },
    skills: { registerProvider(create) { providers.push(create()); return () => providers.pop(); } },
    approval: { async request(request) { calls.push(['approval', request]); return 'allowed-once'; } },
    sandboxPolicy: { resolve: () => policy },
    shell: {
      sandboxMode: 'workspace-write', resolve: (spec) => spec,
      async execute(spec) {
        calls.push(['shell', spec]);
        return { result: async () => ({ exitCode: 0, stdout: { text: 'OK\n', truncated: false }, stderr: { text: '', truncated: false } }) };
      },
    },
    get(name) { return this[name]; },
    ...overrides.ctx,
  };
  const core = {
    createTask: async (args) => { calls.push(['createTask', args]); return { id: 'task-1', ...args }; },
    getTask: async (id) => ({ id }), listTasks: async () => [],
    updateTask: async (args) => args,
    verifyTask: async (args) => { calls.push(['verifyTask', args]); return args.runner({ ...args, cwd: workspace, maxBytes: 65536 }); },
    addArtifact: async (args) => args, completeTask: async (id) => ({ id, status: 'complete' }), doctor: async () => ({ ok: true }),
  };
  const bridge = {
    start: async (args) => { calls.push(['codexStart', args]); return { id: 'job-1', status: 'running' }; },
    get: async (id) => ({ id, status: 'complete' }), list: async () => [],
    cancel: async (id) => ({ id, status: 'cancelled' }),
  };
  const dependencies = {
    defineTool: (definition) => definition,
    createWorkbench: async (directory) => { calls.push(['factory', directory]); return core; },
    createCodexBridge: (options) => { calls.push(['bridgeFactory', options]); return bridge; }, skillsRoot,
    ...overrides.dependencies,
  };
  const registration = registerWorkbench(ctx, overrides.config ?? {}, dependencies);
  const exec = { agent: { id: 'agent-1', session: { id: 'session-1', header: { cwd: workspace } } }, callId: 'call-1', signal: new AbortController().signal };
  return { workspace, ctx, tools, providers, calls, core, bridge, dependencies, exec, registration,
    setPolicy(value) { policy = value; },
    run: (name, args = {}, execution = exec) => tools.get(name).execute(args, execution),
  };
}

test('native tools use current session directory and expose no workspace selector', async (t) => {
  const f = await fixture(t);
  assert.equal(f.tools.size, 12);
  await f.run('workbench_plan', { title: 'report', goal: 'write report', acceptance: ['report exists'] });
  assert.deepEqual(f.calls[0], ['factory', f.workspace]);
  for (const tool of f.tools.values()) assert.equal(Object.hasOwn(tool.parameters, 'workspace'), false);
  await assert.rejects(f.run('workbench_list', {}, { ...f.exec, agent: undefined }), /active DSH agent/);
});

test('read-only host policy blocks ledger writes and new Codex jobs before creating state', async (t) => {
  const f = await fixture(t);
  f.setPolicy({ mode: 'read-only', workspaceRoot: f.workspace });
  await assert.rejects(f.run('workbench_plan', {}), /read-only/);
  await assert.rejects(f.run('codex_start', { prompt: 'review' }), /read-only/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.run('workbench_list'), []);
});

test('a changed cwd outside original writable root is blocked', async (t) => {
  const f = await fixture(t);
  const otherRoot = join(f.workspace, 'other');
  await mkdir(otherRoot);
  f.setPolicy({ mode: 'workspace-write', workspaceRoot: otherRoot });
  await assert.rejects(f.run('workbench_plan', {}), /outside the session writable/);
  assert.equal(f.calls.length, 0);
});

test('verification approval succeeds and original policy reaches DSH shell', async (t) => {
  const f = await fixture(t);
  const result = await f.run('workbench_verify', { taskId: 'task-1', criterion: 1, command: 'node', args: ['check.mjs'] });
  assert.equal(result.status, 'passed');
  assert.equal(f.calls[0][0], 'approval');
  const shell = f.calls.find(([type]) => type === 'shell')[1];
  assert.equal(shell.sandboxPolicy.mode, 'workspace-write');
  assert.equal(shell.sandboxPolicy.workspaceRoot, f.workspace);
  assert.equal(shell.signal, f.exec.signal);
  assert.equal(shell.onExpiry, 'kill');
});

test('missing, rejected, unavailable, cancelled and unexpected approvals never execute', async (t) => {
  for (const outcome of [null, 'rejected', 'unavailable', 'cancelled', 'allowed-always']) {
    const f = await fixture(t);
    f.ctx.approval = outcome === null ? undefined : { request: async () => outcome };
    await assert.rejects(f.run('workbench_verify', { taskId: 'task-1', criterion: 1, command: 'node', args: [] }), /approval|approved/);
    assert.equal(f.calls.filter(([type]) => ['verifyTask', 'shell', 'factory'].includes(type)).length, 0);
  }
});

test('verification never falls back to unrestricted host spawning', async (t) => {
  const f = await fixture(t);
  f.ctx.shell = undefined;
  await assert.rejects(f.run('workbench_verify', { taskId: 't', criterion: 1, command: 'node', args: [] }), /shell service/);
  f.ctx.shell = { resolve() {}, execute() {} };
  await assert.rejects(f.run('workbench_verify', { taskId: 't', criterion: 1, command: 'node', args: [] }), /does not enforce/);
});

test('policy changes during approval prevent execution', async (t) => {
  const f = await fixture(t);
  f.ctx.approval.request = async () => { f.setPolicy({ mode: 'read-only', workspaceRoot: f.workspace }); return 'allowed-once'; };
  await assert.rejects(f.run('workbench_verify', { taskId: 't', criterion: 1, command: 'node', args: [] }), /read-only/);
  assert.equal(f.calls.filter(([type]) => type === 'shell').length, 0);
});

test('Codex writes require host configuration and approval', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run('codex_start', { prompt: 'edit', mode: 'workspace-write' }), /write mode is disabled/);
  await f.run('codex_start', { prompt: 'review', taskId: 'task-1' });
  const factory = f.calls.find(([type]) => type === 'bridgeFactory')[1];
  assert.equal(factory.allowWrite, false);
  assert.equal(factory.workspace, f.workspace);
  assert.equal(f.calls[0][0], 'approval');
});

test('disabled bridge exposes no Codex tools, disabled verification does not request approval', async (t) => {
  const f = await fixture(t, { config: { enableCodex: false, allowVerificationCommands: false } });
  assert.equal(f.tools.size, 8);
  await assert.rejects(f.run('workbench_verify', { taskId: 't', criterion: 1, command: 'node', args: [] }), /disabled/);
  assert.equal(f.calls.length, 0);
});

test('already aborted tools do not create state or request approval', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort(new Error('test abort'));
  await assert.rejects(f.run('workbench_plan', {}, { ...f.exec, signal: controller.signal }), /test abort/);
  assert.equal(f.calls.length, 0);
});

test('native runner propagates timeout, cancellation, nonzero exits and output truncation', async (t) => {
  const f = await fixture(t);
  for (const [result, expected] of [
    [{ exitCode: 3 }, 'failed'], [{ timedOut: true }, 'timed_out'], [{ aborted: true }, 'cancelled'],
    [{ exitCode: 0, stdout: { text: 'partial', truncated: true } }, 'output_limit'],
    [{ exitCode: 0, sandbox: { denied: true } }, 'spawn_error'],
  ]) {
    f.ctx.shell.execute = async () => ({ result: async () => result });
    const runner = createNativeRunner(f.ctx, f.exec, { mode: 'workspace-write', workspaceRoot: f.workspace }, {});
    assert.equal((await runner({ command: 'node', args: [], cwd: f.workspace })).status, expected);
  }
});

test('shell literals preserve dollar, backtick, quotes, spaces and newline as data', () => {
  const args = ['space value', "single'quote", '"double"', '$(Write-Output INJECTION)', '`echo injection`', 'line\nbreak', '; echo injected'];
  const dialect = process.platform === 'win32' ? 'powershell' : 'bash';
  const text = commandForShell(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...args], dialect);
  const result = process.platform === 'win32'
    ? spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', text], { encoding: 'utf8', windowsHide: true })
    : spawnSync('bash', ['-c', text], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), args);
  assert.throws(() => commandForShell('npm.cmd', [], 'powershell'), /command shim/);
  assert.throws(() => commandForShell('node', ['\0'], 'bash'), /NUL/);
});

test('bundled skill discovery and loading reject path escape and keep instructions', async (t) => {
  const f = await fixture(t);
  const provider = bundledSkillProvider(f.dependencies.skillsRoot);
  const [candidate] = await provider.list();
  assert.equal(candidate.name, 'workbench-test');
  assert.equal((await provider.get(candidate)).content, 'Verify the generated file.');
  const outside = join(f.workspace, 'outside.md'); await writeFile(outside, 'outside');
  await assert.rejects(provider.get({ ...candidate, locator: outside }), /outside the bundled/);
  await f.registration.dispose();
  assert.equal(f.tools.size, 0);
  assert.equal(f.providers.length, 0);
});

test('installed DSH defineTool compiles and validates all 12 real schemas', { skip: !process.env.DSH_HOST_NODE_MODULES }, async (t) => {
  const toolsPath = join(process.env.DSH_HOST_NODE_MODULES, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
  const { defineTool } = await import(pathToFileURL(toolsPath).href);
  const f = await fixture(t, { dependencies: { defineTool } });
  for (const tool of f.tools.values()) assert.equal(tool.parameters.type, 'object');
  await assert.rejects(f.run('workbench_plan', { title: 1 }), /argument|expected|required|type/i);
  const task = await f.run('workbench_plan', { title: 'report', goal: 'ready report', acceptance: ['file exists'] });
  assert.equal(task.id, 'task-1');
});
