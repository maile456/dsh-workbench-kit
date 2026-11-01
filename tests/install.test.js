import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { snapshotProfile, captureAfter, restoreProfile } from '../scripts/install.mjs';

test('profile snapshot restores exact bytes and removes only newly created configuration files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-install-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  await fs.mkdir(profile);
  const original = Buffer.from('{"dependencies":{"existing":"1.0"}}\r\n');
  await fs.writeFile(path.join(profile, 'package.json'), original);
  const snap = await snapshotProfile(profile, path.join(root, 'backups'));
  await fs.writeFile(path.join(profile, 'package.json'), '{"dependencies":{"existing":"1.0","dsh-workbench-kit":"0.1.0"}}');
  await fs.writeFile(path.join(profile, 'pnpm-lock.yaml'), 'test: installation\n');
  await fs.writeFile(path.join(profile, 'unrelated.txt'), 'keep');
  await captureAfter(snap.backup, snap.manifest);
  const result = await restoreProfile(snap.backup);
  assert.equal(result.restored, true);
  assert.deepEqual(await fs.readFile(path.join(profile, 'package.json')), original);
  await assert.rejects(fs.access(path.join(profile, 'pnpm-lock.yaml')));
  assert.equal(await fs.readFile(path.join(profile, 'unrelated.txt'), 'utf8'), 'keep');
});

test('rollback preserves later user changes and rejects modified backups', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-rollback-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  await fs.mkdir(profile); await fs.writeFile(path.join(profile, 'package.json'), '{}');
  const snap = await snapshotProfile(profile, path.join(root, 'backups'));
  await fs.writeFile(path.join(profile, 'package.json'), '{"installed":true}');
  await captureAfter(snap.backup, snap.manifest);
  await fs.writeFile(path.join(profile, 'package.json'), '{"installed":true,"later":true}');
  await assert.rejects(restoreProfile(snap.backup), /新变化/);
  await fs.writeFile(path.join(profile, 'package.json'), '{"installed":true}');
  await fs.writeFile(path.join(snap.backup, 'package.json'), 'tampered');
  await assert.rejects(restoreProfile(snap.backup), /哈希/);
  assert.equal(await fs.readFile(path.join(profile, 'package.json'), 'utf8'), '{"installed":true}');
});
