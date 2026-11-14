import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectSessions } from '../public/dashboardModel.js';
import {
  decodeCursorProjectSlug,
  parseAgentTranscript,
  parseComposerDataRows,
  parseComposerHeaderRows,
  parseComposerHeaders,
  buildAgentSessions,
  isMetaCursorWindowTitle
} from '../src/server/cursorAgentScanner.js';

test('decodeCursorProjectSlug resolves hyphenated slug to real workspace path', () => {
  const projectPath = decodeCursorProjectSlug(
    'Users-beibei-AI-Item-Agent-20-Personal-Projects-20260611-ai-tool-session-dashboard',
    {
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync
    }
  );

  assert.equal(
    projectPath,
    '/Users/beibei/AI_Item_Agent/20_Personal_Projects/20260611-ai-tool-session-dashboard'
  );
});

test('decodeCursorProjectSlug returns empty for numeric cursor project ids', () => {
  const projectPath = decodeCursorProjectSlug('1777103830974', {
    existsSync: fs.existsSync,
    readdirSync: fs.readdirSync
  });

  assert.equal(projectPath, '');
});

test('parseAgentTranscript infers progress and title from jsonl lines', () => {
  const parsed = parseAgentTranscript([
    '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\n帮我读一下项目\\n</user_query>"}]}}',
    '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"path":"/tmp/demo/README.md"}}]}}'
  ].join('\n'));

  assert.equal(parsed.title, '帮我读一下项目');
  assert.equal(parsed.progressHint, 'Agent 执行中');
  assert.equal(parsed.status, 'running');
  assert.equal(parsed.turnCount, 0);
});

test('parseAgentTranscript marks finished turn as completed progress', () => {
  const parsed = parseAgentTranscript([
    '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\n测试\\n</user_query>"}]}}',
    '{"role":"assistant","message":{"content":[{"type":"text","text":"完成"}]}}',
    '{"type":"turn_ended","status":"success"}'
  ].join('\n'));

  assert.equal(parsed.progressHint, '一轮已完成，查看状态未知');
  assert.equal(parsed.status, 'unknown');
  assert.equal(parsed.executionPhase, 'succeeded');
});

function cursorUserLine() {
  return JSON.stringify({
    role: 'user',
    message: { content: [{ type: 'text', text: '<user_query>\n测试\n</user_query>' }] }
  });
}

function cursorAssistantLine() {
  return JSON.stringify({
    role: 'assistant',
    message: { content: [{ type: 'text', text: '处理中' }] }
  });
}

test('parseAgentTranscript maps explicit Cursor stop errors to user_stopped', () => {
  for (const turn of [
    { type: 'turn_ended', status: 'error', error: 'User aborted request' },
    { type: 'turn_ended', status: 'error', error: 'user_stopped_generation', timestamp: '2026-11-14T05:27:22.000Z' },
    { type: 'turn_ended', status: 'aborted', error: 'User aborted/interrupted manually.' }
  ]) {
    const parsed = parseAgentTranscript([
      cursorUserLine(),
      cursorAssistantLine(),
      JSON.stringify(turn),
      cursorAssistantLine()
    ].join('\n'));

    assert.equal(parsed.status, 'ended_abnormally');
    assert.equal(parsed.executionPhase, 'failed');
    assert.equal(parsed.endReason, 'user_stopped');
    assert.equal(parsed.progressHint, '你已停止这条 Cursor 轮次');
    assert.equal(parsed.endedAt, turn.timestamp || '');
    assert.equal(parsed.progressHint.includes(turn.error), false);
  }
});

test('parseAgentTranscript keeps real Cursor failures and later turns distinct from manual stop', () => {
  const provider = parseAgentTranscript([
    cursorUserLine(),
    JSON.stringify({
      type: 'turn_ended',
      status: 'error',
      error: 'Provider Error We are having trouble connecting'
    })
  ].join('\n'));
  const superseded = parseAgentTranscript([
    cursorUserLine(),
    JSON.stringify({ type: 'turn_ended', status: 'error', error: 'new_message_submitted' })
  ].join('\n'));
  const network = parseAgentTranscript([
    cursorUserLine(),
    JSON.stringify({
      type: 'turn_ended',
      status: 'error',
      error: '[aborted] Client network socket disconnected before secure TLS connection was established'
    })
  ].join('\n'));
  const continued = parseAgentTranscript([
    cursorUserLine(),
    JSON.stringify({ type: 'turn_ended', status: 'error', error: 'User aborted request' }),
    cursorUserLine(),
    JSON.stringify({ type: 'turn_ended', status: 'success' })
  ].join('\n'));
  const restarted = parseAgentTranscript([
    cursorUserLine(),
    JSON.stringify({ type: 'turn_ended', status: 'error', error: 'user_stopped_generation' }),
    cursorUserLine()
  ].join('\n'));

  for (const parsed of [provider, superseded, network]) {
    assert.equal(parsed.status, 'ended_abnormally');
    assert.equal(parsed.executionPhase, 'failed');
    assert.equal(parsed.endReason, undefined);
    assert.equal(parsed.progressHint, 'Agent 异常结束：error');
  }
  assert.equal(continued.executionPhase, 'succeeded');
  assert.equal(continued.endReason, undefined);
  assert.equal(restarted.status, 'running');
  assert.equal(restarted.endReason, undefined);
});

test('parseComposerHeaders maps composer id to sidebar name and workspace path', () => {
  const headers = parseComposerHeaders(JSON.stringify({
    allComposers: [{
      composerId: 'chat-1',
      name: '项目进展讨论',
      subtitle: 'Edited app.js',
      lastUpdatedAt: 1781191244691,
      workspaceIdentifier: {
        uri: { fsPath: '/tmp/demo/project' }
      },
      hasUnreadMessages: true
    }]
  }));

  assert.equal(headers.get('chat-1').name, '项目进展讨论');
  assert.equal(headers.get('chat-1').projectPath, '/tmp/demo/project');
  assert.equal(headers.get('chat-1').hasUnreadMessages, true);
});

test('parseComposerHeaderRows reads new Cursor composer table state', () => {
  const headers = parseComposerHeaderRows([
    'chat-unread\u001f待查看任务\u001f已编辑文件\u001f1781191244691\u001f/tmp/demo\u001f1\u001f\u001f0\u001f0',
    'chat-seen\u001f已查看任务\u001f\u001f1781191244690\u001f/tmp/demo\u001f0\u001f\u001f0\u001f0',
    'chat-archived\u001f已归档任务\u001f\u001f1781191244689\u001f/tmp/demo\u001f1\u001f\u001f1\u001f0'
  ].join('\n'));

  assert.equal(headers.get('chat-unread').hasUnreadMessages, true);
  assert.equal(headers.get('chat-seen').hasUnreadMessages, false);
  assert.equal(headers.get('chat-unread').name, '待查看任务');
  assert.equal(headers.get('chat-unread').projectPath, '/tmp/demo');
  assert.equal(headers.get('chat-archived').isArchived, true);
});

test('parseComposerDataRows reads native execution metadata without conversation content', () => {
  const updatedAt = 1793717258347;
  const unfinishedAt = 1793717258161;
  const data = parseComposerDataRows([
    `chat-running\u001faborted\u001f${unfinishedAt}\u001f${updatedAt}\u001f/tmp/demo\u001f当前任务`,
    `chat-completed\u001fcompleted\u001f\u001f${updatedAt}\u001f/tmp/demo\u001f完成任务`
  ].join('\n'));

  assert.deepEqual(data.get('chat-running'), {
    nativeStatus: 'aborted',
    unfinishedRunAt: new Date(unfinishedAt).toISOString(),
    lastUpdatedAt: new Date(updatedAt).toISOString(),
    projectPath: '/tmp/demo',
    name: '当前任务'
  });
  assert.equal(data.get('chat-completed').unfinishedRunAt, '');
  assert.equal(data.get('chat-completed').nativeStatus, 'completed');
});

test('buildAgentSessions includes native running session before transcript exists and excludes empty draft', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agent-native-running-'));
  const now = new Date('2026-11-03T15:00:00.000Z');
  const runningAt = new Date('2026-11-03T14:59:00.000Z').toISOString();
  const sessions = buildAgentSessions({
    projectsRoot: root,
    now,
    activeWithinMs: 24 * 60 * 60 * 1000,
    composerHeadersById: new Map([
      ['chat-running', {
        name: '当前 Cursor 任务',
        lastUpdatedAt: runningAt,
        projectPath: '/tmp/demo',
        hasUnreadMessages: false,
        isArchived: false,
        isSubagent: false
      }],
      ['chat-draft', {
        name: '未执行草稿',
        lastUpdatedAt: runningAt,
        projectPath: '/tmp/demo',
        hasUnreadMessages: false,
        isArchived: false,
        isSubagent: false
      }]
    ]),
    composerDataById: new Map([
      ['chat-running', {
        nativeStatus: 'aborted',
        unfinishedRunAt: runningAt,
        lastUpdatedAt: runningAt,
        projectPath: '/tmp/demo',
        name: '当前 Cursor 任务'
      }],
      ['chat-draft', {
        nativeStatus: '',
        unfinishedRunAt: '',
        lastUpdatedAt: runningAt,
        projectPath: '/tmp/demo',
        name: '未执行草稿'
      }]
    ]),
    readdirSync: fs.readdirSync,
    existsSync: fs.existsSync
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'cursor-agent:tmp-demo:chat-running');
  assert.equal(sessions[0].status, 'running');
  assert.equal(sessions[0].endedAt, '');
  assert.equal(sessions[0].statusFacts.hasExecution, true);
  assert.equal(sessions[0].statusFacts.executionPhase, 'active');
  assert.match(sessions[0].statusFacts.signalSource, /cursor-composer-data/);
});

test('buildAgentSessions treats a recorded Cursor stop as stopped even when unfinishedRunAt remains', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agent-user-stop-'));
  const slug = 'Users-demo-project';
  const now = new Date('2026-11-14T06:00:00.000Z');
  const stoppedAt = '2026-11-14T05:27:22.000Z';
  const nativeUpdatedAt = '2026-11-14T05:27:22.231Z';

  for (const [chatId, lines] of [
    ['chat-stop', [
      cursorUserLine(),
      cursorAssistantLine(),
      JSON.stringify({ type: 'turn_ended', status: 'error', error: 'user_stopped_generation', timestamp: stoppedAt }),
      cursorAssistantLine()
    ]],
    ['chat-stop-no-time', [
      cursorUserLine(),
      JSON.stringify({ type: 'turn_ended', status: 'error', error: 'User aborted request' })
    ]],
    ['chat-error', [
      cursorUserLine(),
      JSON.stringify({ type: 'turn_ended', status: 'error', error: 'Connection failed repeatedly' })
    ]],
    ['chat-followup', [
      cursorUserLine(),
      JSON.stringify({ type: 'turn_ended', status: 'success' }),
      cursorUserLine()
    ]]
  ]) {
    const transcriptDir = path.join(root, slug, 'agent-transcripts', chatId);
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, `${chatId}.jsonl`), lines.join('\n'));
  }

  const composerDataById = new Map([
    ['chat-stop', {
      nativeStatus: 'aborted',
      unfinishedRunAt: nativeUpdatedAt,
      lastUpdatedAt: nativeUpdatedAt,
      projectPath: '/tmp/demo',
      name: '已停止任务'
    }],
    ['chat-stop-no-time', {
      nativeStatus: 'aborted',
      unfinishedRunAt: '',
      lastUpdatedAt: nativeUpdatedAt,
      projectPath: '/tmp/demo',
      name: '无时间停止'
    }],
    ['chat-error', {
      nativeStatus: 'aborted',
      unfinishedRunAt: nativeUpdatedAt,
      lastUpdatedAt: nativeUpdatedAt,
      projectPath: '/tmp/demo',
      name: '仍在执行的失败标记'
    }],
    ['chat-followup', {
      nativeStatus: 'aborted',
      unfinishedRunAt: nativeUpdatedAt,
      lastUpdatedAt: nativeUpdatedAt,
      projectPath: '/tmp/demo',
      name: '停止后的新消息'
    }]
  ]);

  const sessions = buildAgentSessions({
    projectsRoot: root,
    now,
    activeWithinMs: 24 * 60 * 60 * 1000,
    composerDataById,
    decodeProjectSlug: () => '/tmp/demo',
    statSync: () => ({ mtimeMs: now.getTime() }),
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    existsSync: fs.existsSync
  });
  const byTitle = new Map(sessions.map((session) => [session.title, session]));
  const stopped = byTitle.get('已停止任务');
  const stoppedWithoutTime = byTitle.get('无时间停止');

  assert.equal(stopped.status, 'ended_abnormally');
  assert.equal(stopped.statusFacts.endReason, 'user_stopped');
  assert.equal(stopped.statusFacts.executionPhase, 'failed');
  assert.equal(stopped.statusReason, '你已停止这条 Cursor 轮次');
  assert.equal(stopped.endedAt, stoppedAt);
  assert.equal(JSON.stringify(stopped).includes('user_stopped_generation'), false);
  assert.equal(stoppedWithoutTime.statusFacts.endReason, 'user_stopped');
  assert.equal(stoppedWithoutTime.endedAt, nativeUpdatedAt);
  assert.equal(byTitle.get('仍在执行的失败标记').status, 'running');
  assert.equal(byTitle.get('仍在执行的失败标记').statusFacts.endReason, undefined);
  assert.equal(byTitle.get('停止后的新消息').status, 'running');
  assert.equal(byTitle.get('停止后的新消息').endedAt, '');
});

test('buildAgentSessions uses native completion time only when transcript timestamp is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agent-native-ended-at-'));
  const slug = 'Users-demo-project';
  const nativeEndedAt = '2026-11-03T14:55:00.000Z';
  const transcriptEndedAt = '2026-11-03T14:56:00.000Z';
  const now = new Date('2026-11-03T15:00:00.000Z');

  for (const [chatId, timestamp] of [
    ['chat-fallback', ''],
    ['chat-transcript-time', transcriptEndedAt]
  ]) {
    const transcriptDir = path.join(root, slug, 'agent-transcripts', chatId);
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, `${chatId}.jsonl`), [
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\n测试\\n</user_query>"}]}}',
      `{"type":"turn_ended","status":"success"${timestamp ? `,"timestamp":"${timestamp}"` : ''}}`
    ].join('\n'));
  }

  const sessions = buildAgentSessions({
    projectsRoot: root,
    now,
    activeWithinMs: 24 * 60 * 60 * 1000,
    composerHeadersById: new Map([
      ['chat-fallback', { name: '回退时间', hasUnreadMessages: false }],
      ['chat-transcript-time', { name: '原生时间', hasUnreadMessages: false }],
      ['chat-native-only', {
        name: '只有原生完成事实',
        projectPath: '/tmp/demo',
        hasUnreadMessages: true,
        isArchived: false,
        isSubagent: false
      }]
    ]),
    composerDataById: new Map([
      ['chat-fallback', { nativeStatus: 'completed', unfinishedRunAt: '', lastUpdatedAt: nativeEndedAt }],
      ['chat-transcript-time', { nativeStatus: 'completed', unfinishedRunAt: '', lastUpdatedAt: nativeEndedAt }],
      ['chat-native-only', {
        nativeStatus: 'completed',
        unfinishedRunAt: '',
        lastUpdatedAt: nativeEndedAt,
        projectPath: '/tmp/demo',
        name: '只有原生完成事实'
      }]
    ]),
    decodeProjectSlug: () => '/tmp/demo/project',
    statSync: () => ({ mtimeMs: now.getTime() }),
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    existsSync: fs.existsSync
  });

  const byTitle = new Map(sessions.map((session) => [session.title, session]));
  assert.equal(byTitle.get('回退时间').endedAt, nativeEndedAt);
  assert.equal(byTitle.get('原生时间').endedAt, transcriptEndedAt);
  assert.equal(byTitle.get('只有原生完成事实').status, 'completed_unseen');
  assert.equal(byTitle.get('只有原生完成事实').endedAt, nativeEndedAt);
});

test('buildAgentSessions prefers composer sidebar name over first user message', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agent-name-'));
  const slug = 'Users-demo-project';
  const chatId = 'chat-1';
  const transcriptDir = path.join(root, slug, 'agent-transcripts', chatId);
  fs.mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, `${chatId}.jsonl`);
  fs.writeFileSync(
    transcriptPath,
    '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\n阅读下现在这个项目\\n</user_query>"}]}}'
  );

  const now = new Date('2026-06-11T12:00:00.000Z');
  const sessions = buildAgentSessions({
    projectsRoot: root,
    now,
    activeWithinMs: 24 * 60 * 60 * 1000,
    composerHeadersById: new Map([
      ['chat-1', {
        name: '项目进展讨论',
        subtitle: 'Edited app.js',
        lastUpdatedAt: now.toISOString(),
        projectPath: '/tmp/demo/project'
      }]
    ]),
    decodeProjectSlug: () => '/tmp/demo/project',
    statSync: () => ({ mtimeMs: now.getTime() }),
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    existsSync: fs.existsSync
  });

  assert.equal(sessions[0].tool, 'Cursor Agent');
  assert.equal(sessions[0].title, '项目进展讨论');
  assert.equal(sessions[0].agent.name, '项目进展讨论');
});

test('buildAgentSessions creates cursor agent rows with project path and progress', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agent-'));
  const slug = 'Users-demo-project';
  const chatId = 'chat-1';
  const transcriptDir = path.join(root, slug, 'agent-transcripts', chatId);
  fs.mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, `${chatId}.jsonl`);
  fs.writeFileSync(
    transcriptPath,
    [
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\n修一下看板\\n</user_query>"}]}}',
      '{"role":"assistant","message":{"content":[{"type":"text","text":"好的"}]}}'
    ].join('\n')
  );

  const now = new Date('2026-06-11T12:00:00.000Z');
  const sessions = buildAgentSessions({
    projectsRoot: root,
    now,
    activeWithinMs: 24 * 60 * 60 * 1000,
    decodeProjectSlug: () => '/tmp/demo/project',
    statSync: (target) => ({ mtimeMs: now.getTime() }),
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    existsSync: fs.existsSync
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].tool, 'Cursor Agent');
  assert.equal(sessions[0].source, 'cursor-agent');
  assert.equal(sessions[0].projectPath, '/tmp/demo/project');
  assert.equal(sessions[0].projectName, 'project');
  assert.equal(sessions[0].title, '修一下看板');
  assert.equal(sessions[0].attentionReason, 'Agent 回复中');
  assert.equal(sessions[0].agent.chatId, chatId);
});

test('buildAgentSessions maps successful turns from Cursor native unread state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agent-read-state-'));
  const slug = 'Users-demo-project';
  const now = new Date('2026-06-11T12:00:00.000Z');

  for (const chatId of ['chat-unread', 'chat-seen']) {
    const transcriptDir = path.join(root, slug, 'agent-transcripts', chatId);
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, `${chatId}.jsonl`), [
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\n测试\\n</user_query>"}]}}',
      '{"role":"assistant","message":{"content":[{"type":"text","text":"完成"}]}}',
      '{"type":"turn_ended","status":"success","timestamp":"2026-06-10T23:00:00.000Z"}'
    ].join('\n'));
  }

  const sessions = buildAgentSessions({
    projectsRoot: root,
    now,
    activeWithinMs: 24 * 60 * 60 * 1000,
    composerHeadersById: new Map([
      ['chat-unread', { name: '待查看任务', hasUnreadMessages: true }],
      ['chat-seen', { name: '已查看任务', hasUnreadMessages: false }]
    ]),
    decodeProjectSlug: () => '/tmp/demo/project',
    statSync: () => ({ mtimeMs: now.getTime() }),
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    existsSync: fs.existsSync
  });

  assert.deepEqual(sessions.map((session) => session.status).sort(), [
    'completed_seen',
    'completed_unseen'
  ]);
  assert.deepEqual(sessions.map((session) => session.statusFacts.viewState).sort(), [
    'seen',
    'unseen'
  ]);
  assert.ok(sessions.every((session) => session.statusFacts.signalSource.includes('cursor-composer-header')));
  assert.ok(sessions.every((session) => session.endedAt === '2026-06-10T23:00:00.000Z'));
});

test('buildAgentSessions lets a read Cursor failure leave attention', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agent-failed-read-'));
  const slug = 'Users-demo-project';
  const now = new Date(2026, 10, 14, 18, 5, 0);
  const endedAt = new Date(2026, 10, 14, 17, 55, 17).toISOString();
  const failure = [
    cursorUserLine(),
    JSON.stringify({ type: 'turn_ended', status: 'error', error: 'Agent turn stopped after repeated resume attempts made no progress' })
  ].join('\n');

  for (const chatId of ['chat-seen', 'chat-unseen', 'chat-unknown', 'chat-open']) {
    const transcriptDir = path.join(root, slug, 'agent-transcripts', chatId);
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, `${chatId}.jsonl`), failure);
  }

  const sessions = buildAgentSessions({
    projectsRoot: root,
    now,
    activeWithinMs: 24 * 60 * 60 * 1000,
    composerHeadersById: new Map([
      ['chat-seen', { name: '已读失败', hasUnreadMessages: false }],
      ['chat-unseen', { name: '未读失败', hasUnreadMessages: true }],
      ['chat-open', { name: '失败标记但仍在执行', hasUnreadMessages: false }]
    ]),
    composerDataById: new Map([
      ['chat-open', {
        nativeStatus: 'aborted',
        unfinishedRunAt: endedAt,
        lastUpdatedAt: endedAt,
        name: '失败标记但仍在执行'
      }]
    ]),
    decodeProjectSlug: () => '/tmp/demo/project',
    statSync: () => ({ mtimeMs: Date.parse(endedAt) }),
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    existsSync: fs.existsSync
  });
  const byTitle = new Map(sessions.map((session) => [session.title, session]));
  const seen = byTitle.get('已读失败');
  const unseen = byTitle.get('未读失败');
  const unknown = byTitle.get('测试');
  const open = byTitle.get('失败标记但仍在执行');

  assert.equal(seen.status, 'ended_abnormally');
  assert.equal(seen.statusFacts.viewState, 'seen');
  assert.equal(seen.statusFacts.endReason, undefined);
  assert.equal(seen.endedAt, endedAt);
  assert.deepEqual(selectSessions([seen], 'attention', '', now), []);
  assert.deepEqual(selectSessions([seen], 'ended_today', '', now).map((session) => session.title), ['已读失败']);
  assert.equal(unseen.statusFacts.viewState, 'unseen');
  assert.deepEqual(selectSessions([unseen], 'attention', '', now).map((session) => session.title), ['未读失败']);
  assert.equal(unknown.statusFacts.viewState, 'indeterminate');
  assert.deepEqual(selectSessions([unknown], 'attention', '', now).map((session) => session.status), ['ended_abnormally']);
  assert.equal(open.status, 'running');
  assert.equal(open.endedAt, '');
});

test('buildAgentSessions excludes archived Cursor conversations and subagents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agent-archived-'));
  const slug = 'Users-demo-project';
  const now = new Date('2026-06-11T12:00:00.000Z');

  for (const chatId of ['chat-active', 'chat-archived', 'chat-subagent']) {
    const transcriptDir = path.join(root, slug, 'agent-transcripts', chatId);
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, `${chatId}.jsonl`), [
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\n测试\\n</user_query>"}]}}',
      '{"type":"turn_ended","status":"success"}'
    ].join('\n'));
  }

  const sessions = buildAgentSessions({
    projectsRoot: root,
    now,
    activeWithinMs: 24 * 60 * 60 * 1000,
    composerHeadersById: new Map([
      ['chat-active', { name: '活跃会话', hasUnreadMessages: false, isArchived: false, isSubagent: false }],
      ['chat-archived', { name: '归档会话', hasUnreadMessages: true, isArchived: true, isSubagent: false }],
      ['chat-subagent', { name: '子任务', hasUnreadMessages: false, isArchived: false, isSubagent: true }]
    ]),
    decodeProjectSlug: () => '/tmp/demo/project',
    statSync: () => ({ mtimeMs: now.getTime() }),
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    existsSync: fs.existsSync
  });

  assert.deepEqual(sessions.map((session) => session.title), ['活跃会话']);
});

test('isMetaCursorWindowTitle identifies Cursor Agents management window', () => {
  assert.equal(isMetaCursorWindowTitle('Cursor Agents'), true);
  assert.equal(isMetaCursorWindowTitle('demo - Cursor'), false);
});
