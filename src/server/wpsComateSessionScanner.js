import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand as defaultRunCommand } from './shell.js';
import { withStatusFacts } from './statusModel.js';

const FIELD_SEPARATOR = '\u001f';
const DEFAULT_DB_PATH = path.join(os.homedir(), '.wpscomate/data/chat_history.db');
const DEFAULT_LOG_ROOT = path.join(os.homedir(), '.wpscomate/agent/logs');
const DEFAULT_STATE_DB_PATH = path.join(os.homedir(), '.wpscomate/data/client-state.db');
const CLOUD_START = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\]\[FORCE_LOG\] \[cloud\]\[chat\] session=([0-9a-f-]{36}) start body_len=\d+ text\(len=\d+\)="([^"\\]{1,80})"/g;
const CLOUD_DONE = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\]\[FORCE_LOG\] \[cloud\]\[chat\] session=([0-9a-f-]{36}) sse_complete reason=([A-Za-z0-9_-]+)/g;
const CLOUD_NOTICE = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\]\[FORCE_LOG\] \[notify\]\[FE\] send_notify \| route=\/cloud\/task\/([0-9a-f-]{36}) body=【([^】]{1,80})】(任务已完成，请点击查看|需要您提供更多的信息，请点击处理)/g;
const DEFAULT_WEBKIT_ROOT = path.join(
  os.homedir(),
  'Library/WebKit/cn.wpscomate.comate-agent/WebsiteData'
);

function timestampMs(value) {
  const number = Number(value || 0);
  if (Number.isFinite(number) && number > 0) {
    return number < 100000000000 ? number * 1000 : number;
  }
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseComateSessionRows(raw) {
  return String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, source, titleHex, status, workspaceHex, sessionFileHex, lastMessageRole, messageCount, createdAtMs, updatedAtMs, streaming, userMessageCount] = line.split(FIELD_SEPARATOR);
      if (!id) return null;
      return {
        id,
        source,
        title: Buffer.from(titleHex || '', 'hex').toString('utf8'),
        status,
        workspace: Buffer.from(workspaceHex || '', 'hex').toString('utf8'),
        sessionFile: Buffer.from(sessionFileHex || '', 'hex').toString('utf8'),
        lastMessageRole,
        messageCount: Number(messageCount || 0),
        createdAtMs: timestampMs(createdAtMs),
        updatedAtMs: timestampMs(updatedAtMs),
        streaming: Number(streaming || 0) === 1,
        userMessageCount: Number(userMessageCount || 0)
      };
    })
    .filter(Boolean);
}

function normalizedMessage(item) {
  return item?.message && typeof item.message === 'object' ? item.message : item;
}

function messageContent(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (Array.isArray(message?.content_blocks)) return message.content_blocks;
  if (Array.isArray(message?.contentBlocks)) return message.contentBlocks;
  return [];
}

function toolCallName(block) {
  return String(block?.name || block?.toolName || block?.tool_name || '').trim().toLowerCase();
}

function toolCallId(block) {
  return String(block?.id || block?.toolCallId || block?.tool_call_id || '').trim();
}

export function parseComateTranscript(raw) {
  const messages = String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return normalizedMessage(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const unresolvedAsks = new Set();
  let hasExecution = false;
  let latestRootStopReason = '';
  let explicitFailure = '';

  for (const message of messages) {
    const role = String(message.role || '').toLowerCase();
    if (role === 'user') {
      hasExecution = true;
      unresolvedAsks.clear();
    }

    const resultId = String(message.toolCallId || message.tool_call_id || '').trim();
    if (resultId) unresolvedAsks.delete(resultId);
    if (message.isError === true && /session|run|root/i.test(String(message.scope || ''))) {
      explicitFailure = '根任务执行失败';
    }

    if (role === 'assistant') {
      const stopReason = String(message.stopReason || message.stop_reason || '').trim();
      if (stopReason) latestRootStopReason = stopReason;

      for (const block of messageContent(message)) {
        const name = toolCallName(block);
        if (name === 'askuser' || name === 'askuserquestion') {
          unresolvedAsks.add(toolCallId(block) || `ask:${unresolvedAsks.size}`);
        }
      }
    }

    const eventStatus = String(message.status || message.type || '').toLowerCase();
    if (['failed', 'error', 'cancelled', 'canceled', 'aborted', 'interrupted'].includes(eventStatus)) {
      explicitFailure = eventStatus;
      hasExecution = true;
    }
  }

  return {
    hasExecution,
    hasUnresolvedAsk: unresolvedAsks.size > 0,
    latestRootStopReason,
    explicitFailure,
    messageCount: messages.length
  };
}

function decodeSeenValue(encoded) {
  const buffer = Buffer.from(encoded || '', 'hex');
  const candidates = [buffer.toString('utf16le'), buffer.toString('utf8')];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.replace(/^\uFEFF/, '').replace(/\0+$/g, ''));
      return Array.isArray(value) ? value.map(String) : [];
    } catch {
      // Try the next encoding.
    }
  }
  return [];
}

export function parseComateClientStateSeen(raw) {
  const localIds = new Set();
  const cloudIds = new Set();
  let sawLocal = false;
  let sawCloud = false;
  for (const line of String(raw || '').split('\n')) {
    const tab = line.indexOf(FIELD_SEPARATOR);
    if (tab < 0) continue;
    const key = line.slice(0, tab);
    const json = line.slice(tab + 1);
    let ids = [];
    try {
      ids = JSON.parse(json);
    } catch {
      continue;
    }
    if (!Array.isArray(ids)) continue;
    if (key.includes('cloud')) {
      sawCloud = true;
      ids.forEach((id) => cloudIds.add(String(id)));
    } else {
      sawLocal = true;
      ids.forEach((id) => localIds.add(String(id)));
    }
  }
  return { sawLocal, sawCloud, localIds, cloudIds };
}

export function parseComateSeenRows(raw) {
  const localIds = new Set();
  const cloudIds = new Set();
  for (const line of String(raw || '').split('\n')) {
    const [key, encoded] = line.split(FIELD_SEPARATOR);
    if (!key || !encoded) continue;
    const target = key.includes('cloud') ? cloudIds : localIds;
    decodeSeenValue(encoded).forEach((id) => target.add(id));
  }
  return { localIds, cloudIds };
}

function findLocalStorageDatabases(root, fsImpl = fs, depth = 0) {
  if (depth > 6) return [];
  let entries;
  try {
    entries = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const databases = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isFile() && entry.name === 'localstorage.sqlite3') databases.push(target);
    else if (entry.isDirectory()) databases.push(...findLocalStorageDatabases(target, fsImpl, depth + 1));
  }
  return databases;
}

export async function loadComateSeenState({
  webkitRoot = DEFAULT_WEBKIT_ROOT,
  stateDbPath = DEFAULT_STATE_DB_PATH,
  existsSync = fs.existsSync,
  fsImpl = fs,
  runCommand = defaultRunCommand
} = {}) {
  const databases = findLocalStorageDatabases(webkitRoot, fsImpl);
  const localIds = new Set();
  const cloudIds = new Set();
  const errors = [];
  let loaded = false;
  for (const dbPath of databases) {
    const result = await runCommand('sqlite3', [
      '-separator', FIELD_SEPARATOR, dbPath,
      "SELECT key, hex(value) FROM ItemTable WHERE key LIKE '%task-seen%';"
    ], { timeoutMs: 3000 });
    if (!result.ok) {
      errors.push(result.error || result.stderr);
      continue;
    }
    loaded = true;
    const parsed = parseComateSeenRows(result.stdout);
    parsed.localIds.forEach((id) => localIds.add(id));
    parsed.cloudIds.forEach((id) => cloudIds.add(id));
  }

  if (stateDbPath && existsSync(stateDbPath)) {
    const state = await runCommand('sqlite3', [
      '-separator', FIELD_SEPARATOR, stateDbPath,
      "SELECT key, value_json FROM local_state WHERE namespace = 'task-list' AND deleted = 0 AND key IN ('seen-cloud-ids', 'seen-local-app-ids');"
    ], { timeoutMs: 3000 });
    if (!state.ok) errors.push(state.error || state.stderr);
    else {
      const current = parseComateClientStateSeen(state.stdout);
      if (current.sawLocal) {
        loaded = true;
        localIds.clear();
        current.localIds.forEach((id) => localIds.add(id));
      }
      if (current.sawCloud) {
        loaded = true;
        cloudIds.clear();
        current.cloudIds.forEach((id) => cloudIds.add(id));
      }
    }
  }
  return { loaded, localIds, cloudIds, errors };
}

function logTimeMs(value) {
  const parsed = new Date(String(value || '').replace(' ', 'T')).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function cloudItem(items, id) {
  if (!items.has(id)) {
    items.set(id, {
      id, title: '', titleFromNotice: false, phase: '', eventAt: 0, updatedAtMs: 0, endedAtMs: 0, failureReason: ''
    });
  }
  return items.get(id);
}

function markCloud(item, time, phase, ended) {
  if (!time || time < item.eventAt) return;
  item.eventAt = time;
  item.phase = phase;
  item.updatedAtMs = time;
  item.endedAtMs = ended ? time : 0;
}

export function parseComateCloudLog(raw) {
  const items = new Map();
  for (const match of String(raw || '').matchAll(CLOUD_START)) {
    const item = cloudItem(items, match[2]);
    const title = match[3];
    markCloud(item, logTimeMs(match[1]), 'active', false);
    if (!item.titleFromNotice && title && !title.includes('<') && !title.includes('{')) item.title = title;
  }
  for (const match of String(raw || '').matchAll(CLOUD_DONE)) {
    const item = cloudItem(items, match[2]);
    const failed = match[3] !== 'eof';
    markCloud(item, logTimeMs(match[1]), failed ? 'failed' : 'succeeded', true);
    if (failed) item.failureReason = match[3];
  }
  for (const match of String(raw || '').matchAll(CLOUD_NOTICE)) {
    const item = cloudItem(items, match[2]);
    const waiting = match[4].startsWith('需要您');
    markCloud(item, logTimeMs(match[1]), waiting ? 'waiting_user' : 'succeeded', !waiting);
    item.title = match[3];
    item.titleFromNotice = true;
  }
  return [...items.values()].filter((item) => item.title && item.phase);
}

function readCloudLog(logRoot, { existsSync = fs.existsSync, readdirSync = fs.readdirSync, readFileSync = fs.readFileSync, statSync = fs.statSync } = {}) {
  if (!logRoot || !existsSync(logRoot)) return [];
  let names = [];
  try {
    names = readdirSync(logRoot).filter((name) => name === 'app.log' || /^app\.log\.\d{4}-\d{2}-\d{2}/.test(name));
  } catch {
    return [];
  }
  const chunks = [];
  for (const name of names.sort()) {
    const target = path.join(logRoot, name);
    let size = 0;
    try {
      size = statSync(target).size;
    } catch {
      continue;
    }
    if (!size || size > 8 * 1024 * 1024) continue;
    try {
      chunks.push(readFileSync(target, 'utf8'));
    } catch {
      // A rotated log that cannot be read does not hide the current one.
    }
  }
  return parseComateCloudLog(chunks.join('\n'));
}

function cloudRecord(item) {
  return {
    id: item.id,
    source: 'cloud',
    title: item.title,
    status: item.phase === 'active' ? 'running' : 'idle',
    workspace: '',
    sessionFile: '',
    userMessageCount: 1,
    streaming: item.phase === 'active',
    updatedAtMs: item.updatedAtMs,
    endedAtMs: item.endedAtMs,
    createdAtMs: item.updatedAtMs,
    failureReason: item.failureReason
  };
}

function cloudTranscript(item) {
  return {
    hasExecution: true,
    hasUnresolvedAsk: item.phase === 'waiting_user',
    latestRootStopReason: item.phase === 'succeeded' ? 'end_turn' : '',
    explicitFailure: item.phase === 'failed' ? (item.failureReason || '云端任务失败') : '',
    messageCount: 1
  };
}

function workspacePath(value) {
  const raw = String(value || '').trim();
  if (raw.startsWith('/')) return raw;
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.path || parsed.cwd || parsed.workspacePath || '').trim();
  } catch {
    return '';
  }
}

export function buildComateSession(record, transcript, seenState = {}, { now = new Date() } = {}) {
  const hasExecution = record.userMessageCount > 0 || transcript.hasExecution;
  if (!hasExecution) return null;

  const nativeStatus = String(record.status || '').toLowerCase();
  const stopReason = String(transcript.latestRootStopReason || '').toLowerCase();
  let executionPhase = 'unknown';
  let statusReason = '';

  if (transcript.hasUnresolvedAsk && !record.streaming) executionPhase = 'waiting_user';
  else if (record.streaming || nativeStatus === 'running') executionPhase = 'active';
  else if (transcript.explicitFailure || record.failureReason) {
    executionPhase = 'failed';
    statusReason = transcript.explicitFailure || record.failureReason;
  } else if (['end_turn', 'endturn', 'stop'].includes(stopReason)) executionPhase = 'succeeded';
  else if (['length', 'error', 'failed', 'cancelled', 'canceled', 'aborted', 'interrupted'].includes(stopReason)) {
    executionPhase = 'failed';
    statusReason = `WPS Comate：${stopReason}`;
  }

  const source = String(record.source || '').toLowerCase();
  const cloud = source.includes('cloud');
  const seenIds = cloud ? seenState.cloudIds : seenState.localIds;
  const viewState = seenState.loaded
    ? (seenIds?.has(record.id) ? 'seen' : 'unseen')
    : 'indeterminate';
  const projectPath = workspacePath(record.workspace);
  const updatedAtMs = record.updatedAtMs || record.createdAtMs || now.getTime();

  return withStatusFacts({
    id: `wps-comate:${record.id}`,
    tool: 'WPS Comate·Desktop',
    toolId: 'wps-comate-desktop',
    appName: 'WPS Comate',
    source: cloud ? 'wps-comate-cloud' : 'wps-comate-local',
    title: String(record.title || '').trim() || 'WPS Comate 任务',
    projectName: cloud ? '云端' : '本地',
    projectPath,
    lastActivityAt: new Date(updatedAtMs).toISOString(),
    jump: {
      canActivateApp: true,
      canOpenProject: Boolean(projectPath),
      canCopyPath: Boolean(projectPath)
    }
  }, {
    hasExecution,
    executionPhase,
    viewState,
    nativeStatus: `${record.status || ''}/${transcript.latestRootStopReason || ''}`,
    statusReason: statusReason || (executionPhase === 'unknown' ? '已执行，但缺少根轮次终态' : ''),
    signalSource: cloud ? 'wps-comate-cloud-log' : 'wps-comate-db+session-log',
    signalObservedAt: new Date(updatedAtMs).toISOString(),
    endedAt: record.endedAtMs ? new Date(record.endedAtMs).toISOString() : ''
  });
}

export async function scanWpsComate(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  const existsSync = options.existsSync || fs.existsSync;
  if (!existsSync(dbPath)) return { sessions: [], errors: [] };

  const runCommand = options.runCommand || defaultRunCommand;
  const sql = `
SELECT
  id,
  COALESCE(source, ''),
  hex(COALESCE(title, '')),
  COALESCE(status, ''),
  hex(COALESCE(workspace, '')),
  hex(COALESCE(session_file, '')),
  COALESCE(last_message_role, ''),
  COALESCE(message_count, 0),
  COALESCE(created_at_ms, 0),
  COALESCE(updated_at_ms, 0),
  COALESCE((SELECT streaming FROM chat_messages WHERE session_id = chat_sessions.id ORDER BY sort_order DESC LIMIT 1), 0),
  COALESCE((SELECT COUNT(*) FROM chat_messages WHERE session_id = chat_sessions.id AND role = 'user'), 0)
FROM chat_sessions
ORDER BY COALESCE(updated_at_ms, 0) DESC
LIMIT 500;`;
  const result = await runCommand('sqlite3', ['-separator', FIELD_SEPARATOR, dbPath, sql], { timeoutMs: 5000 });
  if (!result.ok) {
    return { sessions: [], errors: [`WPS Comate 会话扫描失败：${result.error || result.stderr}`] };
  }

  const readFileSync = options.readFileSync || fs.readFileSync;
  const seenState = options.seenState || await loadComateSeenState(options);
  const sessions = [];
  const localIds = new Set();
  for (const record of parseComateSessionRows(result.stdout)) {
    localIds.add(record.id);
    let transcript = parseComateTranscript('');
    if (record.sessionFile && existsSync(record.sessionFile)) {
      try {
        transcript = parseComateTranscript(readFileSync(record.sessionFile, 'utf8'));
      } catch {
        // Missing transcript evidence will deliberately resolve to 状态不明.
      }
    }
    const session = buildComateSession(record, transcript, seenState, { now: options.now || new Date() });
    if (session) sessions.push(session);
  }

  const logRoot = options.logRoot ?? (options.dbPath ? '' : DEFAULT_LOG_ROOT);
  for (const item of readCloudLog(logRoot, options)) {
    if (localIds.has(item.id)) continue;
    const session = buildComateSession(cloudRecord(item), cloudTranscript(item), seenState, { now: options.now || new Date() });
    if (session) sessions.push(session);
  }

  return {
    sessions,
    errors: (seenState.errors || []).filter(Boolean).map((error) => `WPS Comate 已查看状态读取失败：${error}`)
  };
}
