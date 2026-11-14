import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createDefaultScanner, createHttpServer } from '../src/server/httpServer.js';

const disabledProductReaders = {
  workBuddy: false,
  traeIde: false,
  traeWork: false,
  wpsLingxi: false,
  wpsComate: false
};

test('default scanner exposes Codex approval waiting and clears it on the next fresh scan', async () => {
  const now = new Date('2026-11-03T10:30:00Z');
  let flags = ['waitingOnApproval'];
  const scanner = createDefaultScanner({ tools: [], productReaders: disabledProductReaders }, {
    now: () => now,
    scanProcesses: async () => ({ sessions: [{ toolId: 'codex', process: { command: 'codex app-server' } }], errors: [] }),
    scanWindows: async () => ({ sessions: [], errors: [] }),
    scanCursorAgents: async () => ({ sessions: [], errors: [] }),
    scanCodexThreads: async () => ({
      threads: [{ id: 'waiting-thread', displayTitle: '等待批准', cwd: '/tmp/demo', source: 'user', updatedAtMs: now.getTime() }],
      turnStates: new Map([['waiting-thread', { turnId: 'current-turn', status: 'inProgress' }]]),
      runtimeStates: new Map([['waiting-thread', { threadId: 'waiting-thread', turnId: 'current-turn', type: 'active', activeFlags: flags, observedAtMs: now.getTime() }]]),
      errors: []
    })
  });
  const waiting = await scanner({ bustCache: true });
  assert.equal(waiting.sessions[0].status, 'needs_response');
  assert.equal(waiting.sessions[0].statusFacts.waitingReason, 'waiting_approval');
  flags = [];
  const resumed = await scanner({ bustCache: true });
  assert.equal(resumed.sessions[0].status, 'running');
  assert.equal(resumed.sessions[0].statusFacts.waitingReason, undefined);
});

test('default scanner does not run unused window scanning', async () => {
  let windowScanCalls = 0;
  const scanner = createDefaultScanner({
    tools: [],
    productReaders: disabledProductReaders
  }, {
    scanProcesses: async () => ({ sessions: [], errors: [] }),
    scanWindows: async () => {
      windowScanCalls += 1;
      throw new Error('window scanning should not run');
    },
    scanCursorAgents: async () => ({ sessions: [], errors: [] }),
    scanCodexThreads: async () => ({
      threads: [],
      turnStates: new Map(),
      unreadState: { available: false, unreadThreadIds: new Set() },
      runtimeStates: new Map(),
      errors: []
    })
  });

  const result = await scanner({ bustCache: true });

  assert.equal(windowScanCalls, 0);
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.errors, []);
});

function request(server, { method, url }) {
  return new Promise((resolve) => {
    const req = new Readable({ read() {} });
    req.method = method;
    req.url = url;
    req.push(null);

    const chunks = [];
    const res = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });

    res.writeHead = (statusCode, headers) => {
      res.statusCode = statusCode;
      res.headers = headers;
      return res;
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      Writable.prototype.end.call(res);
      resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      });
      return res;
    };

    server.emit('request', req, res);
  });
}

test('GET /api/sessions returns normalized session payload', async () => {
  const server = createHttpServer({
    tools: [],
    sessionLookbackDays: 7
  }, {
    scanAll: async () => ({
      sessions: [
        {
          id: 'process:1',
          tool: 'Codex',
          status: 'running',
          jump: {}
        }
      ],
      errors: []
    })
  });

  const response = await request(server, { method: 'GET', url: '/api/sessions' });
  const payload = JSON.parse(response.body);

  assert.equal(response.status, 200);
  assert.equal(payload.sessions.length, 1);
  assert.deepEqual(payload.errors, []);
});

test('GET /api/health reports readiness without running a scan', async () => {
  let scanCount = 0;
  const server = createHttpServer({ tools: [] }, {
    scanAll: async () => {
      scanCount += 1;
      return { sessions: [], errors: [] };
    }
  });

  const response = await request(server, { method: 'GET', url: '/api/health' });
  const payload = JSON.parse(response.body);

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 'ready');
  assert.equal(payload.schemaVersion, 2);
  assert.equal(scanCount, 0);
});

test('default scanner expands Codex process rows with local thread titles', async () => {
  const scanAll = createDefaultScanner({
    tools: [],
    sessionLookbackDays: 7,
    productReaders: disabledProductReaders
  }, {
    now: () => new Date('2026-06-11T16:00:00.000Z'),
    scanProcesses: async () => ({
      sessions: [
        {
          id: 'process:123',
          tool: 'Codex',
          toolId: 'codex',
          source: 'terminal',
          title: '终端任务',
          projectName: 'demo',
          projectPath: '/tmp/demo',
          status: 'running',
          attentionReason: '',
          lastActivityAt: '2026-06-11T16:00:00.000Z',
          statusFacts: {
            hasExecution: true,
            executionPhase: 'active',
            signalObservedAt: '2026-06-11T16:00:00.000Z'
          },
          process: { pid: 123 },
          jump: { canActivateApp: true, canOpenProject: true, canCopyPath: true }
        }
      ],
      errors: []
    }),
    scanWindows: async () => ({ sessions: [], errors: [] }),
    scanCursorAgents: async () => ({ sessions: [], errors: [] }),
    scanCodexThreads: async () => ({
      threads: [
        {
          id: 'thread-1',
          displayTitle: '查看项目文档',
          cwd: '/tmp/demo',
          updatedAtMs: Date.parse('2026-06-11T04:59:19.958Z')
        },
        {
          id: 'thread-2',
          displayTitle: '这些进行中 的状态是什么意思',
          cwd: '/tmp/demo',
          updatedAtMs: Date.parse('2026-06-11T15:49:59.000Z')
        }
      ],
      errors: []
    })
  });

  const result = await scanAll({ bustCache: true });

  assert.deepEqual(result.sessions.map((session) => session.title), [
    '这些进行中 的状态是什么意思',
    '查看项目文档'
  ]);
  assert.deepEqual(result.sessions.map((session) => session.codexThread.id), [
    'thread-2',
    'thread-1'
  ]);
});

test('default scanner creates Codex desktop thread rows when app-server cwd is root', async () => {
  const scanAll = createDefaultScanner({
    tools: [],
    sessionLookbackDays: 7,
    productReaders: disabledProductReaders,
    codex: {
      activeWithinHours: 24
    }
  }, {
    now: () => new Date('2026-07-13T05:10:00.000Z'),
    scanProcesses: async () => ({
      sessions: [
        {
          id: 'process:12444',
          tool: 'Codex',
          toolId: 'codex',
          source: 'process',
          title: '未知会话',
          projectName: '未知项目',
          projectPath: '',
          status: 'running',
          attentionReason: '',
          lastActivityAt: '2026-07-13T05:10:00.000Z',
          process: {
            pid: 12444,
            command: '/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server'
          },
          jump: { canActivateApp: true, canOpenProject: false, canCopyPath: false }
        }
      ],
      errors: []
    }),
    scanWindows: async () => ({ sessions: [], errors: [] }),
    scanCursorAgents: async () => ({ sessions: [], errors: [] }),
    scanCodexThreads: async () => ({
      threads: [
        {
          id: 'thread-3',
          displayTitle: '查看项目进度',
          cwd: '/tmp/demo',
          updatedAtMs: Date.parse('2026-07-13T05:09:55.000Z'),
          source: 'user'
        },
        {
          id: 'thread-2',
          displayTitle: '这些进行中 的状态是什么意思',
          cwd: '/tmp/demo',
          updatedAtMs: Date.parse('2026-06-11T16:15:04.000Z'),
          source: 'user'
        }
      ],
      turnStates: new Map([
        ['thread-3', {
          status: 'inProgress',
          hasError: false,
          startedAtMs: Date.parse('2026-07-13T05:09:58.000Z'),
          completedAtMs: 0
        }]
      ]),
      errors: []
    })
  });

  const result = await scanAll({ bustCache: true });

  assert.deepEqual(result.sessions.map((session) => session.title), [
    '查看项目进度'
  ]);
  assert.equal(result.sessions.some((session) => session.title === '未知会话'), false);
  assert.equal(result.sessions[0].source, 'codex-thread');
  assert.equal(result.sessions[0].projectPath, '/tmp/demo');
  assert.equal(result.sessions[0].status, 'running');
  assert.equal(result.sessions[0].statusFacts.nativeStatus, 'inProgress');
});

test('default scanner hides generic Codex app-server when no recent thread exists', async () => {
  const scanAll = createDefaultScanner({
    tools: [],
    sessionLookbackDays: 7,
    productReaders: disabledProductReaders,
    codex: {
      activeWithinHours: 24
    }
  }, {
    now: () => new Date('2026-07-13T05:10:00.000Z'),
    scanProcesses: async () => ({
      sessions: [
        {
          id: 'process:12444',
          tool: 'Codex',
          toolId: 'codex',
          source: 'process',
          title: '未知会话',
          projectName: '未知项目',
          projectPath: '',
          status: 'running',
          attentionReason: '',
          lastActivityAt: '2026-07-13T05:10:00.000Z',
          process: {
            pid: 12444,
            command: '/Applications/ChatGPT.app/Contents/Resources/codex app-server'
          },
          jump: { canActivateApp: true, canOpenProject: false, canCopyPath: false }
        }
      ],
      errors: []
    }),
    scanWindows: async () => ({ sessions: [], errors: [] }),
    scanCursorAgents: async () => ({ sessions: [], errors: [] }),
    scanCodexThreads: async () => ({
      threads: [
        {
          id: 'thread-1',
          displayTitle: '旧侧栏会话',
          cwd: '/tmp/demo',
          updatedAtMs: Date.parse('2026-07-10T05:10:00.000Z'),
          source: 'user'
        }
      ],
      errors: []
    })
  });

  const result = await scanAll({ bustCache: true });

  assert.deepEqual(result.sessions, []);
});

test('default scanner excludes generic Codex app-server when thread scanning fails', async () => {
  const scanAll = createDefaultScanner({
    tools: [],
    sessionLookbackDays: 7,
    productReaders: disabledProductReaders,
    codex: {
      activeWithinHours: 24
    }
  }, {
    now: () => new Date('2026-07-13T05:10:00.000Z'),
    scanProcesses: async () => ({
      sessions: [
        {
          id: 'process:12444',
          tool: 'Codex',
          toolId: 'codex',
          source: 'process',
          title: '未知会话',
          projectName: '未知项目',
          projectPath: '',
          status: 'running',
          attentionReason: '',
          lastActivityAt: '2026-07-13T05:10:00.000Z',
          process: {
            pid: 12444,
            command: '/Applications/ChatGPT.app/Contents/Resources/codex app-server'
          },
          jump: { canActivateApp: true, canOpenProject: false, canCopyPath: false }
        }
      ],
      errors: []
    }),
    scanWindows: async () => ({ sessions: [], errors: [] }),
    scanCursorAgents: async () => ({ sessions: [], errors: [] }),
    scanCodexThreads: async () => ({
      threads: [],
      errors: ['Codex 会话标题扫描失败：数据库不可读']
    })
  });

  const result = await scanAll({ bustCache: true });

  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.errors, ['Codex 会话标题扫描失败：数据库不可读']);
});
