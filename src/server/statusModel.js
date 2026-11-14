export const SESSION_STATUSES = Object.freeze([
  'needs_response',
  'running',
  'completed_unseen',
  'completed_seen',
  'ended_abnormally',
  'unknown'
]);

const STATUS_SET = new Set(SESSION_STATUSES);

export function resolveUnifiedStatus({
  hasExecution,
  executionPhase = 'unknown',
  viewState = 'indeterminate'
} = {}) {
  if (hasExecution !== true) return null;

  switch (executionPhase) {
  case 'waiting_user':
    return 'needs_response';
  case 'active':
    return 'running';
  case 'failed':
    return 'ended_abnormally';
  case 'succeeded':
    if (viewState === 'unseen') return 'completed_unseen';
    if (viewState === 'seen') return 'completed_seen';
    return 'unknown';
  default:
    return 'unknown';
  }
}

export function withStatusFacts(session, facts) {
  const status = resolveUnifiedStatus(facts);
  if (!status) return null;

  return {
    ...session,
    endedAt: ['succeeded', 'failed'].includes(facts.executionPhase) ? facts.endedAt || '' : '',
    status,
    statusReason: facts.statusReason || session.statusReason || session.attentionReason || '',
    attentionReason: facts.statusReason || session.statusReason || session.attentionReason || '',
    statusFacts: {
      hasExecution: facts.hasExecution === true,
      executionPhase: facts.executionPhase || 'unknown',
      viewState: facts.viewState || 'indeterminate',
      ...(facts.endReason ? { endReason: facts.endReason } : {}),
      nativeStatus: facts.nativeStatus || '',
      signalSource: facts.signalSource || session.source || '',
      signalObservedAt: facts.signalObservedAt || session.lastActivityAt || ''
    }
  };
}

export function isUnifiedStatus(status) {
  return STATUS_SET.has(status);
}

function isUserStopped(session) {
  return session.status === 'ended_abnormally' && session.statusFacts?.endReason === 'user_stopped';
}

function priorityFor(session) {
  if (session.status === 'needs_response') return 0;
  if (session.status === 'ended_abnormally' && !isUserStopped(session) && session.statusFacts?.viewState === 'unseen') return 1;
  if (session.status === 'completed_unseen') return 2;
  if (session.status === 'running') return 3;
  if (session.status === 'unknown') return 4;
  if (session.status === 'ended_abnormally' && !isUserStopped(session)) return 5;
  return 6;
}

function timestampFor(session) {
  const value = new Date(
    session.statusFacts?.signalObservedAt
      || session.lastActivityAt
      || 0
  ).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function finalizeSessions({ sessions, now = new Date(), lookbackDays = 7 }) {
  const cutoffMs = now.getTime() - Math.max(1, Number(lookbackDays) || 7) * 86400000;

  return sessions
    .filter(Boolean)
    .filter((session) => session.statusFacts?.hasExecution === true)
    .filter((session) => isUnifiedStatus(session.status))
    .filter((session) => {
      if (timestampFor(session) >= cutoffMs) return true;
      if (session.status === 'needs_response' || session.status === 'running') return true;
      return session.status === 'ended_abnormally' && !isUserStopped(session) && session.statusFacts?.viewState === 'unseen';
    })
    .sort((a, b) => priorityFor(a) - priorityFor(b) || timestampFor(b) - timestampFor(a));
}
