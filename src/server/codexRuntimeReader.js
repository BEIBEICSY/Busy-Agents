import fs from 'node:fs';
import { projectJsonMetadata } from './jsonMetadata.js';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// The desktop IPC has no metadata-only snapshot endpoint. Project these fields
// directly from JSON; skip transcripts, tool arguments and permission contents.
// Never deserialize or persist the complete conversation snapshot.
// Keep only item kinds, identities and question presence. Never retain the
// question/options or reply text. Async questions do not set activeFlags.
const turnFields = {
  turnId: true, status: true, turnStartedAtMs: true,
  items: { '*': { type: true, id: true, status: true, questions: { '*': { id: true } } } }
};
const stateFields = {
  id: true, hostId: true,
  threadRuntimeStatus: { type: true, activeFlags: { '*': true } },
  turns: { '*': turnFields },
  turnHistory: { history: { entitiesByKey: { '*': turnFields } } }
};
const messageFields = {
  type: true, method: true, requestId: true, resultType: true, version: true,
  sourceClientId: true, result: { clientId: true },
  params: {
    conversationId: true, hostId: true,
    change: { type: true, conversationState: stateFields }
  }
};

export function projectRuntimeMessage(json) {
  return projectJsonMetadata(json, messageFields);
}

export function runtimeStateFromMessage(message, observedAtMs = Date.now()) {
  if (message.type !== 'broadcast' || message.method !== 'thread-stream-state-changed'
    || message.version !== 11 || message.params?.hostId !== 'local'
    || message.params?.change?.type !== 'snapshot') return null;
  const state = message.params.change.conversationState;
  const threadId = message.params.conversationId;
  if (!state || state.id !== threadId || (state.hostId && state.hostId !== 'local')) return null;
  const status = state.threadRuntimeStatus;
  if (!status || !['active', 'idle', 'notLoaded', 'systemError'].includes(status.type)) return null;
  const turns = [...(state.turns || []), ...Object.values(state.turnHistory?.history?.entitiesByKey || {})];
  const latest = turns.filter((turn) => turn?.turnId && Number.isFinite(turn.turnStartedAtMs))
    .sort((a, b) => b.turnStartedAtMs - a.turnStartedAtMs)[0];
  return {
    threadId, turnId: latest?.turnId || '', type: status.type,
    activeFlags: [...new Set([
      ...(Array.isArray(status.activeFlags)
        ? status.activeFlags.filter((flag) => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) : []),
      ...(hasPendingAsyncQuestion(latest) ? ['waitingOnUserInput'] : [])
    ])],
    observedAtMs
  };
}

// Only the current in-progress turn can supply async input. A later user
// message invalidates earlier questions conservatively: matching reply text
// would require reading user content. New questions after it remain pending.
function hasPendingAsyncQuestion(turn) {
  if (turn?.status !== 'inProgress' || !Array.isArray(turn.items)) return false;
  let pending = false;
  for (const item of turn.items) {
    if (item?.type === 'userMessage'
      || (item?.type === 'steeringUserMessage' && item.status === 'accepted')) pending = false;
    if (item?.type === 'agentMessage' && typeof item.id === 'string'
      && Array.isArray(item.questions) && item.questions.length > 0) pending = true;
  }
  return pending;
}

// Connect only to an existing, same-user desktop router. Do not start an
// app-server, claim ownership, resume a thread, or send approval responses.
export async function loadCodexRuntimeStates(threadIds, {
  socketPath = path.join(os.homedir(), '.codex', 'ipc', 'ipc.sock'),
  timeoutMs = 1500,
  maxFrameBytes = 32 * 1024 * 1024,
  lstatSync = fs.lstatSync,
  connect = net.createConnection,
  runtimeNow = Date.now
} = {}) {
  const states = new Map();
  const wanted = new Set(threadIds);
  if (!wanted.size) return states;
  try {
    const socketStat = lstatSync(socketPath);
    const directory = lstatSync(path.dirname(socketPath));
    if (!socketStat.isSocket() || socketStat.uid !== process.getuid?.()
      || !directory.isDirectory() || directory.uid !== socketStat.uid || (directory.mode & 0o022)) return states;
  } catch { return states; }

  return new Promise((resolve) => {
    const socket = connect({ path: socketPath });
    let clientId = '';
    let buffer = Buffer.alloc(0);
    let settled = false;
    const initializeId = randomUUID();
    const send = (message) => {
      const body = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    };
    const following = (threadId, follow) => send({
      type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: clientId, params: { conversationId: threadId, hostId: 'local', following: follow }
    });
    const finish = (valid = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (clientId && socket.writable) for (const id of wanted) following(id, false);
      buffer = Buffer.alloc(0);
      socket.end();
      socket.destroySoon();
      resolve(valid ? states : new Map());
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    socket.on('connect', () => send({
      type: 'request', method: 'initialize', requestId: initializeId,
      params: { clientType: 'ai-task-radar-observer' }
    }));
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (!length || length > maxFrameBytes) throw new Error('Unsupported IPC frame');
          if (buffer.length < length + 4) break;
          const message = projectRuntimeMessage(buffer.subarray(4, length + 4).toString('utf8'));
          buffer = buffer.subarray(length + 4);
          if (message.requestId === initializeId && message.resultType === 'success' && message.result?.clientId) {
            clientId = message.result.clientId;
            for (const id of wanted) following(id, true);
          }
          const state = runtimeStateFromMessage(message, runtimeNow());
          if (state && wanted.has(state.threadId)) states.set(state.threadId, state);
          // This observer never claims it can handle requests from other clients.
          if (message.type === 'client-discovery-request') send({
            type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false }
          });
          if (states.size === wanted.size) { finish(); return; }
        }
      } catch { finish(false); }
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish());
  });
}
