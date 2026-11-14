import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexAppThreadSessions,
  enrichCodexSessions,
  isCodexScratchWorkspace,
  pickCodexAppThreads,
  parseCodexUnreadState,
  parseCodexTurnRows,
  parseCodexThreadRows,
  parseSessionIndex
} from '../src/server/codexSessionScanner.js';

test('parseSessionIndex reads Codex navigation names by thread id', () => {
  const index = parseSessionIndex([
    '{"id":"thread-1","thread_name":"查看项目文档","updated_at":"2026-06-11T04:59:19.958863Z"}',
    '{"id":"thread-2","thread_name":"这些进行中 的状态是什么意思","updated_at":"2026-06-11T15:49:59.000Z"}'
  ].join('\n'));

  assert.equal(index.get('thread-1').threadName, '查看项目文档');
  assert.equal(index.get('thread-2').threadName, '这些进行中 的状态是什么意思');
});

test('parseCodexThreadRows prefers sidebar name and keeps latest matching cwd', () => {
  const namesById = new Map([
    ['thread-1', { threadName: '查看项目文档' }],
    ['thread-2', { threadName: '这些进行中 的状态是什么意思' }]
  ]);
  const rows = [
    'thread-1\u001f看下这个项目里的文档\u001f/tmp/demo\u001f1781160000000\u001fuser',
    'thread-2\u001fLong first prompt title\u001f/tmp/demo\u001f1781193000000\u001fuser'
  ].join('\n');

  const threads = parseCodexThreadRows(rows, namesById);

  assert.equal(threads.length, 2);
  assert.equal(threads[0].displayTitle, '这些进行中 的状态是什么意思');
  assert.equal(threads[1].displayTitle, '查看项目文档');
  assert.equal(threads[0].source, 'user');
});

test('parseCodexTurnRows reads the latest native turn phase timestamps', () => {
  const states = parseCodexTurnRows([
    'thread-running\u001finProgress\u001f0\u001f1789296060\u001f0',
    'thread-complete\u001fcompleted\u001f0\u001f1789295000\u001f1789295050',
    'thread-failed\u001fcompleted\u001f1\u001f1789294000\u001f1789294010',
    'thread-limit\u001ffailed\u001f1\u001f1789293000\u001f1789293010\u001fturn-limit\u001fusageLimitExceeded'
  ].join('\n'));

  assert.deepEqual(states.get('thread-running'), {
    status: 'inProgress',
    hasError: false,
    startedAtMs: 1789296060000,
    completedAtMs: 0
  });
  assert.equal(states.get('thread-complete').completedAtMs, 1789295050000);
  assert.equal(states.get('thread-failed').hasError, true);
  assert.equal(states.get('thread-limit').turnId, 'turn-limit');
  assert.equal(states.get('thread-limit').codexErrorInfo, 'usageLimitExceeded');
});

test('parseCodexUnreadState reads native unread thread ids by host', () => {
  const state = parseCodexUnreadState(JSON.stringify({
    'electron-persisted-atom-state': {
      'unread-thread-ids-by-host-v1': {
        local: ['thread-unread', '', null],
        remote: ['thread-remote']
      }
    }
  }));

  assert.equal(state.available, true);
  assert.deepEqual([...state.unreadThreadIds], ['thread-unread']);
});

test('parseCodexUnreadState reads the migrated Codex thread read state', () => {
  const state = parseCodexUnreadState(JSON.stringify({
    'electron-thread-read-state-v1': {
      version: 1,
      unreadByIdentity: {
        'identity-a': {
          'local:installation-a': ['thread-local-a', '', null],
          'remote:host-a': ['thread-remote']
        },
        'identity-b': {
          'local:installation-b': ['thread-local-b', 'thread-local-a']
        }
      }
    }
  }));

  assert.equal(state.available, true);
  assert.deepEqual([...state.unreadThreadIds], ['thread-local-a', 'thread-local-b']);
});

test('parseCodexUnreadState treats an empty migrated unread map as all read', () => {
  const state = parseCodexUnreadState(JSON.stringify({
    'electron-thread-read-state-v1': {
      version: 1,
      unreadByIdentity: {}
    }
  }));

  assert.equal(state.available, true);
  assert.equal(state.unreadThreadIds.size, 0);
});

test('parseCodexUnreadState distinguishes unavailable state from an empty unread list', () => {
  const unavailable = parseCodexUnreadState('{}');
  const allRead = parseCodexUnreadState(JSON.stringify({
    'electron-persisted-atom-state': {
      'unread-thread-ids-by-host-v1': {}
    }
  }));

  assert.equal(unavailable.available, false);
  assert.equal(allRead.available, true);
  assert.equal(allRead.unreadThreadIds.size, 0);
});

test('enrichCodexSessions expands same-project Codex threads into separate rows', () => {
  const sessions = [
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
      process: { pid: 123 },
      jump: { canActivateApp: true, canOpenProject: true, canCopyPath: true }
    }
  ];
  const threads = [
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
    },
    {
      id: 'thread-stale',
      displayTitle: '一个月前的旧会话',
      cwd: '/tmp/demo',
      updatedAtMs: Date.parse('2026-05-11T15:49:59.000Z')
    }
  ];

  const enriched = enrichCodexSessions(sessions, threads, {
    now: new Date('2026-06-11T16:00:00.000Z')
  });

  assert.equal(enriched.length, 2);
  assert.deepEqual(enriched.map((session) => session.title), [
    '这些进行中 的状态是什么意思',
    '查看项目文档'
  ]);
  assert.deepEqual(enriched.map((session) => session.codexThread.id), [
    'thread-2',
    'thread-1'
  ]);
  assert.notEqual(enriched[0].id, enriched[1].id);
});

test('pickCodexAppThreads keeps only recently active threads in active projects', () => {
  const now = new Date('2026-07-13T05:10:00.000Z');
  const threads = [
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
    },
    {
      id: 'thread-1',
      displayTitle: '查看项目文档',
      cwd: '/tmp/demo',
      updatedAtMs: Date.parse('2026-06-11T07:07:32.000Z'),
      source: 'user'
    },
    {
      id: 'automation-1',
      displayTitle: 'Automation: 每日复盘',
      cwd: '/tmp/demo',
      updatedAtMs: Date.parse('2026-07-13T03:00:00.000Z'),
      source: 'automation'
    }
  ];

  const picked = pickCodexAppThreads(threads, {
    now,
    activeWithinMs: 24 * 60 * 60 * 1000
  });

  assert.deepEqual(picked.map((thread) => thread.displayTitle), [
    '查看项目进度'
  ]);
});

test('pickCodexAppThreads does not fall back to stale unarchived threads', () => {
  const picked = pickCodexAppThreads([
    {
      id: 'thread-1',
      displayTitle: '旧侧栏会话',
      cwd: '/tmp/demo',
      updatedAtMs: Date.parse('2026-07-10T05:10:00.000Z'),
      source: 'user'
    }
  ], {
    now: new Date('2026-07-13T05:10:00.000Z'),
    activeWithinMs: 24 * 60 * 60 * 1000
  });

  assert.deepEqual(picked, []);
});

test('buildCodexAppThreadSessions creates rows from desktop app-server threads', () => {
  const sessions = buildCodexAppThreadSessions([
    {
      id: 'thread-3',
      displayTitle: '查看项目进度',
      cwd: '/tmp/demo',
      updatedAtMs: Date.parse('2026-07-13T05:09:55.000Z'),
      source: 'user'
    }
  ], [
    {
      id: 'process:12444',
      tool: 'Codex',
      toolId: 'codex',
      source: 'process',
      projectPath: '',
      process: {
        pid: 12444,
        command: '/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server'
      }
    }
  ], {
    now: new Date('2026-07-13T05:10:00.000Z'),
    turnStates: new Map([
      ['thread-3', {
        status: 'inProgress',
        hasError: false,
        startedAtMs: Date.parse('2026-07-13T05:09:58.000Z'),
        completedAtMs: 0
      }]
    ])
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, '查看项目进度');
  assert.equal(sessions[0].projectName, 'demo');
  assert.equal(sessions[0].projectPath, '/tmp/demo');
  assert.equal(sessions[0].window.app, 'ChatGPT');
  assert.equal(sessions[0].codexThread.id, 'thread-3');
  assert.equal(sessions[0].status, 'running');
  assert.equal(sessions[0].statusFacts.executionPhase, 'active');
  assert.equal(sessions[0].statusFacts.nativeStatus, 'inProgress');
  assert.equal(sessions[0].statusFacts.signalSource, 'codex-thread-history');
});

test('isCodexScratchWorkspace matches only Codex dated temporary directories', () => {
  const home = '/Users/demo';
  assert.equal(isCodexScratchWorkspace('/Users/demo/Documents/Codex/2026-11-14/11', home), true);
  assert.equal(isCodexScratchWorkspace('/Users/demo/Documents/Codex/2026-11-14/11/work', home), true);
  assert.equal(isCodexScratchWorkspace('/Users/demo/Documents/Codex/2026-11-14/new-chat/', home), true);
  assert.equal(isCodexScratchWorkspace('/Users/demo/AI_Lifelog', home), false);
  assert.equal(isCodexScratchWorkspace('/Users/demo/Documents/每日复盘', home), false);
  assert.equal(isCodexScratchWorkspace('/Users/demo/Documents/Codex/my-project', home), false);
  assert.equal(isCodexScratchWorkspace('', home), false);
});

test('buildCodexAppThreadSessions hides a Codex scratch directory and keeps a real workspace', () => {
  const now = new Date('2026-11-14T09:40:00.000Z');
  const sessions = buildCodexAppThreadSessions([
    {
      id: 'scratch',
      displayTitle: '搜索11月至今发布的模型',
      cwd: '/Users/demo/Documents/Codex/2026-11-14/11',
      updatedAtMs: Date.parse('2026-11-14T09:38:32.000Z'),
      source: 'user'
    },
    {
      id: 'real',
      displayTitle: '真实工作区',
      cwd: '/Users/demo/AI_Lifelog',
      updatedAtMs: Date.parse('2026-11-14T09:38:32.000Z'),
      source: 'user'
    }
  ], [], {
    now,
    home: '/Users/demo',
    turnStates: new Map([
      ['scratch', { status: 'completed', hasError: false, startedAtMs: 1, completedAtMs: 2 }],
      ['real', { status: 'completed', hasError: false, startedAtMs: 1, completedAtMs: 2 }]
    ])
  });
  const scratch = sessions.find((session) => session.codexThread.id === 'scratch');
  const real = sessions.find((session) => session.codexThread.id === 'real');

  assert.equal(scratch.projectName, '');
  assert.equal(scratch.projectPath, '');
  assert.equal(scratch.jump.canOpenProject, false);
  assert.equal(scratch.jump.canCopyPath, false);
  assert.equal(real.projectName, 'AI_Lifelog');
  assert.equal(real.projectPath, '/Users/demo/AI_Lifelog');
  assert.equal(real.jump.canOpenProject, true);
});

test('buildCodexAppThreadSessions maps completed turns from Codex native unread state', () => {
  const threads = [
    {
      id: 'thread-unread',
      displayTitle: '待查看任务',
      cwd: '/tmp/demo',
      updatedAtMs: Date.parse('2026-07-13T05:09:55.000Z'),
      source: 'user'
    },
    {
      id: 'thread-read',
      displayTitle: '已查看任务',
      cwd: '/tmp/demo',
      updatedAtMs: Date.parse('2026-07-13T05:09:54.000Z'),
      source: 'user'
    }
  ];
  const processSessions = [{
    toolId: 'codex',
    projectPath: '',
    process: { command: '/Applications/ChatGPT.app/Contents/Resources/codex app-server' }
  }];
  const turnStates = new Map(threads.map((thread) => [thread.id, {
    status: 'completed',
    hasError: false,
    completedAtMs: Date.parse('2026-07-13T05:09:58.000Z')
  }]));

  const sessions = buildCodexAppThreadSessions(threads, processSessions, {
    now: new Date('2026-07-13T05:10:00.000Z'),
    turnStates,
    unreadState: {
      available: true,
      unreadThreadIds: new Set(['thread-unread'])
    }
  });

  assert.deepEqual(sessions.map((session) => session.status), [
    'completed_unseen',
    'completed_seen'
  ]);
  assert.deepEqual(sessions.map((session) => session.statusFacts.viewState), [
    'unseen',
    'seen'
  ]);
  assert.equal(sessions[0].statusReason, 'Codex 当前轮次已完成，待你查看');
  assert.equal(sessions[1].statusReason, 'Codex 当前轮次已完成，已在 Codex 查看');
  assert.match(sessions[0].statusFacts.signalSource, /codex-unread-state/);
});

test('buildCodexAppThreadSessions separates a user stop from an execution failure', () => {
  const processSessions = [{
    toolId: 'codex',
    projectPath: '',
    process: { command: '/Applications/ChatGPT.app/Contents/Resources/codex app-server' }
  }];
  const threads = [
    {
      id: 'thread-stopped',
      displayTitle: '现在来重写一下项目背景',
      cwd: '/tmp/demo',
      updatedAtMs: Date.parse('2026-10-24T08:40:07.000Z'),
      source: 'user'
    },
    {
      id: 'thread-failed',
      displayTitle: '额度用尽',
      cwd: '/tmp/demo',
      updatedAtMs: Date.parse('2026-10-24T08:40:06.000Z'),
      source: 'user'
    }
  ];
  const sessions = buildCodexAppThreadSessions(threads, processSessions, {
    now: new Date('2026-10-24T08:41:00.000Z'),
    turnStates: new Map([
      ['thread-stopped', {
        status: 'interrupted',
        hasError: false,
        startedAtMs: Date.parse('2026-10-24T08:40:02.000Z'),
        completedAtMs: Date.parse('2026-10-24T08:40:07.000Z')
      }],
      ['thread-failed', {
        status: 'failed',
        hasError: true,
        startedAtMs: Date.parse('2026-10-24T08:39:00.000Z'),
        completedAtMs: Date.parse('2026-10-24T08:40:06.000Z')
      }]
    ]),
    unreadState: { available: true, unreadThreadIds: new Set() }
  });

  assert.deepEqual(sessions.map((session) => session.status), [
    'ended_abnormally',
    'ended_abnormally'
  ]);
  assert.equal(sessions[0].statusReason, '你已停止这条 Codex 轮次');
  assert.equal(sessions[0].attentionReason, '你已停止这条 Codex 轮次');
  assert.equal(sessions[0].statusFacts.endReason, 'user_stopped');
  assert.equal(sessions[0].endedAt, '2026-10-24T08:40:07.000Z');
  assert.equal(sessions[1].statusReason, 'Codex 当前轮次执行失败');
  assert.equal(sessions[1].statusFacts.endReason, 'execution_failed');
  assert.equal(sessions[1].endedAt, '2026-10-24T08:40:06.000Z');
});

test('an interrupted turn with an error is still a failure rather than a manual stop', () => {
  const now = new Date('2026-11-03T10:45:00Z');
  const [session] = buildCodexAppThreadSessions([
    { id: 'interrupted-error', displayTitle: '失败样本', cwd: '/tmp/demo', updatedAtMs: now.getTime(), source: 'user' }
  ], [{ toolId: 'codex', process: { command: 'codex app-server' } }], {
    now,
    turnStates: new Map([['interrupted-error', { status: 'interrupted', hasError: true, completedAtMs: now.getTime() }]])
  });
  assert.equal(session.status, 'ended_abnormally');
  assert.equal(session.statusFacts.endReason, 'execution_failed');
  assert.equal(session.statusReason, 'Codex 当前轮次执行失败');
});

test('a structured usage limit error gets a recoverable terminal subtype', () => {
  const now = new Date('2026-11-03T14:35:18Z');
  const [session] = buildCodexAppThreadSessions([
    { id: 'usage-limit', displayTitle: '评估最新 UI 布局', cwd: '/tmp/demo', updatedAtMs: now.getTime(), source: 'user' }
  ], [{ toolId: 'codex', process: { command: 'codex app-server' } }], {
    now,
    turnStates: new Map([['usage-limit', {
      status: 'failed',
      hasError: true,
      codexErrorInfo: 'usageLimitExceeded',
      completedAtMs: now.getTime()
    }]])
  });
  assert.equal(session.status, 'ended_abnormally');
  assert.equal(session.statusFacts.endReason, 'usage_limit');
  assert.equal(session.statusFacts.viewState, 'indeterminate');
  assert.equal(session.statusFacts.nativeErrorType, 'usageLimitExceeded');
  assert.equal(session.statusReason, 'Codex 使用额度已用完，重置后可重试');
});

test('usage limit view state follows the Codex unread set', () => {
  const now = new Date('2026-11-03T14:35:18Z');
  const threads = ['usage-unread', 'usage-read'].map((id) => ({
    id, displayTitle: id, cwd: '/tmp/demo', updatedAtMs: now.getTime(), source: 'user'
  }));
  const sessions = buildCodexAppThreadSessions(threads, [{
    toolId: 'codex', process: { command: 'codex app-server' }
  }], {
    now,
    turnStates: new Map(threads.map((thread) => [thread.id, {
      status: 'failed', hasError: true, codexErrorInfo: 'usageLimitExceeded', completedAtMs: now.getTime()
    }])),
    unreadState: { available: true, unreadThreadIds: new Set(['usage-unread']) }
  });
  assert.deepEqual(sessions.map((session) => session.statusFacts.viewState), ['unseen', 'seen']);
  assert.deepEqual(sessions.map((session) => session.statusFacts.endReason), ['usage_limit', 'usage_limit']);
});

test('closed Codex keeps finished threads and does not leave an unfinished turn running', () => {
  const now = new Date('2026-11-06T08:00:00.000Z');
  const threads = [
    {
      id: 'done', displayTitle: '已完成', cwd: '/tmp/demo',
      updatedAtMs: now.getTime() - 60_000, source: 'user'
    },
    {
      id: 'live', displayTitle: '执行中', cwd: '/tmp/demo',
      updatedAtMs: now.getTime() - 30_000, source: 'user'
    }
  ];
  const turnStates = new Map([
    ['done', { status: 'completed', hasError: false, completedAtMs: now.getTime() - 60_000 }],
    ['live', {
      status: 'inProgress', hasError: false, turnId: 'turn-live',
      startedAtMs: now.getTime() - 30_000, completedAtMs: 0
    }]
  ]);
  const runtimeStates = new Map([['live', {
    threadId: 'live', turnId: 'turn-live', type: 'active',
    activeFlags: ['waitingOnApproval'], observedAtMs: now.getTime()
  }]]);
  const sessions = buildCodexAppThreadSessions(threads, [], {
    now, turnStates, runtimeStates,
    unreadState: { available: true, unreadThreadIds: new Set(['done']) }
  });
  const done = sessions.find((session) => session.codexThread.id === 'done');
  const live = sessions.find((session) => session.codexThread.id === 'live');
  assert.equal(done.status, 'completed_unseen');
  assert.equal(done.endedAt, new Date(now.getTime() - 60_000).toISOString());
  assert.equal(live.status, 'unknown');
  assert.equal(live.statusReason, 'Codex 已退出，当前轮次结果未知');
  assert.equal(live.endedAt, '');
  assert.equal(live.process, null);
  assert.equal(live.jump.canActivateApp, true);
  assert.equal(live.statusFacts.waitingReason, undefined);
  assert.match(live.statusFacts.signalSource, /codex-desktop-closed/);
});

test('buildCodexAppThreadSessions excludes new threads without execution evidence', () => {
  const sessions = buildCodexAppThreadSessions([{
    id: 'thread-new',
    displayTitle: '新会话',
    cwd: '/tmp/demo',
    updatedAtMs: Date.parse('2026-07-13T05:09:55.000Z'),
    source: 'user'
  }], [{
    toolId: 'codex',
    projectPath: '',
    process: { command: '/Applications/ChatGPT.app/Contents/Resources/codex app-server' }
  }], {
    now: new Date('2026-07-13T05:10:00.000Z'),
    turnStates: new Map(),
    unreadState: { available: true, unreadThreadIds: new Set() }
  });

  assert.deepEqual(sessions, []);
});
