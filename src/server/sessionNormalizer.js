import path from 'node:path';

function keyFor(session) {
  if (session.codexThread?.id) {
    return `${session.toolId || session.tool}:thread:${session.codexThread.id}`;
  }

  if (session.id && !String(session.id).startsWith('process:') && !String(session.id).startsWith('window:')) {
    return `${session.toolId || session.tool}:session:${session.id}`;
  }

  if (session.projectPath) {
    return `${session.toolId || session.tool}:${session.projectPath}`;
  }

  return `${session.toolId || session.tool}:${session.projectName || session.title}`;
}

function findExistingKey(session, byKey) {
  const directKey = keyFor(session);
  if (byKey.has(directKey)) return directKey;

  if (session.id && !String(session.id).startsWith('process:') && !String(session.id).startsWith('window:')) {
    return directKey;
  }

  const tool = session.toolId || session.tool;

  for (const [existingKey, existing] of byKey.entries()) {
    if ((existing.toolId || existing.tool) !== tool) continue;

    if (session.codexThread?.id || existing.codexThread?.id) {
      if (session.codexThread?.id && session.codexThread.id === existing.codexThread?.id) {
        return existingKey;
      }
      continue;
    }

    if (
      session.projectPath
      && existing.projectName
      && path.basename(session.projectPath) === existing.projectName
    ) {
      return existingKey;
    }

    if (
      existing.projectPath
      && session.projectName
      && path.basename(existing.projectPath) === session.projectName
    ) {
      return existingKey;
    }
  }

  return directKey;
}

const GENERIC_SESSION_TITLES = new Set(['未知会话', '编辑器', '终端任务', '终端窗口', '工作区']);

function pickTitle(existing, incoming) {
  const existingIsGeneric = !existing || GENERIC_SESSION_TITLES.has(existing);
  const incomingIsSpecific = incoming && !GENERIC_SESSION_TITLES.has(incoming);

  if (incomingIsSpecific) return incoming;
  if (existingIsGeneric && incoming) return incoming;
  return existing || incoming;
}

function pickStatusReason(existing, incoming, incomingSource) {
  if (incomingSource && incoming && !incomingSource.includes('window')) return incoming;
  return existing || incoming;
}

function pickLastActivityAt(existing, incoming) {
  const existingTime = new Date(existing || 0).getTime();
  const incomingTime = new Date(incoming || 0).getTime();
  return incomingTime > existingTime ? incoming : existing;
}

function pickStatus(existing, incoming) {
  if (incoming.statusFacts && !existing.statusFacts) return incoming.status;
  if (existing.statusFacts && !incoming.statusFacts) return existing.status;
  if (incoming.source?.includes('cursor-agent')) return incoming.status;
  if (existing.source?.includes('cursor-agent')) return existing.status;
  return existing.status || incoming.status;
}

function pickStatusFacts(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const existingTime = new Date(existing.signalObservedAt || 0).getTime();
  const incomingTime = new Date(incoming.signalObservedAt || 0).getTime();
  return incomingTime >= existingTime ? incoming : existing;
}

function combineSource(a, b) {
  const parts = new Set(String(a || '').split('+').concat(String(b || '').split('+')).filter(Boolean));
  return [...parts].join('+');
}

export function mergeSessions(sessions) {
  const byKey = new Map();

  for (const session of sessions) {
    const key = findExistingKey(session, byKey);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, { ...session });
      continue;
    }

    byKey.set(key, {
      ...existing,
      source: combineSource(existing.source, session.source),
      title: pickTitle(existing.title, session.title),
      projectName: existing.projectName || session.projectName,
      projectPath: existing.projectPath || session.projectPath,
      status: pickStatus(existing, session),
      statusReason: pickStatusReason(
        existing.statusReason || existing.attentionReason,
        session.statusReason || session.attentionReason,
        session.source
      ),
      attentionReason: pickStatusReason(
        existing.statusReason || existing.attentionReason,
        session.statusReason || session.attentionReason,
        session.source
      ),
      lastActivityAt: pickLastActivityAt(existing.lastActivityAt, session.lastActivityAt),
      statusFacts: pickStatusFacts(existing.statusFacts, session.statusFacts),
      appName: existing.appName || session.appName,
      process: existing.process || session.process,
      window: existing.window || session.window,
      agent: existing.agent || session.agent,
      codexThread: existing.codexThread || session.codexThread,
      jump: {
        canActivateApp: Boolean(existing.jump?.canActivateApp || session.jump?.canActivateApp),
        canOpenProject: Boolean(existing.jump?.canOpenProject || session.jump?.canOpenProject),
        canCopyPath: Boolean(existing.jump?.canCopyPath || session.jump?.canCopyPath)
      }
    });
  }

  return [...byKey.values()];
}
