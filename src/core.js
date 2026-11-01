import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createStore, validId } from './storage.js';
import { runCommand } from './process.js';

const now = () => new Date().toISOString();
function text(value, field, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${field} 需要非空文本（最多 ${max} 字符）`);
  return value.trim();
}
function comparable(snapshot, ignored = []) {
  const excluded = new Set(ignored);
  const files = (snapshot?.files || []).filter(file => !excluded.has(file.path));
  return { digest: files.length ? files.reduce((acc, file) => `${acc}|${file.path}|${file.bytes}|${file.sha256}`, '') : '', files };
}
function structuralArtifactCriterion(label) {
  const value = String(label).toLowerCase();
  const structural = /存在|非空|生成|文件|路径|哈希|sha|file|exist|non.?empty|produced/.test(value);
  const semantic = /内容|正确|数据|视觉|格式|公式|测试|质量|语义|content|correct|data|visual|format|formula|test|quality/.test(value);
  return structural && !semantic;
}

export async function createWorkbench(workspace, options = {}) {
  const store = await createStore(workspace);
  const taskFile = id => `.dsh-workbench/tasks/${validId(id)}.json`;
  async function getTask(taskId) { return store.readJson(taskFile(taskId)); }
  async function mutate(taskId, update) {
    return store.locked(validId(taskId), async () => {
      const task = await getTask(taskId);
      await update(task);
      task.updatedAt = now();
      await store.writeJson(taskFile(taskId), task);
      return task;
    });
  }
  function criterionFor(task, id) {
    if (!Number.isInteger(id)) throw new Error('criterion 应为从 1 开始的整数');
    const criterion = task.criteria.find(c => c.id === id);
    if (!criterion) throw new Error('验收项不存在');
    return criterion;
  }
  function editable(task) {
    if (task.status === 'completed') throw new Error('已完成任务请先通过 update 重新打开');
  }
  async function createTask({ title, goal, acceptance }) {
    if (!Array.isArray(acceptance) || acceptance.length < 1 || acceptance.length > 30) throw new Error('需要 1–30 条可验证验收标准');
    const task = { schemaVersion: 1, id: `task-${randomUUID()}`, title: text(title, 'title', 300), goal: text(goal, 'goal'), status: 'planned', createdAt: now(), updatedAt: now(), criteria: acceptance.map((value, i) => ({ id: i + 1, text: text(value, 'acceptance', 1000), evidence: null, evidencePolicy: 'command' })), artifacts: [], checks: [], notes: [] };
    await store.writeJson(taskFile(task.id), task);
    return task;
  }
  async function listTasks() {
    const directory = await store.resolve('.dsh-workbench/tasks');
    const names = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const tasks = await Promise.all(names.filter(n => /^task-[a-z0-9-]+\.json$/.test(n)).map(n => store.readJson(`.dsh-workbench/tasks/${n}`)));
    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async function updateTask({ taskId, status, note }) {
    if (status !== undefined && !['planned', 'running', 'blocked'].includes(status)) throw new Error('status 仅允许 planned/running/blocked；完成请使用 complete');
    if (note !== undefined) text(note, 'note');
    return mutate(taskId, task => {
      if (status) { task.status = status; delete task.completedAt; }
      if (note) task.notes.push({ at: now(), text: note });
      if (task.notes.length > 500) throw new Error('任务备注上限 500，请新建后续任务');
    });
  }
  async function verifyTask({ taskId, criterion, command, args = [], timeoutMs = 60000, signal, runner }) {
    const checkId = `check-${randomUUID()}`;
    const workspaceBefore = await store.snapshot();
    const startedAt = now();
    await mutate(taskId, task => {
      editable(task);
      if (task.checks.length >= 500) throw new Error('单任务检查次数上限 500');
      const target = criterionFor(task, criterion);
      target.evidence = { kind: 'command', id: checkId, status: 'running' };
      task.status = 'running';
      task.checks.push({ id: checkId, criterion, startedAt, status: 'running' });
    });
    let result;
    try { result = await (runner || options.runner || runCommand)({ command, args, cwd: store.root, timeoutMs, signal, maxBytes: 2 * 1024 * 1024 }); }
    catch (error) { result = { executable: command, args, cwd: store.root, status: 'spawn_error', exitCode: null, signal: null, stdout: '', stderr: error.message, durationMs: 0 }; }
    const workspaceAfter = await store.snapshot();
    const record = { schemaVersion: 1, id: checkId, taskId, criterion, startedAt, finishedAt: now(), requestedCommand: command, workspaceBefore, workspaceAfter, ...result };
    const recordPath = `.dsh-workbench/checks/${checkId}.json`;
    await store.writeJson(recordPath, record);
    await mutate(taskId, task => {
      const check = task.checks.find(c => c.id === checkId);
      Object.assign(check, { status: result.status, exitCode: result.exitCode, recordPath });
      const target = criterionFor(task, criterion);
      if (target.evidence?.id === checkId) target.evidence = { kind: 'command', id: checkId, status: result.status, recordPath };
    });
    return record;
  }
  async function addArtifact({ taskId, path: artifactPath, criterion }) {
    text(artifactPath, 'path', 4000);
    const artifact = await store.fingerprint(artifactPath);
    if (artifact.path === '.dsh-workbench' || artifact.path.startsWith('.dsh-workbench/')) throw new Error('交付物应独立于任务内部记录');
    return mutate(taskId, task => {
      editable(task);
      if (criterion !== undefined) criterionFor(task, criterion);
      if (criterion !== undefined) {
        const target = criterionFor(task, criterion);
        if (!structuralArtifactCriterion(target.text)) throw new Error('该验收项不是纯文件存在/非空检查；请用 workbench_verify 进行内容、数据或视觉验证。');
        target.evidence = { kind: 'artifact', path: artifact.path, sha256: artifact.sha256, status: 'passed' };
      }
      task.artifacts = task.artifacts.filter(a => a.path !== artifact.path);
      if (task.artifacts.length >= 100) throw new Error('单任务最多 100 个交付物');
      task.artifacts.push({ ...artifact, criterion: criterion ?? null, recordedAt: now() });
    });
  }
  async function completeTask(taskId) {
    return mutate(taskId, async task => {
      if (!task.artifacts.length) throw new Error('至少登记一个交付物');
      if (task.checks.some(c => c.status === 'running')) throw new Error('仍有检查在运行');
      for (const criterion of task.criteria) {
        if (criterion.evidence?.status !== 'passed') throw new Error(`验收项 ${criterion.id} 尚未通过：${criterion.text}`);
        if (criterion.evidence.kind === 'command') {
          const record = await store.readJson(criterion.evidence.recordPath);
          if (record.taskId !== task.id || record.criterion !== criterion.id || record.status !== 'passed' || record.exitCode !== 0) throw new Error('检查证据不匹配');
          const currentWorkspace = await store.snapshot();
          const ignored = task.artifacts.map(artifact => artifact.path);
          if (comparable(currentWorkspace, ignored).digest !== comparable(record.workspaceAfter, ignored).digest) throw new Error(`验收后工作区已变化，请重新运行检查：${criterion.text}`);
        }
        if (criterion.evidence.kind === 'artifact' && !task.artifacts.some(a => a.path === criterion.evidence.path && a.sha256 === criterion.evidence.sha256)) throw new Error(`交付物验收记录已过期，验收项尚未通过，请重新登记：${criterion.text}`);
      }
      for (const artifact of task.artifacts) {
        const current = await store.fingerprint(artifact.path);
        if (current.sha256 !== artifact.sha256) throw new Error(`交付物已修改，请重新检查并登记：${artifact.path}`);
      }
      task.status = 'completed'; task.completedAt = now();
    });
  }
  async function doctor() {
    const catalog = JSON.parse(await fs.readFile(new URL('../catalog/capabilities.json', import.meta.url), 'utf8'));
    const profilePath = options.dshProfilePath || path.join(os.homedir(), '.dsh', 'profiles', options.profile || 'desktop');
    let profile = {}, profileError;
    try { profile = JSON.parse(await fs.readFile(path.join(profilePath, 'package.json'), 'utf8')); }
    catch (error) { profileError = error.code || error.message; }
    const dependencies = profile.dependencies || {};
    const capabilities = catalog.capabilities.map(capability => ({ ...capability, installedPackages: (capability.pluginPackages || []).filter(p => Object.hasOwn(dependencies, p)), status: (capability.pluginPackages || []).some(p => Object.hasOwn(dependencies, p)) ? 'package-detected' : 'needs-runtime-check' }));
    return { schemaVersion: 1, workspace: store.root, node: process.version, profilePath, profileRead: !profileError, profileError, capabilities, note: '只检测配置中的软件包。服务连接、API 额度、工具启用和产物质量须另行验证；不读取凭据。' };
  }
  return { workspace: store.root, createTask, getTask, listTasks, updateTask, verifyTask, addArtifact, completeTask, doctor };
}
