import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

test('capability catalog can be consumed without presuming installed services are ready', async () => {
  const catalog = JSON.parse(await read('catalog/capabilities.json'));
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(nonempty(catalog.discoveryPolicy));
  assert.match(catalog.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(catalog.capabilities) && catalog.capabilities.length > 0);
  const ids = new Set();
  for (const capability of catalog.capabilities) {
    assert.match(capability.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(!ids.has(capability.id), `Duplicate capability ${capability.id}`);
    ids.add(capability.id);
    for (const field of ['title', 'description', 'toolDiscovery', 'setupNotes', 'skill']) {
      assert.ok(nonempty(capability[field]), `${capability.id}.${field}`);
    }
    for (const field of ['pluginPackages', 'tools', 'requiredConfiguration']) {
      assert.ok(Array.isArray(capability[field]), `${capability.id}.${field}`);
      assert.ok(capability[field].every(nonempty), `${capability.id}.${field} values`);
      assert.equal(new Set(capability[field]).size, capability[field].length);
    }
    assert.equal(new URL(capability.sourceUrl).protocol, 'https:');
    assert.ok(capability.requiredConfiguration.length > 0);
    assert.equal(Object.hasOwn(capability, 'ready'), false);
    assert.equal(Object.hasOwn(capability, 'installed'), false);
    await access(path.join(root, 'skills', capability.skill, 'SKILL.md'));
  }
});

test('all bundled skills are independently discoverable with valid frontmatter', async () => {
  const entries = await readdir(path.join(root, 'skills'), { withFileTypes: true });
  const skillDirectories = entries.filter((entry) => entry.isDirectory());
  assert.equal(skillDirectories.length, 6);
  const names = new Set();
  for (const directory of skillDirectories) {
    const raw = await read(`skills/${directory.name}/SKILL.md`);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
    assert.ok(frontmatter, `${directory.name}: frontmatter`);
    const fields = Object.fromEntries(frontmatter[1].split(/\r?\n/).map((line) => {
      const colon = line.indexOf(':');
      assert.ok(colon > 0, `Invalid field in ${directory.name}`);
      return [line.slice(0, colon), line.slice(colon + 1).trim()];
    }));
    assert.equal(fields.name, directory.name);
    assert.match(fields.name, /^[a-z][a-z0-9-]{0,63}$/);
    assert.ok(nonempty(fields.description));
    assert.ok(fields.description.length < 1024);
    assert.ok(!names.has(fields.name));
    names.add(fields.name);
    assert.ok(raw.slice(frontmatter[0].length).trim().length > 150);
    assert.doesNotMatch(raw, /\bTODO\b|\bTBD\b|\[INSERT\b/);
  }
});

test('workflow documentation links resolve inside the distributable project', async () => {
  const targets = ['docs/workflows.md'];
  const directories = await readdir(path.join(root, 'skills'), { withFileTypes: true });
  targets.push(...directories.filter((entry) => entry.isDirectory()).map((entry) => `skills/${entry.name}/SKILL.md`));
  for (const relative of targets) {
    const raw = await read(relative);
    for (const match of raw.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const href = match[1];
      if (/^https?:\/\//.test(href)) {
        assert.equal(new URL(href).protocol, 'https:');
        continue;
      }
      if (href.startsWith('#')) continue;
      const target = path.resolve(root, path.dirname(relative), href.split('#')[0]);
      const within = path.relative(root, target);
      assert.ok(!within.startsWith('..') && !path.isAbsolute(within));
      await access(target);
    }
  }
});
