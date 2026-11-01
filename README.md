# DSH Workbench Kit

`dsh-workbench-kit` 把 DSH 的一次性对话整理成可追踪、可验证、可恢复的项目工作流，并提供可选的本机 Codex 调度入口。

## 能做什么

### 路线一：增强 DSH 工作能力

- 在当前工作区建立任务账本、状态、备注和编号验收标准。
- 用真实命令记录 stdout、stderr、退出状态、超时和工作区快照。
- 登记交付文件并保存 SHA-256；文件变更会使旧验收失效。
- 提供能力诊断和六套可复用技能：交付、研究、编程、Office、浏览器、Codex。
- 复用 DSH 已安装的搜索、视觉、记忆和 Office 能力，不自动替换现有插件。

### 路线二：让 DSH 调度本机 Codex

- `codex_start` 启动后台任务，保存 JSONL 事件、stdout、stderr 和最终回答。
- `codex_status`、`codex_list`、`codex_cancel` 支持查询和取消。
- 默认 `read-only`；写模式同时需要 DSH 的可写策略、审批和 `allowCodexWrite: true`。
- 限制工作区路径、超时、输出大小和并发数；不读取登录凭据，也不加入绕过审批的参数。

这不是把 Codex Desktop 的连接器、登录态或模型能力完整复制到 DSH，而是一个有边界的本地协作适配器。

## 快速开始

环境要求：Node.js 22+。在项目目录运行：

```powershell
npm test
npm run demo
npm run verify
```

在已安装 DSH Desktop 依赖的机器上，还可以验证真实工具 schema 和服务契约（不会启动 DSH 或模型）：

```powershell
$env:DSH_HOST_NODE_MODULES='D:\Users\91146\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules'
node --test tests/plugin.test.js
```

独立 CLI 示例：

```powershell
node src/cli.js plan --workspace . --title "交付报告" --goal "生成并核对报告" --accept "报告文件存在" --accept "数据核对通过"
node src/cli.js list --workspace .
node src/cli.js doctor --workspace . --profile desktop
```

`verify` 的命令必须放在 `--` 后，并按“可执行文件 + 参数”传递：

```powershell
node src/cli.js verify TASK_ID --workspace . --criterion 2 -- node check-report.mjs
node src/cli.js artifact TASK_ID --workspace . --path report.md --criterion 1
node src/cli.js complete TASK_ID --workspace .
```

## 安装到 DSH Desktop

先构建并检查 `.tgz` 包，再完全退出 DSH：

```powershell
npm pack
node scripts/install.mjs --profile desktop --package .\dsh-workbench-kit-0.1.0.tgz --dry-run
node scripts/install.mjs --profile desktop --package .\dsh-workbench-kit-0.1.0.tgz
```

安装脚本会在 `~/.dsh/workbench-backups/` 保存 profile 配置快照、原始哈希和安装后哈希。常规卸载请在 DSH 插件页移除插件；需要恢复安装前配置时：

```powershell
node scripts/rollback.mjs --backup PATH_TO_BACKUP
```

回滚会先检查安装后配置是否仍是脚本写入的版本；检测到后续手工修改时会保留现状并停止，避免覆盖新配置。

## DSH 配置要点

插件配置位于 DSH Desktop profile 的插件设置中：

- `enableCodex: true`：显示路线二工具。
- `allowVerificationCommands: true`：允许通过 DSH shell 执行验收命令。
- `allowCodexWrite: false`：默认关闭 Codex 写模式，按项目需要显式开启。
- `codexTimeoutMs`、`maxConcurrentCodex`：限制后台 Codex 任务。

工作台记录写入当前会话工作区的 `.dsh-workbench/`。只读会话可以查询，但创建任务、登记文件、执行验证和启动 Codex 需要 DSH 的可写工作区与审批服务。

## 目录

- `src/core.js`：任务账本、验收、文件指纹和诊断。
- `src/codex-bridge.js`：本机 Codex 发现、后台作业、事件和取消。
- `src/plugin.js`、`src/plugin-runtime.js`：DSH 原生工具和技能提供方。
- `skills/`、`catalog/`、`docs/`：可复用技能、能力目录和中文工作流。
- `scripts/install.mjs`、`scripts/rollback.mjs`：安装、备份和回滚。
- `tests/`：离线单元测试与 DSH 原生接口兼容测试。
- `docs/verification-record.md`：本次基线、修改后结果和回滚验证记录。

## 验证边界

静态能力诊断只说明 profile 中发现了软件包；它不代表服务额度、浏览器登录、模型可达性或最终产物质量。内容、数据、视觉和公式验收必须由真实检查程序完成。
