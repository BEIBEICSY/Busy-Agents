import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand as defaultRunCommand } from './shell.js';

const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), '.cursor', 'projects');
const DEFAULT_COMPOSER_STATE_DB = path.join(
  os.homedir(),
  'Library/Application Support/Cursor/User/globalStorage/state.vscdb'
);
const META_WINDOW_TITLES = new Set(['cursor agents']);
const WORKSPACE_PATH_RE = /\/Users\/[^\s"'<>]+/g;
const FIELD_SEPARATOR = '\u001f';
const CURSOR_USER_STOP_ERRORS = new Set([
  'user aborted request',
  'user_stopped_generation',
  'user aborted/interrupted manually.'
]);

function normalizeToken(value) {
  return String(value || '').toLowerCase().replace(/[_-]/g, '');
}

export function decodeCursorProjectSlug(slug, fsImpl = fs) {
  if (!slug || /^\d+$/.test(slug) || !slug.startsWith('Users-')) {
    return '';
  }

  const tokens = slug.slice('Users-'.length).split('-');
  let current = '/Users';
  let tokenIndex = 0;

  while (tokenIndex < tokens.length) {
    let entries = [];

    try {
      entries = fsImpl.readdirSync(current);
    } catch {
      return '';
    }

    let matched = null;

    for (let end = tokens.length; end > tokenIndex; end -= 1) {
      const joined = tokens.slice(tokenIndex, end).join('');
      const hyphenJoined = tokens.slice(tokenIndex, end).join('-');
      const underscoreJoined = tokens.slice(tokenIndex, end).join('_');
      const candidates = new Set([
        normalizeToken(joined),
        normalizeToken(hyphenJoined),
        normalizeToken(underscoreJoined)
      ]);

      const entry = entries.find((name) => candidates.has(normalizeToken(name)));
      if (entry) {
        matched = { name: entry, nextIndex: end };
        break;
      }
    }

    if (!matched) {
      return '';
    }

    current = path.join(current, matched.name);
    tokenIndex = matched.nextIndex;
  }

  return fsImpl.existsSync(current) ? current : '';
}

function extractTextFromMessage(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';

  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim();
}

function cleanUserQuery(text) {
  return String(text || '')
    .replace(/<user_query>\s*/gi, '')
    .replace(/<\/user_query>/gi, '')
    .replace(/\[Image\][\s\S]*?<\/image_files>/gi, '')
    .replace(/<image_files>[\s\S]*?<\/image_files>/gi, '')
    .trim();
}

function extractWorkspacePaths(text, fsImpl = fs) {
  const matches = String(text || '').match(WORKSPACE_PATH_RE) || [];

  return [...new Set(matches
    .map((value) => value.replace(/[\\`,.:;]+$/g, ''))
    .filter((value) => !value.includes('/.cursor/'))
    .filter((value) => {
      try {
        return fsImpl.existsSync(value);
      } catch {
        return false;
      }
    }))];
}

function pickWorkspacePath(paths) {
  if (!paths.length) return '';

  const directories = paths.filter((value) => {
    try {
      return fs.statSync(value).isDirectory();
    } catch {
      return false;
    }
  });

  const candidates = directories.length ? directories : paths;
  return candidates.sort((a, b) => b.length - a.length)[0];
}

function inferTitle(lines) {
  const firstUser = lines.find((line) => line.role === 'user');
  const text = cleanUserQuery(extractTextFromMessage(firstUser?.message));
  if (!text || /^<timestamp>/i.test(text) || /^<external_links>/i.test(text)) {
    return 'Cursor Agent';
  }

  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function extractComposerProjectPath(composer) {
  return composer?.workspaceIdentifier?.uri?.fsPath
    || composer?.workspaceIdentifier?.uri?.path
    || composer?.agentLocation?.environment?.uri?.fsPath
    || composer?.agentLocation?.environment?.uri?.path
    || '';
}

function toIsoString(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : '';
}

export function parseComposerHeaders(raw) {
  const headersById = new Map();

  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const composers = Array.isArray(parsed?.allComposers) ? parsed.allComposers : [];

    for (const composer of composers) {
      const composerId = String(composer?.composerId || '').trim();
      if (!composerId) continue;

      headersById.set(composerId, {
        name: String(composer?.name || '').trim(),
        subtitle: String(composer?.subtitle || '').trim(),
        lastUpdatedAt: toIsoString(composer?.lastUpdatedAt),
        projectPath: extractComposerProjectPath(composer),
        hasUnreadMessages: typeof composer?.hasUnreadMessages === 'boolean'
          ? composer.hasUnreadMessages
          : null,
        nativeStatus: String(composer?.status || '').trim(),
        isArchived: typeof composer?.isArchived === 'boolean'
          ? composer.isArchived
          : null,
        isSubagent: typeof composer?.isSubagent === 'boolean'
          ? composer.isSubagent
          : null
      });
    }
  } catch {
    return headersById;
  }

  return headersById;
}

export function parseComposerHeaderRows(raw) {
  const headersById = new Map();

  for (const line of String(raw || '').split('\n')) {
    const value = line.trim();
    if (!value) continue;

    const [
      composerId,
      name,
      subtitle,
      lastUpdatedAt,
      projectPath,
      unreadValue,
      nativeStatus,
      isArchivedValue,
      isSubagentValue
    ] = value.split(FIELD_SEPARATOR);
    const id = String(composerId || '').trim();
    if (!id) continue;

    headersById.set(id, {
      name: String(name || '').trim(),
      subtitle: String(subtitle || '').trim(),
      lastUpdatedAt: toIsoString(lastUpdatedAt),
      projectPath: String(projectPath || '').trim(),
      hasUnreadMessages: unreadValue === '1'
        ? true
        : unreadValue === '0'
          ? false
          : null,
      nativeStatus: String(nativeStatus || '').trim(),
      isArchived: isArchivedValue === '1'
        ? true
        : isArchivedValue === '0'
          ? false
          : null,
      isSubagent: isSubagentValue === '1'
        ? true
        : isSubagentValue === '0'
          ? false
          : null
    });
  }

  return headersById;
}

export function parseComposerDataRows(raw) {
  const dataById = new Map();

  for (const line of String(raw || '').split('\n')) {
    const value = line.trim();
    if (!value) continue;

    const [
      composerId,
      nativeStatus,
      unfinishedRunAt,
      lastUpdatedAt,
      projectPath,
      name
    ] = value.split(FIELD_SEPARATOR);
    const id = String(composerId || '').trim();
    if (!id) continue;

    dataById.set(id, {
      nativeStatus: String(nativeStatus || '').trim(),
      unfinishedRunAt: toIsoString(/^\d+$/.test(unfinishedRunAt) ? Number(unfinishedRunAt) : unfinishedRunAt),
      lastUpdatedAt: toIsoString(/^\d+$/.test(lastUpdatedAt) ? Number(lastUpdatedAt) : lastUpdatedAt),
      projectPath: String(projectPath || '').trim(),
      name: String(name || '').trim()
    });
  }

  return dataById;
}

export async function loadComposerHeaders({
  stateDbPath = DEFAULT_COMPOSER_STATE_DB,
  existsSync = fs.existsSync,
  runCommand = defaultRunCommand
} = {}) {
  if (!existsSync(stateDbPath)) {
    return new Map();
  }

  const tableResult = await runCommand('sqlite3', [
    '-separator',
    FIELD_SEPARATOR,
    stateDbPath,
    `
SELECT
  composerId,
  replace(replace(COALESCE(json_extract(value, '$.name'), ''), char(10), ' '), char(13), ' '),
  replace(replace(COALESCE(json_extract(value, '$.subtitle'), ''), char(10), ' '), char(13), ' '),
  COALESCE(lastUpdatedAt, json_extract(value, '$.lastUpdatedAt'), 0),
  COALESCE(
    json_extract(value, '$.workspaceIdentifier.uri.fsPath'),
    json_extract(value, '$.workspaceIdentifier.uri.path'),
    json_extract(value, '$.agentLocation.environment.uri.fsPath'),
    json_extract(value, '$.agentLocation.environment.uri.path'),
    ''
  ),
  CASE
    WHEN json_type(value, '$.hasUnreadMessages') IN ('true', 'false')
      THEN CAST(json_extract(value, '$.hasUnreadMessages') AS INTEGER)
    ELSE ''
  END,
  COALESCE(json_extract(value, '$.status'), ''),
  COALESCE(isArchived, 0),
  COALESCE(isSubagent, 0)
FROM composerHeaders
WHERE json_valid(value);
`
  ], { timeoutMs: 3000 });

  if (tableResult.ok && tableResult.stdout.trim()) {
    return parseComposerHeaderRows(tableResult.stdout);
  }

  const result = await runCommand('sqlite3', [
    stateDbPath,
    "SELECT value FROM ItemTable WHERE key='composer.composerHeaders';"
  ], { timeoutMs: 3000 });

  if (!result.ok || !result.stdout.trim()) {
    return new Map();
  }

  return parseComposerHeaders(result.stdout.trim());
}

export async function loadComposerData({
  stateDbPath = DEFAULT_COMPOSER_STATE_DB,
  existsSync = fs.existsSync,
  runCommand = defaultRunCommand
} = {}) {
  if (!existsSync(stateDbPath)) {
    return new Map();
  }

  const result = await runCommand('sqlite3', [
    '-separator',
    FIELD_SEPARATOR,
    stateDbPath,
    `
SELECT
  substr(key, length('composerData:') + 1),
  COALESCE(json_extract(value, '$.status'), ''),
  COALESCE(json_extract(value, '$.unfinishedRunAt'), ''),
  COALESCE(json_extract(value, '$.lastUpdatedAt'), 0),
  COALESCE(
    json_extract(value, '$.workspaceIdentifier.uri.fsPath'),
    json_extract(value, '$.workspaceIdentifier.uri.path'),
    ''
  ),
  replace(replace(COALESCE(json_extract(value, '$.name'), ''), char(10), ' '), char(13), ' ')
FROM cursorDiskKV
WHERE key GLOB 'composerData:*' AND json_valid(value);
`
  ], { timeoutMs: 5000 });

  if (!result.ok || !result.stdout.trim()) {
    return new Map();
  }

  return parseComposerDataRows(result.stdout);
}

function isCursorUserStop(line) {
  if (line?.type !== 'turn_ended') return false;
  const error = String(line.error || '').trim().toLowerCase();
  return CURSOR_USER_STOP_ERRORS.has(error);
}

function inferProgress(lines) {
  if (!lines.length) {
    return {
      status: null,
      progressHint: '',
      turnCount: 0,
      hasExecution: false,
      executionPhase: 'unknown'
    };
  }

  const turnCount = lines.filter((line) => line.type === 'turn_ended').length;
  let lastTurnEndIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].type === 'turn_ended') {
      lastTurnEndIndex = index;
      break;
    }
  }

  if (lastTurnEndIndex >= 0) {
    const turn = lines[lastTurnEndIndex];
    const startedNewTurn = lines
      .slice(lastTurnEndIndex + 1)
      .some((line) => line.role === 'user');
    if (!startedNewTurn && isCursorUserStop(turn)) {
      return {
        status: 'ended_abnormally',
        progressHint: '你已停止这条 Cursor 轮次',
        turnCount,
        hasExecution: true,
        executionPhase: 'failed',
        endReason: 'user_stopped',
        endedAt: toIsoString(turn.timestamp)
      };
    }
  }

  const last = lines[lines.length - 1];

  if (last.type === 'turn_ended') {
    return {
      status: last.status === 'success' ? 'unknown' : 'ended_abnormally',
      progressHint: last.status === 'success'
        ? '一轮已完成，查看状态未知'
        : `Agent 异常结束：${last.status || 'unknown'}`,
      turnCount,
      hasExecution: true,
      executionPhase: last.status === 'success' ? 'succeeded' : 'failed'
    };
  }

  if (last.role === 'user') {
    return {
      status: 'running',
      progressHint: '等待 Agent 回复',
      turnCount,
      hasExecution: true,
      executionPhase: 'active'
    };
  }

  if (last.role === 'assistant') {
    const content = last.message?.content || [];
    if (content.some((item) => item?.type === 'tool_use')) {
      return {
        status: 'running',
        progressHint: 'Agent 执行中',
        turnCount,
        hasExecution: true,
        executionPhase: 'active'
      };
    }

    return {
      status: 'running',
      progressHint: 'Agent 回复中',
      turnCount,
      hasExecution: true,
      executionPhase: 'active'
    };
  }

  return {
    status: 'unknown',
    progressHint: '已执行，但当前状态未知',
    turnCount,
    hasExecution: true,
    executionPhase: 'unknown'
  };
}

export function parseAgentTranscript(raw) {
  const lines = String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const progress = inferProgress(lines);

  return {
    title: inferTitle(lines),
    ...progress,
    lines
  };
}

function resolveProjectPath({ slug, parsed, fsImpl }) {
  const fromSlug = decodeCursorProjectSlug(slug, fsImpl);
  if (fromSlug) return fromSlug;

  const fromTranscript = pickWorkspacePath(
    parsed.lines.flatMap((line) => extractWorkspacePaths(JSON.stringify(line), fsImpl))
  );

  return fromTranscript;
}

export function isMetaCursorWindowTitle(title) {
  return META_WINDOW_TITLES.has(String(title || '').trim().toLowerCase());
}

function cursorProjectSlug(projectPath) {
  return String(projectPath || '')
    .replace(/^\/+/, '')
    .replaceAll('/', '-');
}

function latestIsoString(...values) {
  return values.reduce((latest, value) => {
    const timestamp = new Date(value || 0).getTime();
    return Number.isFinite(timestamp) && timestamp > new Date(latest || 0).getTime()
      ? new Date(timestamp).toISOString()
      : latest;
  }, '');
}

export function buildAgentSessions({
  projectsRoot = DEFAULT_PROJECTS_ROOT,
  now = new Date(),
  activeWithinMs = 24 * 60 * 60 * 1000,
  composerHeadersById = new Map(),
  composerDataById = new Map(),
  decodeProjectSlug = decodeCursorProjectSlug,
  statSync = fs.statSync,
  readFileSync = fs.readFileSync,
  readdirSync = fs.readdirSync,
  existsSync = fs.existsSync
} = {}) {
  const fsImpl = { existsSync, readdirSync, statSync, readFileSync };
  const sessions = [];
  const transcriptChatIds = new Set();

  if (!existsSync(projectsRoot)) {
    return sessions;
  }

  for (const slug of readdirSync(projectsRoot)) {
    const transcriptsRoot = path.join(projectsRoot, slug, 'agent-transcripts');
    if (!existsSync(transcriptsRoot)) continue;

    for (const chatId of readdirSync(transcriptsRoot)) {
      const transcriptPath = path.join(transcriptsRoot, chatId, `${chatId}.jsonl`);
      if (!existsSync(transcriptPath)) continue;

      let stat;
      try {
        stat = statSync(transcriptPath);
      } catch {
        continue;
      }

      const composerData = composerDataById.get(chatId);
      const nativeActivityAt = latestIsoString(
        composerData?.unfinishedRunAt,
        composerData?.lastUpdatedAt
      );
      const activityTime = Math.max(
        stat.mtimeMs,
        new Date(nativeActivityAt || 0).getTime()
      );
      const ageMs = now.getTime() - activityTime;
      if (ageMs > activeWithinMs) continue;

      const raw = readFileSync(transcriptPath, 'utf8');
      const parsed = parseAgentTranscript(raw);
      const composerHeader = composerHeadersById.get(chatId);
      if (composerHeader?.isArchived === true || composerHeader?.isSubagent === true) continue;
      const userStopped = parsed.endReason === 'user_stopped';
      const hasOpenNativeRun = Boolean(composerData?.unfinishedRunAt) && !userStopped;
      const hasNativeCompletion = composerData?.nativeStatus === 'completed';
      if (!parsed.hasExecution && !hasOpenNativeRun && !hasNativeCompletion) continue;

      transcriptChatIds.add(chatId);

      const executionPhase = hasOpenNativeRun
        ? 'active'
        : parsed.hasExecution
          ? parsed.executionPhase
          : 'succeeded';
      const displayTitle = composerHeader?.name || composerData?.name || parsed.title;
      const viewState = ['succeeded', 'failed'].includes(executionPhase)
        && typeof composerHeader?.hasUnreadMessages === 'boolean'
        ? (composerHeader.hasUnreadMessages ? 'unseen' : 'seen')
        : 'indeterminate';
      const status = executionPhase === 'active'
        ? 'running'
        : executionPhase === 'succeeded'
        ? viewState === 'unseen'
          ? 'completed_unseen'
          : viewState === 'seen'
            ? 'completed_seen'
            : 'unknown'
        : parsed.status;
      const statusReason = hasOpenNativeRun
        ? 'Cursor Agent 执行中'
        : executionPhase === 'succeeded'
        ? viewState === 'unseen'
          ? '一轮已完成，待你查看'
          : viewState === 'seen'
            ? '一轮已完成，已在 Cursor 查看'
            : parsed.progressHint
        : parsed.progressHint;

      const projectPath = resolveProjectPath({
        slug,
        parsed,
        fsImpl: {
          ...fsImpl,
          readdirSync: (target) => readdirSync(target)
        }
      }) || composerHeader?.projectPath || composerData?.projectPath || decodeProjectSlug(slug, fsImpl);

      const projectName = projectPath
        ? path.basename(projectPath)
        : slug;

      const lastActivityAt = latestIsoString(
        new Date(stat.mtimeMs).toISOString(),
        composerHeader?.lastUpdatedAt,
        composerData?.lastUpdatedAt,
        composerData?.unfinishedRunAt
      );
      const transcriptEndedAt = ['succeeded', 'failed'].includes(parsed.executionPhase)
        ? parsed.endedAt || toIsoString(parsed.lines.at(-1)?.timestamp)
        : '';
      const endedAt = ['succeeded', 'failed'].includes(executionPhase)
        ? transcriptEndedAt || (
          hasNativeCompletion || userStopped
            ? composerData?.lastUpdatedAt || ''
            : executionPhase === 'failed'
              ? new Date(stat.mtimeMs).toISOString()
              : ''
        )
        : '';
      const signalSource = [
        'cursor-agent-transcript',
        composerData ? 'cursor-composer-data' : '',
        viewState === 'indeterminate' ? '' : 'cursor-composer-header'
      ].filter(Boolean).join('+');

      sessions.push({
        id: `cursor-agent:${slug}:${chatId}`,
        tool: 'Cursor Agent',
        toolId: 'cursor-agent',
        appName: 'Cursor',
        source: 'cursor-agent',
        title: displayTitle,
        projectName,
        projectPath,
        status,
        statusReason,
        attentionReason: statusReason,
        lastActivityAt,
        endedAt,
        statusFacts: {
          hasExecution: true,
          executionPhase,
          viewState,
          ...(parsed.endReason ? { endReason: parsed.endReason } : {}),
          nativeStatus: composerData?.nativeStatus || composerHeader?.nativeStatus || parsed.status || '',
          signalSource,
          signalObservedAt: lastActivityAt
        },
        process: null,
        window: null,
        agent: {
          chatId,
          slug,
          name: composerHeader?.name || '',
          subtitle: composerHeader?.subtitle || '',
          turnCount: parsed.turnCount,
          progressHint: parsed.progressHint,
          transcriptPath
        },
        jump: {
          canActivateApp: true,
          canOpenProject: Boolean(projectPath),
          canCopyPath: Boolean(projectPath)
        }
      });
    }
  }

  for (const [chatId, composerHeader] of composerHeadersById.entries()) {
    if (transcriptChatIds.has(chatId)) continue;
    if (composerHeader?.isArchived === true || composerHeader?.isSubagent === true) continue;

    const composerData = composerDataById.get(chatId);
    const hasOpenNativeRun = Boolean(composerData?.unfinishedRunAt);
    const hasNativeCompletion = composerData?.nativeStatus === 'completed';
    if (!hasOpenNativeRun && !hasNativeCompletion) continue;

    const lastActivityAt = latestIsoString(
      composerData?.unfinishedRunAt,
      composerData?.lastUpdatedAt
    );
    const ageMs = now.getTime() - new Date(lastActivityAt || 0).getTime();
    if (!lastActivityAt || ageMs > activeWithinMs) continue;

    const projectPath = composerHeader?.projectPath || composerData?.projectPath || '';
    const projectName = projectPath ? path.basename(projectPath) : '未知项目';
    const slug = cursorProjectSlug(projectPath) || 'native';
    const executionPhase = hasOpenNativeRun ? 'active' : 'succeeded';
    const viewState = executionPhase === 'succeeded'
      && typeof composerHeader?.hasUnreadMessages === 'boolean'
      ? (composerHeader.hasUnreadMessages ? 'unseen' : 'seen')
      : 'indeterminate';
    const status = executionPhase === 'active'
      ? 'running'
      : viewState === 'unseen'
        ? 'completed_unseen'
        : viewState === 'seen'
          ? 'completed_seen'
          : 'unknown';
    const statusReason = executionPhase === 'active'
      ? 'Cursor Agent 执行中'
      : viewState === 'unseen'
        ? '一轮已完成，待你查看'
        : viewState === 'seen'
          ? '一轮已完成，已在 Cursor 查看'
          : '一轮已完成，查看状态未知';

    sessions.push({
      id: `cursor-agent:${slug}:${chatId}`,
      tool: 'Cursor Agent',
      toolId: 'cursor-agent',
      appName: 'Cursor',
      source: 'cursor-agent',
      title: composerHeader?.name || composerData?.name || 'Cursor Agent',
      projectName,
      projectPath,
      status,
      statusReason,
      attentionReason: statusReason,
      lastActivityAt,
      endedAt: executionPhase === 'succeeded' ? composerData?.lastUpdatedAt || '' : '',
      statusFacts: {
        hasExecution: true,
        executionPhase,
        viewState,
        nativeStatus: composerData?.nativeStatus || composerHeader?.nativeStatus || '',
        signalSource: `cursor-composer-data${viewState === 'indeterminate' ? '' : '+cursor-composer-header'}`,
        signalObservedAt: lastActivityAt
      },
      process: null,
      window: null,
      agent: {
        chatId,
        slug,
        name: composerHeader?.name || composerData?.name || '',
        subtitle: composerHeader?.subtitle || '',
        turnCount: 0,
        progressHint: statusReason,
        transcriptPath: ''
      },
      jump: {
        canActivateApp: true,
        canOpenProject: Boolean(projectPath),
        canCopyPath: Boolean(projectPath)
      }
    });
  }

  return sessions;
}

export async function scanCursorAgents(options = {}) {
  try {
    const [composerHeadersById, composerDataById] = await Promise.all([
      options.composerHeadersById || loadComposerHeaders(options),
      options.composerDataById || loadComposerData(options)
    ]);

    return {
      sessions: buildAgentSessions({
        ...options,
        composerHeadersById,
        composerDataById
      }),
      errors: []
    };
  } catch (error) {
    return {
      sessions: [],
      errors: [`Cursor Agent 扫描失败：${error.message}`]
    };
  }
}
