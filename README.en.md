# DSH Workbench Kit

Turn DeepSeek Harness (DSH) conversations into traceable, verifiable, and recoverable project workflows, with an optional bridge to the local Codex CLI.

[简体中文](README.md) | [English](README.en.md)

## What it does

DSH Workbench Kit is a lightweight local workbench plugin and CLI. It organizes task plans, acceptance criteria, execution evidence, deliverables, and recovery steps. It does not replace DSH search, vision, memory, or Office integrations, and it does not copy Codex Desktop accounts, connectors, or subscription access.

| Track | Purpose | Entry points |
| --- | --- | --- |
| Workbench enhancement | Keep long tasks, criteria, evidence, and artifacts organized | `workbench_*` tools, six skills, standalone CLI |
| Codex collaboration | Delegate a bounded local coding task and preserve its execution record | `codex_start`, `codex_status`, `codex_list`, `codex_cancel` |

## Features

- Project-local task ledger with goals, states, next steps, and numbered acceptance criteria.
- Verification records with executable, arguments, stdout, stderr, exit status, and timing.
- SHA-256 artifact fingerprints; changing a deliverable invalidates its previous verification.
- Capability discovery that distinguishes installed packages from working services.
- Six reusable skills for delivery, research, coding, Office, browser, and Codex tasks.
- Optional local Codex CLI bridge with background jobs, JSONL events, status lookup, and cancellation.
- Installer backups and guarded rollback.

## Requirements

- Node.js 22+
- DSH Desktop 0.2.1-rc.2 or a compatible release when using the native plugin
- A locally installed and signed-in Codex CLI for the Codex bridge

Clone the repository:

```powershell
git clone https://github.com/maile456/dsh-workbench-kit.git
cd dsh-workbench-kit
```

## Verify locally

```powershell
npm test
npm run demo
npm run verify
```

Tests use Node.js built-ins and do not call a model or require network access. To compile and validate schemas against an installed DSH package set:

```powershell
$env:DSH_HOST_NODE_MODULES='D:\Path\To\DeepSeek Harness\resources\app\dsh\node_modules'
node --test tests/plugin.test.js
```

## Standalone CLI

```powershell
node src/cli.js plan --workspace . --title "Release report" --goal "Create and check the report" --accept "Report exists" --accept "Data checks pass"
node src/cli.js list --workspace .
node src/cli.js doctor --workspace . --profile desktop
```

Verification commands are passed as an executable and argument array after `--`:

```powershell
node src/cli.js verify TASK_ID --workspace . --criterion 2 -- node check-report.mjs
node src/cli.js artifact TASK_ID --workspace . --path report.md --criterion 1
node src/cli.js complete TASK_ID --workspace .
```

## Install into DSH Desktop

Build the package and fully exit DSH before installation:

```powershell
npm pack
node scripts/install.mjs --profile desktop --package .\dsh-workbench-kit-0.1.0.tgz --dry-run
node scripts/install.mjs --profile desktop --package .\dsh-workbench-kit-0.1.0.tgz
```

The installer stores profile snapshots and hashes in `~/.dsh/workbench-backups/`. Restore a snapshot with:

```powershell
node scripts/rollback.mjs --backup PATH_TO_BACKUP
```

Rollback checks that the installed configuration has not changed since installation. Later manual edits are preserved.

## Codex bridge boundaries

The bridge reuses the local Codex CLI configuration and defaults to `read-only`. Write mode also requires the plugin setting, writable workspace, and per-run DSH approval. Each job stores its prompt, JSONL events, stderr, final response, and status metadata under `.dsh-workbench/`.

A `completed` job means the CLI turn ended successfully; it does not mean the project output passed acceptance checks. Verify actual files and behavior with `workbench_verify` and appropriate artifact checks.

## Documentation

- [Task workflows](docs/workflows.md)
- [Codex bridge](docs/codex-bridge.md)
- [DSH compatibility](docs/dsh-compatibility.md)
- [Architecture](docs/architecture.md)
- [FAQ](docs/faq.md)
- [Verification record](docs/verification-record.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Development

```powershell
npm test
git diff --check
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Do not commit `.dsh-workbench/`, `.test-tmp/`, `.env` files, generated packages, or local DSH profiles.

## License

[MIT](LICENSE)

## Feedback

Use [GitHub Issues](https://github.com/maile456/dsh-workbench-kit/issues) for reproducible bug reports and feature requests. Include Node.js and DSH versions, minimal reproduction steps, and redacted logs. Never attach credentials or sensitive workspace files.
