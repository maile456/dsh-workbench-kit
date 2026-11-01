# 架构说明

## 总览

项目由纯 Node.js 核心、独立 CLI、DSH 插件适配层和可选 Codex 子进程桥组成。核心逻辑尽量只依赖 Node.js 内置模块，插件层通过 DSH 宿主接口接入审批、工作目录、shell、技能和工具注册。

```text
DSH tools / skills                  Standalone CLI
          |                               |
          +---------- src/core.js --------+
                         |
               src/storage.js
                         |
             <workspace>/.dsh-workbench/

DSH codex_* tools -> src/codex-bridge.js -> local codex exec
                                               |
                                  job events and final result
```

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/core.js` | 任务状态、验收项、命令证据、产物指纹、完成条件 |
| `src/storage.js` | 工作区内的数据读取、写入、路径边界和原子保存 |
| `src/cli.js` | 独立使用的任务与诊断命令 |
| `src/plugin.js` | DSH 插件入口、设置 schema、工具和技能注册 |
| `src/plugin-runtime.js` | 把核心操作连接到当前 DSH 工作区、审批和 shell 服务 |
| `src/codex-bridge.js` | Codex CLI 发现、作业生命周期、事件处理和取消 |
| `src/process.js` | 平台相关的直接进程启动和取消 |

## 数据生命周期

1. 任务计划和验收项存入当前项目 `.dsh-workbench/`。
2. 每次验收保存实际命令、参数、输出和退出状态。
3. 产物登记时计算 SHA-256；完成检查会重新核对文件指纹和所需验收项。
4. Codex 作业按 UUID 分目录保存提示词、事件、stderr、最终回答和状态元数据。
5. 安装配置快照独立保存在 `~/.dsh/workbench-backups/`，回滚前核对安装后哈希。

工作台记录可能含有项目内容，默认不应提交到公开仓库。

## 信任边界

- DSH 的当前工作目录是插件的数据边界；工具输入不提供任意宿主目录参数。
- 验收命令由 DSH shell provider 执行，使用参数数组和原生审批，不回退到宿主 shell。
- Codex 桥使用本机 CLI 的沙箱模式；默认只读，写模式由插件设置和 DSH 审批共同限制。
- 进程退出成功不是产物正确的证明；验收标准应由真实检查命令或明确的人工检查验证。
- 能力诊断只报告发现到的包与配置线索，不探测登录令牌，也不承诺远端服务可用。

## 兼容性策略

当前针对 DSH 0.2.1-rc.2 的宿主接口构建，并使用离线 fake provider 测试服务契约。使用 `DSH_HOST_NODE_MODULES` 时，测试会通过实际 DSH schema 包编译工具参数。真实模型、浏览器会话和网络能力属于独立运行条件，不纳入离线测试保证。
