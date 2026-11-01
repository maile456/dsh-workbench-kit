# DSH Workbench Kit

把 DeepSeek Harness（DSH）的对话式工作，变成可追踪、可验证、可恢复的项目流程，并按需调度本机 Codex CLI。

[简体中文](README.md) | [English](README.en.md)

[![CI](https://github.com/maile456/dsh-workbench-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/maile456/dsh-workbench-kit/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 项目定位

DSH Workbench Kit 是一个轻量的本地工作台插件与 CLI。它不替换 DSH 已有的搜索、视觉、记忆或 Office 能力，也不复制 Codex Desktop 的账号、连接器或额度；它负责把任务拆解、证据、产物和恢复步骤组织起来。

项目包含两条路线：

| 路线 | 解决的问题 | 主要入口 |
| --- | --- | --- |
| 路线一：工作台增强 | 长任务容易丢进度、验收标准不清、文件交付无法追溯 | `workbench_*` 工具、六套技能、独立 CLI |
| 路线二：Codex 协作 | 需要把明确的本机编码子任务交给 Codex，并保留过程记录 | `codex_start`、`codex_status`、`codex_list`、`codex_cancel` |

## 核心能力

- **任务账本**：记录目标、状态、下一步和编号验收标准。
- **证据链**：保存命令、参数、标准输出、错误输出、退出码和执行时间。
- **产物指纹**：登记交付文件并保存 SHA-256；文件变化后旧验收自动失效。
- **能力诊断**：识别 DSH profile 中已安装的工具和插件线索，不把“已安装”误判成“服务可用”。
- **六套技能**：交付、研究、编程、Office、浏览器、Codex。
- **Codex 桥接**：后台执行、JSONL 事件、最终回答、状态查询、取消和边界控制。
- **安装可回滚**：安装前保存 profile 快照、哈希和恢复记录。

## 快速开始

### 获取项目

```powershell
git clone https://github.com/maile456/dsh-workbench-kit.git
cd dsh-workbench-kit
```

### 环境

- Node.js 22 或更高版本
- 使用 DSH 插件时：DeepSeek Harness 0.2.1-rc.2 或兼容版本
- 使用路线二时：本机已安装并登录 Codex CLI

### 本地验证

```powershell
npm test
npm run demo
npm run verify
```

项目核心测试只使用 Node.js 内置模块，默认不访问网络、不调用模型。完整的 DSH 原生接口检查：

```powershell
$env:DSH_HOST_NODE_MODULES='D:\Users\91146\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules'
node --test tests/plugin.test.js
```

### 使用独立 CLI

```powershell
node src/cli.js plan --workspace . --title "交付报告" --goal "生成并核对报告" --accept "报告文件存在" --accept "数据核对通过"
node src/cli.js list --workspace .
node src/cli.js doctor --workspace . --profile desktop
```

验收命令放在 `--` 后，以可执行文件和参数数组传递：

```powershell
node src/cli.js verify TASK_ID --workspace . --criterion 2 -- node check-report.mjs
node src/cli.js artifact TASK_ID --workspace . --path report.md --criterion 1
node src/cli.js complete TASK_ID --workspace .
```

### 安装到 DSH Desktop

先构建包，再完全退出 DSH：

```powershell
npm pack
node scripts/install.mjs --profile desktop --package .\dsh-workbench-kit-0.1.0.tgz --dry-run
node scripts/install.mjs --profile desktop --package .\dsh-workbench-kit-0.1.0.tgz
```

安装脚本会在 `~/.dsh/workbench-backups/` 保存配置快照、原始哈希和安装后哈希。需要恢复安装前配置时：

```powershell
node scripts/rollback.mjs --backup PATH_TO_BACKUP
```

回滚前会检查安装后文件是否仍是脚本写入的版本；检测到后续手工修改时会保留现状并停止。

## DSH 配置

插件设置中的常用字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enableCodex` | `true` | 是否注册路线二工具 |
| `allowVerificationCommands` | `true` | 是否提供命令验收执行，仍保留 DSH 原生审批 |
| `allowCodexWrite` | `false` | 是否允许 Codex 请求工作区写模式 |
| `shellDialect` | `auto` | 使用 `auto`、`powershell` 或 `bash` |
| `codexTimeoutMs` | `600000` | 单个 Codex 作业的时限 |
| `maxConcurrentCodex` | `1` | 每个工作区的并发上限 |

工作台记录写入当前项目的 `.dsh-workbench/`。只读会话可以查询；创建任务、执行验收、登记产物和启动 Codex 需要 DSH 提供可写工作区与审批服务。

## 路线二：Codex 桥接边界

桥接复用本机 Codex CLI 的登录和配置，默认使用 `read-only`。写模式必须同时满足插件设置、工作区权限和每次启动的 DSH 审批。每个作业保存：

- `prompt.md`：提交给 Codex 的任务
- `events.jsonl`：原始事件流
- `stderr.log`：错误输出
- `final.md`：最终回答
- `job.json`：状态、退出码、工作目录和 token 使用信息

`completed` 只表示 Codex 进程正常结束，不等于项目成果自动通过验收；仍需使用 `workbench_verify` 和真实产物检查。

## 目录结构

```text
src/          核心账本、CLI、插件和 Codex 桥
skills/       六套可复用工作技能
catalog/      能力目录
docs/         安装、兼容性、工作流和桥接说明
scripts/      演示、安装、验证和回滚脚本
tests/        离线单元测试与 DSH 原生契约测试
```

详细说明：

- [真实任务工作流](docs/workflows.md)
- [Codex 桥接](docs/codex-bridge.md)
- [DSH 兼容性与边界](docs/dsh-compatibility.md)
- [架构说明](docs/architecture.md)
- [常见问题](docs/faq.md)
- [验证记录](docs/verification-record.md)

## 验证结果

基线验证包括：`npm test`、演示流程、独立 CLI 验证、DSH 原生接口检查、打包检查和安装回滚检查。测试不会读取账号凭据，也不会把静态能力发现当成模型或服务可用性证明。最新结果见 [验证记录](docs/verification-record.md)。

## 开发与贡献

```powershell
npm test
git diff --check
```

提交前请补充对应测试和文档，保持 Node.js 内置模块优先，并避免把 `.dsh-workbench/`、`.test-tmp/`、`.env` 或构建包提交到仓库。详见 [贡献指南](CONTRIBUTING.md)。

## 路线图

- [x] 可追踪任务、验收和产物指纹
- [x] DSH 原生工具与技能挂载
- [x] 本机 Codex 后台桥接
- [x] 安装备份与可验证回滚
- [ ] 增加更多可复用的领域技能模板
- [ ] 根据 DSH 预览版接口变化持续更新兼容层
- [ ] 增加更丰富的任务导出与团队协作格式

## 许可证

[MIT License](LICENSE)

## 联系与反馈

请通过 [Issues](https://github.com/maile456/dsh-workbench-kit/issues) 报告可复现问题或提出功能建议。提交问题时请附上 Node.js 版本、DSH 版本、最小复现步骤和相关日志摘要；不要上传账号令牌或包含敏感内容的工作区文件。
