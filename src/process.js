import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export async function resolveExecutable(command, cwd) {
  if (typeof command !== 'string' || !command || command.includes('\0')) throw new Error('需要有效可执行文件');
  const extensions = process.platform === 'win32' ? ['', '.exe', '.com'] : [''];
  const directories = command.includes('/') || command.includes('\\') ? [cwd] : (process.env.PATH || '').split(path.delimiter);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory, command + extension);
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) continue;
        if (process.platform === 'win32' && !/\.(exe|com)$/i.test(candidate)) continue;
        await fs.access(candidate, process.platform === 'win32' ? 0 : 1);
        return candidate;
      } catch { /* Try the next executable path. */ }
    }
  }
  throw new Error(`找不到可执行文件：${command}。Windows 请使用 .exe，或用 node 执行 npm-cli.js；不自动经 shell 运行 .cmd/.ps1。`);
}

export function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.on('close', code => { if (code !== 0) child.kill(); });
    const fallback = setTimeout(() => child.kill(), 1500);
    fallback.unref();
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export async function runCommand({ command, args = [], cwd, timeoutMs = 60000, signal, maxBytes = 2 * 1024 * 1024 }) {
  if (!Array.isArray(args) || args.some(v => typeof v !== 'string' || v.includes('\0'))) throw new Error('args 必须是字符串数组');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000) throw new Error('timeoutMs 应为 100–600000');
  if (signal?.aborted) throw new Error('操作已取消');
  const executable = await resolveExecutable(command, cwd);
  return new Promise(resolve => {
    const start = Date.now();
    let outputBytes = 0, status, stdout = [], stderr = [];
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = reason => { if (!status) { status = reason; terminateTree(child); } };
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('timed_out'), timeoutMs);
    const capture = destination => chunk => {
      const remaining = Math.max(0, maxBytes - outputBytes);
      if (remaining) destination.push(chunk.subarray(0, remaining));
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) stop('output_limit');
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', error => { stderr.push(Buffer.from(error.message)); if (!status) status = 'spawn_error'; });
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve({ executable, args, cwd, status: status || (exitCode === 0 ? 'passed' : 'failed'), exitCode, signal: exitSignal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), durationMs: Date.now() - start, outputBytes });
    });
  });
}
