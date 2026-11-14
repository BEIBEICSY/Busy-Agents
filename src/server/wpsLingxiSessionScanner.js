import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { readChromiumLocalStorage } from './chromiumLocalStorage.js';
import { withStatusFacts } from './statusModel.js';
import { loadLingxiRolloutRecords, DEFAULT_LINGXI_STATE_ROOT } from './lingxiRolloutReader.js';

const DEFAULT_PARTITIONS_ROOT = path.join(
  os.homedir(),
  'Library/Application Support/WPS 灵犀/Partitions'
);
const DEFAULT_CACHE_ROOT = path.join(
  os.homedir(),
  'Library/Application Support/WPS 灵犀/Partitions/lingxi.wps.cn/Cache/Cache_Data'
);
const DEFAULT_LEVELDB_ROOT = path.join(
  os.homedir(),
  'Library/Application Support/WPS 灵犀/Partitions/lingxi.wps.cn/Local Storage/leveldb'
);
const DEFAULT_LINGXI_LOG_ROOT = path.join(os.homedir(), 'Library/Logs/WPS 灵犀/app');
const SESSION_LIST_READ_STATUS = /session_id\\":\\"(\d+)\\"(?:(?!session_id\\":\\")[\s\S]){0,900}?read_status\\":\\"(read|completed|failed)\\"/g;

function lingxiSessionDetailCacheName(sessionId) {
  const key = `1/0/https://lingxi.wps.cn/api/public/v1/sessions/${sessionId}`;
  return `${createHash('sha1').update(key).digest().subarray(0, 8).reverse().toString('hex')}_0`;
}

function readBusinessSessionDetails(records, {
  partitionsRoot, existsSync, readdirSync, statSync, readFileSync, cutoffMs
}) {
  if (!partitionsRoot || !existsSync(partitionsRoot)) return [];
  const sessionIds = [...new Set(records
    .map((record) => String(record.session_id || '').trim())
    .filter((sessionId) => /^\d+$/.test(sessionId)))];
  if (sessionIds.length === 0) return [];
  let partitions = [];
  try {
    partitions = readdirSync(partitionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const details = [];
  for (const entry of partitions) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const isDirectory = typeof entry === 'string' || entry.isDirectory();
    if (!isDirectory || !/^lingxi-business-v2-/.test(name)) continue;
    const cacheData = path.join(partitionsRoot, name, 'Cache/Cache_Data');
    if (!existsSync(cacheData)) continue;
    for (const sessionId of sessionIds) {
      const filePath = path.join(cacheData, lingxiSessionDetailCacheName(sessionId));
      if (!existsSync(filePath)) continue;
      try {
        const stat = statSync(filePath);
        if (!stat.isFile() || stat.size > 5 * 1024 * 1024 || stat.mtimeMs < cutoffMs) continue;
        details.push(...extractLingxiCacheRecords(readFileSync(filePath)).map((record) => ({
          ...record,
          _cacheObservedAt: stat.mtimeMs,
          _lingxiSource: 'session-cache'
        })));
      } catch {
        // A missing or unreadable detail does not hide the execution record.
      }
    }
  }
  return details;
}

function parseLogTime(value) {
  const local = String(value || '').trim();
  if (!local) return 0;
  const iso = /^\d{4}\/\d{2}\/\d{2} /.test(local)
    ? local.replaceAll('/', '-').replace(' ', 'T')
    : local;
  const parsed = new Date(iso).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function readSessionListReadState(logRoot, { existsSync, readdirSync, readFileSync, statSync, cutoffMs }) {
  if (!logRoot || !existsSync(logRoot)) return [];
  let names = [];
  try {
    names = readdirSync(logRoot).filter((name) => /^app\..*\.log$/.test(name) || name === 'app.log');
  } catch {
    return [];
  }
  const latest = new Map();
  for (const name of names) {
    const filePath = path.join(logRoot, name);
    let stat;
    try { stat = statSync(filePath); } catch { continue; }
    if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024 || stat.mtimeMs < cutoffMs) continue;
    let text = '';
    try { text = readFileSync(filePath, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"method":"session/list"') || !line.includes('request_completed')) continue;
      const observedAt = parseLogTime(line.match(/"time":"([^"]+)"/)?.[1]);
      if (!observedAt || observedAt < cutoffMs) continue;
      SESSION_LIST_READ_STATUS.lastIndex = 0;
      for (const match of line.matchAll(SESSION_LIST_READ_STATUS)) {
        const sessionId = match[1];
        const readStatus = match[2];
        const current = latest.get(sessionId);
        if (!current || observedAt >= current.observedAt) latest.set(sessionId, { readStatus, observedAt });
      }
    }
  }
  return [...latest].map(([sessionId, state]) => ({
    session_id: sessionId,
    read_status: state.readStatus,
    update_time: state.observedAt,
    _cacheObservedAt: state.observedAt,
    _lingxiSource: 'session-list'
  }));
}

const LINGXI_EXECUTION_SOURCES = new Set(['app-server-rollout', 'telemetry', 'app-log-completion']);

export function extractLingxiBackgroundCompletions(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const completions = new Map();
  const failureShows = new Map();
  for (const line of text.split('\n')) {
    if (!line.includes('"event":"background_session_notify"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.event !== 'background_session_notify') continue;
    const sessionId = String(event.sessionId || '').trim();
    if (!/^\d+$/.test(sessionId)) continue;
    const observedAt = timestampMs(event.timestamp) || parseLogTime(event.time);
    if (!observedAt) continue;
    if (event.step === 'messages_completion_parsed') {
      const terminalEvent = String(event.terminalEvent || '').trim();
      if (!terminalEvent) continue;
      const current = completions.get(sessionId);
      if (!current || observedAt >= current.observedAt) {
        completions.set(sessionId, { observedAt, terminalEvent });
      }
    } else if (event.step === 'notify_completion_show' && event.isFailed === true) {
      const current = failureShows.get(sessionId) || 0;
      if (observedAt >= current) failureShows.set(sessionId, observedAt);
    }
  }

  return [...completions].flatMap(([sessionId, completion]) => {
    const failureAt = failureShows.get(sessionId) || 0;
    const failed = /error|fail|cancel|interrupt|abort/i.test(completion.terminalEvent)
      || (failureAt >= completion.observedAt - 5000 && failureAt <= completion.observedAt + 15000);
    const succeeded = completion.terminalEvent === 'run.end' && !failed;
    if (!failed && !succeeded) return [];
    return [{
      session_id: sessionId,
      update_time: completion.observedAt,
      ended_at: completion.observedAt,
      status: failed ? 'failed' : 'completed',
      hasExecution: true,
      native_status: `background-notify/${completion.terminalEvent}/${failed ? 'failed' : 'success'}`,
      _lingxiSource: 'app-log-completion'
    }];
  });
}

function readLingxiBackgroundCompletions(logRoot, { existsSync, readdirSync, readFileSync, statSync, cutoffMs }) {
  if (!logRoot || !existsSync(logRoot)) return [];
  let names = [];
  try {
    names = readdirSync(logRoot).filter((name) => /^app\..*\.log$/.test(name) || name === 'app.log');
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    const filePath = path.join(logRoot, name);
    let stat;
    try { stat = statSync(filePath); } catch { continue; }
    if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024 || stat.mtimeMs < cutoffMs) continue;
    let text = '';
    try { text = readFileSync(filePath, 'utf8'); } catch { continue; }
    records.push(...extractLingxiBackgroundCompletions(text).filter((record) => timestampMs(record.update_time) >= cutoffMs));
  }
  return records;
}

function timestampMs(value) {
  const number = Number(value || 0);
  if (Number.isFinite(number) && number > 0) {
    return number < 100000000000 ? number * 1000 : number;
  }
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function findJsonEnd(raw, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

export function extractLingxiRecords(raw) {
  const source = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const records = [];
  const fingerprints = new Set();
  let markerIndex = source.indexOf('"session_id"');

  while (markerIndex >= 0) {
    const minimum = Math.max(0, markerIndex - 262144);
    let start = source.lastIndexOf('{', markerIndex);
    while (start >= minimum) {
      const end = findJsonEnd(source, start);
      if (end > markerIndex) {
        try {
          const value = JSON.parse(source.slice(start, end));
          if (value && typeof value === 'object' && value.session_id) {
            const fingerprint = `${value.session_id}:${value.update_time || ''}:${value.read_status || ''}:${value.session_status || value.status || ''}:${value.session_title || value.title || ''}`;
            if (!fingerprints.has(fingerprint)) {
              fingerprints.add(fingerprint);
              records.push(value);
            }
            break;
          }
        } catch {
          // Keep walking outwards until the containing response object is found.
        }
      }
      start = source.lastIndexOf('{', start - 1);
    }
    markerIndex = source.indexOf('"session_id"', markerIndex + 12);
  }

  return records;
}

export function extractLingxiCacheRecords(raw) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
  const records = extractLingxiRecords(buffer);

  if (buffer.length < 24 || !buffer.includes(Buffer.from('Content-Encoding: br'))) return records;

  try {
    const keyLength = buffer.readUInt32LE(12);
    const bodyOffset = 24 + keyLength;
    if (keyLength <= 0 || bodyOffset >= buffer.length) return records;
    records.push(...extractLingxiRecords(brotliDecompressSync(buffer.subarray(bodyOffset))));
  } catch {
    // Ignore partial or unsupported cache entries; other sources remain available.
  }

  const unique = new Map();
  for (const record of records) {
    const fingerprint = `${record.session_id}:${record.update_time || ''}:${record.read_status || ''}:${record.session_status || record.status || ''}:${record.session_title || record.title || ''}`;
    unique.set(fingerprint, record);
  }
  return [...unique.values()];
}

export function extractLingxiTelemetryEvents(raw) {
  const source = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const events = [];
  const fingerprints = new Set();
  const marker = '"name":"lxai_claw_';
  let markerIndex = source.indexOf(marker);

  while (markerIndex >= 0) {
    const minimum = Math.max(0, markerIndex - 65536);
    let start = source.lastIndexOf('{', markerIndex);
    while (start >= minimum) {
      const end = findJsonEnd(source, start);
      if (end > markerIndex) {
        try {
          const value = JSON.parse(source.slice(start, end));
          const name = String(value?.name || '');
          const sessionId = String(value?.data?.session_id || value?.data?.sessionId || '').trim();
          if (name.startsWith('lxai_claw_') && sessionId) {
            const fingerprint = [
              value.id || '',
              name,
              sessionId,
              value.remoteTime || value.localTime || '',
              value.data?.message_id || '',
              value.data?.request_way || '',
              value.data?.result || ''
            ].join(':');
            if (!fingerprints.has(fingerprint)) {
              fingerprints.add(fingerprint);
              events.push(value);
            }
            break;
          }
        } catch {
          // LevelDB values have binary framing; continue to the containing object.
        }
      }
      start = source.lastIndexOf('{', start - 1);
    }
    markerIndex = source.indexOf(marker, markerIndex + marker.length);
  }

  return events;
}

function telemetryEventTime(event) {
  return event?.remoteTime || event?.localTime || event?.timestamp || 0;
}

export function buildLingxiTelemetryRecords(events) {
  return events.map((event) => {
    const name = String(event?.name || '').trim().toLowerCase();
    const data = event?.data && typeof event.data === 'object' ? event.data : {};
    const sessionId = String(data.session_id || data.sessionId || '').trim();
    if (!sessionId) return null;

    if (name === 'lxai_claw_createrequest') {
      return {
        session_id: sessionId,
        update_time: telemetryEventTime(event),
        status: 'Running',
        hasExecution: true,
        native_status: `createrequest/${data.request_way || 'main'}`,
        _lingxiSource: 'telemetry'
      };
    }

    if (name !== 'lxai_claw_requestresult') return null;

    const result = String(data.result || '').trim().toLowerCase();
    const stopReason = String(data.stop_reason || '').trim().toLowerCase();
    const processSteps = String(data.process_step || '').trim().toLowerCase();
    const waitingForUser = /(?:^|,)c_(?:ask_user_question|bash_auth|permission)(?:,|$)/.test(processSteps);
    const failed = ['fail', 'failed', 'error', 'cancelled', 'canceled', 'stopped', 'interrupted'].includes(result)
      || ['fail', 'failed', 'error', 'cancelled', 'canceled', 'stopped', 'interrupted'].includes(stopReason);
    const succeeded = result === 'success'
      || ['finish', 'finished', 'success', 'succeeded', 'completed', 'end_turn'].includes(stopReason);

    return {
      session_id: sessionId,
      update_time: telemetryEventTime(event),
      status: waitingForUser && !failed
        ? 'Done'
        : failed
          ? 'failed'
          : succeeded
            ? 'completed'
            : 'Done',
      hasExecution: true,
      hasUnresolvedInteraction: waitingForUser && !failed,
      native_status: `requestresult/${result || 'unknown'}/${stopReason || 'unknown'}`,
      _lingxiSource: 'telemetry'
    };
  }).filter(Boolean);
}

function nativePhase(record) {
  if (!record) return 'unknown';
  const status = String(record.status ?? record.session_status ?? '').trim().toLowerCase();
  if (record.inStream === true || record.inRequest === true || status === 'running') return 'active';
  if (['failed', 'error', 'cancelled', 'canceled', 'stopped', 'interrupted'].includes(status)) return 'failed';
  if (['completed', 'success', 'succeeded'].includes(status)) return 'succeeded';
  return 'unknown';
}

function hasUnresolvedInteraction(record) {
  if (record?.hasUnresolvedInteraction === true) return true;
  const blocks = record.interactionBlocks || record.blocks || [];
  if (!Array.isArray(blocks)) return false;
  const waitingTypes = new Set(['c_ask_user_question', 'c_bash_auth', 'c_permission']);
  return blocks.some((block) => waitingTypes.has(block?.type) && block?.resolved !== true);
}

export function buildLingxiSessions(records, { now = new Date() } = {}) {
  const sessionListAvailable = records.some((record) => record._lingxiSource === 'session-list');
  const grouped = new Map();
  for (const record of records) {
    const id = String(record.session_id || '').trim();
    if (!id) continue;
    const current = grouped.get(id) || [];
    current.push(record);
    grouped.set(id, current);
  }

  const sessions = [];
  for (const [sessionId, history] of grouped) {
    history.sort((a, b) => timestampMs(a.update_time) - timestampMs(b.update_time));
    const latest = history[history.length - 1];
    const executionRecord = [...history].reverse().find((item) =>
      LINGXI_EXECUTION_SOURCES.has(item._lingxiSource)
    );
    const latestTime = timestampMs(latest.update_time || latest.create_time) || now.getTime();
    const explicitPhase = nativePhase(latest);
    const terminalRecord = [...history].reverse().find((item) => {
      const readStatus = String(item.read_status || '').toLowerCase();
      return readStatus === 'completed' || readStatus === 'failed' || ['succeeded', 'failed'].includes(nativePhase(item));
    });
    const terminalReadStatus = String(terminalRecord?.read_status || '').toLowerCase();
    const terminalTime = timestampMs(terminalRecord?.update_time || terminalRecord?.create_time);

    let executionPhase = 'unknown';
    const isStreaming = latest.inStream === true || latest.inRequest === true;
    if (hasUnresolvedInteraction(latest) && !isStreaming) executionPhase = 'waiting_user';
    else if (explicitPhase === 'active') executionPhase = 'active';
    else if (terminalReadStatus === 'failed' || nativePhase(terminalRecord) === 'failed') executionPhase = 'failed';
    else if (terminalReadStatus === 'completed' || nativePhase(terminalRecord) === 'succeeded') executionPhase = 'succeeded';
    if (executionRecord) {
      executionPhase = hasUnresolvedInteraction(executionRecord) ? 'waiting_user' : nativePhase(executionRecord);
    }

    const hasExecution = executionPhase !== 'unknown' || history.some((item) => item.hasExecution === true);
    if (!hasExecution) continue;

    const viewRecord = history
      .filter((item) => {
        const readStatus = String(item.read_status || '').toLowerCase();
        // Completion-time caches can retain an old unread dot. A later explicit
        // read detail is useful evidence; compare its observation time with the
        // list, rather than its unchanged session update_time.
        if (sessionListAvailable && item._lingxiSource !== 'session-list'
          && !(item._lingxiSource === 'session-cache' && readStatus === 'read')) return false;
        if (!['completed', 'failed', 'read'].includes(readStatus)) return false;
        const observedAt = timestampMs(item._cacheObservedAt || item.update_time || item.create_time);
        const endTime = executionRecord
          ? timestampMs(executionRecord.ended_at)
            || (['succeeded', 'failed'].includes(nativePhase(executionRecord)) ? timestampMs(executionRecord.update_time) : 0)
          : terminalTime;
        return !endTime || observedAt >= endTime - 5000;
      })
      .sort((a, b) => (
        timestampMs(a._cacheObservedAt || a.update_time || a.create_time)
        - timestampMs(b._cacheObservedAt || b.update_time || b.create_time)
      ))
      .at(-1);
    const readStatus = String(viewRecord?.read_status || '').toLowerCase();
    const viewState = executionPhase === 'succeeded'
      ? (readStatus === 'completed' ? 'unseen' : readStatus === 'read' ? 'seen' : 'indeterminate')
      : executionPhase === 'failed'
        ? readStatus === 'failed' ? 'unseen' : readStatus === 'read' ? 'seen' : 'indeterminate'
        : 'indeterminate';
    const cachedMetadata = [...history].reverse().find((item) => item._lingxiSource === 'session-cache' && (item.session_title || item.title));
    const metadataRecord = cachedMetadata || [...history].reverse().find((item) => item.session_title || item.title || item.project_path || item.cwd) || latest;
    const projectPath = String(metadataRecord.project_path || metadataRecord.cwd || '').trim();
    const hasTelemetry = history.some((item) => item._lingxiSource === 'telemetry');
    const hasSessionCache = history.some((item) => item._lingxiSource === 'session-cache' || !item._lingxiSource);
    const hasSessionList = history.some((item) => item._lingxiSource === 'session-list');
    const signalSource = `${executionRecord?._lingxiSource === 'app-server-rollout'
      ? `wps-lingxi-app-server-rollout${hasSessionCache ? '+session-cache' : ''}`
      : executionRecord?._lingxiSource === 'app-log-completion'
        ? `wps-lingxi-app-log${hasTelemetry ? '+telemetry' : ''}${hasSessionCache ? '+session-cache' : ''}`
      : hasTelemetry && hasSessionCache
      ? 'wps-lingxi-local-telemetry+wps-lingxi-session-cache'
      : hasTelemetry
        ? 'wps-lingxi-local-telemetry'
        : 'wps-lingxi-session-cache'}${hasSessionList ? '+session-list' : ''}`;
    const statusReason = executionPhase === 'waiting_user'
      ? 'WPS 灵犀正在等待你的输入'
      : executionPhase === 'active'
        ? 'WPS 灵犀任务正在执行'
        : executionPhase === 'succeeded' && viewState === 'unseen'
          ? 'WPS 灵犀任务已完成，待你查看'
          : executionPhase === 'succeeded' && viewState === 'seen'
            ? 'WPS 灵犀任务已完成，已在 WPS 灵犀查看'
            : executionPhase === 'succeeded'
              ? 'WPS 灵犀任务已完成，查看状态未知'
              : executionPhase === 'failed'
                ? 'WPS 灵犀任务异常结束'
                : 'WPS 灵犀任务已执行，终态未知';

    const session = withStatusFacts({
      id: `wps-lingxi:${sessionId}`,
      tool: 'WPS灵犀·Desktop',
      toolId: 'wps-lingxi-desktop',
      appName: 'WPS 灵犀',
      source: executionRecord || hasTelemetry ? 'wps-lingxi-local' : 'wps-lingxi-cache',
      title: String(metadataRecord.session_title || metadataRecord.title || '').trim() || 'WPS 灵犀任务',
      projectName: projectPath ? path.basename(projectPath) : '未知项目',
      projectPath,
      lastActivityAt: new Date(latestTime).toISOString(),
      jump: {
        canActivateApp: true,
        canOpenProject: Boolean(projectPath),
        canCopyPath: Boolean(projectPath)
      }
    }, {
      hasExecution,
      executionPhase,
      endedAt: ['succeeded', 'failed'].includes(executionPhase)
        ? timestampMs(executionRecord?.ended_at)
          ? new Date(timestampMs(executionRecord.ended_at)).toISOString()
          : executionRecord?._lingxiSource === 'telemetry' && timestampMs(executionRecord.update_time)
            ? new Date(timestampMs(executionRecord.update_time)).toISOString()
            : !executionRecord && terminalRecord?._lingxiSource === 'telemetry' && terminalTime > 0
              ? new Date(terminalTime).toISOString() : ''
        : '',
      viewState,
      nativeStatus: executionRecord?.native_status || latest.native_status || `${latest.session_status ?? latest.status ?? ''}/${readStatus}`,
      statusReason,
      signalSource,
      signalObservedAt: new Date(executionRecord ? timestampMs(executionRecord.update_time) : latestTime).toISOString()
    });
    if (session) sessions.push(session);
  }
  return sessions;
}

export async function scanWpsLingxi(options = {}) {
  const cacheRoot = options.cacheRoot || DEFAULT_CACHE_ROOT;
  const levelDbRoot = options.levelDbRoot || DEFAULT_LEVELDB_ROOT;
  const existsSync = options.existsSync || fs.existsSync;
  const readdirSync = options.readdirSync || fs.readdirSync;
  const statSync = options.statSync || fs.statSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const now = options.now || new Date();
  const partitionsRoot = options.partitionsRoot
    ?? (options.cacheRoot || options.levelDbRoot ? '' : DEFAULT_PARTITIONS_ROOT);
  const readLocalStorage = options.readChromiumLocalStorage || readChromiumLocalStorage;
  const appServerStateRoot = options.appServerStateRoot
    ?? (options.cacheRoot || options.levelDbRoot ? '' : DEFAULT_LINGXI_STATE_ROOT);
  const logRoot = options.logRoot ?? (
    options.cacheRoot || options.levelDbRoot || options.partitionsRoot || options.appServerStateRoot
      ? ''
      : DEFAULT_LINGXI_LOG_ROOT
  );
  if (!existsSync(cacheRoot) && !existsSync(levelDbRoot)
    && !existsSync(appServerStateRoot) && !existsSync(partitionsRoot)) return { sessions: [], errors: [] };

  const native = appServerStateRoot
    ? await (options.loadRolloutRecords || loadLingxiRolloutRecords)({ ...options, now, appServerStateRoot })
      .catch(() => ({ records: [], errors: ['灵犀新版执行记录扫描失败'] }))
    : { records: [], errors: [] };

  try {
    const cutoffMs = now.getTime() - (Number(options.lookbackDays || 7) + 1) * 86400000;
    const files = existsSync(cacheRoot) ? readdirSync(cacheRoot)
      .map((name) => {
        const filePath = path.join(cacheRoot, name);
        try {
          const stat = statSync(filePath);
          return stat.isFile() && stat.size <= 5 * 1024 * 1024 && stat.mtimeMs >= cutoffMs
            ? { filePath, mtimeMs: stat.mtimeMs }
            : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Number(options.maxFiles || 2000)) : [];

    const records = [];
    for (const file of files) {
      const raw = readFileSync(file.filePath);
      if (!raw.includes(Buffer.from('"session_id"')) && !raw.includes(Buffer.from('Content-Encoding: br'))) continue;
      records.push(...extractLingxiCacheRecords(raw).map((record) => ({
        ...record,
        _cacheObservedAt: file.mtimeMs,
        _lingxiSource: 'session-cache'
      })));
    }

    const telemetryEvents = [];
    const levelDbFiles = existsSync(levelDbRoot) ? readdirSync(levelDbRoot)
      .filter((name) => /\.(?:log|ldb)$/.test(name))
      .map((name) => {
        const filePath = path.join(levelDbRoot, name);
        try {
          const stat = statSync(filePath);
          return stat.isFile() && stat.size <= 10 * 1024 * 1024 && stat.mtimeMs >= cutoffMs
            ? { filePath, mtimeMs: stat.mtimeMs }
            : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Number(options.maxLevelDbFiles || 100)) : [];

    for (const file of levelDbFiles) {
      const raw = readFileSync(file.filePath);
      if (!raw.includes(Buffer.from('"name":"lxai_claw_'))) continue;
      telemetryEvents.push(...extractLingxiTelemetryEvents(raw));
    }

    const businessErrors = [];
    if (existsSync(partitionsRoot)) {
      let partitions = [];
      try {
        partitions = readdirSync(partitionsRoot, { withFileTypes: true });
      } catch {
        businessErrors.push('灵犀新版生命周期存储读取失败');
      }
      for (const entry of partitions) {
        const name = typeof entry === 'string' ? entry : entry.name;
        const isDirectory = typeof entry === 'string' || entry.isDirectory();
        if (!isDirectory || !/^lingxi-business-v2-/.test(name)) continue;
        const businessLevelDbRoot = path.join(partitionsRoot, name, 'Local Storage/leveldb');
        if (!existsSync(businessLevelDbRoot)) continue;
        const snapshot = readLocalStorage(businessLevelDbRoot, [], {
          origins: ['https://lingxi.wps.cn'],
          keyPrefixes: ['dw_store_queen_data_events_']
        });
        if (!snapshot.available) {
          businessErrors.push('灵犀新版生命周期存储读取失败');
          continue;
        }
        for (const raw of snapshot.values.values()) {
          telemetryEvents.push(...extractLingxiTelemetryEvents(raw));
        }
      }
    }
    records.push(...buildLingxiTelemetryRecords(telemetryEvents).filter((record) => {
      const observedAt = timestampMs(record.update_time);
      return observedAt >= cutoffMs;
    }));

    records.push(...native.records);
    records.push(...readSessionListReadState(logRoot, {
      existsSync, readdirSync, readFileSync, statSync, cutoffMs
    }));
    records.push(...readLingxiBackgroundCompletions(logRoot, {
      existsSync, readdirSync, readFileSync, statSync, cutoffMs
    }));
    // Log-only sessions also need their native title and current read marker.
    // Discover every session ID before looking up its targeted detail cache.
    records.push(...readBusinessSessionDetails(records, {
      partitionsRoot, existsSync, readdirSync, statSync, readFileSync, cutoffMs
    }));
    return { sessions: buildLingxiSessions(records, { now }), errors: [...native.errors, ...new Set(businessErrors)] };
  } catch (error) {
    return { sessions: buildLingxiSessions(native.records, { now }), errors: [...native.errors, `WPS 灵犀旧版缓存扫描失败：${error.code || '读取错误'}`] };
  }
}
