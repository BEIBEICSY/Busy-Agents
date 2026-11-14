import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefaultScanner } from '../src/server/httpServer.js';
import { createTerminalSessionLog } from '../src/server/terminalSessionLog.js';

const disabledProductReaders = {
  workBuddy: false,
  traeIde: false,
  traeWork: false,
  wpsLingxi: false,
  wpsComate: false
};

function tempLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-terminal-log-'));
  return path.join(dir, 'terminal-sessions.json');
}

function claudeSession(now) {
  return {
    id: 'process:9',
    tool: 'Claude Code',
    toolId: 'claude-code',
    appName: 'Terminal',
    source: 'terminal',
    title: '终端任务',
    projectName: 'demo',
    projectPath: '/tmp/demo',
    status: 'running',
    lastActivityAt: now.toISOString(),
    statusFacts: {
      hasExecution: true,
      executionPhase: 'active',
      viewState: 'indeterminate',
      nativeStatus: 'process-active',
      signalSource: 'process',
      signalObservedAt: now.toISOString()
    },
    process: {
      pid: 9,
      elapsedSeconds: 12,
      command: 'claude --print SECRET_PROMPT'
    },
    jump: {
      canActivateApp: true,
      canOpenProject: true,
      canCopyPath: true
    }
  };
}

test('terminal log keeps a seen CLI task after the process and the radar both restart', () => {
  const filePath = tempLogPath();
  const now = new Date('2026-11-13T10:00:00.000Z');
  const first = createTerminalSessionLog({ filePath });
  const seen = first.sync([claudeSession(now)], { now, lookbackDays: 7, processScanOk: true });
  assert.deepEqual(seen, []);

  const later = new Date('2026-11-13T10:05:00.000Z');
  const reloaded = createTerminalSessionLog({ filePath });
  const retained = reloaded.sync([], { now: later, lookbackDays: 7, processScanOk: true });

  assert.equal(retained.length, 1);
  assert.equal(retained[0].toolId, 'claude-code');
  assert.equal(retained[0].projectPath, '/tmp/demo');
  assert.equal(retained[0].status, 'unknown');
  assert.equal(retained[0].statusReason, '进程已退出，但没有取得根轮次终态');
  assert.equal(retained[0].statusFacts.executionPhase, 'unknown');
  assert.equal(JSON.stringify(retained[0]).includes('SECRET_PROMPT'), false);
  assert.equal(fs.readFileSync(filePath, 'utf8').includes('SECRET_PROMPT'), false);
});

test('terminal log does not duplicate a Codex CLI task already stored in the thread database', () => {
  const filePath = tempLogPath();
  const now = new Date('2026-11-13T10:00:00.000Z');
  const log = createTerminalSessionLog({ filePath });
  log.sync([{
    ...claudeSession(now),
    id: 'process:4:codex-thread:thread-1',
    tool: 'Codex·CLI',
    toolId: 'codex-cli',
    codexThread: { id: 'thread-1', title: '已有线程' }
  }], { now, processScanOk: true });
  const retained = log.sync([], { now: new Date('2026-11-13T10:05:00.000Z'), processScanOk: true });

  assert.deepEqual(retained, []);
});

test('terminal log keeps Hermes and a Codex CLI task that has no thread record', () => {
  const filePath = tempLogPath();
  const now = new Date('2026-11-13T10:00:00.000Z');
  const log = createTerminalSessionLog({ filePath });
  log.sync([
    {
      ...claudeSession(now),
      id: 'process:4',
      tool: 'Codex·CLI',
      toolId: 'codex-cli',
      process: { pid: 4, elapsedSeconds: 3, command: 'codex SECRET' }
    },
    {
      ...claudeSession(now),
      id: 'process:5',
      tool: 'Hermes',
      toolId: 'hermes',
      process: { pid: 5, elapsedSeconds: 3, command: 'hermes SECRET' }
    }
  ], { now, processScanOk: true });
  const retained = log.sync([], { now: new Date('2026-11-13T10:05:00.000Z'), processScanOk: true });

  assert.deepEqual(retained.map((session) => session.toolId).sort(), ['codex-cli', 'hermes']);
});

test('terminal log does not mark tasks exited when the process scan fails', () => {
  const filePath = tempLogPath();
  const now = new Date('2026-11-13T10:00:00.000Z');
  const log = createTerminalSessionLog({ filePath });
  log.sync([claudeSession(now)], { now, processScanOk: true });
  const duringFailure = log.sync([], {
    now: new Date('2026-11-13T10:01:00.000Z'),
    processScanOk: false
  });
  assert.deepEqual(duringFailure, []);

  const after = log.sync([], { now: new Date('2026-11-13T10:02:00.000Z'), processScanOk: true });
  assert.equal(after.length, 1);
  assert.equal(after[0].status, 'unknown');
});

test('terminal log does not list a still-running process a second time', () => {
  const filePath = tempLogPath();
  const now = new Date('2026-11-13T10:00:00.000Z');
  const session = claudeSession(now);
  createTerminalSessionLog({ filePath }).sync([session], { now, processScanOk: true });
  const retained = createTerminalSessionLog({ filePath }).sync([session], {
    now: new Date('2026-11-13T10:01:00.000Z'),
    processScanOk: true
  });

  assert.deepEqual(retained, []);
});

test('terminal log drops exited tasks after the lookback window', () => {
  const filePath = tempLogPath();
  const now = new Date('2026-11-13T10:00:00.000Z');
  const log = createTerminalSessionLog({ filePath });
  log.sync([claudeSession(now)], { now, lookbackDays: 7, processScanOk: true });
  log.sync([], { now: new Date('2026-11-13T10:05:00.000Z'), lookbackDays: 7, processScanOk: true });
  const expired = log.sync([], {
    now: new Date('2026-11-21T10:06:00.000Z'),
    lookbackDays: 7,
    processScanOk: true
  });

  assert.deepEqual(expired, []);
});

test('scanner still shows a seen terminal task after a new scanner process starts', async () => {
  const filePath = tempLogPath();
  const now = new Date('2026-11-13T12:00:00.000Z');
  let processes = [claudeSession(now)];
  const stubs = {
    now: () => now,
    terminalSessionLogPath: filePath,
    scanProcesses: async () => ({ sessions: processes, errors: [] }),
    scanCursorAgents: async () => ({ sessions: [], errors: [] }),
    scanCodexThreads: async () => ({
      threads: [],
      turnStates: new Map(),
      unreadState: { available: false, unreadThreadIds: new Set() },
      runtimeStates: new Map(),
      errors: []
    }),
    scanWorkBuddy: async () => ({ sessions: [], errors: [] }),
    scanTraeIde: async () => ({ sessions: [], errors: [] }),
    scanTraeWork: async () => ({ sessions: [], errors: [] }),
    scanWpsLingxi: async () => ({ sessions: [], errors: [] }),
    scanWpsComate: async () => ({ sessions: [], errors: [] })
  };
  const running = createDefaultScanner({ tools: [], productReaders: disabledProductReaders, sessionLookbackDays: 7 }, stubs);
  const live = await running({ bustCache: true });
  assert.equal(live.sessions.filter((session) => session.toolId === 'claude-code' && session.status === 'running').length, 1);

  processes = [];
  const exited = await running({ bustCache: true });
  assert.equal(exited.sessions.filter((session) => session.toolId === 'claude-code').length, 1);
  assert.equal(exited.sessions[0].status, 'unknown');

  const restarted = createDefaultScanner({
    tools: [],
    productReaders: disabledProductReaders,
    sessionLookbackDays: 7
  }, stubs);
  const again = await restarted({ bustCache: true });
  assert.equal(again.sessions.filter((session) => session.toolId === 'claude-code').length, 1);
  assert.equal(again.sessions[0].status, 'unknown');
  assert.equal(again.sessions[0].statusReason, '进程已退出，但没有取得根轮次终态');
});
