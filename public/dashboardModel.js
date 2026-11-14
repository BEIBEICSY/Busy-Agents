// Display groups do not change the six underlying session states.
export const statusLabels = Object.freeze({
  needs_response: '需你响应', running: '执行中', completed_unseen: '待查看',
  completed_seen: '已完成', ended_abnormally: '异常结束', unknown: '状态不明'
});

export const overviewGroups = Object.freeze([
  { filter: 'attention', label: '待你处理', icon: 'alert' },
  { filter: 'completed_unseen', label: '待查看', icon: 'unread' },
  { filter: 'running', label: '进行中', icon: 'running' },
  { filter: 'ended_today', label: '今日已结束', icon: 'tray' }
]);

export function isUserStopped(session) {
  return session.status === 'ended_abnormally' && session.statusFacts?.endReason === 'user_stopped';
}

export function isUsageLimited(session) {
  return session.status === 'ended_abnormally' && session.statusFacts?.endReason === 'usage_limit';
}

export function isAcknowledgedAbnormalEnd(session) {
  return session.status === 'ended_abnormally'
    && !isUserStopped(session)
    && session.statusFacts?.viewState === 'seen';
}

export function isCompletedViewUnknown(session) {
  return session.status === 'unknown' && session.statusFacts?.executionPhase === 'succeeded';
}

export function statusLabelFor(session) {
  if (isCompletedViewUnknown(session)) return '已完成';
  if (isUsageLimited(session)) return '额度已用完';
  return isUserStopped(session) ? '已停止' : statusLabels[session.status] || statusLabels.unknown;
}

export function isEnded(session) {
  return ['completed_seen', 'completed_unseen', 'ended_abnormally'].includes(session.status)
    || (session.status === 'unknown' && ['succeeded', 'failed'].includes(session.statusFacts?.executionPhase));
}

export function endedToday(session, now = new Date()) {
  const belongsToToday = session.status === 'completed_seen'
    || session.status === 'unknown'
    || isUserStopped(session)
    || isAcknowledgedAbnormalEnd(session);
  if (!belongsToToday || !session.endedAt) return false;
  const endedAt = Date.parse(session.endedAt);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Number.isFinite(endedAt) && endedAt >= start.getTime() && endedAt <= now.getTime();
}

export function matchesFilter(session, filter, now = new Date()) {
  if (filter === 'all') return true;
  if (filter === 'attention') {
    return !isUserStopped(session) && !isAcknowledgedAbnormalEnd(session)
      && ['needs_response', 'ended_abnormally'].includes(session.status);
  }
  // Unseen successful results stay in "待查看", even though execution has ended.
  if (filter === 'ended') return ['completed_seen', 'ended_abnormally'].includes(session.status) || isCompletedViewUnknown(session);
  if (filter === 'unknown') return session.status === 'unknown' && !isCompletedViewUnknown(session);
  if (filter === 'ended_today') return endedToday(session, now);
  if (filter === 'ended_abnormally') return session.status === filter && !isUserStopped(session);
  return session.status === filter;
}

export function selectSessions(sessions, filter = 'all', query = '', now = new Date()) {
  const term = query.trim().toLocaleLowerCase();
  const selected = sessions.filter((session) => matchesFilter(session, filter, now) && (!term ||
    [session.title, session.tool, session.projectName, session.projectPath]
      .filter(Boolean).join(' ').toLocaleLowerCase().includes(term)));
  return filter === 'ended_today' ? selected.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt)) : selected;
}

export function overviewSessions(sessions, filter, now = new Date()) {
  const items = selectSessions(sessions, filter, '', now);
  return items;
}

export function relativeTime(value, now = Date.now()) {
  if (!value) return '时间未知';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '时间未知';
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

export function projectNameForDisplay(session) {
  const name = typeof session.projectName === 'string' ? session.projectName.trim() : '';
  return ['', '未知项目', '未知工作区', '未选择项目', '未选择工作区', 'unknown project', 'unknown workspace'].includes(name.toLowerCase()) ? '' : name;
}

export function allTaskSessions(sessions, filter = 'all', query = '', now = new Date()) {
  const time = session => {
    for (const value of [session.endedAt, session.lastActivityAt]) {
      const timestamp = Date.parse(value || '');
      if (Number.isFinite(timestamp)) return timestamp;
    }
    return -Infinity;
  };
  return selectSessions(sessions, filter, query, now).sort((a, b) => {
    const left = time(a), right = time(b);
    return left === right ? 0 : left > right ? -1 : 1;
  });
}
