import test from 'node:test';
import assert from 'node:assert/strict';
import { loadToolConfig, normalizeToolConfig } from '../src/server/config.js';

test('normalizeToolConfig keeps required matching fields', () => {
  const config = normalizeToolConfig({
    tools: [
      {
        id: 'codex',
        name: 'Codex',
        type: ['terminal'],
        processNames: ['codex'],
        commandKeywords: ['codex'],
        windowTitleKeywords: ['Codex'],
        preferredOpen: 'terminal'
      }
    ]
  });

  assert.equal(config.tools.length, 1);
  assert.equal(config.tools[0].id, 'codex');
  assert.deepEqual(config.tools[0].type, ['terminal']);
  assert.deepEqual(config.tools[0].commandKeywords, ['codex']);
});

test('loadToolConfig reads the project whitelist', () => {
  const config = loadToolConfig();
  const ids = config.tools.map((tool) => tool.id);

  assert.ok(ids.includes('cursor-ide'));
  assert.ok(ids.includes('codex'));
  assert.ok(ids.includes('trae-ide'));
  assert.ok(ids.includes('traework-desktop'));
  assert.ok(ids.includes('workbuddy-desktop'));
  assert.ok(ids.includes('wps-lingxi-desktop'));
  assert.ok(ids.includes('wps-comate-desktop'));
  assert.ok(ids.includes('hermes'));
  assert.ok(ids.includes('claude-code'));
  assert.equal(config.sessionLookbackDays, 7);
});
