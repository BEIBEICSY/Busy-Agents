import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand as defaultRunCommand } from './shell.js';
import { withStatusFacts } from './statusModel.js';

const FIELD_SEPARATOR = '\u001f';
const PRODUCT_DEFINITIONS = {
  trae: {
    tool: 'Trae·IDE',
    toolId: 'trae-ide',
    appName: 'Trae',
    dataRoot: path.join(os.homedir(), 'Library/Application Support/Trae'),
    aliases: ['trae', 'trae ide']
  },
  traework: {
    tool: 'TraeWork·Desktop',
    toolId: 'traework-desktop',
    appName: 'TRAE SOLO CN',
    dataRoot: path.join(os.homedir(), 'Library/Application Support/TRAE SOLO CN'),
    aliases: ['traework', 'trae work', 'trae solo', 'trae solo cn', 'trae work cn']
  }
};

const DEFAULT_EVENT_PATHS = [
  path.join(os.homedir(), 'Library/Application Support/DesktopPet/trae_ai_task_events.jsonl'),
  path.join(os.homedir(), 'Library/Application Support/DesktopPet/trae_hook_debug.jsonl')
];

function timestampMs(value) {
  const number = Number(value || 0);
  if (Number.isFinite(number) && number > 0) {
    return number < 100000000000 ? number * 1000 : number;
  }
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function parsePayload(event) {
  if (event?.payload && typeof event.payload === 'object') return { ...event.payload, event: event.event };
  return event || {};
}

function productMatches(event, definition, productKey) {
  const product = String(
    event.product || event.toolName || event.tool || event.client || event.app || ''
  ).trim().toLowerCase();
  if (!product) return productKey === 'trae';
  const isTraeWork = PRODUCT_DEFINITIONS.traework.aliases.some((alias) => product.includes(alias));
  if (isTraeWork) return productKey === 'traework';
  return definition.aliases.some((alias) => product.includes(alias));
}

export function parseTraeEvents(raw, { product = 'trae' } = {}) {
  const definition = PRODUCT_DEFINITIONS[product] || PRODUCT_DEFINITIONS.trae;
  return String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        const envelope = JSON.parse(line);
        const item = parsePayload(envelope);
        if (!productMatches(item, definition, product)) return null;
        return {
          ...item,
          _sequence: index,
          _timestampMs: timestampMs(item.timestamp || item.time || item.createdAt || envelope.timestamp)
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function eventName(event) {
  return String(event.event || event.type || event.name || event.phase || '').trim().toLowerCase();
}

function notificationType(event) {
  return String(event.notification_type || event.notificationType || event.message_type || event.phase || '').trim().toLowerCase();
}

function sessionIdFor(event) {
  return String(event.session_id || event.sessionId || event.conversation_id || event.conversationId || '').trim();
}

function phaseForEvent(event) {
  const name = eventName(event);
  const notification = notificationType(event);
  const nativeStatus = String(event.status || event.runningStatus || event.running_status || event.phase || '').trim().toLowerCase();

  if (
    ['waitinginput', 'waiting_input', 'awaiting_input', 'needs_input'].includes(nativeStatus)
    || ['permission_prompt', 'document_review', 'ask_user_question', 'browser_interaction'].includes(notification)
    || /askuser|waitinginput|permissionprompt/.test(name)
  ) return 'waiting_user';

  if (
    notification === 'idle_prompt'
    || ['completed', 'complete', 'success', 'succeeded', 'finished'].includes(nativeStatus)
  ) return 'succeeded';

  if (
    ['failed', 'error', 'canceled', 'cancelled', 'interrupted', 'aborted'].includes(nativeStatus)
    || /session(error|failed|cancel)|run(error|failed|cancel)/.test(name)
  ) return 'failed';

  if (
    ['running', 'pending', 'in_progress', 'queuing', 'queued', 'sending', 'intentrecognizing', 'wait-ai-response', 'ai-generate-ing', 'triggered'].includes(nativeStatus)
    || ['userpromptsubmit', 'pretooluse', 'posttooluse'].includes(name.replaceAll('_', ''))
  ) return 'active';

  // A Stop hook may be blocked and followed by more work. It proves execution,
  // but does not prove successful completion.
  if (name.replaceAll('_', '') === 'stop') return 'unknown';
  return 'unknown';
}

function provesExecution(event) {
  const name = eventName(event).replaceAll('_', '');
  if (name === 'sessionstart') return false;
  if (['userpromptsubmit', 'pretooluse', 'posttooluse', 'stop'].includes(name)) return true;
  return phaseForEvent(event) !== 'unknown'
    || ['completed', 'failed', 'triggered'].includes(String(event.phase || '').toLowerCase());
}

function idsFromBadges(value, target = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => idsFromBadges(item, target));
  } else if (value && typeof value === 'object') {
    if (typeof value.sessionId === 'string') target.add(value.sessionId);
    if (typeof value.session_id === 'string') target.add(value.session_id);
    Object.values(value).forEach((item) => idsFromBadges(item, target));
  }
  return target;
}

export function parseTraeBadgeRows(raw) {
  const ids = new Set();
  for (const line of String(raw || '').split('\n')) {
    const [, encoded] = line.split(FIELD_SEPARATOR);
    try {
      idsFromBadges(JSON.parse(Buffer.from(encoded || '', 'hex').toString('utf8')), ids);
    } catch {
      // Ignore a corrupt or version-incompatible badge value.
    }
  }
  return ids;
}

export async function loadTraeBadges({ dataRoot, existsSync = fs.existsSync, runCommand = defaultRunCommand } = {}) {
  const dbPath = path.join(dataRoot, 'User/globalStorage/state.vscdb');
  if (!existsSync(dbPath)) return { loaded: false, unreadIds: new Set(), error: '' };

  const result = await runCommand('sqlite3', [
    '-separator', FIELD_SEPARATOR, dbPath,
    "SELECT key, hex(value) FROM ItemTable WHERE key LIKE 'all_session_badges_%';"
  ], { timeoutMs: 4000 });

  return result.ok
    ? { loaded: true, unreadIds: parseTraeBadgeRows(result.stdout), error: '' }
    : { loaded: false, unreadIds: new Set(), error: result.error || result.stderr };
}

export function buildTraeSessions(events, {
  product = 'trae',
  badges = { loaded: false, unreadIds: new Set() },
  now = new Date(),
  lookbackDays = 7
} = {}) {
  const definition = PRODUCT_DEFINITIONS[product] || PRODUCT_DEFINITIONS.trae;
  const cutoffMs = now.getTime() - Math.max(1, Number(lookbackDays) || 7) * 86400000;
  const bySession = new Map();

  for (const event of events) {
    const sessionId = sessionIdFor(event);
    if (!sessionId) continue;
    const current = bySession.get(sessionId) || [];
    current.push(event);
    bySession.set(sessionId, current);
  }

  const sessions = [];
  for (const [sessionId, sessionEvents] of bySession) {
    sessionEvents.sort((a, b) => a._timestampMs - b._timestampMs || a._sequence - b._sequence);
    const executed = sessionEvents.filter(provesExecution);
    if (!executed.length) continue;

    const latest = executed[executed.length - 1];
    const observedAtMs = latest._timestampMs || 0;
    if (observedAtMs && observedAtMs < cutoffMs) continue;
    const executionPhase = phaseForEvent(latest);
    const viewState = executionPhase === 'succeeded' && badges.loaded
      ? (badges.unreadIds.has(sessionId) ? 'unseen' : 'seen')
      : 'indeterminate';
    const latestWithWorkspace = [...sessionEvents].reverse().find((event) => event.workspace || event.cwd || event.projectPath) || latest;
    const latestWithTitle = [...sessionEvents].reverse().find((event) => event.prompt || event.title || event.detail) || latest;
    const projectPath = String(latestWithWorkspace.workspace || latestWithWorkspace.cwd || latestWithWorkspace.projectPath || '').trim();
    const title = String(latestWithTitle.prompt || latestWithTitle.title || latestWithTitle.detail || '').trim();

    const session = withStatusFacts({
      id: `${definition.toolId}:${sessionId}`,
      tool: definition.tool,
      toolId: definition.toolId,
      appName: definition.appName,
      source: `${definition.toolId}-hooks`,
      title: title || `${definition.tool} 任务`,
      projectName: projectPath ? path.basename(projectPath) : '未知项目',
      projectPath,
      lastActivityAt: new Date(observedAtMs || now.getTime()).toISOString(),
      jump: {
        canActivateApp: true,
        canOpenProject: Boolean(projectPath),
        canCopyPath: Boolean(projectPath)
      }
    }, {
      hasExecution: true,
      executionPhase,
      endedAt: ['succeeded', 'failed'].includes(executionPhase) && observedAtMs > 0 ? new Date(observedAtMs).toISOString() : '',
      viewState,
      nativeStatus: String(latest.status || latest.runningStatus || latest.phase || eventName(latest)),
      statusReason: executionPhase === 'waiting_user'
        ? 'Trae 正在等待你的操作'
        : executionPhase === 'failed'
          ? `Trae：${latest.status || latest.phase || eventName(latest)}`
          : executionPhase === 'unknown'
            ? '已执行，但缺少可确认的当前轮次状态'
            : '',
      signalSource: 'trae-hooks',
      signalObservedAt: new Date(observedAtMs || now.getTime()).toISOString()
    });
    if (session) sessions.push(session);
  }
  return sessions;
}

export async function scanTraeProduct(product = 'trae', options = {}) {
  const definition = PRODUCT_DEFINITIONS[product] || PRODUCT_DEFINITIONS.trae;
  const eventPaths = options.eventPaths || DEFAULT_EVENT_PATHS;
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  let events = [];

  for (const eventPath of eventPaths) {
    if (!existsSync(eventPath)) continue;
    try {
      events = events.concat(parseTraeEvents(readFileSync(eventPath, 'utf8'), { product }));
    } catch {
      // A partially written hook journal is optional evidence.
    }
  }

  const badges = options.badges || await loadTraeBadges({
    ...options,
    dataRoot: options.dataRoot || definition.dataRoot
  });

  return {
    sessions: buildTraeSessions(events, {
      product,
      badges,
      now: options.now || new Date(),
      lookbackDays: options.lookbackDays || 7
    }),
    errors: badges.error ? [`${definition.tool} 未读状态读取失败：${badges.error}`] : []
  };
}

export function scanTraeIde(options = {}) {
  return scanTraeProduct('trae', options);
}

export function scanTraeWork(options = {}) {
  return scanTraeProduct('traework', options);
}
