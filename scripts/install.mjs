#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const trackedFiles = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'];
const hash = buffer => createHash('sha256').update(buffer).digest('hex');

export async function snapshotProfile(profileDir, backupRoot) {
  const profile = await fs.realpath(profileDir);
  if (!(await fs.stat(profile)).isDirectory()) throw new Error('profile 必须是已有目录');
  const backup = path.resolve(backupRoot, `install-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  const manifest = { schemaVersion: 1, profile, createdAt: new Date().toISOString(), files: [], postInstall: null, packageName: 'dsh-workbench-kit' };
  for (const name of trackedFiles) {
    const source = path.join(profile, name);
    try {
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`profile 配置不是普通文件：${name}`);
      const content = await fs.readFile(source);
      await fs.writeFile(path.join(backup, name), content, { mode: 0o600 });
      manifest.files.push({ name, exists: true, sha256: hash(content) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      manifest.files.push({ name, exists: false, sha256: null });
    }
  }
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { backup, manifest };
}

export async function captureAfter(backup, manifest) {
  manifest.postInstall = {};
  for (const entry of manifest.files) {
    try { manifest.postInstall[entry.name] = hash(await fs.readFile(path.join(manifest.profile, entry.name))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; manifest.postInstall[entry.name] = null; }
  }
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function restoreProfile(backupRoot, { expectedCurrent = true } = {}) {
  const backup = await fs.realpath(backupRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !path.isAbsolute(manifest.profile) || !Array.isArray(manifest.files)) throw new Error('无效备份清单');
  const profile = await fs.realpath(manifest.profile);
  if (profile !== manifest.profile) throw new Error('profile 真实路径已变更');
  const restore = [];
  for (const entry of manifest.files) {
    if (!trackedFiles.includes(entry.name)) throw new Error('备份清单包含未知配置文件');
    const target = path.join(profile, entry.name);
    const stat = await fs.lstat(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('配置文件类型发生变化');
    const current = stat ? hash(await fs.readFile(target)) : null;
    if (expectedCurrent && (!manifest.postInstall || current !== manifest.postInstall[entry.name])) throw new Error(`安装后配置有新变化，保留现状：${entry.name}。请先使用插件管理器卸载本插件。`);
    let content;
    if (entry.exists) {
      const original = path.join(backup, entry.name);
      const originalStat = await fs.lstat(original);
      if (!originalStat.isFile() || originalStat.isSymbolicLink()) throw new Error('备份文件类型异常');
      content = await fs.readFile(original);
      if (hash(content) !== entry.sha256) throw new Error(`备份哈希不匹配：${entry.name}`);
    }
    restore.push({ entry, target, content });
  }
  for (const { entry, target, content } of restore) {
    if (entry.exists) await fs.writeFile(target, content, { mode: 0o600 });
    else await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  for (const entry of manifest.files) {
    const current = await fs.readFile(path.join(profile, entry.name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if ((current ? hash(current) : null) !== entry.sha256) throw new Error(`恢复验证失败：${entry.name}`);
  }
  return { restored: true, profile, backup, verifiedFiles: manifest.files.length, note: '配置恢复已验证。插件缓存和工作区任务记录保留；重启 DSH 后生效。' };
}

function flags(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error('请使用 --profile / --package / --rollback 等选项');
    const key = argv[i].slice(2);
    result[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return result;
}

export async function locateDsh(explicit) {
  const candidate = explicit || (process.platform === 'win32' ? path.join(os.homedir(), '.dsh', 'bin', 'dsh.ps1') : 'dsh');
  if (candidate.endsWith('.ps1')) {
    await fs.access(candidate);
    return { command: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), prefix: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.resolve(candidate)] };
  }
  if (/\.(cmd|bat)$/i.test(candidate)) throw new Error('请指定 dsh.ps1 或可执行文件，不经 cmd 拼接安装参数');
  return { command: candidate, prefix: [] };
}

function invoke({ command, prefix }, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], { shell: false, windowsHide: true, stdio: 'inherit' });
    child.on('error', reject); child.on('close', code => resolve(code));
  });
}

async function main() {
  const args = flags(process.argv.slice(2));
  if (args.help) {
    console.log('安装（先退出 DSH）：node scripts/install.mjs --profile desktop --package artifacts/dsh-workbench-kit-0.1.0.tgz\n预览：追加 --dry-run\n自定义配置根目录：--dsh-home DIR；指定启动器：--dsh-command PATH\n回滚：node scripts/rollback.mjs --backup BACKUP_DIRECTORY\n常规卸载：在 DSH 插件页移除 dsh-workbench-kit，再重启。');
    return;
  }
  if (args.rollback) { console.log(JSON.stringify(await restoreProfile(String(args.rollback)), null, 2)); return; }
  const profile = args.profile || 'desktop';
  if (typeof profile !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('无效 profile 名称');
  if (!args.package || typeof args.package !== 'string') throw new Error('请通过 --package 指定已经验证的 .tgz 安装包');
  const packageFile = await fs.realpath(path.resolve(args.package));
  if (!packageFile.endsWith('.tgz')) throw new Error('安装包应为 .tgz 文件');
  const dshHome = path.resolve(typeof args['dsh-home'] === 'string' ? args['dsh-home'] : process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const profileDir = path.join(dshHome, 'profiles', profile);
  await fs.access(path.join(profileDir, 'package.json'));
  const launcher = await locateDsh(args['dsh-command']);
  const commandArgs = ['plugin', '--profile', profile, 'add', packageFile];
  if (args['dry-run']) {
    console.log(JSON.stringify({ dryRun: true, profileDir, launcher, args: commandArgs, packageSha256: hash(await fs.readFile(packageFile)), note: '请在完全退出 DSH 后执行；不会重装搜索、视觉或记忆插件。' }, null, 2));
    return;
  }
  const backupRoot = path.join(dshHome, 'workbench-backups');
  const { backup, manifest } = await snapshotProfile(profileDir, backupRoot);
  manifest.packageSha256 = hash(await fs.readFile(packageFile));
  // A requested DSH_HOME is applied only to this child invocation and restored immediately.
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  let exitCode;
  try { exitCode = await invoke(launcher, commandArgs); }
  finally { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await captureAfter(backup, manifest); }
  console.log(JSON.stringify({ exitCode, backup, rollback: ['node', 'scripts/rollback.mjs', '--backup', backup], note: exitCode === 0 ? '请重新打开 DSH，确认插件工具及六个技能出现。' : '安装未成功，备份及实际修改状态已保留，可执行 rollback。' }, null, 2));
  if (exitCode !== 0) process.exitCode = exitCode || 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
