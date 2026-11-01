import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createWorkbench } from './core.js';
import { createCodexBridge } from './codex-bridge.js';
import { registerWorkbench } from './plugin-runtime.js';

export const name = 'dsh-workbench-kit';
export const inject = ['tools', 'skills', 'workingDirectory'];
export const Config = z.object({
  allowVerificationCommands: z.boolean().default(true),
  enableCodex: z.boolean().default(true),
  allowCodexWrite: z.boolean().default(false),
  shellDialect: z.union([z.const('auto'), z.const('powershell'), z.const('bash')]).default('auto'),
  codexCommand: z.string(),
  codexCommandArgs: z.array(z.string()),
  codexTimeoutMs: z.number().default(600000),
  maxConcurrentCodex: z.number().default(1),
  dshProfilePath: z.string(),
});

export function apply(ctx, config = {}) {
  registerWorkbench(ctx, config, {
    defineTool, createWorkbench, createCodexBridge,
    skillsRoot: fileURLToPath(new URL('../skills/', import.meta.url)),
  });
}
