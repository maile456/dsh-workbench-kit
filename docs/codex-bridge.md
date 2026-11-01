# 路线二：在 DSH 中交给 Codex 执行

本模块通过本机 `codex exec` 运行任务，复用 Codex CLI 已有的登录和配置。它不导入账号文件，也不复制 Codex 桌面端的专属插件、订阅额度或界面。

## 先决条件

1. 已安装 Codex CLI，并在终端完成登录；本项目只检查可执行文件与参数，不代替登录。
2. 所选工作目录应当是你明确选择的 Git 项目。桥不会自动添加 `--skip-git-repo-check`；非 Git 目录由 Codex 返回原始错误。
3. 默认使用 `read-only`，适合分析、审查和规划。需要改代码时，先在插件设置启用 `allowCodexWrite`，再选择 `workspace-write`。
4. Codex 使用你已有的模型配置；任务可单独指定可用模型。实际调用仍消耗对应模型的额度。

## 模块接口

```js
import { createCodexBridge } from '../src/codex-bridge.js';

const bridge = createCodexBridge({
  workspace: '/absolute/project',
  allowWrite: false,
  timeoutMs: 30 * 60 * 1000,
  maxConcurrent: 1,
});
const diagnostic = await bridge.doctor();
const job = await bridge.start({
  prompt: '检查失败的测试，给出有文件位置和证据的修复建议。',
  mode: 'read-only',
  taskId: '关联的工作台任务标识',
});
const progress = await bridge.get(job.id);
// await bridge.cancel(job.id);
```

`start()` 创建后台子进程后立即返回。宿主进程需要持续运行；DSH 插件会保留桥实例。`get()` 和 `list()` 可读取持久化结果，`cancel()` 只请求原执行进程取消任务，不根据任意记录的 PID 杀进程。

支持 `command` 和 `commandArgs` 指定宿主级的可执行文件，例如 `node` 加 Codex CLI 的 `bin/codex.js`。Windows 会优先找真正的 `codex.exe`，并识别 npm 安装中的平台二进制；不执行 `.cmd`、`.bat` 或 `.ps1` 包装脚本。所有参数使用数组传递，提示词从 stdin 输入。

## 验证与结果

每个任务在工作区 `.dsh-workbench/codex/cx-<uuid>/` 保存：

- `prompt.md`：本次明确提交的任务。
- `events.jsonl`：原始 stdout JSONL 事件，含会话标识和工具活动。
- `stderr.log`：原始 stderr 输出。
- `final.md`：最终回答。
- `job.json`：工作目录、执行参数、退出码、状态、token 使用信息和文件路径；长回答只保留摘要，完整内容在 `final.md`。

只有退出码为 0、收到 `turn.completed`、没有失败事件或损坏 JSONL，并获得非空最终回答，才标记 `completed`。这表示 Codex 这一轮正常结束；工作结果是否达到验收标准，仍需要工作台的检查步骤验证。

其他状态：`failed`（执行/协议失败）、`cancelled`（用户取消）、`timed_out`（超时）、`output_limit`（输出超限）、`interrupted`（宿主中断、未确认完成）。当前版本提供任务级新会话，保留会话 ID 供追溯；尚未提供自动续接或自动合并不同任务。

默认超时 30 分钟，stdout/stderr 合计最多 2 MiB，最终文件也限制在 2 MiB，提示词最多 128 KiB。文件日志保留在本地，内容可能包含项目材料，按项目资料管理。最终文件的大小检查发生在运行期间和结束时；短时间写入的大文件可能先落盘，然后被标记超限，不会加载进内存。

运行时显式设置 Codex 审批策略 `never`：只在选定的权限模式内执行，超出边界的操作返回失败，不挂起等待终端输入。它不关闭 Codex 的文件权限限制，也不启用绕过开关。进程取消在 Windows 使用系统 `taskkill /T`，其他平台终止单独的进程组。强制结束整个宿主可能留下未收尾状态，重启后会标记 `interrupted`，不会假定成功。

## 测试边界

自动测试使用独立的 `fake-codex.mjs` 子进程验证协议、stdin、失败、取消、超时、输出限制和路径边界，不访问模型、不读取登录信息。`doctor()` 可对真实已安装 CLI 执行 `--version` 与 `exec --help`；成功不代表账号已登录、模型可用或端到端模型任务已成功。

设计依据：[Codex SDK 官方说明](https://learn.chatgpt.com/docs/codex-sdk)。当前实现选择 CLI 兼容层，适配本机已核对的 Codex 0.147.0 参数；后续更深的交互式审批或界面集成可使用 App Server。
