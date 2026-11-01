#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const command = process.execPath;

function run(file, fileArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, fileArgs, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
}

const testFiles = (await fs.readdir(path.join(root, 'tests')))
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => path.join('tests', name));
const testExit = await run('tests', ['--test', ...testFiles]);
if (testExit !== 0) process.exitCode = testExit;
else console.log(JSON.stringify({ verified: true, suite: ['node', '--test', ...testFiles] }));
