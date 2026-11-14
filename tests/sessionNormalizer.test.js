import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSessions } from '../src/server/sessionNormalizer.js';
import { createSessionStore } from '../src/server/sessionStore.js';
import { finalizeSessions, resolveUnifiedStatus } from '../src/server/statusModel.js';

test('manual stops do not receive unseen-failure priority or indefinite attention retention', () => {
  const now = new Date('2026-11-03T10:00:00Z');
  const facts = { hasExecution: true, viewState: 'unseen', signalObservedAt: now.toISOString() };
  const stopped = { id: 'stopped', status: 'ended_abnormally', statusFacts: { ...facts, endReason: 'user_stopped' } };
  const failed = { id: 'failed', status: 'ended_abnormally', statusFacts: { ...facts, endReason: 'execution_failed' } };
  const running = { id: 'running', status: 'running', statusFacts: facts };
  const oldStopped = { ...stopped, id: 'old-stopped', statusFacts: { ...stopped.statusFacts, signalObservedAt: '2026-10-01T10:00:00Z' } };
  const oldFailed = { ...failed, id: 'old-failed', statusFacts: { ...failed.statusFacts, signalObservedAt: '2026-10-01T10:00:00Z' } };
  assert.deepEqual(finalizeSessions({ sessions: [stopped, running, failed, oldStopped, oldFailed], now }).map((s) => s.id),
    ['failed', 'old-failed', 'running', 'stopped']);
});

test('mergeSessions deduplicates process and window sessions by tool and project', () => {
  const merged = mergeSessions([
    {
      id: 'process:1',
      tool: 'Codex',
      toolId: 'codex',
      source: 'terminal',
      title: 'codex run',
      projectName: 'demo',
      projectPath: '/tmp/demo',
      status: 'running',
      attentionReason: '',
      lastActivityAt: '2026-06-11T10:00:00.000Z',
      process: { pid: 1 },
      jump: { canActivateApp: true, canOpenProject: true, canCopyPath: true }
    },
    {
      id: 'window:codex:0:demo',
      tool: 'Codex',
      toolId: 'codex',
      source: 'window',
      title: 'demo - Codex',
      projectName: 'demo',
      projectPath: '',
      status: 'running',
      attentionReason: '',
      lastActivityAt: '2026-06-11T10:00:00.000Z',
      process: null,
      jump: { canActivateApp: true, canOpenProject: false, canCopyPath: false }
    }
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'terminal+window');
  assert.equal(merged[0].projectPath, '/tmp/demo');
});

test('mergeSessions keeps Cursor IDE and Cursor Agent as separate rows', () => {
  const merged = mergeSessions([
    {
      id: 'process:1',
      tool: 'Cursor IDE',
      toolId: 'cursor-ide',
      source: 'process',
      title: '编辑器',
      projectName: 'demo',
      projectPath: '/tmp/demo',
      status: 'running',
      attentionReason: '',
      lastActivityAt: '2026-06-11T10:00:00.000Z',
      process: { pid: 1 },
      jump: { canActivateApp: true, canOpenProject: true, canCopyPath: true }
    },
    {
      id: 'cursor-agent:slug:chat-1',
      tool: 'Cursor Agent',
      toolId: 'cursor-agent',
      source: 'cursor-agent',
      title: '修一下看板',
      projectName: 'demo',
      projectPath: '/tmp/demo',
      status: 'running',
      attentionReason: 'Agent 执行中',
      lastActivityAt: '2026-06-11T10:05:00.000Z',
      agent: { chatId: 'chat-1', progressHint: 'Agent 执行中' },
      jump: { canActivateApp: true, canOpenProject: true, canCopyPath: true }
    }
  ]);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((session) => session.tool).sort(), ['Cursor Agent', 'Cursor IDE']);
});

test('mergeSessions keeps same-project Codex threads as separate rows', () => {
  const base = {
    tool: 'Codex',
    toolId: 'codex',
    source: 'terminal',
    projectName: 'demo',
    projectPath: '/tmp/demo',
    status: 'running',
    attentionReason: '',
    lastActivityAt: '2026-06-11T10:00:00.000Z',
    process: { pid: 1 },
    jump: { canActivateApp: true, canOpenProject: true, canCopyPath: true }
  };
  const merged = mergeSessions([
    {
      ...base,
      id: 'process:1:codex-thread:thread-1',
      title: '查看项目文档',
      codexThread: { id: 'thread-1', title: '查看项目文档' }
    },
    {
      ...base,
      id: 'process:1:codex-thread:thread-2',
      title: '这些进行中 的状态是什么意思',
      codexThread: { id: 'thread-2', title: '这些进行中 的状态是什么意思' }
    }
  ]);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((session) => session.title), [
    '查看项目文档',
    '这些进行中 的状态是什么意思'
  ]);
});

test('quiet running sessions stay running without timeout guessing', () => {
  const sessions = finalizeSessions({
    sessions: [
      {
        id: 'process:1',
        status: 'running',
        lastActivityAt: '2026-06-11T09:00:00.000Z',
        attentionReason: '',
        statusFacts: {
          hasExecution: true,
          executionPhase: 'active',
          signalObservedAt: '2026-06-11T09:00:00.000Z'
        }
      }
    ],
    now: new Date('2026-06-11T10:00:00.000Z'),
    lookbackDays: 7
  });

  assert.equal(sessions[0].status, 'running');
});

test('session store does not invent a terminal result after the process exits', () => {
  const store = createSessionStore();
  store.update([{
    id: 'process:1',
    title: 'codex run',
    status: 'running',
    source: 'terminal'
  }], new Date('2026-06-11T10:00:00.000Z'));
  const next = store.update([], new Date('2026-06-11T10:05:00.000Z'));

  assert.deepEqual(next, []);
});

test('new sessions without execution are excluded instead of becoming unknown', () => {
  assert.equal(resolveUnifiedStatus({ hasExecution: false, executionPhase: 'unknown' }), null);
  assert.equal(resolveUnifiedStatus({ executionPhase: 'unknown' }), null);
  assert.deepEqual(finalizeSessions({
    sessions: [{
      id: 'new-empty',
      status: 'unknown',
      lastActivityAt: '2026-06-11T10:00:00.000Z',
      statusFacts: { hasExecution: false, signalObservedAt: '2026-06-11T10:00:00.000Z' }
    }],
    now: new Date('2026-06-11T10:01:00.000Z')
  }), []);
});

test('native product sessions in the same project stay separate by conversation id', () => {
  const merged = mergeSessions([
    {
      id: 'workbuddy:one', toolId: 'workbuddy-desktop', tool: 'WorkBuddy·Desktop',
      source: 'workbuddy-local', projectPath: '/tmp/demo', title: '任务一', status: 'running'
    },
    {
      id: 'workbuddy:two', toolId: 'workbuddy-desktop', tool: 'WorkBuddy·Desktop',
      source: 'workbuddy-local', projectPath: '/tmp/demo', title: '任务二', status: 'running'
    }
  ]);

  assert.equal(merged.length, 2);
});

test('finalizeSessions applies the agreed attention-first state order', () => {
  const at = '2026-06-11T10:00:00.000Z';
  const statuses = [
    'completed_seen',
    'unknown',
    'running',
    'completed_unseen',
    'ended_abnormally',
    'needs_response'
  ];
  const sessions = finalizeSessions({
    sessions: statuses.map((status) => ({
      id: status,
      status,
      lastActivityAt: at,
      statusFacts: {
        hasExecution: true,
        viewState: 'indeterminate',
        signalObservedAt: at
      }
    })),
    now: new Date(at)
  });

  assert.deepEqual(sessions.map((session) => session.status), [
    'needs_response',
    'completed_unseen',
    'running',
    'unknown',
    'ended_abnormally',
    'completed_seen'
  ]);
});
