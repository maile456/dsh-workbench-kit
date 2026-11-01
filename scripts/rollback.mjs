#!/usr/bin/env node
import { restoreProfile } from './install.mjs';
try {
  const index = process.argv.indexOf('--backup');
  if (index < 0 || !process.argv[index + 1]) throw new Error('用法：node scripts/rollback.mjs --backup BACKUP_DIRECTORY（先退出 DSH）');
  console.log(JSON.stringify(await restoreProfile(process.argv[index + 1]), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
