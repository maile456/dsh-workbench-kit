# DSH 原生适配与验证边界

## 已核对的版本

适配目标是 DeepSeek Harness **0.2.1-rc.2**。本机桌面安装的包公开接口用于只读核对：

- `@deepseek-ai/dsh-tools` 0.2.1-rc.2：`defineTool` 和 `ctx.tools.register`。
- `@deepseek-ai/dsh-working-directory`：`ctx.workingDirectory.ensure(exec.agent, exec.signal)`。
- `@deepseek-ai/dsh-skill`：`ctx.skills.registerProvider(() => provider)`。
- `@deepseek-ai/dsh-user-approval`：`ctx.get('approval').request(...)`，只接受 `allowed-once`。
- `@deepseek-ai/dsh-shell`：`resolve(request)`、`execute(spec)`、`result()`。
- `@deepseek-ai/dsh-sandbox-policy`：`resolve({ session })`。
- `@deepseek-ai/schemastery` 3.18.5：插件设置 schema。

DSH 当前仍有预览版接口变动。兼容检查代表工具 schema、服务契约及安装包的检查；不等于已经在正在运行的桌面应用中完成真实模型调用。

## 注册的工具

路线一：`workbench_plan`、`workbench_status`、`workbench_list`、`workbench_update`、`workbench_verify`、`workbench_artifact`、`workbench_complete`、`workbench_doctor`。

路线二：`codex_start`、`codex_status`、`codex_list`、`codex_cancel`。`enableCodex: false` 时不注册这四个工具。

所有工具都从当前会话获取工作目录；模型参数中没有可任意选择宿主目录的 `workspace` 字段。任务记录与桥接日志归当前项目所有。跨会话使用同一项目时可读取其既有任务。

## 文件范围与命令执行

账本写操作先读取 DSH 当前文件策略。只读会话允许查询，新增任务、记录产物和启动桥接需要在 DSH 中选择可写工作区。工作区可写模式还会将当前目录与会话原始工作区做真实路径比较，避免目录切换扩张写入范围。

`workbench_verify` 每次调用 DSH 原生审批，批准后重新检查工作区和文件策略。命令以 executable/args 输入，再逐参数作为字面量引用，交由 DSH 已挂载的 shell 执行器；传入原始 `sandboxPolicy`、取消信号与时间限制。缺少 shell 服务时直接报告配置问题，不退回宿主直接执行。文件策略启用时，非隔离 shell 提供方也不会被当作隔离执行器使用。当前会话若明确采用无隔离执行器与全权限模式，命令遵循该宿主配置。

默认自动选择当前主机的 PowerShell 或 Bash，也可由用户设置 `shellDialect`。此适配器面向本机工作区；远程工作区和跨操作系统 shell 应单独接入相应的远程执行器。

`codex_start` 每次调用原生审批，默认给子 Codex 传 `read-only`。写模式需要插件设置 `allowCodexWrite: true`，并仍保留每次启动审批。它使用本机 Codex 自己的隔离机制；dsh 的细粒度自定义规则不会自动翻译给子 Codex，因此这里只支持三种标准文件模式与本地工作区。子 Codex 的日志需要写入项目目录，所以 DSH 只读会话只提供桥接状态查询。

文件存在与哈希检查仅验证结构、完整性和是否发生变化。文档内容、数据正确性、界面布局等仍需按技能里的要求增加相应检查。

## 设置

在本插件的配置中可设置：

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `allowVerificationCommands` | `true` | 是否提供命令验收执行；始终保留原生审批 |
| `enableCodex` | `true` | 是否注册 Codex 协作工具 |
| `allowCodexWrite` | `false` | 是否允许请求 Codex 工作区写模式 |
| `shellDialect` | `auto` | `auto`、`powershell`、`bash` |
| `codexCommand` | 自动发现 | 手工指定本地 Codex 可执行程序 |
| `codexCommandArgs` | 空 | 明确配置 Node 启动器时的固定前置参数 |
| `codexTimeoutMs` | `600000` | Codex 作业时限 |
| `maxConcurrentCodex` | `1` | 每工作区并发作业上限 |
| `dshProfilePath` | 核心默认探测 | 可选的 profile 目录，仅用于检查 package.json 中的能力插件 |

## 验证方式

`node --test tests/plugin.test.js` 执行离线服务契约、拒绝/缺失审批、文件边界、取消、命令引用、技能加载等测试。

设置 `DSH_HOST_NODE_MODULES` 为已有 DSH 安装的 `node_modules` 后，同一测试还使用该安装的真正 `defineTool` 编译和验证全部工具 schema。未设置时，这项明确标记为 skipped，其他测试继续运行。该检查不会启动 DSH，不读取账号凭据，也不修改已有 profile。

官方接口参考：

- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/shell.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/working-directory.md
