import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildWorkBuddySession, completionTimestampFromEvents, hasOpenWorkBuddyQuestion,
  readWorkBuddyCompletionMs, scanWorkBuddy
} from '../src/server/workBuddySessionScanner.js';
import { buildTraeSessions, parseTraeEvents } from '../src/server/traeSessionScanner.js';
import {
  buildLingxiSessions,
  buildLingxiTelemetryRecords,
  extractLingxiCacheRecords,
  extractLingxiTelemetryEvents,
  scanWpsLingxi
} from '../src/server/wpsLingxiSessionScanner.js';
import {
  buildComateSession,
  loadComateSeenState,
  parseComateCloudLog,
  parseComateTranscript,
  scanWpsComate
} from '../src/server/wpsComateSessionScanner.js';

const now = new Date('2026-09-13T10:00:00.000Z');

test('WorkBuddy maps native execution and view facts without admitting empty new sessions', () => {
  const empty = buildWorkBuddySession({
    conversationId: 'empty', status: '', createdAt: now.getTime(), updatedAt: now.getTime()
  });
  const running = buildWorkBuddySession({
    conversationId: 'run', status: 'Running', createdAt: now.getTime(), updatedAt: now.getTime()
  });
  const waiting = buildWorkBuddySession({
    conversationId: 'wait', status: 'Running', awaiting_input: true,
    createdAt: now.getTime(), updatedAt: now.getTime()
  });
  const unseen = buildWorkBuddySession({
    conversationId: 'done', status: 'Completed', createdAt: now.getTime(), updatedAt: now.getTime()
  }, { unreadIds: new Set(['done']), readIds: new Set() });
  const seen = buildWorkBuddySession({
    conversationId: 'seen', status: 'Completed', createdAt: now.getTime(), updatedAt: now.getTime()
  }, { unreadIds: new Set(), readIds: new Set(['seen']) });
  const failed = buildWorkBuddySession({
    conversationId: 'failed', status: 'Terminated', createdAt: now.getTime(), updatedAt: now.getTime()
  });

  assert.equal(empty, null);
  assert.equal(running.status, 'running');
  assert.equal(waiting.status, 'needs_response');
  assert.equal(unseen.status, 'completed_unseen');
  assert.equal(seen.status, 'completed_seen');
  assert.equal(seen.endedAt, ''); // Viewing / metadata update is not a completion clock.
  assert.equal(running.endedAt, '');
  assert.equal(failed.status, 'ended_abnormally');
});

test('WorkBuddy uses the latest execution event time and ignores later snapshots or activity updates', async () => {
  const secret = '不要保留这段对话正文';
  const started = Date.parse('2026-11-06T06:57:25.872Z');
  const finished = Date.parse('2026-11-06T07:41:28.413Z');
  const viewed = Date.parse('2026-11-06T08:10:00.000Z');
  const events = [
    { type: 'message', role: 'user', timestamp: started, content: secret },
    { type: 'message', role: 'assistant', status: 'completed', timestamp: finished, content: secret },
    { type: 'file-history-snapshot', timestamp: viewed, content: secret }
  ];
  assert.equal(completionTimestampFromEvents(events), finished);
  assert.equal(JSON.stringify(events).includes(secret), true);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-workbuddy-log-'));
  const projectsDir = path.join(root, 'projects');
  const sessionDir = path.join(projectsDir, 'Users-beibei-WorkBuddy-demo');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'stay.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  try {
    assert.equal(readWorkBuddyCompletionMs(path.join(sessionDir, 'missing.jsonl')), 0);
    assert.equal(readWorkBuddyCompletionMs(path.join(sessionDir, 'stay.jsonl')), finished);
    const completed = buildWorkBuddySession({
      conversationId: 'stay', status: 'completed', cwd: '/Users/beibei/WorkBuddy/demo',
      createdAt: started, updatedAt: viewed, completedAt: finished,
      completionSource: 'workbuddy-session-db+workbuddy-session-log'
    });
    assert.equal(completed.endedAt, new Date(finished).toISOString());
    assert.equal(completed.statusFacts.signalSource, 'workbuddy-session-db+workbuddy-session-log');
    assert.equal(JSON.stringify(completed).includes(secret), false);

    const dbPath = path.join(root, 'workbuddy.db');
    execFileSync('sqlite3', [dbPath, `
      CREATE TABLE sessions (id TEXT, title TEXT, custom_title TEXT, status TEXT,
        cwd TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
      INSERT INTO sessions VALUES
        ('stay', '今天完成', NULL, 'completed', '/Users/beibei/WorkBuddy/demo', ${started}, ${viewed}, NULL),
        ('running', '仍在执行', NULL, 'working', '/Users/beibei/WorkBuddy/demo', ${started}, ${viewed}, NULL);
    `]);
    const result = await scanWorkBuddy({
      dbPath,
      projectsDir,
      existsSync: (target) => target === dbPath || fs.existsSync(target),
      viewState: { readIds: new Set(), unreadIds: new Set() }
    });
    assert.deepEqual(result.errors, []);
    const stay = result.sessions.find((session) => session.id === 'workbuddy:stay');
    const runningSession = result.sessions.find((session) => session.id === 'workbuddy:running');
    assert.equal(stay.endedAt, new Date(finished).toISOString());
    assert.equal(stay.status, 'unknown');
    assert.equal(runningSession.endedAt, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WorkBuddy prefers the current SQLite store over legacy data', async () => {
  const nativeDbPath = '/mock/.workbuddy/workbuddy.db';
  const calls = [];
  const record = {
    conversationId: 'hotel', title: '酒店查价', status: 'working', cwd: '/tmp/hotel',
    createdAt: now.getTime(), updatedAt: now.getTime()
  };
  const result = await scanWorkBuddy({
    nativeDbPath,
    legacyDbPath: '/mock/WorkBuddy/codebuddy-sessions.vscdb',
    existsSync: () => true,
    viewState: { readIds: new Set(), unreadIds: new Set() },
    runCommand: async (command, args) => {
      calls.push({ command, args });
      assert.equal(args.includes('-readonly'), true);
      assert.equal(args.includes(nativeDbPath), true);
      const sql = args.at(-1);
      if (sql.includes('sqlite_master')) return { ok: true, stdout: 'sessions\n' };
      assert.match(sql, /FROM sessions/);
      assert.match(sql, /deleted_at IS NULL/);
      assert.match(sql, /custom_title/);
      return { ok: true, stdout: `hotel\u001f${Buffer.from(JSON.stringify(record)).toString('hex')}\n` };
    }
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].title, '酒店查价');
  assert.equal(result.sessions[0].status, 'running');
  assert.equal(calls.length, 2);
});

test('WorkBuddy reads actual native SQLite metadata and uses its matching view-state directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-workbuddy-'));
  try {
    const dbPath = path.join(root, 'workbuddy.db');
    execFileSync('sqlite3', [dbPath, `
      CREATE TABLE sessions (id TEXT, title TEXT, custom_title TEXT, status TEXT,
        cwd TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
      INSERT INTO sessions VALUES ('working', '标题', '自定义标题', 'working', '/tmp/demo', 1, 2, NULL);
      INSERT INTO sessions VALUES ('seen-a', '完成', NULL, 'completed', '/tmp/demo', 1, 2, NULL);
      INSERT INTO sessions VALUES ('deleted', '删除', NULL, 'working', '/tmp/demo', 1, 2, 3);
      INSERT INTO sessions VALUES ('archived', '归档', NULL, 'archived', '/tmp/demo', 1, 2, NULL);
      INSERT INTO sessions VALUES ('pending', '空任务', NULL, 'Pending', '/tmp/demo', 1, 2, NULL);
    `]);
    let viewPath;
    const result = await scanWorkBuddy({
      dbPath,
      readdirSync: (directory) => {
        viewPath = directory;
        return fs.readdirSync(new URL('./fixtures/workbuddy-view-state/', import.meta.url));
      },
      readFileSync: (file) => fs.readFileSync(new URL(`./fixtures/workbuddy-view-state/${path.basename(file)}`, import.meta.url)),
      existsSync: () => true
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.sessions.length, 2);
    assert.equal(result.sessions[0].title, '自定义标题');
    assert.equal(result.sessions[0].status, 'running');
    assert.equal(result.sessions[1].status, 'completed_seen');
    assert.equal(viewPath.endsWith('.workbuddy/app/session/Local Storage/leveldb'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WorkBuddy still reads sessions after a clean exit removes the WAL sidecars', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-workbuddy-wal-'));
  try {
    const dbPath = path.join(root, 'workbuddy.db');
    execFileSync('sqlite3', [dbPath, `
      PRAGMA journal_mode=WAL;
      CREATE TABLE sessions (id TEXT, title TEXT, custom_title TEXT, status TEXT,
        cwd TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
      INSERT INTO sessions VALUES
        ('after-exit', '退出后仍在', NULL, 'completed', '/tmp/demo', 1, 2, NULL);
    `]);
    execFileSync('sqlite3', [dbPath, 'PRAGMA wal_checkpoint(TRUNCATE);']);
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    let readonlyError = '';
    try {
      execFileSync('sqlite3', ['-readonly', dbPath, 'SELECT count(*) FROM sessions;'], { stdio: 'pipe' });
    } catch (error) {
      readonlyError = `${error.stderr || ''}${error.message || ''}`;
    }
    assert.match(readonlyError, /unable to open database file/);

    const result = await scanWorkBuddy({
      dbPath,
      existsSync: (target) => target === dbPath,
      viewState: { readIds: new Set(['after-exit']), unreadIds: new Set() }
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].title, '退出后仍在');
    assert.equal(result.sessions[0].status, 'completed_seen');
    assert.equal(fs.existsSync(`${dbPath}-wal`), false);
    assert.equal(fs.existsSync(`${dbPath}-shm`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WorkBuddy retains the legacy store when the current database is absent', async () => {
  const legacyDbPath = '/mock/WorkBuddy/codebuddy-sessions.vscdb';
  const record = { conversationId: 'old', status: 'Completed', updatedAt: now.getTime() };
  const result = await scanWorkBuddy({
    nativeDbPath: '/mock/.workbuddy/workbuddy.db', legacyDbPath,
    existsSync: (p) => p === legacyDbPath,
    viewState: { readIds: new Set(['old']), unreadIds: new Set() },
    runCommand: async (command, args) => {
      assert.equal(args.includes(legacyDbPath), true);
      if (args.at(-1).includes('sqlite_master')) return { ok: true, stdout: 'ItemTable\n' };
      assert.match(args.at(-1), /FROM ItemTable/);
      return { ok: true, stdout: `session:old\u001f${Buffer.from(JSON.stringify(record)).toString('hex')}\n` };
    }
  });
  assert.equal(result.sessions[0].status, 'completed_seen');
});

test('WorkBuddy treats an open AskUserQuestion as confirmation and leaves a bare pending session out', async () => {
  const secret = '不要读取这段提问正文';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-workbuddy-question-'));
  const projectsDir = path.join(root, 'projects');
  const sessionDir = path.join(projectsDir, 'Users-beibei-WorkBuddy-trip');
  fs.mkdirSync(sessionDir, { recursive: true });
  const writeLog = (id, events) => {
    fs.writeFileSync(path.join(sessionDir, `${id}.jsonl`), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  };
  writeLog('open-q', [
    { type: 'function_call', name: 'AskUserQuestion', callId: 'call_old', arguments: secret },
    { type: 'function_call_result', name: 'AskUserQuestion', callId: 'call_old', status: 'completed' },
    { type: 'function_call', name: 'AskUserQuestion', callId: 'call_new', arguments: secret }
  ]);
  writeLog('closed-q', [
    { type: 'function_call', name: 'AskUserQuestion', callId: 'call_done', arguments: secret },
    { type: 'function_call_result', name: 'AskUserQuestion', callId: 'call_done', status: 'completed' }
  ]);
  writeLog('active-q', [
    { type: 'function_call', name: 'AskUserQuestion', callId: 'call_live', arguments: secret }
  ]);
  writeLog('done-q', [
    { type: 'function_call', name: 'AskUserQuestion', callId: 'call_left', arguments: secret }
  ]);
  try {
    assert.equal(hasOpenWorkBuddyQuestion(path.join(sessionDir, 'open-q.jsonl')), true);
    assert.equal(hasOpenWorkBuddyQuestion(path.join(sessionDir, 'closed-q.jsonl')), false);
    assert.equal(hasOpenWorkBuddyQuestion(path.join(sessionDir, 'missing.jsonl')), false);
    assert.equal(buildWorkBuddySession({ conversationId: 'empty-q', status: 'Pending' }), null);

    const dbPath = path.join(root, 'workbuddy.db');
    execFileSync('sqlite3', [dbPath, `
      CREATE TABLE sessions (id TEXT, title TEXT, custom_title TEXT, status TEXT,
        cwd TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
      INSERT INTO sessions VALUES
        ('open-q', '深圳行程', NULL, 'pending', '/Users/beibei/WorkBuddy/trip', 1, 2, NULL),
        ('closed-q', '已回答', NULL, 'pending', '/Users/beibei/WorkBuddy/trip', 1, 2, NULL),
        ('empty-q', '空任务', NULL, 'Pending', '/Users/beibei/WorkBuddy/trip', 1, 2, NULL),
        ('active-q', '执行中确认', NULL, 'working', '/Users/beibei/WorkBuddy/trip', 1, 2, NULL),
        ('done-q', '已完成', NULL, 'completed', '/Users/beibei/WorkBuddy/trip', 1, 2, NULL);
    `]);
    const result = await scanWorkBuddy({
      dbPath,
      projectsDir,
      existsSync: (target) => target === dbPath || fs.existsSync(target),
      viewState: { readIds: new Set(), unreadIds: new Set() }
    });
    assert.deepEqual(result.errors, []);
    const byId = new Map(result.sessions.map((session) => [session.id, session]));
    assert.equal(byId.has('workbuddy:closed-q'), false);
    assert.equal(byId.has('workbuddy:empty-q'), false);
    assert.equal(byId.get('workbuddy:open-q').status, 'needs_response');
    assert.equal(byId.get('workbuddy:open-q').statusReason, 'WorkBuddy 正在等待你确认');
    assert.equal(byId.get('workbuddy:open-q').statusFacts.signalSource, 'workbuddy-session-db+workbuddy-session-log');
    assert.equal(byId.get('workbuddy:active-q').status, 'needs_response');
    assert.equal(byId.get('workbuddy:done-q').statusFacts.executionPhase, 'succeeded');
    assert.equal(byId.get('workbuddy:done-q').status, 'unknown');
    assert.equal(JSON.stringify(result.sessions).includes(secret), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WorkBuddy excludes pending, archived and deleted records and never treats read failure as empty success', async () => {
  for (const record of [
    { status: 'Pending' }, { status: 'archived', hasExecution: true },
    { status: 'Completed', deletedAt: now.getTime() },
    { status: 'Completed', isArchived: true }
  ]) assert.equal(buildWorkBuddySession({ conversationId: 'hidden', ...record }), null);

  for (const result of [
    { ok: false, error: 'database locked' }, { ok: true, stdout: 'future_schema\n' }
  ]) {
    const scanned = await scanWorkBuddy({ existsSync: () => true, runCommand: async () => result });
    assert.deepEqual(scanned.sessions, []);
    assert.equal(scanned.errors.length, 1);
  }
});

test('Trae readers require execution evidence and use native badges only after success', () => {
  const events = parseTraeEvents([
    JSON.stringify({ event: 'SessionStart', session_id: 'empty', timestamp: '2026-09-13T09:00:00Z', toolName: 'Trae' }),
    JSON.stringify({ event: 'UserPromptSubmit', session_id: 'run', timestamp: '2026-09-13T09:01:00Z', toolName: 'Trae', prompt: '运行任务' }),
    JSON.stringify({ event: 'UserPromptSubmit', session_id: 'done', timestamp: '2026-09-13T09:02:00Z', toolName: 'Trae' }),
    JSON.stringify({ event: 'Notification', notification_type: 'idle_prompt', session_id: 'done', timestamp: '2026-09-13T09:03:00Z', toolName: 'Trae' }),
    JSON.stringify({ event: 'Notification', notification_type: 'ask_user_question', session_id: 'wait', timestamp: '2026-09-13T09:04:00Z', toolName: 'Trae' }),
    JSON.stringify({ event: 'RunFailed', status: 'failed', session_id: 'failed', timestamp: '2026-09-13T09:05:00Z', toolName: 'Trae' })
  ].join('\n'));
  const sessions = buildTraeSessions(events, {
    product: 'trae',
    badges: { loaded: true, unreadIds: new Set(['done']) },
    now
  });
  const byId = new Map(sessions.map((session) => [session.id, session]));

  assert.equal(byId.has('trae-ide:empty'), false);
  assert.equal(byId.get('trae-ide:run').status, 'running');
  assert.equal(byId.get('trae-ide:done').status, 'completed_unseen');
  assert.equal(byId.get('trae-ide:wait').status, 'needs_response');
  assert.equal(byId.get('trae-ide:failed').status, 'ended_abnormally');
  assert.equal(byId.get('trae-ide:failed').endedAt, '2026-09-13T09:05:00.000Z');
  assert.equal(byId.get('trae-ide:run').endedAt, '');
});

test('TraeWork keeps a separate product surface while accepting the TRAE SOLO alias', () => {
  const events = parseTraeEvents(JSON.stringify({
    event: 'UserPromptSubmit', sessionId: 'solo-1', timestamp: '2026-09-13T09:00:00Z', toolName: 'TRAE SOLO CN'
  }), { product: 'traework' });
  const [session] = buildTraeSessions(events, { product: 'traework', now });

  assert.equal(session.tool, 'TraeWork·Desktop');
  assert.equal(session.toolId, 'traework-desktop');
});

test('WPS Lingxi combines terminal history with the latest native read state', () => {
  const sessions = buildLingxiSessions([
    { session_id: 'unseen', session_title: '未查看', update_time: now.getTime(), read_status: 'completed' },
    { session_id: 'seen', session_title: '已查看', update_time: now.getTime() - 1000, read_status: 'completed' },
    { session_id: 'seen', session_title: '已查看', update_time: now.getTime(), read_status: 'read' },
    { session_id: 'failed', session_title: '失败', update_time: now.getTime(), read_status: 'failed' },
    { session_id: 'empty', session_title: '新建任务', update_time: now.getTime(), read_status: 'read' }
  ], { now });
  const byId = new Map(sessions.map((session) => [session.id, session]));

  assert.equal(byId.get('wps-lingxi:unseen').status, 'completed_unseen');
  assert.equal(byId.get('wps-lingxi:seen').status, 'completed_seen');
  assert.equal(byId.get('wps-lingxi:failed').status, 'ended_abnormally');
  assert.equal(byId.has('wps-lingxi:empty'), false);
});

test('WPS Lingxi reads local request lifecycle events before the session list cache refreshes', () => {
  const raw = Buffer.from(`\u0000binary-prefix${JSON.stringify([
    {
      id: 'event-run',
      name: 'lxai_claw_createrequest',
      remoteTime: now.getTime(),
      data: { session_id: 'run', request_way: 'main' }
    },
    {
      id: 'event-done',
      name: 'lxai_claw_requestresult',
      remoteTime: now.getTime(),
      data: { session_id: 'done', result: 'success', stop_reason: 'finish', process_step: 'c_text' }
    },
    {
      id: 'event-wait',
      name: 'lxai_claw_requestresult',
      remoteTime: now.getTime(),
      data: { session_id: 'wait', result: 'success', stop_reason: 'finish', process_step: 'c_text,c_ask_user_question' }
    },
    {
      id: 'event-failed',
      name: 'lxai_claw_requestresult',
      remoteTime: now.getTime(),
      data: { session_id: 'failed', result: 'error', stop_reason: 'error' }
    }
  ])}\u0000binary-suffix`);

  const events = extractLingxiTelemetryEvents(raw);
  const records = buildLingxiTelemetryRecords(events);
  const sessions = buildLingxiSessions(records, { now });
  const byId = new Map(sessions.map((session) => [session.id, session]));

  assert.equal(events.length, 4);
  assert.equal(byId.get('wps-lingxi:run').status, 'running');
  assert.equal(byId.get('wps-lingxi:done').status, 'unknown');
  assert.equal(byId.get('wps-lingxi:done').statusReason, 'WPS 灵犀任务已完成，查看状态未知');
  assert.equal(byId.get('wps-lingxi:wait').status, 'needs_response');
  assert.equal(byId.get('wps-lingxi:failed').status, 'ended_abnormally');
  assert.equal(byId.get('wps-lingxi:done').statusFacts.signalSource, 'wps-lingxi-local-telemetry');
  assert.equal(byId.get('wps-lingxi:done').endedAt, now.toISOString());
  assert.equal(byId.get('wps-lingxi:wait').endedAt, '');
});

test('WPS Lingxi reads lifecycle events from the current business partition', async () => {
  const partitionsRoot = '/partitions';
  const businessLevelDbRoot = '/partitions/lingxi-business-v2-test/Local Storage/leveldb';
  const eventStore = JSON.stringify([{
    id: 'new-run',
    name: 'lxai_claw_createrequest',
    remoteTime: now.getTime(),
    data: { session_id: 'repeat', request_way: 'main' }
  }]);
  let readOptions;

  const result = await scanWpsLingxi({
    cacheRoot: '/missing-cache',
    levelDbRoot: '/missing-leveldb',
    appServerStateRoot: '',
    partitionsRoot,
    now,
    existsSync: (target) => target === partitionsRoot || target === businessLevelDbRoot,
    readdirSync: (target) => target === partitionsRoot
      ? [{ name: 'lingxi-business-v2-test', isDirectory: () => true }]
      : [],
    readChromiumLocalStorage: (target, keys, options) => {
      assert.equal(target, businessLevelDbRoot);
      assert.deepEqual(keys, []);
      readOptions = options;
      return {
        available: true,
        values: new Map([['dw_store_queen_data_events_test', eventStore]])
      };
    }
  });

  assert.deepEqual(readOptions.origins, ['https://lingxi.wps.cn']);
  assert.deepEqual(readOptions.keyPrefixes, ['dw_store_queen_data_events_']);
  assert.equal(result.sessions[0].id, 'wps-lingxi:repeat');
  assert.equal(result.sessions[0].status, 'running');
});

test('WPS Lingxi reports a visible error when the current business snapshot cannot be read', async () => {
  const partitionsRoot = '/partitions';
  const businessLevelDbRoot = '/partitions/lingxi-business-v2-test/Local Storage/leveldb';
  const result = await scanWpsLingxi({
    cacheRoot: '/missing-cache',
    levelDbRoot: '/missing-leveldb',
    appServerStateRoot: '',
    partitionsRoot,
    now,
    existsSync: (target) => target === partitionsRoot || target === businessLevelDbRoot,
    readdirSync: (target) => target === partitionsRoot
      ? [{ name: 'lingxi-business-v2-test', isDirectory: () => true }]
      : [],
    readChromiumLocalStorage: () => ({ available: false, values: new Map() })
  });

  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.errors, ['灵犀新版生命周期存储读取失败']);
});

test('WPS Lingxi decompresses Brotli Chromium cache entries for title and read state', () => {
  const key = Buffer.from('1/0/https://lingxi.wps.cn/api/public/v1/sessions/current');
  const header = Buffer.alloc(24);
  header.writeUInt32LE(key.length, 12);
  const payload = Buffer.from(JSON.stringify({
    data: {
      session_id: 'compressed',
      session_title: '压缩缓存任务',
      status: 'finished',
      read_status: 'completed',
      update_time: Math.floor(now.getTime() / 1000)
    }
  }));
  const cacheEntry = Buffer.concat([
    header,
    key,
    brotliCompressSync(payload),
    Buffer.from('\u0000HTTP/1.1 200 OK\u0000Content-Encoding: br\u0000')
  ]);

  const [record] = extractLingxiCacheRecords(cacheEntry);

  assert.equal(record.session_id, 'compressed');
  assert.equal(record.session_title, '压缩缓存任务');
  assert.equal(record.read_status, 'completed');
});

test('WPS Lingxi scanner admits Brotli entries without a plaintext session marker', async () => {
  const key = Buffer.from('1/0/https://lingxi.wps.cn/api/public/v1/sessions/current');
  const header = Buffer.alloc(24);
  header.writeUInt32LE(key.length, 12);
  const payload = Buffer.from(JSON.stringify({
    data: {
      session_id: 'compressed-only',
      session_title: '只有压缩正文',
      status: 'finished',
      read_status: 'completed',
      update_time: Math.floor(now.getTime() / 1000)
    }
  }));
  const cacheEntry = Buffer.concat([
    header,
    key,
    brotliCompressSync(payload),
    Buffer.from('\u0000HTTP/1.1 200 OK\u0000Content-Encoding: br\u0000')
  ]);
  const result = await scanWpsLingxi({
    cacheRoot: '/cache',
    levelDbRoot: '/leveldb',
    now,
    existsSync: (target) => target === '/cache',
    readdirSync: () => ['entry'],
    statSync: () => ({ isFile: () => true, size: cacheEntry.length, mtimeMs: now.getTime() }),
    readFileSync: () => cacheEntry
  });

  assert.equal(result.errors.length, 0);
  assert.equal(result.sessions[0].title, '只有压缩正文');
  assert.equal(result.sessions[0].status, 'completed_unseen');
});

test('WPS Lingxi does not reuse a stale read marker for a newer completed request', () => {
  const records = [
    { session_id: 'repeat', update_time: now.getTime() - 60000, read_status: 'read' },
    ...buildLingxiTelemetryRecords([{
      id: 'new-result',
      name: 'lxai_claw_requestresult',
      remoteTime: now.getTime(),
      data: { session_id: 'repeat', result: 'success', stop_reason: 'finish' }
    }])
  ];
  const [session] = buildLingxiSessions(records, { now });

  assert.equal(session.status, 'unknown');
  assert.equal(session.statusFacts.viewState, 'indeterminate');
});

test('WPS Lingxi prefers the most recently observed native read state', () => {
  const records = [
    {
      session_id: 'read-later',
      session_title: '稍后已查看',
      update_time: now.getTime(),
      read_status: 'completed',
      _cacheObservedAt: now.getTime()
    },
    {
      session_id: 'read-later',
      session_title: '稍后已查看',
      update_time: now.getTime(),
      read_status: 'read',
      _cacheObservedAt: now.getTime() + 60000
    }
  ];
  const [session] = buildLingxiSessions(records, { now });

  assert.equal(session.status, 'completed_seen');
  assert.equal(session.statusFacts.viewState, 'seen');
});

function comateRecord(overrides = {}) {
  return {
    id: 'task-1',
    source: 'local',
    title: '任务',
    status: 'idle',
    workspace: '/tmp/demo',
    messageCount: 2,
    userMessageCount: 1,
    createdAtMs: now.getTime(),
    updatedAtMs: now.getTime(),
    streaming: false,
    ...overrides
  };
}

test('WPS Comate separates running, waiting, success, failure, and empty sessions', () => {
  const user = JSON.stringify({ type: 'message', message: { role: 'user', content: '开始' } });
  const success = parseComateTranscript([
    user,
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [], stopReason: 'end_turn' } })
  ].join('\n'));
  const waiting = parseComateTranscript([
    user,
    JSON.stringify({ type: 'message', message: {
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'askUserQuestion', id: 'ask-1' }],
      stopReason: 'toolUse'
    } })
  ].join('\n'));
  const failed = parseComateTranscript([
    user,
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [], stopReason: 'length' } })
  ].join('\n'));
  const seenState = { loaded: true, localIds: new Set(['seen']), cloudIds: new Set() };

  assert.equal(buildComateSession(comateRecord({ id: 'empty', messageCount: 0, userMessageCount: 0 }), parseComateTranscript(''), seenState, { now }), null);
  assert.equal(buildComateSession(comateRecord({ id: 'run', status: 'running' }), success, seenState, { now }).projectName, '本地');
  assert.equal(buildComateSession(comateRecord({ id: 'run', status: 'running' }), success, seenState, { now }).status, 'running');
  assert.equal(buildComateSession(comateRecord({ id: 'wait', status: 'running' }), waiting, seenState, { now }).status, 'needs_response');
  assert.equal(buildComateSession(comateRecord({ id: 'unseen' }), success, seenState, { now }).status, 'completed_unseen');
  assert.equal(buildComateSession(comateRecord({ id: 'seen' }), success, seenState, { now }).status, 'completed_seen');
  assert.equal(buildComateSession(comateRecord({ id: 'failed' }), failed, seenState, { now }).status, 'ended_abnormally');
  const cloudUnseen = buildComateSession(comateRecord({ id: 'cloud-1', source: 'cloud', workspace: '' }), success, seenState, { now });
  assert.equal(cloudUnseen.projectName, '云端');
  assert.equal(cloudUnseen.source, 'wps-comate-cloud');
  assert.equal(cloudUnseen.status, 'completed_unseen');
});

test('WPS Comate cloud tasks come from completion metadata and stay separate from local tasks', async () => {
  const raw = [
    '[2026-11-06 23:06:10.312][FORCE_LOG] [cloud][chat] session=37c2e8f1-b1c5-4c72-9a9c-e0fb0f858408 start body_len=20 text(len=9)="松山湖有什么好玩的"',
    '[2026-11-06 23:06:10.312][FORCE_LOG] [cloud][chat] session=37c2e8f1-b1c5-4c72-9a9c-e0fb0f858408 request_json={"text":"不应采用这段正文"}',
    '[2026-11-06 23:06:10.500][FORCE_LOG] [cloud][chat] session=37c2e8f1-b1c5-4c72-9a9c-e0fb0f858408 sse_frame data="另一段回答"',
    '[2026-11-06 23:06:29.644][FORCE_LOG] [cloud][chat] session=37c2e8f1-b1c5-4c72-9a9c-e0fb0f858408 sse_complete reason=eof chunks=1',
    '[2026-11-06 23:06:29.647][FORCE_LOG] [notify][FE] send_notify | route=/cloud/task/37c2e8f1-b1c5-4c72-9a9c-e0fb0f858408 body=【松山湖有什么好玩的】任务已完成，请点击查看',
    '[2026-05-26 16:47:18.227][FORCE_LOG] [cloud][chat] session=b8636052-ee31-40e1-8931-dfa3c0953431 start body_len=10 text(len=12)="<at id=\'x\' data-mention=\'{"',
    '[2026-05-26 16:58:28.731][FORCE_LOG] [notify][FE] send_notify | route=/cloud/task/b8636052-ee31-40e1-8931-dfa3c0953431 body=【推送AI埋点到德谱平台】任务已完成，请点击查看',
    '[2026-11-06 23:10:00.000][FORCE_LOG] [cloud][chat] session=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee start body_len=3 text(len=3)="进行中"'
  ].join('');
  const cloud = parseComateCloudLog(raw);
  assert.deepEqual(cloud.map((item) => item.title), ['松山湖有什么好玩的', '推送AI埋点到德谱平台', '进行中']);
  assert.deepEqual(cloud.map((item) => item.phase), ['succeeded', 'succeeded', 'active']);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comate-cloud-'));
  const dbPath = path.join(root, 'chat_history.db');
  const logPath = path.join(root, 'app.log');
  fs.writeFileSync(logPath, raw);
  execFileSync('sqlite3', [dbPath, `
    CREATE TABLE chat_sessions (
      id TEXT, source TEXT, title TEXT, status TEXT, workspace TEXT, session_file TEXT,
      last_message_role TEXT, message_count INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE chat_messages (session_id TEXT, role TEXT, streaming INTEGER, sort_order INTEGER);
    INSERT INTO chat_sessions VALUES ('local-1','local','智点产品方案与策略','idle','/Users/demo/.wpscomate/agent/workspace','', 'user', 1, 1, 1);
    INSERT INTO chat_messages VALUES ('local-1','user',0,1);
  `]);
  const result = await scanWpsComate({
    dbPath,
    logRoot: root,
    seenState: { loaded: true, localIds: new Set(), cloudIds: new Set(['37c2e8f1-b1c5-4c72-9a9c-e0fb0f858408']), errors: [] },
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync
  });
  assert.deepEqual(result.errors, []);
  const byTitle = Object.fromEntries(result.sessions.map((session) => [session.title, session]));
  assert.equal(byTitle['智点产品方案与策略'].projectName, '本地');
  assert.equal(byTitle['智点产品方案与策略'].source, 'wps-comate-local');
  assert.equal(byTitle['松山湖有什么好玩的'].projectName, '云端');
  assert.equal(byTitle['松山湖有什么好玩的'].status, 'completed_seen');
  assert.equal(byTitle['推送AI埋点到德谱平台'].status, 'completed_unseen');
  assert.equal(byTitle['进行中'].status, 'running');
  assert.equal(byTitle['不应采用这段正文'], undefined);
});

test('WPS Comate prefers the current client-state seen sets over the stale WebKit copy', async () => {
  const seen = await loadComateSeenState({
    webkitRoot: path.join(os.tmpdir(), 'comate-webkit-missing'),
    stateDbPath: '/tmp/client-state.db',
    existsSync: (target) => target === '/tmp/client-state.db',
    runCommand: async (_command, args) => ({
      ok: true,
      stdout: args.at(-1).includes('local_state')
        ? `seen-cloud-ids${String.fromCharCode(31)}["cloud-new"]\nseen-local-app-ids${String.fromCharCode(31)}["local-new"]\n`
        : `old-task-seen-cloud-ids${String.fromCharCode(31)}${Buffer.from('["cloud-old"]', 'utf8').toString('hex')}\n`
    })
  });
  assert.deepEqual([...seen.cloudIds], ['cloud-new']);
  assert.deepEqual([...seen.localIds], ['local-new']);
  assert.equal(seen.loaded, true);
});
