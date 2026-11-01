#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createWorkbench } from '../src/core.js';

const root = fileURLToPath(new URL('../.demo-workspace/', import.meta.url));
await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(root, { recursive: true });
try {
  const workbench = await createWorkbench(root);
  const task = await workbench.createTask({
    title: '演示交付',
    goal: '展示计划、验证、产物登记和完成闭环',
    acceptance: ['检查命令通过', '报告文件存在且非空'],
  });
  await fs.writeFile(path.join(root, 'report.md'), '# Demo report\n');
  await workbench.addArtifact({ taskId: task.id, path: 'report.md', criterion: 2 });
  const check = await workbench.verifyTask({
    taskId: task.id,
    criterion: 1,
    command: process.execPath,
    args: ['-e', "if (!require('fs').statSync('report.md').size) process.exit(2)"],
  });
  const completed = await workbench.completeTask(task.id);
  console.log(JSON.stringify({ workspace: root, taskId: task.id, checkStatus: check.status, status: completed.status }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
