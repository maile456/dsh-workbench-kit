import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const providerName = 'dsh-workbench-kit';
const requiredString = (description) => ({ type: 'string', required: true, description });
const taskId = requiredString('Task ID returned by workbench_plan.');
const jobId = requiredString('Job ID returned by codex_start.');
const criterion = { type: 'integer', required: true, description: 'Acceptance criterion number, starting at 1.' };

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation cancelled.');
}

function service(ctx, name) {
  return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
}

function contained(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export async function resolveWorkspace(ctx, exec, { write = false } = {}) {
  throwIfAborted(exec?.signal);
  if (!exec?.agent) throw new Error('Workbench requires an active DSH agent and session.');
  const directory = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('The session has no absolute local workspace.');
  const workspace = await realpath(directory);
  const policy = await service(ctx, 'sandboxPolicy')?.resolve?.({ session: exec.agent.session });
  if (write && policy?.mode === 'read-only') {
    throw new Error('This session is read-only. Select workspace-write in DSH before creating task records or starting a job.');
  }
  if (write && policy?.mode === 'workspace-write') {
    const root = await realpath(policy.workspaceRoot);
    if (!contained(root, workspace)) throw new Error('Current directory is outside the session writable workspace.');
  }
  throwIfAborted(exec.signal);
  return { workspace, policy };
}

export async function requestApproval(ctx, exec, toolName, reason) {
  throwIfAborted(exec.signal);
  const approval = service(ctx, 'approval');
  if (!approval || typeof approval.request !== 'function') {
    throw new Error('DSH approval service is required for command execution and Codex delegation.');
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName,
    callId: exec.callId,
    reason,
    displayReason: reason,
    signal: exec.signal,
  });
  throwIfAborted(exec.signal);
  if (outcome !== 'allowed-once') throw new Error(`Execution was not approved (${String(outcome)}).`);
}

/** Quote each argv entry as one literal; no model-provided shell program is interpolated. */
export function commandForShell(command, args, dialect) {
  if (typeof command !== 'string' || !command.trim() || !Array.isArray(args) ||
      [command, ...args].some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('Expected a nonempty command and string arguments without NUL characters.');
  }
  if (/\.(?:cmd|bat|ps1)$/i.test(command)) throw new Error('Use an executable or node plus an explicit CLI script instead of a command shim.');
  if (dialect === 'powershell') {
    // PowerShell receives -Command through a platform-specific argv parser. A
    // base64 JSON payload avoids nested quote/backtick/$ expansion entirely,
    // then splatting preserves each argument as one literal value.
    const payload = Buffer.from(JSON.stringify({ command, args }), 'utf8').toString('base64');
    return `$ErrorActionPreference = 'Stop'; $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; function Quote-Win32([string]$s) { if ($null -eq $s) { $s = '' }; $r = '"'; $slashes = 0; foreach ($ch in $s.ToCharArray()) { if ($ch -eq '\\') { $slashes++; continue }; if ($ch -eq '"') { $r += ('\\' * (2 * $slashes + 1) -join '') + '"'; $slashes = 0; continue }; $r += ('\\' * $slashes -join '') + $ch; $slashes = 0 }; $r += ('\\' * (2 * $slashes) -join '') + '"'; $r }; $i = [Diagnostics.ProcessStartInfo]::new(); $i.FileName = [string]$p.command; $i.UseShellExecute = $false; $i.Arguments = ((@($p.args) | ForEach-Object { Quote-Win32 ([string]$_) }) -join ' '); $x = [Diagnostics.Process]::new(); $x.StartInfo = $i; [void]$x.Start(); $x.WaitForExit(); exit $x.ExitCode`;
  }
  if (dialect === 'bash') {
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    return `exec ${[command, ...args].map(quote).join(' ')}`;
  }
  throw new Error('shellDialect must be powershell or bash.');
}

export function createNativeRunner(ctx, exec, policy, config) {
  const shell = service(ctx, 'shell');
  if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') {
    throw new Error('DSH shell service is required; Workbench does not fall back to an unrestricted host process.');
  }
  if (policy && policy.mode !== 'danger-full-access' && shell.sandboxMode === undefined) {
    throw new Error('The selected DSH shell does not enforce the current file policy. Select the DSH sandboxed shell provider.');
  }
  const dialect = config.shellDialect && config.shellDialect !== 'auto'
    ? config.shellDialect : ('pwshPath' in shell || process.platform === 'win32' ? 'powershell' : 'bash');
  return async ({ command, args = [], cwd, timeoutMs = 120000, signal, maxBytes = 262144 }) => {
    const start = Date.now();
    const runSignal = signal ?? exec.signal;
    throwIfAborted(runSignal);
    const spec = shell.resolve({
      command: commandForShell(command, args, dialect),
      workdir: cwd,
      timeoutMs,
      onExpiry: 'kill',
      stdoutMaxBytes: maxBytes,
      signal: runSignal,
      ...(policy ? { sandboxPolicy: policy } : {}),
      ...(service(ctx, 'shellEnv') ? { dshEnv: service(ctx, 'shellEnv').collect(exec) } : {}),
    });
    const result = await (await shell.execute(spec)).result();
    const stdout = result.stdout?.text ?? '';
    const stderr = result.stderr?.text ?? '';
    const truncated = Boolean(result.stdout?.truncated || result.stderr?.truncated);
    const outputBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    const status = result.aborted ? 'cancelled' : result.timedOut ? 'timed_out'
      : truncated || outputBytes > maxBytes ? 'output_limit'
        : result.sandbox?.denied || result.sandbox?.runnerFailed ? 'spawn_error'
          : result.exitCode === 0 ? 'passed' : 'failed';
    return {
      executable: command, args, cwd, status,
      exitCode: result.exitCode ?? null, signal: result.signal ?? null,
      stdout: Buffer.from(stdout).subarray(0, maxBytes).toString('utf8'),
      stderr: Buffer.from(stderr).subarray(0, maxBytes).toString('utf8'),
      durationMs: Date.now() - start, outputBytes,
    };
  };
}

function parseSkill(raw, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!match) throw new Error(`Skill has no frontmatter: ${path}`);
  const field = (key) => {
    const value = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1])?.[1]?.trim();
    return value?.replace(/^(["'])([\s\S]*)\1$/, '$2');
  };
  const name = field('name');
  const description = field('description');
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !description) {
    throw new Error(`Skill needs a kebab-case name and one-line description: ${path}`);
  }
  return { name, description, content: raw.slice(match[0].length).trim() };
}

export function bundledSkillProvider(skillsRoot) {
  return {
    name: providerName,
    async list() {
      const entries = await readdir(skillsRoot, { withFileTypes: true });
      const candidates = [];
      for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(skillsRoot, entry.name, 'SKILL.md');
        const { name, description } = parseSkill(await readFile(path, 'utf8'), path);
        candidates.push({
          name, description, provider: providerName, source: 'bundled', rank: 100,
          invocation: { modelInvocable: true, userInvocable: true },
          resourceBase: { kind: 'directory', path: dirname(path).split(sep).join('/') },
          locator: path, path,
        });
      }
      return candidates;
    },
    async get(candidate, options = {}) {
      const { locator, rank: _rank, ...summary } = candidate;
      const root = await realpath(skillsRoot);
      const target = await realpath(locator);
      if (!contained(root, target)) throw new Error('Skill path is outside the bundled skill directory.');
      const parsed = parseSkill(await readFile(target, { encoding: 'utf8', signal: options.signal }), target);
      if (parsed.name !== candidate.name) throw new Error('Skill name changed after discovery; refresh the skill catalog.');
      return { ...summary, description: parsed.description, content: parsed.content };
    },
  };
}

/** Peer-free implementation allows offline contract tests without downloading DSH. */
export function registerWorkbench(ctx, config = {}, dependencies) {
  const { defineTool, createWorkbench, createCodexBridge, skillsRoot } = dependencies;
  const bridges = new Map();
  const disposers = [];
  const workbench = (workspace) => createWorkbench(workspace, {
    ...(config.dshProfilePath ? { dshProfilePath: config.dshProfilePath } : {}),
  });
  const bridge = (workspace) => {
    if (!bridges.has(workspace)) bridges.set(workspace, createCodexBridge({
      workspace,
      allowWrite: config.allowCodexWrite === true,
      ...(config.codexCommand ? { command: config.codexCommand } : {}),
      ...(config.codexCommandArgs?.length ? { commandArgs: config.codexCommandArgs } : {}),
      timeoutMs: config.codexTimeoutMs ?? 600000,
      maxConcurrent: config.maxConcurrentCodex ?? 1,
    }));
    return bridges.get(workspace);
  };
  const register = (name, description, parameters, handler, write = false) => {
    const disposer = ctx.tools.register(defineTool({
      name, description, parameters,
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      isConcurrencySafe: () => !write,
      async execute(args, exec) {
        const state = await resolveWorkspace(ctx, exec, { write });
        return handler(args, exec, state);
      },
    }));
    if (typeof disposer === 'function') disposers.push(disposer);
  };
  register('workbench_plan', 'Create a persistent task with numbered acceptance criteria in the current workspace.', {
    title: requiredString('Short task title.'), goal: requiredString('Concrete requested outcome.'),
    acceptance: { type: 'array', required: true, items: { type: 'string' }, description: 'Measurable acceptance criteria.' },
  }, async (args, _exec, { workspace }) => (await workbench(workspace)).createTask(args), true);
  register('workbench_status', 'Read task status, evidence, and artifacts.', { taskId },
    async ({ taskId }, _exec, { workspace }) => (await workbench(workspace)).getTask(taskId));
  register('workbench_list', 'List the current workspace task ledger.', {},
    async (_args, _exec, { workspace }) => (await workbench(workspace)).listTasks());
  register('workbench_update', 'Record progress or a blocker; completion uses workbench_complete.', {
    taskId, status: { type: 'string', required: true, enum: ['planned', 'running', 'blocked'] }, note: requiredString('What changed or what blocks progress.'),
  }, async (args, _exec, { workspace }) => (await workbench(workspace)).updateTask(args), true);
  register('workbench_verify', 'Run an explicitly approved verification command through the DSH shell and attach its exit status/output to one acceptance criterion.', {
    taskId, criterion, command: requiredString('Executable name or absolute executable path; no shell command string.'),
    args: { type: 'array', required: true, items: { type: 'string' }, description: 'Executable arguments, each as a separate string.' },
    timeoutMs: { type: 'integer', description: 'Positive timeout in milliseconds; default 120000.' },
  }, async (args, exec, { workspace, policy }) => {
    if (config.allowVerificationCommands === false) throw new Error('Verification command execution is disabled in the plugin configuration.');
    const runner = createNativeRunner(ctx, exec, policy, config);
    await requestApproval(ctx, exec, 'workbench_verify', `在工作区 ${workspace} 执行验收命令并保存结果：${JSON.stringify([args.command, ...args.args])}`);
    const current = await resolveWorkspace(ctx, exec, { write: true });
    if (current.workspace !== workspace || JSON.stringify(current.policy) !== JSON.stringify(policy)) throw new Error('Workspace or file policy changed while awaiting approval; retry the verification.');
    return (await workbench(workspace)).verifyTask({ ...args, runner, signal: exec.signal });
  }, true);
  register('workbench_artifact', 'Register a nonempty workspace deliverable and its content hash. File existence alone is structural evidence, not a visual or semantic review.', {
    taskId, path: requiredString('Deliverable path relative to the current workspace.'),
    criterion: { type: 'integer', description: 'Optional acceptance criterion number starting at 1.' },
  }, async (args, _exec, { workspace }) => (await workbench(workspace)).addArtifact(args), true);
  register('workbench_complete', 'Recheck task evidence and artifact hashes; mark complete only after every criterion passes and an artifact is recorded.', { taskId },
    async ({ taskId }, _exec, { workspace }) => (await workbench(workspace)).completeTask(taskId), true);
  register('workbench_doctor', 'Inspect runtime availability and configured capability plugins without reading credentials.', {},
    async (_args, exec, { workspace, policy }) => ({
      ...await (await workbench(workspace)).doctor(),
      native: {
        filePolicy: policy?.mode ?? 'host-unconfined',
        verificationCommands: config.allowVerificationCommands !== false,
        approvalService: Boolean(service(ctx, 'approval')),
        shellService: Boolean(service(ctx, 'shell')),
        codexEnabled: config.enableCodex !== false,
        codexWriteEnabled: config.allowCodexWrite === true,
        visibleTools: (() => {
          try { return typeof ctx.tools.schemas === 'function' ? ctx.tools.schemas(exec.agent).map((item) => item.name) : []; }
          catch { return []; }
        })(),
      },
    }));
  if (config.enableCodex !== false) {
    register('codex_start', 'Delegate a bounded task to local Codex. Requires DSH approval, stores logs in this workspace, and returns a job ID. Default mode is read-only.', {
      prompt: requiredString('Task, allowed changes, expected deliverables, and verification requirements.'),
      mode: { type: 'string', enum: ['read-only', 'workspace-write'] },
      model: { type: 'string', description: 'Optional available Codex model; omit to use local defaults.' },
      taskId: { type: 'string', description: 'Optional workbench task association.' },
    }, async (args, exec, { workspace, policy }) => {
      if (args.mode === 'workspace-write' && config.allowCodexWrite !== true) throw new Error('Codex write mode is disabled; enable allowCodexWrite in plugin configuration first.');
      await requestApproval(ctx, exec, 'codex_start', `让本机 Codex 在 ${workspace} 以 ${args.mode ?? 'read-only'} 模式执行任务，记录输出并使用本机 Codex 已配置的模型访问：${args.prompt}`);
      const current = await resolveWorkspace(ctx, exec, { write: true });
      if (current.workspace !== workspace || JSON.stringify(current.policy) !== JSON.stringify(policy)) throw new Error('Workspace or file policy changed while awaiting approval; retry delegation.');
      if (args.taskId) await (await workbench(workspace)).getTask(args.taskId);
      return bridge(workspace).start(args);
    }, true);
    register('codex_status', 'Read a delegated Codex job, its final answer, and saved log paths.', { jobId },
      async ({ jobId }, _exec, { workspace }) => bridge(workspace).get(jobId));
    register('codex_list', 'List saved and active Codex jobs in this workspace.', {},
      async (_args, _exec, { workspace }) => bridge(workspace).list());
    register('codex_cancel', 'Cancel a running Codex job in this workspace.', { jobId },
      async ({ jobId }, _exec, { workspace }) => bridge(workspace).cancel(jobId), true);
  }
  const providerDisposer = ctx.skills.registerProvider(() => bundledSkillProvider(skillsRoot));
  if (typeof providerDisposer === 'function') disposers.push(providerDisposer);
  const dispose = async () => {
    for (const item of bridges.values()) {
      for (const job of await item.list()) {
        if (job.status === 'running' || job.status === 'starting' || job.status === 'queued') await item.cancel(job.id ?? job.jobId);
      }
    }
    for (const cleanup of disposers.reverse()) cleanup();
  };
  if (typeof ctx.on === 'function') ctx.on('dispose', dispose);
  return { dispose };
}
