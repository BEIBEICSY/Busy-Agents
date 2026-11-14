import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXIT_REASON = '进程已退出，但没有取得根轮次终态';
const PERSISTABLE_TOOLS = new Set(['claude-code', 'hermes', 'codex-cli']);

export function defaultTerminalSessionLogPath() {
  return path.join(os.homedir(), 'Library/Application Support/AI Task Radar/terminal-sessions.json');
}

export function isPersistableTerminalSession(session) {
  if (!session || session.status !== 'running') return false;
  if (!String(session.source || '').includes('terminal')) return false;
  if (session.codexThread?.id) return false;
  return PERSISTABLE_TOOLS.has(session.toolId);
}

function startedAtMs(session, now) {
  const observed = new Date(session.lastActivityAt || now).getTime();
  const elapsed = Number(session.process?.elapsedSeconds || 0);
  const base = Number.isFinite(observed) ? observed : now.getTime();
  return base - (Number.isFinite(elapsed) ? elapsed * 1000 : 0);
}

function snapshot(session, now) {
  const observedAt = session.lastActivityAt || now.toISOString();
  const pid = session.process?.pid ?? null;
  const started = startedAtMs(session, now);

  return {
    id: `terminal:${session.toolId}:${pid}:${started}`,
    tool: session.tool,
    toolId: session.toolId,
    appName: session.appName || '',
    source: 'terminal',
    title: session.title || '终端任务',
    projectName: session.projectName || '',
    projectPath: session.projectPath || '',
    pid,
    startedAtMs: started,
    lastActivityAt: observedAt,
    exitedAt: '',
    status: 'running',
    jump: {
      canActivateApp: session.jump?.canActivateApp !== false,
      canOpenProject: Boolean(session.projectPath),
      canCopyPath: Boolean(session.projectPath)
    }
  };
}

function toSession(record) {
  const observedAt = record.exitedAt || record.lastActivityAt;

  return {
    id: record.id,
    tool: record.tool,
    toolId: record.toolId,
    appName: record.appName,
    source: 'terminal',
    title: record.title,
    projectName: record.projectName,
    projectPath: record.projectPath,
    status: 'unknown',
    statusReason: EXIT_REASON,
    attentionReason: EXIT_REASON,
    lastActivityAt: observedAt,
    statusFacts: {
      hasExecution: true,
      executionPhase: 'unknown',
      viewState: 'indeterminate',
      nativeStatus: 'process-exited',
      signalSource: 'terminal-session-log',
      signalObservedAt: observedAt
    },
    jump: record.jump || {
      canActivateApp: true,
      canOpenProject: Boolean(record.projectPath),
      canCopyPath: Boolean(record.projectPath)
    }
  };
}

function withinLookback(record, cutoff) {
  if (record.status === 'running') return true;
  const stamp = new Date(record.exitedAt || record.lastActivityAt || 0).getTime();
  return stamp >= cutoff;
}

export function createTerminalSessionLog({
  filePath = defaultTerminalSessionLogPath(),
  fsImpl = fs
} = {}) {
  function load() {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function save(records) {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tempPath, JSON.stringify(records));
    fsImpl.renameSync(tempPath, filePath);
  }

  return {
    sync(sessions, { now = new Date(), lookbackDays = 7, processScanOk = true } = {}) {
      const cutoff = now.getTime() - Math.max(1, Number(lookbackDays) || 7) * 86400000;
      let records = load().filter((record) => withinLookback(record, cutoff));

      if (processScanOk) {
        const matched = new Set();

        for (const session of (sessions || []).filter(isPersistableTerminalSession)) {
          let record = records.find((item) => (
            item.status === 'running'
            && item.toolId === session.toolId
            && item.pid === (session.process?.pid ?? null)
          ));

          if (!record) {
            record = snapshot(session, now);
            records.push(record);
          } else {
            record.title = session.title || record.title;
            record.projectName = session.projectName || record.projectName;
            record.projectPath = session.projectPath || record.projectPath;
            record.lastActivityAt = session.lastActivityAt || now.toISOString();
            record.appName = session.appName || record.appName;
            record.jump = snapshot(session, now).jump;
          }

          matched.add(record.id);
        }

        for (const record of records) {
          if (record.status === 'running' && !matched.has(record.id)) {
            record.status = 'unknown';
            record.exitedAt = now.toISOString();
            record.lastActivityAt = record.exitedAt;
          }
        }
      }

      records = records.filter((record) => withinLookback(record, cutoff));
      save(records);
      return records.filter((record) => record.status !== 'running').map(toSession);
    }
  };
}
