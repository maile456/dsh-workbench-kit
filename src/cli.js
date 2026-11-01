#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkbench } from './core.js';
import { createCodexBridge } from './codex-bridge.js';

function parse(argv) {
  const flags = {}, positional = [], commandArgs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') { commandArgs.push(...argv.slice(i + 1)); break; }
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (key === 'accept') (flags.accept ||= []).push(value);
      else flags[key] = value;
    } else positional.push(argv[i]);
  }
  return { flags, positional, commandArgs };
}

const help = `DSH Workbench Kit — 可验证的工作交付与 Codex 协作

node src/cli.js doctor --workspace DIR [--profile desktop]
node src/cli.js plan --workspace DIR --title 标题 --goal 目标 --accept 验收1 --accept 验收2
node src/cli.js list --workspace DIR
node src/cli.js status TASK_ID --workspace DIR
node src/cli.js update TASK_ID --workspace DIR --status running --note 进度
node src/cli.js verify TASK_ID --workspace DIR --criterion 1 -- node check.js
node src/cli.js artifact TASK_ID --workspace DIR --path report.md [--criterion 2]
node src/cli.js complete TASK_ID --workspace DIR
node src/cli.js codex doctor --workspace DIR
node src/cli.js codex run --workspace DIR --prompt 任务 [--mode read-only|workspace-write] [--allow-write]
node src/cli.js codex status JOB_ID --workspace DIR
node src/cli.js codex list --workspace DIR
node src/cli.js codex cancel JOB_ID --workspace DIR

所有操作输出 JSON；verify 执行你明确给出的命令。Windows 直接使用 node 或 .exe。
Codex run 会等待完成，默认只读；写任务需同时指定 --mode workspace-write --allow-write。
安装与卸载：node scripts/install.mjs --help
`;

try {
  const { flags, positional, commandArgs } = parse(process.argv.slice(2));
  const [command, id, extra] = positional;
  if (!command || command === 'help' || flags.help) { process.stdout.write(help); }
  else {
    const workspace = path.resolve(typeof flags.workspace === 'string' ? flags.workspace : process.cwd());
    let result;
    if (command === 'codex') {
      const bridge = createCodexBridge({ workspace, allowWrite: flags['allow-write'] === true, timeoutMs: flags.timeout ? Number(flags.timeout) : 600000 });
      if (id === 'doctor') result = await bridge.doctor();
      else if (id === 'list') result = await bridge.list();
      else if (id === 'status') result = await bridge.get(extra);
      else if (id === 'cancel') result = await bridge.cancel(extra);
      else if (id === 'run') {
        const prompt = flags['prompt-file'] ? await fs.readFile(path.resolve(workspace, String(flags['prompt-file'])), 'utf8') : flags.prompt;
        let job = await bridge.start({ prompt, mode: flags.mode || 'read-only', model: flags.model });
        process.stderr.write(`Codex job: ${job.id}\n`);
        const cancel = () => { void bridge.cancel(job.id); };
        process.once('SIGINT', cancel);
        while (['queued', 'starting', 'running'].includes(job.status)) {
          await new Promise(r => setTimeout(r, 250));
          job = await bridge.get(job.id);
        }
        process.removeListener('SIGINT', cancel);
        result = job;
        if (job.status !== 'completed') process.exitCode = 1;
      } else throw new Error('未知 Codex 子命令，运行 --help 查看用法');
    } else {
      const workbench = await createWorkbench(workspace, { profile: flags.profile, dshProfilePath: flags['profile-path'] });
      switch (command) {
        case 'doctor': result = await workbench.doctor(); break;
        case 'plan': result = await workbench.createTask({ title: flags.title, goal: flags.goal, acceptance: flags.accept }); break;
        case 'list': result = await workbench.listTasks(); break;
        case 'status': result = await workbench.getTask(id); break;
        case 'update': result = await workbench.updateTask({ taskId: id, status: flags.status, note: flags.note }); break;
        case 'verify':
          if (!commandArgs.length) throw new Error('在 -- 后提供检查命令与参数');
          result = await workbench.verifyTask({ taskId: id, criterion: Number(flags.criterion), command: commandArgs[0], args: commandArgs.slice(1), timeoutMs: flags.timeout ? Number(flags.timeout) : 60000 });
          if (result.status !== 'passed') process.exitCode = 1;
          break;
        case 'artifact': result = await workbench.addArtifact({ taskId: id, path: flags.path, criterion: flags.criterion ? Number(flags.criterion) : undefined }); break;
        case 'complete': result = await workbench.completeTask(id); break;
        default: throw new Error('未知命令，运行 --help 查看用法');
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
}
