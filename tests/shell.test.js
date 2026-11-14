import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../src/server/shell.js';

test('runCommand returns an error object when spawn fails synchronously', async () => {
  const result = await runCommand('', []);

  assert.equal(result.ok, false);
  assert.match(result.error, /file|argument|spawn|command/i);
});
