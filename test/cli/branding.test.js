import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { COMMANDS } from '../../cli/lib/commands.js';
import { finishCliSuite, makeHome, runCli } from '../helpers/cli.js';

async function publicFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? publicFiles(path) : [path];
  }));
  return files.flat();
}

test('public text and all CLI help pages use neutral names', async () => {
  const root = new URL('../../', import.meta.url);
  const paths = [
    ...await publicFiles(new URL('public/', root)),
    ...['README.md', 'PRODUCT.md', 'docs/API.md', 'docs/CLI.md'].map((path) => new URL(path, root)),
  ];
  for (const path of paths) {
    assert.doesNotMatch(await readFile(path, 'utf8'), /morph/i, path.pathname);
  }
  assert.doesNotMatch(JSON.parse(await readFile(new URL('package.json', root), 'utf8')).description, /morph/i);
  const home = await makeHome();
  try {
    const commands = [[], ...Object.entries(COMMANDS).flatMap(([name, command]) => [
      [name],
      ...Object.keys(command.subcommands ?? {}).map((subcommand) => [name, subcommand]),
    ])];
    for (const command of commands) {
      const result = await runCli([...command, '--help'], { home });
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /morph/i, command.join(' '));
    }
  } finally {
    await finishCliSuite();
  }
});
