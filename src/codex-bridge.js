import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';

const running = new Map();
const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'output_limit', 'interrupted']);
const jobPattern = /^cx-[a-f0-9-]{36}$/;
const now = () => new Date().toISOString();
const error = (code, message) => Object.assign(new Error(message), { code });
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

async function regularFile(file) {
  try { const s = await fs.lstat(file); return s.isFile() && !s.isSymbolicLink(); }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

async function ensureInside(root, target, { directory = false } = {}) {
  const absolute = path.resolve(target);
  if (!inside(root, absolute)) throw error('PATH_ESCAPE', 'Codex output directory must stay inside the selected workspace.');
  const pieces = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let cursor = root;
  for (let i = 0; i < pieces.length; i += 1) {
    cursor = path.join(cursor, pieces[i]);
    let stat;
    try { stat = await fs.lstat(cursor); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (directory || i < pieces.length - 1) {
        await fs.mkdir(cursor).catch((err) => { if (err.code !== 'EEXIST') throw err; });
        stat = await fs.lstat(cursor);
      } else break;
    }
    if (stat?.isSymbolicLink()) throw error('PATH_ESCAPE', 'Codex state paths must not contain symbolic links or junctions.');
    if ((directory || i < pieces.length - 1) && !stat?.isDirectory()) throw error('NOT_DIRECTORY', 'A Codex state directory is occupied by a file.');
    if (stat && !inside(root, await fs.realpath(cursor))) throw error('PATH_ESCAPE', 'Codex state path resolves outside the workspace.');
  }
  return absolute;
}

async function atomicJson(root, file, value) {
  await ensureInside(root, file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); }
  finally { await handle.close(); }
  try {
    for (let attempt = 0; ; attempt += 1) {
      try { await fs.rename(temporary, file); break; }
      catch (e) {
        // Windows briefly rejects a rename while another reader has the old state open.
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 8) throw e;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  }
  catch (e) { await fs.unlink(temporary).catch(() => {}); throw e; }
}

async function readJson(root, file) {
  await ensureInside(root, file);
  const s = await fs.lstat(file);
  if (!s.isFile() || s.size > 512 * 1024) throw error('INVALID_STATE', 'Invalid or oversized Codex job state.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function executableCandidates(name) {
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) return [path.resolve(name)];
  const extensions = process.platform === 'win32' ? (path.extname(name) ? [''] : ['.exe']) : [''];
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
    .flatMap((directory) => extensions.map((extension) => path.join(directory.replace(/^"|"$/g, ''), name + extension)));
}

async function locateExecutable(name) {
  for (const candidate of executableCandidates(name)) {
    if (await regularFile(candidate)) return candidate;
  }
  return null;
}

async function discoverCommand(command, commandArgs) {
  if (command) {
    if (/\.(cmd|bat|ps1)$/i.test(command)) throw error('COMMAND_WRAPPER', 'Use codex.exe, or node with the Codex CLI JavaScript entry; shell wrappers are not executed.');
    const found = await locateExecutable(command);
    if (!found) throw error('CODEX_NOT_FOUND', `Executable not found: ${command}`);
    return { command: found, args: [...commandArgs] };
  }
  const direct = await locateExecutable('codex');
  if (direct) return { command: direct, args: [] };
  const npmRoots = new Set((process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((p) => path.join(p.replace(/^"|"$/g, ''), 'node_modules', '@openai', 'codex')));
  if (process.env.APPDATA) npmRoots.add(path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex'));
  npmRoots.add(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@openai', 'codex'));
  const platformPackage = process.platform === 'win32' ? `codex-win32-${process.arch}` : `codex-${process.platform}-${process.arch}`;
  const triples = process.platform === 'win32'
    ? [`${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`]
    : process.platform === 'darwin'
      ? [`${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`]
      : [`${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`];
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const npmRoot of npmRoots) {
    for (const vendor of [path.join(npmRoot, 'node_modules', '@openai', platformPackage, 'vendor'), path.join(npmRoot, 'vendor')]) {
      for (const triple of triples) for (const folder of ['bin', 'codex']) {
        const candidate = path.join(vendor, triple, folder, binary);
        if (await regularFile(candidate)) return { command: candidate, args: [] };
      }
    }
    const script = path.join(npmRoot, 'bin', 'codex.js');
    if (await regularFile(script)) {
      const node = await locateExecutable('node');
      if (node) return { command: node, args: [script] };
    }
  }
  throw error('CODEX_NOT_FOUND', 'Install or configure a local Codex CLI executable first. Existing Codex authentication is reused.');
}

async function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); });
      killer.once('close', (code) => { if (code !== 0) child.kill('SIGKILL'); resolve(); });
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  }
}

async function probe(launcher, args, cwd, milliseconds = 5000) {
  return new Promise((resolve) => {
    const child = spawn(launcher.command, [...launcher.args, ...args], { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { void stopTree(child); finish({ exitCode: null, stdout, stderr, error: 'probe_timeout' }); }, milliseconds);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(0, 32768); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(0, 32768); });
    child.once('error', (e) => finish({ exitCode: null, stdout, stderr, error: e.message }));
    child.once('close', (exitCode) => finish({ exitCode, stdout, stderr }));
  });
}

/** A process-owned Codex bridge. No account files or application configuration are modified. */
export function createCodexBridge({ workspace, stateDir, command, commandArgs = [], allowWrite = false, timeoutMs = 30 * 60 * 1000, maxConcurrent = 1, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw error('WORKSPACE_REQUIRED', 'An absolute workspace directory is required.');
  if (!Array.isArray(commandArgs) || commandArgs.some((x) => typeof x !== 'string' || x.includes('\0'))) throw error('INVALID_COMMAND', 'commandArgs must be an array of strings.');
  if (commandArgs.some((x) => /dangerously-bypass|danger-full-access|ignore-rules|ignore-user-config/.test(x))) throw error('INVALID_COMMAND', 'Launcher arguments must preserve Codex permissions and user configuration.');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw error('INVALID_CONFIG', 'maxConcurrent must be between 1 and 8.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 86400000) throw error('INVALID_CONFIG', 'timeoutMs must be between 50 and 86400000.');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 32 * 1024 * 1024) throw error('INVALID_CONFIG', 'maxOutputBytes must be between 1024 and 33554432.');
  const ready = (async () => {
    const root = await fs.realpath(workspace);
    if (!(await fs.stat(root)).isDirectory()) throw error('NOT_DIRECTORY', 'Workspace must be a directory.');
    // Resolve the user-supplied stateDir against the canonical workspace, never cwd.
    const selected = stateDir ? path.resolve(root, stateDir) : path.join(root, '.dsh-workbench', 'codex');
    return { root, directory: await ensureInside(root, selected, { directory: true }) };
  })();
  // Keep initialization errors available to every public call without unhandled rejections.
  ready.catch(() => {});

  async function load(jobId) {
    if (!jobPattern.test(jobId)) throw error('INVALID_JOB_ID', 'Invalid Codex job identifier.');
    const { root, directory } = await ready;
    const file = path.join(directory, jobId, 'job.json');
    const job = await readJson(root, file);
    if (job.id !== jobId) throw error('INVALID_STATE', 'Codex job identifier does not match its record.');
    if (!terminal.has(job.status) && !alive(job.ownerPid)) {
      job.status = 'interrupted'; job.endedAt = now();
      job.error = 'The process that owned this run exited before recording a result. No completion is inferred.';
      await atomicJson(root, file, job);
    }
    return job;
  }

  async function acquireSlot(jobId) {
    const { root, directory } = await ready;
    for (let slot = 0; slot < maxConcurrent; slot += 1) {
      const file = path.join(directory, `.slot-${slot}.json`);
      await ensureInside(root, file);
      let existing;
      try { existing = await readJson(root, file); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (existing && alive(existing.ownerPid)) continue;
      if (existing) await fs.unlink(file).catch((e) => { if (e.code !== 'ENOENT') throw e; });
      const lease = { jobId, ownerPid: process.pid, nonce: randomUUID(), createdAt: now() };
      try {
        const handle = await fs.open(file, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(lease)); } finally { await handle.close(); }
        return async () => {
          try { if ((await readJson(root, file)).nonce === lease.nonce) await fs.unlink(file); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
        };
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    throw error('CONCURRENCY_LIMIT', 'A Codex job is already running in this workspace. Wait for it or cancel it before starting another.');
  }

  async function start({ prompt, mode = 'read-only', model, taskId } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 128 * 1024 || prompt.includes('\0')) throw error('INVALID_PROMPT', 'Prompt must be non-empty text of at most 128 KiB without NUL characters.');
    if (!['read-only', 'workspace-write'].includes(mode)) throw error('INVALID_MODE', 'Select read-only or workspace-write.');
    if (mode === 'workspace-write' && !allowWrite) throw error('WRITE_DISABLED', 'Workspace writes require allowCodexWrite in the host configuration.');
    if (model !== undefined && (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(model))) throw error('INVALID_MODEL', 'Model must be a single model identifier.');
    if (taskId !== undefined && (typeof taskId !== 'string' || taskId.length > 128 || /[\r\n\0]/.test(taskId))) throw error('INVALID_TASK_ID', 'Invalid task identifier.');
    const { root, directory } = await ready;
    const launcher = await discoverCommand(command, commandArgs);
    const id = `cx-${randomUUID()}`;
    const release = await acquireSlot(id);
    const jobDir = path.join(directory, id);
    let stdoutFile; let stderrFile; let child;
    try {
      await ensureInside(root, jobDir, { directory: true });
      const files = { directory: jobDir, state: path.join(jobDir, 'job.json'), events: path.join(jobDir, 'events.jsonl'), stderr: path.join(jobDir, 'stderr.log'), final: path.join(jobDir, 'final.md'), prompt: path.join(jobDir, 'prompt.md') };
      await fs.writeFile(files.prompt, prompt, { flag: 'wx', mode: 0o600 });
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
      stdoutFile = await fs.open(files.events, flags, 0o600);
      stderrFile = await fs.open(files.stderr, flags, 0o600);
      const args = [...launcher.args, '-a', 'never', 'exec', '--json', '--color', 'never', '--sandbox', mode, '-C', root, '-o', files.final];
      if (model) args.push('-m', model);
      args.push('-');
      const job = { schemaVersion: 1, id, jobId: id, taskId: taskId ?? null, status: 'running', mode, model: model ?? null, workspace: root, ownerPid: process.pid, processPid: null, createdAt: now(), startedAt: now(), endedAt: null, exitCode: null, signal: null, threadId: null, outputBytes: 0, malformedEvents: 0, eventCount: 0, usage: null, error: null, finalText: '', command: launcher.command, args, files };
      await atomicJson(root, files.state, job);
      child = spawn(launcher.command, args, { cwd: root, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      job.processPid = child.pid ?? null;
      let queue = Promise.resolve(); let outputBytes = 0; let pending = ''; let finalFromEvent = ''; let turnCompleted = false; let turnFailed = null; let stopping = false; let finished = false; let finalizing = false; let requestedStatus = null; let requestedError = null;
      const decoder = new StringDecoder('utf8');
      const save = () => atomicJson(root, files.state, job);
      const enqueue = (operation) => {
        queue = queue.then(operation).catch((e) => { requestStop('failed', `Failed to record Codex output: ${e.message}`); });
      };
      function requestStop(status, reason) {
        if (finished || stopping) return;
        stopping = true; requestedStatus = status; requestedError = reason;
        void stopTree(child);
      }
      const control = { job, stop: () => requestStop('cancelled', 'Cancelled by the caller.') };
      running.set(files.state, control);

      function parseLine(line) {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); }
        catch { job.malformedEvents += 1; return; }
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') { job.malformedEvents += 1; return; }
        job.eventCount += 1;
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') job.threadId = event.thread_id;
        if (event.type === 'turn.completed') { turnCompleted = true; job.usage = event.usage ?? null; }
        if (event.type === 'turn.failed') turnFailed = typeof event.error?.message === 'string' ? event.error.message : 'Codex reported a failed turn.';
        if (event.type === 'error') turnFailed = typeof event.message === 'string' ? event.message : 'Codex reported an error.';
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') finalFromEvent = event.item.text;
      }

      function consume(stream, chunk) {
        if (finished || stopping) return;
        const remaining = maxOutputBytes - outputBytes;
        const part = chunk.subarray(0, Math.max(0, remaining));
        outputBytes += part.length; job.outputBytes = outputBytes;
        enqueue(async () => {
          await (stream === 'stdout' ? stdoutFile : stderrFile).write(part);
          if (stream === 'stdout') {
            pending += decoder.write(part);
            let newline;
            while ((newline = pending.indexOf('\n')) >= 0) { parseLine(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
          }
        });
        if (part.length < chunk.length) requestStop('output_limit', `Combined Codex stdout/stderr exceeded ${maxOutputBytes} bytes.`);
      }
      child.stdout.on('data', (chunk) => consume('stdout', chunk));
      child.stderr.on('data', (chunk) => consume('stderr', chunk));
      child.stdin.on('error', (e) => { if (e.code !== 'EPIPE' && !stopping) requestStop('failed', `Codex stdin failed: ${e.message}`); });
      const timeout = setTimeout(() => requestStop('timed_out', `Codex exceeded the ${timeoutMs} ms time limit.`), timeoutMs);
      let polling = false;
      const poll = setInterval(async () => {
        if (finished || finalizing || polling) return;
        polling = true;
        try {
          const cancellation = path.join(jobDir, 'cancel.request');
          if (await regularFile(cancellation)) requestStop('cancelled', 'Cancelled by the caller.');
          await ensureInside(root, files.final);
          const stat = await fs.lstat(files.final).catch((e) => { if (e.code !== 'ENOENT') throw e; return null; });
          if (stat && stat.size > maxOutputBytes) requestStop('output_limit', `Codex final answer exceeded ${maxOutputBytes} bytes.`);
          if (!finalizing && !finished) enqueue(save);
        } catch (e) { requestStop('failed', e.message); }
        finally { polling = false; }
      }, 250);
      async function finish(exitCode, signal, spawnError) {
        if (finalizing || finished) return;
        finalizing = true; clearTimeout(timeout); clearInterval(poll);
        try {
          await queue;
          if (pending) parseLine(pending + decoder.end());
          await stdoutFile.close(); await stderrFile.close();
          job.exitCode = exitCode; job.signal = signal ?? null; job.endedAt = now();
          if (requestedStatus) { job.status = requestedStatus; job.error = requestedError; }
          else if (spawnError || exitCode !== 0 || turnFailed || job.malformedEvents || !turnCompleted) {
            job.status = 'failed';
            job.error = spawnError?.message ?? turnFailed ?? (job.malformedEvents ? `Invalid JSONL event lines: ${job.malformedEvents}.` : !turnCompleted ? 'Codex did not emit turn.completed; success was not inferred.' : `Codex exited with code ${exitCode}.`);
          } else {
            await ensureInside(root, files.final);
            const stat = await fs.lstat(files.final).catch((e) => { if (e.code !== 'ENOENT') throw e; return null; });
            if (stat && !stat.isFile()) throw error('INVALID_OUTPUT', 'Codex final answer must be a regular file.');
            if ((stat?.size ?? Buffer.byteLength(finalFromEvent)) > maxOutputBytes) {
              job.status = 'output_limit'; job.error = `Codex final answer exceeded ${maxOutputBytes} bytes.`;
            } else {
              job.finalText = stat ? await fs.readFile(files.final, 'utf8') : finalFromEvent;
              if (!job.finalText.trim()) { job.status = 'failed'; job.error = 'Codex completed without a final answer.'; }
              else {
                if (!stat) await fs.writeFile(files.final, job.finalText, { flag: 'wx', mode: 0o600 });
                job.status = 'completed';
              }
            }
          }
        } catch (e) { job.status = 'failed'; job.error = e.message; job.endedAt = now(); }
        finally {
          finished = true;
          // A compact state record keeps the full answer in final.md, not duplicated in JSON.
          const persisted = { ...job, finalText: job.finalText.slice(0, 8192), finalTextTruncated: job.finalText.length > 8192 };
          try { await release(); await atomicJson(root, files.state, persisted); }
          finally { running.delete(files.state); }
        }
      }
      child.once('error', (e) => { void finish(null, null, e).catch(() => {}); });
      child.once('close', (exitCode, signal) => { void finish(exitCode, signal).catch(() => {}); });
      child.stdin.end(prompt);
      enqueue(save);
      return structuredClone(job);
    } catch (e) {
      if (child) await stopTree(child);
      await stdoutFile?.close().catch(() => {}); await stderrFile?.close().catch(() => {});
      await release();
      throw e;
    }
  }

  async function get(jobId) { return load(jobId); }

  async function list() {
    const { directory } = await ready;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) if (entry.isDirectory() && jobPattern.test(entry.name)) {
      try { jobs.push(await load(entry.name)); }
      catch (e) { jobs.push({ id: entry.name, jobId: entry.name, status: 'invalid', error: e.message }); }
    }
    return jobs.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }

  async function cancel(jobId) {
    const job = await load(jobId);
    if (terminal.has(job.status)) return job;
    const { root, directory } = await ready;
    const stateFile = path.join(directory, jobId, 'job.json');
    const active = running.get(stateFile);
    if (active) active.stop();
    else {
      const request = path.join(directory, jobId, 'cancel.request');
      await ensureInside(root, request);
      await fs.writeFile(request, `${now()}\n`, { flag: 'wx', mode: 0o600 }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
    }
    return { ...job, cancellationRequested: true };
  }

  async function doctor() {
    const { root, directory } = await ready;
    try {
      const launcher = await discoverCommand(command, commandArgs);
      const version = await probe(launcher, ['--version'], root);
      const help = await probe(launcher, ['exec', '--help'], root);
      const required = ['--json', '--sandbox', '--output-last-message'];
      const missingFlags = required.filter((flag) => !help.stdout.includes(flag));
      return { available: version.exitCode === 0 && help.exitCode === 0 && missingFlags.length === 0, workspace: root, stateDir: directory, command: launcher.command, commandArgs: launcher.args, version: version.stdout.trim(), missingFlags, allowWrite, maxConcurrent, timeoutMs, maxOutputBytes, authentication: 'not_checked', modelInvocation: 'not_performed', diagnostics: [version.error, help.error, version.stderr.trim(), help.stderr.trim()].filter(Boolean) };
    } catch (e) { return { available: false, workspace: root, stateDir: directory, error: e.message, code: e.code, authentication: 'not_checked', modelInvocation: 'not_performed' }; }
  }

  return { start, get, list, cancel, doctor };
}
