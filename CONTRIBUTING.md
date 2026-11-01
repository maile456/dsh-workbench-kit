# 贡献指南

感谢参与 DSH Workbench Kit。项目优先保持小依赖、可复现和边界清晰。

## 开始开发

1. 安装 Node.js 22+。
2. 克隆仓库；项目测试基于 Node.js 内置模块，无需安装运行时依赖。
3. 运行 `npm test`、`npm run demo` 和 `npm run verify`。
4. 修改后运行 `git diff --check`。

## 提交要求

- 新行为必须有测试；修复问题时优先补充回归测试。
- 同步更新 README 或 `docs/` 中受影响的说明。
- 命令使用参数数组传递，不把用户输入拼接进 shell 字符串。
- 文件写入必须限制在明确的工作区；不要读取或提交登录凭据。
- 不提交 `.dsh-workbench/`、`.test-tmp/`、`.env`、安装包或本机 profile。
- 提交信息使用简短、清晰的动词开头，例如 `feat:`、`fix:`、`docs:`、`test:`。

## Pull Request

请说明改动解决的问题和范围、新增或修改的测试、`npm test` / `npm run demo` / `npm run verify` 的结果，以及 DSH 预览版接口的兼容性影响。

保持 PR 聚焦。如果改动影响安装或回滚，请同时更新验证记录和对应脚本测试。
