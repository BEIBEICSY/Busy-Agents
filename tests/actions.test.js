import test from 'node:test';
import assert from 'node:assert/strict';
import { createActions } from '../src/server/actions.js';

test('copyPath uses pbcopy when project path exists', async () => {
  const calls = [];
  const actions = createActions({
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { ok: true, stdout: '', stderr: '', error: '' };
    }
  });

  const result = await actions.copyPath({ projectPath: '/tmp/demo' });

  assert.equal(result.ok, true);
  assert.equal(calls[0].command, 'pbcopy');
});

test('openProject uses open for project path', async () => {
  const calls = [];
  const actions = createActions({
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { ok: true, stdout: '', stderr: '', error: '' };
    }
  });

  const result = await actions.openProject({ projectPath: '/tmp/demo' });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], { command: 'open', args: ['/tmp/demo'] });
});

test('goTo activates ChatGPT for Codex desktop thread sessions', async () => {
  const calls = [];
  const actions = createActions({
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { ok: true, stdout: '', stderr: '', error: '' };
    }
  });

  const result = await actions.goTo({
    tool: 'Codex',
    toolId: 'codex',
    source: 'codex-thread'
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].command, 'osascript');
  assert.deepEqual(calls[0].args, ['-e', 'tell application "ChatGPT" to activate']);
});
