import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowJson, buildWindowSessions } from '../src/server/windowScanner.js';

const tools = [
  {
    id: 'cursor-ide',
    name: 'Cursor IDE',
    type: ['gui'],
    processNames: ['Cursor'],
    commandKeywords: ['cursor'],
    windowTitleKeywords: ['Cursor', 'ai-tool-session-dashboard'],
    preferredOpen: 'cursor'
  }
];

test('parseWindowJson parses AppleScript JSON output', () => {
  const windows = parseWindowJson('[{"app":"Cursor","title":"ai-tool-session-dashboard - Cursor"}]');

  assert.equal(windows.length, 1);
  assert.equal(windows[0].app, 'Cursor');
  assert.equal(windows[0].title, 'ai-tool-session-dashboard - Cursor');
});

test('buildWindowSessions matches configured GUI tools', () => {
  const sessions = buildWindowSessions({
    windows: [{ app: 'Cursor', title: 'ai-tool-session-dashboard - Cursor' }],
    tools,
    now: new Date('2026-06-11T10:00:00.000Z')
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].tool, 'Cursor IDE');
  assert.equal(sessions[0].source, 'window');
  assert.equal(sessions[0].projectName, 'ai-tool-session-dashboard');
  assert.equal(sessions[0].title, '编辑器');
});
