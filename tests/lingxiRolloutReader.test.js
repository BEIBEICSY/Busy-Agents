import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLingxiRolloutState, applyLingxiRolloutLine, lingxiRecordFromRollout, loadLingxiRolloutRecords } from '../src/server/lingxiRolloutReader.js';
import { buildLingxiSessions, buildLingxiTelemetryRecords, extractLingxiBackgroundCompletions, scanWpsLingxi } from '../src/server/wpsLingxiSessionScanner.js';
import { selectSessions, statusLabelFor } from '../public/dashboardModel.js';

const now = new Date('2026-11-03T14:10:00Z');
const base = now.getTime() - 60_000;
const group = '12075370420961417';
function frame(type, offset, content = {}, extra = {}) {
  return JSON.stringify({ id: `event-${offset}`, session_id: '12345', group_id: group,
    type, content: { group_id: group, ...content }, status: 0, create_time: base + offset, ...extra });
}
function parse(lines) {
  const state = createLingxiRolloutState('12345');
  lines.forEach(line => applyLingxiRolloutLine(state, line));
  return lingxiRecordFromRollout(state);
}
const input = frame('user.input', 1, { AgentInput: { text: '深圳游玩问题', files: [{ content: 'PRIVATE FILE BODY' }] } });

test('new Lingxi durable root events prove execution and preserve the root completion clock', () => {
  assert.equal(parse([input]), null);
  assert.equal(parse([frame('run.start', 2)]), null);
  const longInput = frame('user.input', 1, { AgentInput: { text: 'PRIVATE '.repeat(1000) } });
  const longTask = parse([longInput, frame('run.start', 2), frame('run.end', 3)]);
  assert.equal(longTask.status, 'completed');
  assert.doesNotMatch(JSON.stringify(longTask), /PRIVATE/);
  const running = parse([input, frame('run.start', 2), frame('component.end', 3, { full_content: 'PRIVATE ASSISTANT BODY' })]);
  assert.equal(running.status, 'Running');
  assert.equal(running.ended_at, 0);
  const record = parse([input, frame('run.start', 2), frame('component.end', 3), frame('run.end', 4)]);
  assert.equal(record.status, 'completed');
  assert.equal(record.session_title, '深圳游玩问题');
  assert.equal(record.ended_at, base + 4);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE|full_content|AgentInput/);
  const [session] = buildLingxiSessions([record], { now });
  assert.equal(session.statusFacts.executionPhase, 'succeeded');
  assert.equal(session.statusFacts.viewState, 'indeterminate');
  assert.equal(session.endedAt, new Date(base + 4).toISOString());
  assert.equal(statusLabelFor(session), '已完成');
  assert.equal(selectSessions([session], 'ended_today', '', now).length, 1);
});

test('waiting clears on resolution; subsequent root runs cannot inherit stale ends', () => {
  const state = createLingxiRolloutState('12345');
  [input, frame('run.start', 2), frame('component.start', 3, { id: 'ask', type: 'c_ask_user_question' })]
    .forEach(line => applyLingxiRolloutLine(state, line));
  assert.equal(lingxiRecordFromRollout(state).hasUnresolvedInteraction, true);
  applyLingxiRolloutLine(state, frame('component.end', 4, { id: 'ask' }));
  assert.equal(lingxiRecordFromRollout(state).status, 'Running');
  applyLingxiRolloutLine(state, frame('run.end', 5));
  assert.equal(lingxiRecordFromRollout(state).status, 'completed');
  const next = '12075370420961418';
  applyLingxiRolloutLine(state, frame('run.start', 6, { group_id: next }));
  applyLingxiRolloutLine(state, frame('run.end', 7)); // Late previous-run frame.
  assert.equal(lingxiRecordFromRollout(state).status, 'Running');
  assert.equal(lingxiRecordFromRollout(state).ended_at, 0);
  applyLingxiRolloutLine(state, frame('run.start', 2)); // Old start cannot rewind state.
  assert.equal(state.group, next);
});

test('root failures, cancellation, exclusions and partial records are handled conservatively', () => {
  assert.equal(parse([input, frame('run.start', 2), frame('error', 3, { code: 'run_error' }), frame('run.end', 4)]).status, 'failed');
  assert.equal(parse([input, frame('run.start', 2), frame('error', 3, { code: 'invalid_run_event' }), frame('run.end', 4)]).status, 'completed');
  assert.equal(parse([input, frame('run.start', 2), frame('force.stop', 3)]).status, 'failed');
  assert.equal(parse([input, frame('run.start', 2), frame('session.archived', 3)]), null);
  assert.equal(parse([input, frame('run.start', 2, { parent_session_id: 'parent' })]), null);
  assert.equal(parse([input, frame('run.start', 2), '{"type":"run.end",']).status, 'Running');
  assert.equal(parse([frame('run.end', 1)]), null);
});

test('durable execution outranks stale cache state but can retain trustworthy native viewing metadata', () => {
  const done = parse([input, frame('run.start', 2), frame('run.end', 4)]);
  const cache = { session_id: '12345', session_title: '客户端自动标题', read_status: 'read',
    update_time: base + 8, _cacheObservedAt: base + 8, _lingxiSource: 'session-cache' };
  const [seen] = buildLingxiSessions([done, cache], { now });
  assert.equal(seen.title, '客户端自动标题');
  assert.equal(seen.status, 'completed_seen');
  const running = parse([input, frame('run.start', 10)]);
  const [active] = buildLingxiSessions([running, { ...cache, status: 'completed', update_time: base + 20 }], { now });
  assert.equal(active.status, 'running');
  assert.equal(active.endedAt, '');
  assert.equal(active.statusFacts.viewState, 'indeterminate');
});

test('a later run of the same Lingxi task outranks the first completed session', () => {
  const firstDone = parse([input, frame('run.start', 2), frame('run.end', 4)]);
  const secondRunning = buildLingxiTelemetryRecords([{
    name: 'lxai_claw_createrequest',
    remoteTime: base + 10,
    data: { session_id: '12345', request_way: 'main' }
  }]);
  const [running] = buildLingxiSessions([firstDone, ...secondRunning], { now });
  assert.equal(running.status, 'running');
  assert.equal(running.endedAt, '');
  assert.equal(running.statusFacts.nativeStatus, 'createrequest/main');

  const secondDone = buildLingxiTelemetryRecords([{
    name: 'lxai_claw_requestresult',
    remoteTime: base + 12,
    data: { session_id: '12345', result: 'success', stop_reason: 'finish' }
  }]);
  const [completed] = buildLingxiSessions([firstDone, ...secondRunning, ...secondDone], { now });
  assert.equal(completed.statusFacts.executionPhase, 'succeeded');
  assert.equal(completed.endedAt, new Date(base + 12).toISOString());

  const laterRollout = parse([input, frame('run.start', 20), frame('run.end', 22)]);
  const [rolloutWins] = buildLingxiSessions([...secondDone, laterRollout], { now });
  assert.equal(rolloutWins.statusFacts.nativeStatus, 'app-server/run.end');
  assert.equal(rolloutWins.endedAt, new Date(base + 22).toISOString());
});

test('native-only installation is discovered without old web caches and without reading whole chat bodies', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-rollout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'accounts');
  function writeSession(id, lines, meta) {
    const dir = path.join(stateRoot, '67890', 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout.jsonl'), lines.join('\n'));
    if (meta) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  }
  writeSession('12345', [input, frame('run.start', 2), frame('run.end', 4)], { version: 1, read: { last_check: now.getTime() } });
  writeSession('55555', [frame('run.start', 2, {}, { session_id: '55555' })], { archived: true });
  writeSession('99999', ['broken JSON'], {});
  const result = await scanWpsLingxi({ appServerStateRoot: stateRoot,
    cacheRoot: path.join(root, 'missing-cache'), levelDbRoot: path.join(root, 'missing-leveldb'), now });
  assert.deepEqual(result.errors, []);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, 'wps-lingxi:12345');
  assert.equal(result.sessions[0].statusFacts.viewState, 'indeterminate'); // last_check is not a read mark.
  const large = await loadLingxiRolloutRecords({ appServerStateRoot: stateRoot, now, maxRolloutBytes: 1 });
  assert.equal(large.records.length, 0);
  assert.ok(large.errors.length > 0);
  assert.deepEqual(await loadLingxiRolloutRecords({ appServerStateRoot: path.join(root, 'absent') }), { records: [], errors: [] });
});

function lingxiDetailCacheName(sessionId) {
  const key = `1/0/https://lingxi.wps.cn/api/public/v1/sessions/${sessionId}`;
  return `${createHash('sha1').update(key).digest().subarray(0, 8).reverse().toString('hex')}_0`;
}

test('WPS Lingxi reads the business partition session detail for the sidebar read dot', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheDir = path.join(root, 'partitions/lingxi-business-v2-test/Cache/Cache_Data');
  fs.mkdirSync(cacheDir, { recursive: true });
  const endedAt = now.getTime();
  function writeDetail(sessionId, title, readStatus) {
    const filePath = path.join(cacheDir, lingxiDetailCacheName(sessionId));
    fs.writeFileSync(filePath, JSON.stringify({
      data: {
        session_id: sessionId,
        session_title: title,
        status: 'finished',
        read_status: readStatus,
        update_time: Math.floor(endedAt / 1000)
      }
    }));
    fs.utimesSync(filePath, endedAt / 1000, endedAt / 1000);
  }
  writeDetail('12092035339583634', '侧栏未读标题', 'completed');
  writeDetail('12091580509585636', '侧栏已读标题', 'completed');
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(logDir);
  const stamp = new Date(endedAt + 60_000).toISOString();
  fs.writeFileSync(path.join(logDir, 'app.log'), [
    `{"time":"${stamp}","event":"request_completed","method":"session/list","result":"{\\"sessions\\":[{\\"session_id\\":\\"12092035339583634\\",\\"read_status\\":\\"completed\\"},{\\"session_id\\":\\"12091580509585636\\",\\"read_status\\":\\"read\\"}]}"}`
  ].join('\n'));
  const rollout = (sessionId, title) => ({
    session_id: sessionId,
    session_title: title,
    update_time: endedAt,
    ended_at: endedAt,
    status: 'completed',
    hasExecution: true,
    native_status: 'app-server/run.end',
    _lingxiSource: 'app-server-rollout'
  });

  const result = await scanWpsLingxi({
    cacheRoot: path.join(root, 'missing-cache'),
    levelDbRoot: path.join(root, 'missing-leveldb'),
    appServerStateRoot: path.join(root, 'missing-state'),
    partitionsRoot: path.join(root, 'partitions'),
    logRoot: logDir,
    now,
    loadRolloutRecords: async () => ({
      records: [rollout('12092035339583634', '用户原话未读'), rollout('12091580509585636', '用户原话已读')],
      errors: []
    })
  });
  const byId = new Map(result.sessions.map((session) => [session.id, session]));

  assert.deepEqual(result.errors, []);
  assert.equal(byId.get('wps-lingxi:12092035339583634').title, '侧栏未读标题');
  assert.equal(byId.get('wps-lingxi:12092035339583634').status, 'completed_unseen');
  assert.equal(byId.get('wps-lingxi:12091580509585636').title, '侧栏已读标题');
  assert.equal(byId.get('wps-lingxi:12091580509585636').status, 'completed_seen');
});

test('a Lingxi run that finishes after leaving the page closes without a requestresult', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-background-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const levelDb = path.join(root, 'leveldb');
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(levelDb);
  fs.mkdirSync(logDir);
  const started = base;
  const finished = base + 9000;
  const secret = '不要保留这段离开页面后的回答';
  fs.writeFileSync(path.join(levelDb, '000001.log'), JSON.stringify({
    name: 'lxai_claw_createrequest',
    remoteTime: started,
    data: { session_id: '12092737757249752', request_way: 'main', mode: 'normal', reply: secret }
  }));
  const finishStamp = new Date(finished).toISOString();
  const listStamp = new Date(finished + 1000).toISOString();
  fs.writeFileSync(path.join(logDir, 'app.log'), [
    JSON.stringify({
      time: finishStamp,
      timestamp: finished,
      event: 'background_session_notify',
      step: 'status_finished',
      sessionId: '12092737757249752',
      isForeground: false
    }),
    JSON.stringify({
      time: finishStamp,
      timestamp: finished,
      event: 'background_session_notify',
      step: 'messages_completion_parsed',
      sessionId: '12092737757249752',
      terminalEvent: 'run.end',
      inputText: secret
    }),
    JSON.stringify({
      time: finishStamp,
      timestamp: finished + 200,
      event: 'background_session_notify',
      step: 'notify_completion_show',
      sessionId: '12092737757249752',
      isFailed: false,
      readStatus: 'completed'
    }),
    JSON.stringify({
      time: listStamp,
      timestamp: finished + 1000,
      event: 'request_completed',
      method: 'session/list',
      result: JSON.stringify({
        sessions: [{ session_id: '12092737757249752', title: '松山湖游玩推荐', read_status: 'completed' }]
      })
    })
  ].join('\n'));

  const result = await scanWpsLingxi({
    cacheRoot: path.join(root, 'missing-cache'),
    levelDbRoot: levelDb,
    appServerStateRoot: path.join(root, 'missing-state'),
    partitionsRoot: path.join(root, 'missing-partitions'),
    logRoot: logDir,
    now
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.sessions.length, 1);
  const session = result.sessions[0];
  assert.equal(session.id, 'wps-lingxi:12092737757249752');
  assert.equal(session.status, 'completed_unseen');
  assert.equal(session.endedAt, new Date(finished).toISOString());
  assert.equal(session.statusFacts.nativeStatus, 'background-notify/run.end/success');
  assert.equal(JSON.stringify(session).includes(secret), false);

  const laterStart = buildLingxiTelemetryRecords([{
    name: 'lxai_claw_createrequest',
    remoteTime: finished + 20_000,
    data: { session_id: '12092737757249752', request_way: 'main' }
  }]);
  const [stillRunning] = buildLingxiSessions([
    ...extractLingxiBackgroundCompletions(fs.readFileSync(path.join(logDir, 'app.log'), 'utf8')),
    ...laterStart
  ], { now });
  assert.equal(stillRunning.status, 'running');
  assert.equal(stillRunning.endedAt, '');

  const failedLog = JSON.stringify({
    timestamp: finished,
    event: 'background_session_notify',
    step: 'messages_completion_parsed',
    sessionId: '12092737757249752',
    terminalEvent: 'run.end'
  }) + '\n' + JSON.stringify({
    timestamp: finished + 100,
    event: 'background_session_notify',
    step: 'notify_completion_show',
    sessionId: '12092737757249752',
    isFailed: true
  });
  const [failed] = buildLingxiSessions([
    ...buildLingxiTelemetryRecords([{
      name: 'lxai_claw_createrequest',
      remoteTime: started,
      data: { session_id: '12092737757249752', request_way: 'main' }
    }]),
    ...extractLingxiBackgroundCompletions(failedLog)
  ], { now });
  assert.equal(failed.status, 'ended_abnormally');

  const unfinished = extractLingxiBackgroundCompletions(JSON.stringify({
    timestamp: finished,
    event: 'background_session_notify',
    step: 'status_finished',
    sessionId: '12092737757249752'
  }));
  assert.deepEqual(unfinished, []);
});


test('Lingxi newer explicit read detail supersedes old unread list without reviving stale dots', () => {
  const end = now.getTime() - 60000;
  const execution = { session_id: '12345', update_time: end, ended_at: end,
    status: 'completed', hasExecution: true, _lingxiSource: 'app-server-rollout' };
  const list = { session_id: '12345', update_time: end + 1000,
    _cacheObservedAt: end + 1000, read_status: 'completed', _lingxiSource: 'session-list' };
  const detail = { session_id: '12345', update_time: end - 1000,
    _cacheObservedAt: end + 20000, read_status: 'read', _lingxiSource: 'session-cache' };
  const status = records => buildLingxiSessions(records, { now })[0].status;
  assert.equal(status([execution, list, detail]), 'completed_seen');
  assert.equal(status([execution, { ...list, _cacheObservedAt: end + 30000 }, detail]), 'completed_unseen');
  assert.equal(status([execution, { ...list, read_status: 'read' },
    { ...detail, read_status: 'completed' }]), 'completed_seen');
  assert.equal(status([{ ...execution, update_time: end + 40000, ended_at: end + 40000 }, list, detail]), 'unknown');
});

test('Lingxi discovers log-only sessions before reading their title and read detail', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-log-detail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logDir = path.join(root, 'logs');
  const cacheDir = path.join(root, 'partitions/lingxi-business-v2-test/Cache/Cache_Data');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const sessionId = '12092737757249752';
  const finished = base + 9000;
  fs.writeFileSync(path.join(logDir, 'app.log'), [
    JSON.stringify({ time: new Date(finished).toISOString(), event: 'background_session_notify',
      step: 'messages_completion_parsed', sessionId, terminalEvent: 'run.end' }),
    JSON.stringify({ time: new Date(finished + 1000).toISOString(), event: 'request_completed',
      method: 'session/list', result: JSON.stringify({ sessions: [{ session_id: sessionId, read_status: 'completed' }] }) })
  ].join('\n'));
  const detail = path.join(cacheDir, lingxiDetailCacheName(sessionId));
  fs.writeFileSync(detail, JSON.stringify({ data: { session_id: sessionId,
    session_title: '松山湖游玩推荐', read_status: 'read', update_time: finished } }));
  fs.utimesSync(detail, (finished + 2000) / 1000, (finished + 2000) / 1000);
  const result = await scanWpsLingxi({ cacheRoot: path.join(root, 'missing-cache'),
    levelDbRoot: path.join(root, 'missing-leveldb'), appServerStateRoot: path.join(root, 'missing-state'),
    partitionsRoot: path.join(root, 'partitions'), logRoot: logDir, now });
  assert.deepEqual(result.errors, []);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].title, '松山湖游玩推荐');
  assert.equal(result.sessions[0].status, 'completed_seen');
  assert.equal(result.sessions[0].endedAt, new Date(finished).toISOString());
});
