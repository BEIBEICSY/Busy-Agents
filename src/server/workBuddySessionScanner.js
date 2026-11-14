import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand as defaultRunCommand } from './shell.js';
import { withStatusFacts } from './statusModel.js';
import { readChromiumLocalStorage } from './chromiumLocalStorage.js';

const FIELD_SEPARATOR = '\u001f';
const DEFAULT_NATIVE_DB_PATH = path.join(os.homedir(), '.workbuddy/workbuddy.db');
const DEFAULT_NATIVE_LEVELDB_PATH = path.join(
  os.homedir(), '.workbuddy/app/session/Local Storage/leveldb'
);
const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  'Library/Application Support/WorkBuddy/codebuddy-sessions.vscdb'
);
const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.workbuddy/projects');
const EXECUTION_EVENT_TYPES = new Set([
  'message', 'function_call', 'function_call_result', 'reasoning', 'summary'
]);
const DEFAULT_LEVELDB_PATH = path.join(
  os.homedir(),
  'Library/Application Support/WorkBuddy/Local Storage/leveldb'
);

function timestampMs(value) {
  const number = Number(value || 0);
  if (Number.isFinite(number) && number > 0) {
    return number < 100000000000 ? number * 1000 : number;
  }
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseWorkBuddyRows(raw) {
  return String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [key, encoded] = line.split(FIELD_SEPARATOR);
      try {
        const record = JSON.parse(Buffer.from(encoded || '', 'hex').toString('utf8'));
        return { ...record, conversationId: record.conversationId || String(key || '').replace(/^session:/, '') };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function loadWorkBuddyViewState({
  levelDbPath = DEFAULT_LEVELDB_PATH,
  ...options
} = {}) {
  const snapshot = readChromiumLocalStorage(levelDbPath, [
    'codebuddy-unread-completed', 'codebuddy-read-conversations'
  ], options);
  const readSet = (key) => {
    try {
      const value = JSON.parse(snapshot.values.get(key));
      // The native hook stores string arrays. Do not infer IDs from arbitrary JSON.
      return Array.isArray(value) && value.every((id) => typeof id === 'string')
        ? new Set(value) : null;
    } catch {
      return null;
    }
  };
  const unreadIds = readSet('codebuddy-unread-completed');
  const readIds = readSet('codebuddy-read-conversations');
  return {
    loaded: snapshot.available && (unreadIds !== null || readIds !== null),
    unreadLoaded: unreadIds !== null,
    readLoaded: readIds !== null,
    unreadIds: unreadIds || new Set(),
    readIds: readIds || new Set()
  };
}

function hasWorkBuddyInteraction(record) {
  if (record.awaiting_input === true || record.awaitingInput === true || record.hasUnresolvedInteraction === true) {
    return true;
  }
  const blocks = record.interactionBlocks || record.blocks || [];
  return Array.isArray(blocks) && blocks.some((block) => {
    const type = String(block?.type || block?.name || '').toLowerCase();
    return /askuser|permission|confirm|review/.test(type) && block?.resolved !== true;
  });
}

function workBuddyPhase(record) {
  if (hasWorkBuddyInteraction(record)) return 'waiting_user';
  const status = String(record.status || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['waiting_for_input', 'waitinginput', 'awaiting_input', 'needs_input'].includes(status)) return 'waiting_user';
  if (['running', 'working', 'planning', 'active', 'in_progress', 'queued'].includes(status)) return 'active';
  if (['completed', 'complete', 'done', 'finished', 'success', 'succeeded'].includes(status)) return 'succeeded';
  if (['failed', 'error', 'stopped', 'terminated', 'cancelled', 'canceled', 'killed', 'interrupted'].includes(status)) return 'failed';
  return 'unknown';
}

export function workBuddyProjectDir(cwd) {
  return String(cwd || '').replace(/^\/+/, '').replaceAll('/', '-');
}

export function completionTimestampFromEvents(events) {
  let latest = 0;
  for (const event of events || []) {
    if (!EXECUTION_EVENT_TYPES.has(event?.type)) continue;
    const timestamp = timestampMs(event.timestamp);
    if (timestamp > latest) latest = timestamp;
  }
  return latest;
}

function sessionLogEvents(filePath, fileSystem = fs) {
  if (!filePath || !fileSystem.existsSync(filePath)) return [];
  let raw = '';
  try {
    raw = fileSystem.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of String(raw).split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip a damaged line. Do not infer a question or a completion from it.
    }
  }
  return events;
}

export function readWorkBuddyCompletionMs(filePath, fileSystem = fs) {
  let latest = 0;
  for (const event of sessionLogEvents(filePath, fileSystem)) {
    if (!EXECUTION_EVENT_TYPES.has(event?.type)) continue;
    const timestamp = timestampMs(event.timestamp);
    if (timestamp > latest) latest = timestamp;
  }
  return latest;
}

// Only the call id, event type and tool name are used. Question text and arguments stay in the file.
export function hasOpenWorkBuddyQuestion(filePath, fileSystem = fs) {
  const open = new Set();
  for (const event of sessionLogEvents(filePath, fileSystem)) {
    const callId = String(event?.callId || '').trim();
    if (!callId) continue;
    if (event.type === 'function_call' && event.name === 'AskUserQuestion') open.add(callId);
    if (event.type === 'function_call_result' && open.has(callId)) open.delete(callId);
  }
  return open.size > 0;
}

function cannotOpenDatabase(result) {
  const detail = `${result?.error || ''}\n${result?.stderr || ''}`;
  return /unable to open database file|\(14\)/.test(detail);
}

export function immutableWorkBuddyUri(dbPath) {
  const encoded = path.resolve(dbPath)
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `file:${encoded}?immutable=1`;
}

function sessionLogPath(record, options) {
  const sessionId = String(record.conversationId || record.id || '').trim();
  if (!sessionId) return '';
  const projectsDir = options.projectsDir || DEFAULT_PROJECTS_DIR;
  return path.join(projectsDir, workBuddyProjectDir(record.cwd), `${sessionId}.jsonl`);
}

function withSessionLogSignals(record, options) {
  const fileSystem = options.sessionLogFs || fs;
  const phase = workBuddyPhase(record);
  let next = record;
  if (['succeeded', 'failed'].includes(phase) && !timestampMs(record.completedAt || record.finishedAt)) {
    const completedAt = readWorkBuddyCompletionMs(sessionLogPath(record, options), fileSystem);
    if (completedAt) {
      next = {
        ...record,
        completedAt,
        completionSource: 'workbuddy-session-db+workbuddy-session-log'
      };
    }
  }
  // A bare Pending session has not started. The same status is also WorkBuddy's
  // 待确认 state once AskUserQuestion is still open. A finished session keeps its own status.
  const status = String(next.status || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (status !== 'pending' && phase !== 'active') return next;
  if (!hasOpenWorkBuddyQuestion(sessionLogPath(next, options), fileSystem)) return next;
  return {
    ...next,
    awaitingInput: true,
    hasExecution: true,
    interactionSource: 'workbuddy-session-db+workbuddy-session-log'
  };
}

export function buildWorkBuddySession(record, viewState = {}) {
  const sessionId = String(record.conversationId || record.id || '').trim();
  if (!sessionId) return null;
  if (record.isArchived === true || record.deletedAt != null
    || String(record.status || '').toLowerCase() === 'archived') return null;

  const executionPhase = workBuddyPhase(record);
  const createdAtMs = timestampMs(record.createdAt);
  const updatedAtMs = timestampMs(record.updatedAt) || createdAtMs;
  const hasExecution = executionPhase !== 'unknown'
    || record.hasExecution === true;
  if (!hasExecution) return null;

  const view = viewState.unreadIds?.has(sessionId)
    ? 'unseen'
    : viewState.readIds?.has(sessionId)
      ? 'seen'
      : 'indeterminate';
  const projectPath = String(record.cwd || '').trim();

  return withStatusFacts({
    id: `workbuddy:${sessionId}`,
    tool: 'WorkBuddy·Desktop',
    toolId: 'workbuddy-desktop',
    appName: 'WorkBuddy',
    source: 'workbuddy-local',
    title: String(record.title || '').trim() || 'WorkBuddy 任务',
    projectName: projectPath ? path.basename(projectPath) : '未知项目',
    projectPath,
    lastActivityAt: new Date(updatedAtMs || Date.now()).toISOString(),
    jump: {
      canActivateApp: true,
      canOpenProject: Boolean(projectPath),
      canCopyPath: Boolean(projectPath)
    }
  }, {
    hasExecution,
    executionPhase,
    endedAt: timestampMs(record.completedAt || record.finishedAt) > 0
      ? new Date(timestampMs(record.completedAt || record.finishedAt)).toISOString() : '',
    viewState: view,
    nativeStatus: String(record.status || ''),
    statusReason: executionPhase === 'waiting_user'
      ? 'WorkBuddy 正在等待你确认'
      : executionPhase === 'failed'
        ? `WorkBuddy：${record.status || '异常结束'}`
        : executionPhase === 'succeeded' && view === 'indeterminate'
          ? '任务已完成，WorkBuddy 暂无查看标记' : '',
    signalSource: record.interactionSource || record.completionSource || 'workbuddy-session-db',
    signalObservedAt: new Date(updatedAtMs || Date.now()).toISOString()
  });
}

export async function scanWorkBuddy(options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  const nativeDbPath = options.nativeDbPath || DEFAULT_NATIVE_DB_PATH;
  const dbPath = options.dbPath || (existsSync(nativeDbPath)
    ? nativeDbPath
    : options.legacyDbPath || DEFAULT_DB_PATH);
  if (!existsSync(dbPath)) return { sessions: [], errors: [] };

  const runCommand = options.runCommand || defaultRunCommand;
  // A clean WorkBuddy exit checkpoints WAL and deletes -wal/-shm. sqlite3 -readonly
  // cannot recreate those files, so fall back to an immutable snapshot. Do not open
  // the user's database read-write; that would write sidecars into ~/.workbuddy.
  let openArgs = ['-readonly', '-separator', FIELD_SEPARATOR, dbPath];
  const query = async (sql) => {
    const result = await runCommand('sqlite3', [...openArgs, sql], { timeoutMs: 5000 });
    if (result.ok || openArgs[0] !== '-readonly' || !cannotOpenDatabase(result)) return result;
    openArgs = ['-separator', FIELD_SEPARATOR, immutableWorkBuddyUri(dbPath)];
    return runCommand('sqlite3', [...openArgs, sql], { timeoutMs: 5000 });
  };
  const schema = await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'ItemTable');");
  if (!schema.ok) {
    return { sessions: [], errors: [`WorkBuddy 会话扫描失败：${schema.error || schema.stderr}`] };
  }
  const tables = new Set(String(schema.stdout || '').trim().split('\n'));
  const isNative = tables.has('sessions');
  if (!isNative && !tables.has('ItemTable')) {
    return { sessions: [], errors: ['WorkBuddy 会话扫描失败：无法识别本地会话库结构'] };
  }
  // Select only session metadata. Never read message bodies or authentication fields.
  const sql = isNative ? `SELECT id, hex(json_object(
    'conversationId', id, 'title', COALESCE(NULLIF(custom_title, ''), title),
    'status', status, 'cwd', cwd, 'createdAt', created_at, 'updatedAt', updated_at
  )) FROM sessions WHERE deleted_at IS NULL AND lower(status) != 'archived';`
    : "SELECT key, hex(value) FROM ItemTable WHERE key LIKE 'session:%';";
  const result = await query(sql);
  if (!result.ok) {
    return { sessions: [], errors: [`WorkBuddy 会话扫描失败：${result.error || result.stderr}`] };
  }

  const viewState = options.viewState || loadWorkBuddyViewState({
    ...options,
    levelDbPath: options.levelDbPath || (isNative ? DEFAULT_NATIVE_LEVELDB_PATH : DEFAULT_LEVELDB_PATH)
  });
  return {
    sessions: parseWorkBuddyRows(result.stdout)
      .map((record) => buildWorkBuddySession(withSessionLogSignals(record, options), viewState))
      .filter(Boolean),
    errors: []
  };
}
