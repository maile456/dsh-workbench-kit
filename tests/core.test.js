import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbench } from '../src/core.js';
import { createStore } from '../src/storage.js';
import { runCommand } from '../src/process.js';

const tempRoot = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
await fs.mkdir(tempRoot, { recursive: true });
async function setup(t) {
  const root = await fs.mkdtemp(path.join(tempRoot, 'core-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, workbench: await createWorkbench(root) };
}

test('failed check blocks delivery; successful retry and artifact allow completion', async t => {
  const { root, workbench: w } = await setup(t);
  const task = await w.createTask({ title: '交付', goal: '真实验证', acceptance: ['测试通过', '报告存在'] });
  const bad = await w.verifyTask({ taskId: task.id, criterion: 1, command: process.execPath, args: ['-e', "console.error('FAIL');process.exit(7)"] });
  assert.equal(bad.exitCode, 7); assert.match(bad.stderr, /FAIL/);
  await fs.writeFile(path.join(root, 'report.md'), '# Report\n');
  await w.addArtifact({ taskId: task.id, path: 'report.md', criterion: 2 });
  await assert.rejects(w.completeTask(task.id), /尚未通过/);
  const good = await w.verifyTask({ taskId: task.id, criterion: 1, command: process.execPath, args: ['-e', "console.log('PASS')"] });
  assert.equal(good.exitCode, 0); assert.equal(good.stdout.trim(), 'PASS');
  const reportCheck = await w.verifyTask({ taskId: task.id, criterion: 2, command: process.execPath, args: ['-e', "const fs=require('fs'); if (!fs.statSync('report.md').size) process.exit(2)"] });
  assert.equal(reportCheck.exitCode, 0);
  const done = await w.completeTask(task.id);
  assert.equal(done.status, 'completed'); assert.equal(done.checks.length, 3);
  await assert.rejects(w.verifyTask({ taskId: task.id, criterion: 1, command: process.execPath }), /重新打开/);
});

test('artifact changes and missing files block completion', async t => {
  const { root, workbench: w } = await setup(t);
  const task = await w.createTask({ title: '文件', goal: '哈希', acceptance: ['文件存在'] });
  await fs.writeFile(path.join(root, 'out.txt'), 'v1');
  await w.addArtifact({ taskId: task.id, path: 'out.txt', criterion: 1 });
  await fs.writeFile(path.join(root, 'out.txt'), 'v2');
  await assert.rejects(w.completeTask(task.id), /已修改|验收后工作区已变化/);
  await w.addArtifact({ taskId: task.id, path: 'out.txt' });
  await assert.rejects(w.completeTask(task.id), /尚未通过/);
  await w.addArtifact({ taskId: task.id, path: 'out.txt', criterion: 1 });
  await w.verifyTask({ taskId: task.id, criterion: 1, command: process.execPath, args: ['-e', "if (require('fs').readFileSync('out.txt','utf8') !== 'v2') process.exit(3)"] });
  assert.equal((await w.completeTask(task.id)).status, 'completed');
});

test('paths and symbolic links cannot escape project state', async t => {
  const { root, workbench: w } = await setup(t);
  const task = await w.createTask({ title: '边界', goal: '文件限制', acceptance: ['文件'] });
  await assert.rejects(w.addArtifact({ taskId: task.id, path: '../escape.txt' }), /超出/);
  await assert.rejects(w.getTask('../escape'), /无效/);
  const outside = await fs.mkdtemp(path.join(tempRoot, 'outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  let linked = true;
  try { await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) linked = false;
    else throw error;
  }
  if (linked) await assert.rejects(w.addArtifact({ taskId: task.id, path: 'linked/secret.txt' }), /符号链接|联接/);
  const clean = await fs.mkdtemp(path.join(tempRoot, 'linked-'));
  t.after(() => fs.rm(clean, { recursive: true, force: true }));
  let stateLinked = true;
  try { await fs.symlink(outside, path.join(clean, '.dsh-workbench'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) stateLinked = false;
    else throw error;
  }
  if (stateLinked) {
    const store = await createStore(clean);
    await assert.rejects(store.writeJson('.dsh-workbench/x.json', {}), /符号链接|联接/);
  }
});

test('concurrent notes preserve all updates and completion cannot be forged with update', async t => {
  const { workbench: w } = await setup(t);
  const task = await w.createTask({ title: '并发', goal: '不丢更新', acceptance: ['完成'] });
  await Promise.all(Array.from({ length: 12 }, (_, i) => w.updateTask({ taskId: task.id, note: `note-${i}` })));
  assert.equal((await w.getTask(task.id)).notes.length, 12);
  await assert.rejects(w.updateTask({ taskId: task.id, status: 'completed' }), /complete/);
  await assert.rejects(w.completeTask(task.id), /交付物/);
});

test('spawn failure, timeout and output overflow never count as passing', async t => {
  const { workbench: w, root } = await setup(t);
  const task = await w.createTask({ title: '执行失败', goal: '保留退出结果', acceptance: ['成功'] });
  const missing = await w.verifyTask({ taskId: task.id, criterion: 1, command: 'nonexistent-workbench-binary-1234' });
  assert.equal(missing.status, 'spawn_error'); assert.equal(missing.exitCode, null);
  const timeout = await runCommand({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: root, timeoutMs: 200 });
  assert.equal(timeout.status, 'timed_out');
  const overflow = await runCommand({ command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(20000))"], cwd: root, maxBytes: 1024 });
  assert.equal(overflow.status, 'output_limit'); assert.ok(Buffer.byteLength(overflow.stdout) <= 1024);
});

test('arguments pass literally rather than through a shell', async t => {
  const { root } = await setup(t);
  const literal = 'a & echo INJECTED $(whoami) `test` "quoted"';
  const result = await runCommand({ command: process.execPath, args: ['-e', 'console.log(process.argv[1])', literal], cwd: root });
  assert.equal(result.stdout.trim(), literal); assert.equal(result.exitCode, 0);
});

test('doctor identifies packages without claiming service readiness', async t => {
  const { root } = await setup(t);
  await fs.mkdir(path.join(root, 'profile'));
  await fs.writeFile(path.join(root, 'profile/package.json'), JSON.stringify({ dependencies: { '@liustack/modsearch': '5.10.11' } }));
  const w = await createWorkbench(root, { dshProfilePath: path.join(root, 'profile') });
  const report = await w.doctor();
  assert.equal(report.profileRead, true);
  assert.ok(report.capabilities.some(c => c.installedPackages.includes('@liustack/modsearch') && c.status === 'package-detected'));
});
