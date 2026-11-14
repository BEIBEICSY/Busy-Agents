import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadCodexRuntimeStates, projectRuntimeMessage, runtimeStateFromMessage } from '../src/server/codexRuntimeReader.js';
import { buildCodexAppThreadSessions, parseCodexTurnRows, scanCodexThreads } from '../src/server/codexSessionScanner.js';

const now = Date.parse('2026-11-03T10:30:00Z');
function snapshot(flags = ['waitingOnApproval'], overrides = {}) {
  return {
    type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
    params: {
      conversationId: 'thread-a', hostId: 'local',
      change: { type: 'snapshot', conversationState: {
        id: 'thread-a', hostId: 'local', threadRuntimeStatus: { type: 'active', activeFlags: flags },
        turns: [{ turnId: 'turn-a', turnStartedAtMs: now - 1000, status: 'inProgress',
          items: [{ text: 'PRIVATE CHAT BODY', arguments: { token: 'PRIVATE TOOL ARGUMENT' } }] }],
        requests: [{ params: { command: 'PRIVATE COMMAND' } }],
        ...overrides
      } }
    }
  };
}
function session(runtime, turn = {}) {
  return buildCodexAppThreadSessions([
    { id: 'thread-a', displayTitle: '测试', cwd: '/tmp/demo', updatedAtMs: now, source: 'user' }
  ], [{ toolId: 'codex', process: { command: '/Applications/ChatGPT.app/codex app-server' } }], {
    now: new Date(now),
    turnStates: new Map([['thread-a', { turnId: 'turn-a', status: 'inProgress', startedAtMs: now - 1000, ...turn }]]),
    runtimeStates: new Map(runtime ? [['thread-a', runtime]] : [])
  })[0];
}

test('runtime projection skips transcripts, request contents and escaped strings', () => {
  const input = snapshot();
  input.params.change.conversationState.turns[0].items[0].text += ' \\" } ] { " unicode 中文';
  const projected = projectRuntimeMessage(JSON.stringify(input));
  const text = JSON.stringify(projected);
  assert.doesNotMatch(text, /PRIVATE|requests|arguments|token/);
  const runtime = runtimeStateFromMessage(projected, now);
  assert.equal(runtime.turnId, 'turn-a');
  assert.deepEqual(runtime.activeFlags, ['waitingOnApproval']);
  assert.throws(() => projectRuntimeMessage('{"type":'), /IPC/);
  assert.throws(() => projectRuntimeMessage('{}{}'), /Trailing/);
});

test('canonical history projects only turn metadata; wrong hosts and protocol versions are ignored', () => {
  const input = snapshot([], { turns: [], turnHistory: { history: { entitiesByKey: {
    old: { turnId: 'old', turnStartedAtMs: now - 5000, items: ['PRIVATE'] },
    new: { turnId: 'turn-a', turnStartedAtMs: now - 1000, params: { input: 'PRIVATE' } }
  } } } });
  assert.equal(runtimeStateFromMessage(projectRuntimeMessage(JSON.stringify(input)), now).turnId, 'turn-a');
  input.version++;
  assert.equal(runtimeStateFromMessage(input), null);
  input.version--;
  input.params.hostId = 'remote';
  assert.equal(runtimeStateFromMessage(input), null);
});

test('same-turn fresh approval and user-input flags override inProgress, and clear immediately', () => {
  for (const [flag, reason] of [['waitingOnApproval', '批准'], ['waitingOnUserInput', '回答']]) {
    const waiting = runtimeStateFromMessage(snapshot([flag]), now);
    assert.equal(session(waiting).status, 'needs_response');
    assert.match(session(waiting).statusReason, new RegExp(reason));
    assert.match(session(waiting).statusFacts.signalSource, /codex-desktop-runtime/);
    assert.equal(session({ ...waiting, activeFlags: [] }).status, 'running');
    assert.equal(session().status, 'running');
    assert.equal(session({ ...waiting, turnId: 'old-turn' }).status, 'running');
    assert.equal(session({ ...waiting, observedAtMs: now - 10_001 }).status, 'running');
    assert.equal(session({ ...waiting, observedAtMs: now + 2001 }).status, 'running');
    assert.equal(session({ ...waiting, type: 'idle' }).status, 'running');
    assert.equal(session(waiting, { status: 'interrupted' }).status, 'ended_abnormally');
    assert.notEqual(session(waiting, { status: 'completed' }).status, 'needs_response');
    assert.equal(session(waiting, { turnId: 'new-turn' }).status, 'running');
  }
});

test('SQLite turn parser retains native turn identity for runtime correlation', () => {
  const states = parseCodexTurnRows('thread-a\u001finProgress\u001f0\u001f1793701799\u001f0\u001fturn-a');
  assert.equal(states.get('thread-a').turnId, 'turn-a');
});

const stat = (socket = true, uid = process.getuid?.()) => ({
  uid, mode: 0o700, isSocket: () => socket, isDirectory: () => true
});
function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function fakeConnection(onSend) {
  const sent = [];
  const socket = new EventEmitter();
  Object.assign(socket, {
    writable: true,
    write(bytes) {
      const message = JSON.parse(bytes.subarray(4).toString());
      sent.push(message);
      queueMicrotask(() => onSend(message, socket));
    },
    end() { this.writable = false; },
    destroySoon() { queueMicrotask(() => this.emit('close')); }
  });
  return { sent, connect: () => { queueMicrotask(() => socket.emit('connect')); return socket; } };
}

test('IPC observer handles fragmented frames, unregisters observation and never controls a thread', async () => {
  const { sent, connect } = fakeConnection((message, socket) => {
    if (message.method === 'initialize') socket.emit('data', frame({
      type: 'response', requestId: message.requestId, resultType: 'success', result: { clientId: 'observer' }
    }));
    if (message.params?.following === true) {
      const data = frame(snapshot());
      for (let i = 0; i < data.length; i += 7) socket.emit('data', data.subarray(i, i + 7));
    }
  });
  const states = await loadCodexRuntimeStates(['thread-a'], { connect, lstatSync: () => stat(), runtimeNow: () => now });
  assert.equal(states.get('thread-a').activeFlags[0], 'waitingOnApproval');
  assert.deepEqual(sent.map((m) => m.method), ['initialize', 'thread-stream-following-changed', 'thread-stream-following-changed']);
  assert.deepEqual(sent.slice(1).map((m) => m.params.following), [true, false]);
});

test('unavailable, untrusted, timed-out or oversized IPC sources cannot supply stale waiting state', async () => {
  for (const lstatSync of [() => { throw new Error('missing'); }, () => stat(true, -1), () => ({ ...stat(), mode: 0o777 })]) {
    const states = await loadCodexRuntimeStates(['thread-a'], { lstatSync, connect: () => { throw new Error('must not connect'); } });
    assert.equal(states.size, 0);
  }
  const quiet = fakeConnection(() => {});
  assert.equal((await loadCodexRuntimeStates(['thread-a'], { ...quiet, lstatSync: () => stat(), timeoutMs: 10 })).size, 0);
  const oversized = fakeConnection((message, socket) => {
    const data = Buffer.alloc(4); data.writeUInt32LE(9999); socket.emit('data', data);
  });
  assert.equal((await loadCodexRuntimeStates(['thread-a'], { ...oversized, lstatSync: () => stat(), maxFrameBytes: 100 })).size, 0);
});

test('Codex scanner queries runtime for active candidates and isolates runtime failures', async () => {
  let queried;
  const options = {
    now: new Date(now), namesById: new Map(), unreadState: { available: false }, existsSync: () => true,
    runCommand: async (cmd, args) => ({ ok: true, stdout: args.at(-1).includes('FROM threads')
      ? `thread-a\u001f测试\u001f/tmp/demo\u001f${now}\u001fuser`
      : `thread-a\u001finProgress\u001f0\u001f${now / 1000}\u001f0\u001fturn-a` }),
    loadRuntimeStates: async (ids) => { queried = ids; throw new Error('disconnected'); }
  };
  const result = await scanCodexThreads(options);
  assert.deepEqual(queried, ['thread-a']);
  assert.equal(result.threads.length, 1);
  assert.equal(result.runtimeStates.size, 0);
  assert.deepEqual(result.errors, []);
});


test('async ask_user questions supplement absent flags without retaining questions or replies', () => {
  const turn = { turnId: 'turn-a', turnStartedAtMs: now - 1000, status: 'inProgress', items: [
    { type: 'agentMessage', id: 'question-message', text: 'PRIVATE MESSAGE', questions: [
      { question: 'PRIVATE QUESTION', options: ['PRIVATE OPTION'] }
    ] }
  ] };
  const read = (t = turn, other = {}) => {
    const projected = projectRuntimeMessage(JSON.stringify(snapshot([], { turns: [t], ...other })));
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|text|options|question"/);
    return runtimeStateFromMessage(projected, now);
  };
  const waiting = read();
  assert.deepEqual(waiting.activeFlags, ['waitingOnUserInput']);
  assert.equal(session(waiting).status, 'needs_response');
  assert.match(session(waiting).statusReason, /回答/);
  assert.equal(session(read({ ...turn, items: [] })).status, 'running');
  for (const reply of [{ type: 'userMessage', content: 'PRIVATE REPLY' },
    { type: 'steeringUserMessage', status: 'accepted', input: 'PRIVATE REPLY' }]) {
    assert.equal(session(read({ ...turn, items: [...turn.items, reply] })).status, 'running');
    assert.equal(session(read({ ...turn, items: [...turn.items, reply, ...turn.items] })).status, 'needs_response');
  }
  assert.equal(session(read({ ...turn, items: [...turn.items,
    { type: 'steeringUserMessage', status: 'pending' }] })).status, 'needs_response');
  assert.equal(session(read({ ...turn, status: 'completed' })).status, 'running');
  assert.notEqual(session(waiting, { status: 'completed' }).status, 'needs_response');
  assert.equal(session(waiting, { turnId: 'new-turn' }).status, 'running');
  assert.equal(session(read(turn, { turnHistory: { history: { entitiesByKey: {
    newer: { turnId: 'new-turn', turnStartedAtMs: now, status: 'inProgress', items: [] }
  } } } })).status, 'running');
  assert.equal(session(read({ ...turn, items: [{ type: 'tool', id: 'x', questions: [{}] }] })).status, 'running');
  assert.equal(session(read(turn, { turns: [], turnHistory: { history: { entitiesByKey: { current: turn } } } })).status, 'needs_response');
});
