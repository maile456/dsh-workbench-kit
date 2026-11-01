# 验证记录

记录时间：2026-11-01（Asia/Shanghai）

本记录对应当前工作区 `dsh-workbench-kit`，验证命令均在项目根目录执行。测试使用临时工作区，未启动真实模型调用，也未修改 DSH Desktop profile。

## 基线

| 命令 | 输入 | 退出状态 | 结果 |
| --- | --- | ---: | --- |
| `node --test tests/*.test.js` | 内置离线 fake Codex、临时项目目录 | 1 | 初始发现 1 项提示匹配失败：产物验收过期提示缺少“验收项尚未通过”。 |

基线失败发生在测试断言文本，不是任务状态机误报；实际状态仍为阻止完成。

## 修改后验证

| 命令 | 输入 | 退出状态 | literal 输出摘要 |
| --- | --- | ---: | --- |
| `npm test` | `node --test tests/*.test.js` | 0 | `tests 38`, `pass 37`, `fail 0`, `skipped 1` |
| `npm run demo` | 项目内 `.demo-workspace/` | 0 | `checkStatus: "passed"`, `status: "completed"` |
| `npm run verify` | 逐文件传入 5 个 `tests/*.test.js` | 0 | `verified: true` |
| `DSH_HOST_NODE_MODULES=... node --test tests/plugin.test.js` | 本机 DSH `0.2.1-rc.2` 的 host node_modules | 0 | `tests 14`, `pass 14`, `fail 0`, `skipped 0` |
| `npm pack` | 当前 `package.json` | 0 | `dsh-workbench-kit-0.1.0.tgz`, 26 files |
| `tar -tf dsh-workbench-kit-0.1.0.tgz` | 生成包 | 0 | 含 `src/`、`skills/`、`catalog/`、`docs/`、`scripts/`、`README.md` |

`npm test` 的 1 个 skipped 是未设置 `DSH_HOST_NODE_MODULES` 时的真实 DSH schema 编译检查；独立原生测试已使用本机依赖完成并为 14/14。

## 回滚验证

安装脚本在执行前将 profile 中受跟踪文件复制到 `~/.dsh/workbench-backups/install-*/`，保存原始 SHA-256；`scripts/rollback.mjs --backup PATH` 会先校验安装后哈希、恢复原始字节，再重新计算哈希。单元测试 `rollback preserves later user changes and rejects modified backups` 通过，后续手工修改不会被覆盖。

## 复测命令

```powershell
npm test
$env:DSH_HOST_NODE_MODULES='D:\Users\91146\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules'
node --test tests/plugin.test.js
npm run demo
npm run verify
```
