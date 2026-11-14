import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { projectJsonMetadata } from './jsonMetadata.js';

const fields = {
  id: true, session_id: true, group_id: true, type: true, create_time: true,
  session_type: true, parent_session_id: true, is_subagent: true,
  content: {
    id: true, group_id: true, run_id: true, type: true, component_type: true,
    operation_id: true, operation_type: true, request_id: true,
    code: true, reason: true, title: true, session_type: true, parent_session_id: true, is_subagent: true,
    AgentInput: { text: true }
  }
};
const supported = new Set([
  'user.input', 'run.start', 'run.end', 'run.cancelled', 'force.stop', 'error',
  'permission.request', 'permission.response', 'permission.resolved',
  'component.start', 'component.end', 'client.operation.start', 'client.operation.end',
  'session.title_updated', 'session.archived', 'session.deleted'
]);
const waitingTypes = new Set(['c_ask_user_question', 'c_bash_auth', 'c_permission']);
export const DEFAULT_LINGXI_STATE_ROOT = path.join(os.homedir(), 'Library/Application Support/WPS 灵犀/app-server-data/state/accounts');

export function createLingxiRolloutState(sessionId) {
  return { sessionId, title: '', hasUserInput: false, hasExecution: false, group: '', phase: 'unknown',
    updatedAt: 0, endedAt: 0, nativeStatus: '', waiting: new Set(), failed: false, excluded: false };
}

export function applyLingxiRolloutLine(state, line) {
  // Inspect only an envelope prefix before projecting. Component content and
  // assistant responses are skipped altogether; only one user input names the task.
  const type = line.slice(0, 2048).match(/"type"\s*:\s*"([^"]+)"/)?.[1];
  if (!supported.has(type)) return;
  let event;
  try {
    const selection = state.title
      ? { ...fields, content: { ...fields.content, AgentInput: undefined } } : fields;
    event = projectJsonMetadata(line, selection);
  } catch {
    // Long prompts need not be materialized to retain their execution envelope.
    if (type !== 'user.input') return;
    try { event = projectJsonMetadata(line, { ...fields, content: { ...fields.content, AgentInput: undefined } }); }
    catch { return; } // A concurrently appended partial last line is harmless.
  }
  if (event.session_id !== state.sessionId || event.type !== type) return;
  const content = event.content || {};
  if (event.parent_session_id || content.parent_session_id || event.is_subagent === true || content.is_subagent === true) {
    state.excluded = true; return;
  }
  const time = Number(event.create_time);
  if (!Number.isFinite(time) || time <= 0) return;
  if (time < state.updatedAt) return;
  if (['session.archived', 'session.deleted'].includes(type)) { state.excluded = true; return; }
  if (type === 'session.title_updated' && content.title) state.title = String(content.title).trim().slice(0, 80);
  if (type === 'user.input' && !state.title && typeof content.AgentInput?.text === 'string') {
    state.title = content.AgentInput.text.replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  if (type === 'user.input') state.hasUserInput = true;
  const group = String(content.group_id || content.run_id
    || (typeof event.group_id === 'string' || Number.isSafeInteger(event.group_id) ? event.group_id : '') || '');
  if (type === 'run.start') {
    if (['subagent', 'agent', 'group'].includes(event.session_type || content.session_type)) { state.excluded = true; return; }
    state.hasExecution = true;
    state.group = group;
    state.phase = 'active';
    state.failed = false;
    state.endedAt = 0;
    state.waiting.clear();
  }
  if (!state.hasExecution || (group && state.group && group !== state.group)) return;
  // Ignore delayed frames from an earlier run, even after a later run starts.
  if (type === 'error' && content.code !== 'invalid_run_event') {
    state.failed = true;
    state.phase = 'failed';
    state.endedAt = time;
    state.waiting.clear();
  } else if (type === 'run.end' || type === 'run.cancelled' || type === 'force.stop') {
    state.phase = type === 'run.end' && !state.failed ? 'succeeded' : 'failed';
    state.endedAt = time;
    state.waiting.clear();
  } else if (!state.endedAt) {
    const id = String(content.request_id || content.operation_id || content.id || event.id || '');
    if (type === 'permission.request'
      || (type === 'component.start' && waitingTypes.has(content.type || content.component_type))
      || (type === 'client.operation.start' && content.operation_type === 'bash_auth')) state.waiting.add(id);
    if (['permission.response', 'permission.resolved', 'component.end', 'client.operation.end'].includes(type)) state.waiting.delete(id);
    state.phase = state.waiting.size ? 'waiting_user' : 'active';
  }
  state.updatedAt = time;
  state.nativeStatus = type;
}

export function lingxiRecordFromRollout(state) {
  if (!state.hasUserInput || !state.hasExecution || state.excluded || !state.updatedAt) return null;
  return {
    session_id: state.sessionId,
    session_title: state.title || '灵犀任务',
    update_time: state.updatedAt,
    ended_at: state.endedAt,
    status: { active: 'Running', waiting_user: 'Done', succeeded: 'completed', failed: 'failed' }[state.phase],
    hasExecution: true,
    hasUnresolvedInteraction: state.phase === 'waiting_user',
    native_status: `app-server/${state.nativeStatus}`,
    _lingxiSource: 'app-server-rollout'
  };
}

export async function loadLingxiRolloutRecords({
  appServerStateRoot = DEFAULT_LINGXI_STATE_ROOT,
  now = new Date(), lookbackDays = 7, maxRollouts = 100, maxRolloutBytes = 32 * 1024 * 1024
} = {}) {
  if (!fs.existsSync(appServerStateRoot)) return { records: [], errors: [] };
  const candidates = [];
  const errors = [];
  try {
    const cutoff = now.getTime() - (lookbackDays + 1) * 86400000;
    for (const account of fs.readdirSync(appServerStateRoot, { withFileTypes: true })) {
      if (!account.isDirectory() || !/^\d+$/.test(account.name)) continue;
      const root = path.join(appServerStateRoot, account.name, 'sessions');
      if (!fs.existsSync(root)) continue;
      for (const session of fs.readdirSync(root, { withFileTypes: true })) {
        if (!session.isDirectory() || !/^\d+$/.test(session.name)) continue;
        const file = path.join(root, session.name, 'rollout.jsonl');
        try {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.size === 0 || stat.mtimeMs < cutoff) continue;
          if (stat.size > maxRolloutBytes) { errors.push('灵犀一条执行记录过大，已跳过'); continue; }
          candidates.push({ file, sessionId: session.name, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch { /* New or removed empty session. */ }
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const records = [];
    for (const item of candidates.slice(0, maxRollouts)) {
      const state = createLingxiRolloutState(item.sessionId);
      try {
        const metaPath = path.join(path.dirname(item.file), 'meta.json');
        if (fs.existsSync(metaPath)) {
          if (fs.lstatSync(metaPath).size > 64 * 1024) { errors.push('灵犀一条会话元数据过大，已跳过'); continue; }
          const meta = projectJsonMetadata(fs.readFileSync(metaPath, 'utf8'), {
            archived: true, is_archived: true, deleted: true, deleted_at: true,
            session_type: true, parent_session_id: true, is_subagent: true, title: true
          });
          if (meta.archived === true || meta.is_archived === true || meta.deleted === true || meta.deleted_at
            || meta.parent_session_id || meta.is_subagent === true || ['subagent', 'agent', 'group'].includes(meta.session_type)) continue;
          if (typeof meta.title === 'string') state.title = meta.title.trim().slice(0, 80);
        }
        const stream = fs.createReadStream(item.file, { encoding: 'utf8', highWaterMark: 64 * 1024, end: item.size - 1 });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) applyLingxiRolloutLine(state, line);
        } finally { lines.close(); stream.destroy(); }
        const record = lingxiRecordFromRollout(state);
        if (record) records.push(record);
      } catch { errors.push('灵犀一条本机执行记录读取失败'); }
    }
    return { records, errors };
  } catch (error) { return { records: [], errors: [`灵犀新版执行记录扫描失败：${error.code || '读取错误'}`] }; }
}
