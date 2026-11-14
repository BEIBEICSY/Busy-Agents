import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand as defaultRunCommand } from './shell.js';
import { resolveUnifiedStatus } from './statusModel.js';
import { loadCodexRuntimeStates } from './codexRuntimeReader.js';

const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
const DEFAULT_STATE_DB = path.join(DEFAULT_CODEX_HOME, 'state_5.sqlite');
const DEFAULT_THREAD_HISTORY_DB = path.join(DEFAULT_CODEX_HOME, 'thread_history_1.sqlite');
const DEFAULT_SESSION_INDEX = path.join(DEFAULT_CODEX_HOME, 'session_index.jsonl');
const DEFAULT_GLOBAL_STATE = path.join(DEFAULT_CODEX_HOME, '.codex-global-state.json');
const CODEX_UNREAD_ATOM_KEY = 'unread-thread-ids-by-host-v1';
const CODEX_THREAD_READ_STATE_KEY = 'electron-thread-read-state-v1';
const FIELD_SEPARATOR = '\u001f';

function normalizePath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function toIsoString(ms) {
  return Number.isFinite(ms) && ms > 0
    ? new Date(ms).toISOString()
    : '';
}

function toTimestampMs(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 1e12 ? numeric * 1000 : numeric;
}

function projectNameFor(cwd) {
  const value = normalizePath(cwd);
  return value ? path.basename(value) || value : '未知项目';
}

export function isCodexScratchWorkspace(cwd, home = os.homedir()) {
  const value = normalizePath(cwd);
  const root = normalizePath(path.join(home, 'Documents', 'Codex'));
  if (!value || !root || (value !== root && !value.startsWith(`${root}/`))) return false;
  const date = value.slice(root.length).replace(/^\//, '').split('/')[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function projectForCodexThread(cwd, home = os.homedir()) {
  if (isCodexScratchWorkspace(cwd, home)) return { projectName: '', projectPath: '' };
  const projectPath = normalizePath(cwd);
  return { projectName: projectNameFor(projectPath), projectPath };
}

export function parseSessionIndex(raw) {
  const namesById = new Map();

  for (const line of String(raw || '').split('\n')) {
    const value = line.trim();
    if (!value) continue;

    try {
      const item = JSON.parse(value);
      const id = String(item?.id || '').trim();
      if (!id) continue;

      namesById.set(id, {
        threadName: String(item?.thread_name || '').trim(),
        updatedAt: item?.updated_at || ''
      });
    } catch {
      // Ignore partial or stale index lines.
    }
  }

  return namesById;
}

export function parseCodexThreadRows(raw, namesById = new Map()) {
  return String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, title, cwd, updatedAt, source] = line.split(FIELD_SEPARATOR);
      const threadId = String(id || '').trim();
      if (!threadId) return null;

      const sidebarName = namesById.get(threadId)?.threadName || '';
      const updatedAtMs = Number(updatedAt || 0);

      return {
        id: threadId,
        title: String(title || '').trim(),
        displayTitle: sidebarName || String(title || '').trim() || 'Codex 会话',
        cwd: normalizePath(cwd),
        updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
        source: String(source || '').trim()
      };
    })
    .filter((thread) => thread && thread.cwd)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export function parseCodexTurnRows(raw) {
  const states = new Map();

  for (const line of String(raw || '').split('\n')) {
    const value = line.trim();
    if (!value) continue;

    const [threadId, status, hasError, startedAt, completedAt, turnId, codexErrorInfo] = value.split(FIELD_SEPARATOR);
    const id = String(threadId || '').trim();
    if (!id) continue;

    states.set(id, {
      status: String(status || '').trim(),
      hasError: String(hasError || '').trim() === '1',
      startedAtMs: toTimestampMs(startedAt),
      completedAtMs: toTimestampMs(completedAt),
      ...(turnId ? { turnId } : {}),
      ...(codexErrorInfo ? { codexErrorInfo } : {})
    });
  }

  return states;
}

export function parseCodexUnreadState(raw, hostId = 'local') {
  try {
    const state = JSON.parse(String(raw || ''));
    const threadReadState = state?.[CODEX_THREAD_READ_STATE_KEY];

    if (threadReadState && typeof threadReadState === 'object' && !Array.isArray(threadReadState)) {
      const unreadThreadIds = new Set();
      const unreadByIdentity = threadReadState.unreadByIdentity;

      if (unreadByIdentity && typeof unreadByIdentity === 'object' && !Array.isArray(unreadByIdentity)) {
        for (const unreadByHost of Object.values(unreadByIdentity)) {
          if (!unreadByHost || typeof unreadByHost !== 'object' || Array.isArray(unreadByHost)) continue;

          for (const [nativeHostId, threadIds] of Object.entries(unreadByHost)) {
            if (nativeHostId !== hostId && !nativeHostId.startsWith(`${hostId}:`)) continue;
            if (!Array.isArray(threadIds)) continue;
            for (const threadId of threadIds) {
              const value = String(threadId || '').trim();
              if (value) unreadThreadIds.add(value);
            }
          }
        }

        return { available: true, unreadThreadIds };
      }

      const migratedByHost = threadReadState.legacyMigration?.unreadThreadIdsByHostId;
      if (migratedByHost && typeof migratedByHost === 'object' && !Array.isArray(migratedByHost)) {
        for (const threadId of Array.isArray(migratedByHost[hostId]) ? migratedByHost[hostId] : []) {
          const value = String(threadId || '').trim();
          if (value) unreadThreadIds.add(value);
        }
        return { available: true, unreadThreadIds };
      }
    }

    const atoms = state?.['electron-persisted-atom-state'];

    if (!atoms || !Object.prototype.hasOwnProperty.call(atoms, CODEX_UNREAD_ATOM_KEY)) {
      return { available: false, unreadThreadIds: new Set() };
    }

    const unreadByHost = atoms[CODEX_UNREAD_ATOM_KEY];
    if (!unreadByHost || typeof unreadByHost !== 'object' || Array.isArray(unreadByHost)) {
      return { available: false, unreadThreadIds: new Set() };
    }

    const unreadThreadIds = Array.isArray(unreadByHost[hostId])
      ? unreadByHost[hostId]
        .map((threadId) => String(threadId || '').trim())
        .filter(Boolean)
      : [];

    return {
      available: true,
      unreadThreadIds: new Set(unreadThreadIds)
    };
  } catch {
    return { available: false, unreadThreadIds: new Set() };
  }
}

function executionPhaseForTurn(turnState) {
  const status = String(turnState?.status || '').trim().toLowerCase();

  if (['inprogress', 'in_progress', 'running', 'started'].includes(status)) return 'active';
  if (['failed', 'error', 'cancelled', 'canceled', 'interrupted', 'aborted'].includes(status)) {
    return 'failed';
  }
  if (['completed', 'succeeded', 'success'].includes(status)) {
    return turnState?.hasError ? 'failed' : 'succeeded';
  }
  return 'unknown';
}

function viewStateForThread(executionPhase, threadId, unreadState) {
  if (!['succeeded', 'failed'].includes(executionPhase) || !unreadState?.available) {
    return 'indeterminate';
  }

  return unreadState.unreadThreadIds?.has(threadId) ? 'unseen' : 'seen';
}

function endReasonForTurn(turnState) {
  const status = String(turnState?.status || '').trim().toLowerCase();
  if (turnState?.codexErrorInfo === 'usageLimitExceeded') return 'usage_limit';
  if (status === 'interrupted' && !turnState?.hasError) return 'user_stopped';
  return 'execution_failed';
}

function statusReasonForPhase(executionPhase, viewState, turnState) {
  if (executionPhase === 'waiting_user') return 'Codex 正在等待你的响应';
  if (executionPhase === 'active') return 'Codex 当前轮次正在执行';
  if (executionPhase === 'succeeded' && viewState === 'unseen') return 'Codex 当前轮次已完成，待你查看';
  if (executionPhase === 'succeeded' && viewState === 'seen') return 'Codex 当前轮次已完成，已在 Codex 查看';
  if (executionPhase === 'succeeded') return 'Codex 当前轮次已完成，查看状态未知';
  if (executionPhase === 'failed') {
    const endReason = endReasonForTurn(turnState);
    if (endReason === 'user_stopped') return '你已停止这条 Codex 轮次';
    if (endReason === 'usage_limit') return 'Codex 使用额度已用完，重置后可重试';
    return 'Codex 当前轮次执行失败';
  }
  return '已执行，但尚未取得原生轮次终态';
}

function isUserThread(thread) {
  return !thread.source || thread.source === 'user';
}

function isRecentlyActiveUserThread(thread, cutoffMs) {
  return isUserThread(thread)
    && Number.isFinite(thread.updatedAtMs)
    && thread.updatedAtMs >= cutoffMs;
}

export function pickCodexAppThreads(threads, {
  now = new Date(),
  activeWithinMs = 24 * 60 * 60 * 1000,
  maxProjects = 8,
  maxThreadsPerProject = 8,
  maxThreads = 40
} = {}) {
  const cutoffMs = now.getTime() - activeWithinMs;
  const recentUserThreads = threads
    .filter((thread) => isRecentlyActiveUserThread(thread, cutoffMs))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  const activeProjectCwds = new Set();

  for (const thread of recentUserThreads) {
    activeProjectCwds.add(normalizePath(thread.cwd));
    if (activeProjectCwds.size >= maxProjects) break;
  }

  const perProjectCounts = new Map();
  const picked = [];

  for (const thread of recentUserThreads) {
    const cwd = normalizePath(thread.cwd);
    if (!activeProjectCwds.has(cwd)) continue;

    const count = perProjectCounts.get(cwd) || 0;
    if (count >= maxThreadsPerProject) continue;

    picked.push(thread);
    perProjectCounts.set(cwd, count + 1);

    if (picked.length >= maxThreads) break;
  }

  return picked;
}

export function buildCodexAppThreadSessions(threads, codexProcessSessions, options = {}) {
  const appSession = codexProcessSessions.find((session) => {
    const command = String(session.process?.command || '');
    return ['codex', 'codex-desktop'].includes(session.toolId || session.tool)
      && !normalizePath(session.projectPath)
      && /\bapp-server\b/i.test(command);
  });

  const desktopRunning = Boolean(appSession);
  const now = options.now || new Date();
  const pickedThreads = pickCodexAppThreads(threads, { ...options, now });

  return pickedThreads.map((thread) => {
    const turnState = options.turnStates?.get(thread.id);
    if (!turnState) return null;

    const runtime = options.runtimeStates?.get(thread.id);
    // A fresh snapshot must belong to this exact turn. Terminal DB evidence
    // always wins; never carry a pending approval across turns or scans.
    const runtimeMatches = desktopRunning && runtime?.threadId === thread.id && runtime.turnId
      && runtime.turnId === turnState.turnId && Number.isFinite(runtime.observedAtMs)
      && now.getTime() - runtime.observedAtMs >= -2000
      && now.getTime() - runtime.observedAtMs <= 10_000;
    const flags = runtimeMatches && runtime.type === 'active' ? runtime.activeFlags || [] : [];
    const waitingReason = flags.includes('waitingOnApproval') ? 'waiting_approval'
      : flags.includes('waitingOnUserInput') ? 'waiting_input' : '';
    const turnPhase = executionPhaseForTurn(turnState);
    let executionPhase = turnPhase === 'active' && waitingReason ? 'waiting_user' : turnPhase;
    const viewState = viewStateForThread(executionPhase, thread.id, options.unreadState);
    let endReason = executionPhase === 'failed' ? endReasonForTurn(turnState) : '';
    let statusReason = executionPhase === 'waiting_user'
      ? waitingReason === 'waiting_approval' ? 'Codex 正在等待你的批准' : 'Codex 正在等待你的回答'
      : statusReasonForPhase(executionPhase, viewState, turnState);
    const closedDuringTurn = !desktopRunning && ['active', 'waiting_user'].includes(executionPhase);
    if (closedDuringTurn) {
      executionPhase = 'unknown';
      endReason = '';
      statusReason = 'Codex 已退出，当前轮次结果未知';
    }
    const signalObservedAt = toIsoString(Math.max(
      thread.updatedAtMs || 0,
      turnState?.completedAtMs || 0,
      turnState?.startedAtMs || 0,
      runtimeMatches ? runtime.observedAtMs : 0
    )) || now.toISOString();
    const status = resolveUnifiedStatus({
      hasExecution: true,
      executionPhase,
      viewState
    });
    const project = projectForCodexThread(thread.cwd, options.home);

    return {
      id: `codex-thread:${thread.id}`,
      tool: 'Codex·Desktop',
      toolId: 'codex-desktop',
      appName: 'ChatGPT',
      source: 'codex-thread',
      title: thread.displayTitle,
      projectName: project.projectName,
      projectPath: project.projectPath,
      status,
      statusReason,
      attentionReason: statusReason,
      lastActivityAt: toIsoString(thread.updatedAtMs) || signalObservedAt,
      endedAt: ['succeeded', 'failed'].includes(executionPhase) ? toIsoString(turnState.completedAtMs) : '',
      statusFacts: {
        hasExecution: true,
        executionPhase,
        viewState,
        ...(endReason ? { endReason } : {}),
        ...(turnState?.codexErrorInfo ? { nativeErrorType: turnState.codexErrorInfo } : {}),
        ...(executionPhase === 'waiting_user' ? { waitingReason } : {}),
        ...(runtimeMatches ? { runtimeStatus: runtime.type, activeFlags: flags } : {}),
        nativeStatus: turnState?.status || '',
        signalSource: turnState
          ? `codex-thread-history${runtimeMatches ? '+codex-desktop-runtime' : ''}${closedDuringTurn ? '+codex-desktop-closed' : ''}${viewState === 'indeterminate' ? '' : '+codex-unread-state'}`
          : 'codex-thread-index',
        signalObservedAt
      },
      process: appSession?.process || null,
      window: {
        app: 'ChatGPT',
        title: 'Codex'
      },
      codexThread: {
        id: thread.id,
        title: thread.displayTitle
      },
      jump: {
        canActivateApp: true,
        canOpenProject: Boolean(project.projectPath),
        canCopyPath: Boolean(project.projectPath)
      }
    };
  }).filter(Boolean);
}

export function enrichCodexSessions(sessions, threads, {
  now = new Date(),
  activeWithinMs = 24 * 60 * 60 * 1000
} = {}) {
  const threadsByCwd = new Map();
  const cutoffMs = now.getTime() - activeWithinMs;

  for (const thread of threads) {
    if (!isRecentlyActiveUserThread(thread, cutoffMs)) continue;

    const cwd = normalizePath(thread.cwd);
    if (!cwd) continue;

    const current = threadsByCwd.get(cwd) || [];
    current.push(thread);
    threadsByCwd.set(cwd, current);
  }

  for (const matches of threadsByCwd.values()) {
    matches.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  return sessions.flatMap((session) => {
    if (!['codex', 'codex-cli'].includes(session.toolId || session.tool)) return [session];

    const matches = threadsByCwd.get(normalizePath(session.projectPath)) || [];
    if (!matches.length) return [session];

    return matches.map((thread) => ({
      ...session,
      id: `${session.id}:codex-thread:${thread.id}`,
      source: `${session.source}+codex-thread`,
      title: thread.displayTitle,
      lastActivityAt: toIsoString(thread.updatedAtMs) || session.lastActivityAt,
      codexThread: {
        id: thread.id,
        title: thread.displayTitle
      }
    }));
  });
}

export function loadSessionIndex({
  sessionIndexPath = DEFAULT_SESSION_INDEX,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync
} = {}) {
  if (!existsSync(sessionIndexPath)) return new Map();

  try {
    return parseSessionIndex(readFileSync(sessionIndexPath, 'utf8'));
  } catch {
    return new Map();
  }
}

export function loadCodexUnreadState({
  globalStatePath = DEFAULT_GLOBAL_STATE,
  hostId = 'local',
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync
} = {}) {
  if (!existsSync(globalStatePath)) {
    return { available: false, unreadThreadIds: new Set() };
  }

  try {
    return parseCodexUnreadState(readFileSync(globalStatePath, 'utf8'), hostId);
  } catch {
    return { available: false, unreadThreadIds: new Set() };
  }
}

export async function loadCodexThreads({
  stateDbPath = DEFAULT_STATE_DB,
  namesById,
  existsSync = fs.existsSync,
  runCommand = defaultRunCommand
} = {}) {
  if (!existsSync(stateDbPath)) return [];

  const sql = `
SELECT
  id,
  replace(replace(title, char(10), ' '), char(13), ' '),
  cwd,
  COALESCE(updated_at_ms, updated_at * 1000, 0),
  COALESCE(thread_source, '')
FROM threads
WHERE cwd != ''
  AND archived = 0
  AND COALESCE(thread_source, '') != 'subagent'
ORDER BY COALESCE(updated_at_ms, updated_at * 1000, 0) DESC
LIMIT 500;
`;

  const result = await runCommand('sqlite3', [
    '-separator',
    FIELD_SEPARATOR,
    stateDbPath,
    sql
  ], { timeoutMs: 3000 });

  return result.ok ? parseCodexThreadRows(result.stdout, namesById || new Map()) : [];
}

export async function loadCodexTurnStates({
  threadHistoryDbPath = DEFAULT_THREAD_HISTORY_DB,
  existsSync = fs.existsSync,
  runCommand = defaultRunCommand
} = {}) {
  if (!existsSync(threadHistoryDbPath)) return new Map();

  const sql = `
SELECT
  turns.thread_id,
  turns.status,
  CASE WHEN turns.error_json IS NULL OR turns.error_json = '' THEN 0 ELSE 1 END,
  COALESCE(turns.started_at, 0),
  COALESCE(turns.completed_at, 0),
  turns.turn_id,
  CASE
    WHEN json_valid(turns.error_json)
    THEN COALESCE(json_extract(turns.error_json, '$.codexErrorInfo'), '')
    ELSE ''
  END
FROM thread_turns AS turns
JOIN (
  SELECT thread_id, MAX(rollout_ordinal) AS latest_ordinal
  FROM thread_turns
  GROUP BY thread_id
) AS latest
  ON latest.thread_id = turns.thread_id
 AND latest.latest_ordinal = turns.rollout_ordinal;
`;

  const result = await runCommand('sqlite3', [
    '-separator',
    FIELD_SEPARATOR,
    threadHistoryDbPath,
    sql
  ], { timeoutMs: 3000 });

  return result.ok ? parseCodexTurnRows(result.stdout) : new Map();
}

export async function scanCodexThreads(options = {}) {
  try {
    const namesById = options.namesById || loadSessionIndex(options);
    const unreadState = options.unreadState || loadCodexUnreadState(options);
    const [threads, turnStates] = await Promise.all([
      loadCodexThreads({
        ...options,
        namesById
      }),
      loadCodexTurnStates(options)
    ]);

    const activeIds = pickCodexAppThreads(threads, options)
      .filter((thread) => executionPhaseForTurn(turnStates.get(thread.id)) === 'active')
      .map((thread) => thread.id);
    const runtimeStates = await (options.loadRuntimeStates || loadCodexRuntimeStates)(activeIds, options)
      .catch(() => new Map());
    return { threads, turnStates, unreadState, runtimeStates, errors: [] };
  } catch (error) {
    return {
      threads: [],
      turnStates: new Map(),
      unreadState: { available: false, unreadThreadIds: new Set() },
      errors: [`Codex 会话标题扫描失败：${error.message}`]
    };
  }
}
