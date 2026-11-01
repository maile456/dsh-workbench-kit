import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function createStore(workspace) {
  if (typeof workspace !== 'string' || !workspace) throw new Error('需要明确的工作区目录');
  const root = await fs.realpath(path.resolve(workspace));
  if (!(await fs.stat(root)).isDirectory()) throw new Error('工作区必须是目录');
  async function resolve(file, { mkdir = false, directory = false } = {}) {
    const target = path.resolve(root, file);
    if (!inside(root, target)) throw new Error('路径超出工作区');
    const parts = path.relative(root, target).split(path.sep).filter(Boolean);
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      cursor = path.join(cursor, parts[i]);
      const isDirectory = i < parts.length - 1 || directory;
      let stat;
      try { stat = await fs.lstat(cursor); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (mkdir && isDirectory) {
          try { await fs.mkdir(cursor); } catch (e) { if (e.code !== 'EEXIST') throw e; }
          stat = await fs.lstat(cursor);
        } else continue;
      }
      if (stat.isSymbolicLink()) throw new Error('路径包含符号链接或目录联接');
      if (isDirectory && !stat.isDirectory()) throw new Error('路径中间节点不是目录');
      if (!inside(root, await fs.realpath(cursor))) throw new Error('实际路径超出工作区');
    }
    return target;
  }
  async function writeJson(file, value) {
    const target = await resolve(file, { mkdir: true });
    const temporary = path.join(path.dirname(target), `.tmp-${randomUUID().slice(0, 12)}`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await resolve(file);
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function readJson(file) {
    const target = await resolve(file);
    const stat = await fs.stat(target);
    if (stat.size > 4 * 1024 * 1024) throw new Error('记录文件超过大小限制');
    return JSON.parse(await fs.readFile(target, 'utf8'));
  }
  async function locked(name, callback) {
    const target = await resolve(`.dsh-workbench/locks/${name}.lock`, { mkdir: true });
    let handle;
    const deadline = Date.now() + 5000;
    while (!handle) {
      try { handle = await fs.open(target, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() > deadline) throw new Error(`记录正由其他进程更新：${name}；异常退出后请检查锁文件`);
        await new Promise(r => setTimeout(r, 25));
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return await callback();
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(target).catch(() => {});
    }
  }
  async function fingerprint(file) {
    const target = await resolve(file);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size === 0) throw new Error('交付物必须是非空普通文件');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    return { path: path.relative(root, target).split(path.sep).join('/'), bytes: stat.size, sha256: hash.digest('hex') };
  }
  async function snapshot() {
    const files = [];
    const ignored = new Set(['.dsh-workbench', '.git']);
    async function visit(directory) {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (ignored.has(entry.name) && directory === root) continue;
        const target = path.join(directory, entry.name);
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) throw new Error(`工作区快照遇到符号链接：${path.relative(root, target)}`);
        if (stat.isDirectory()) await visit(target);
        else if (stat.isFile()) {
          if (files.length >= 10000) throw new Error('工作区文件过多，无法形成完整验收快照');
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(target)) hash.update(chunk);
          files.push({ path: path.relative(root, target).split(path.sep).join('/'), bytes: stat.size, sha256: hash.digest('hex') });
        }
      }
    }
    await visit(root);
    const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    return { digest, files };
  }
  return { root, resolve, writeJson, readJson, locked, fingerprint, snapshot };
}

export function validId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(id)) throw new Error('无效记录 ID');
  return id;
}
