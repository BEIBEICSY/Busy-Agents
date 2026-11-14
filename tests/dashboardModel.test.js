import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSessions, overviewSessions, overviewGroups, relativeTime, isUserStopped, statusLabelFor } from '../public/dashboardModel.js';

const states = ['needs_response', 'running', 'completed_unseen', 'completed_seen', 'ended_abnormally', 'unknown'];
const sessions = states.map((status, index) => ({
  id: String(index), status, title: `任务 ${index}`, tool: 'Codex·Desktop',
  projectName: '演示项目', projectPath: '/Users/demo/LongProject'
}));

test('today uses the local end date and excludes tasks already requiring action or viewing', () => {
  const now = new Date(2026, 10, 3, 19, 30);
  const at = (day, hour = 12) => new Date(2026, 10, day, hour).toISOString();
  const rows = [
    { id: 'success', status: 'completed_seen', endedAt: at(3, 10) },
    { id: 'unread', status: 'completed_unseen', endedAt: at(3, 18) },
    { id: 'stopped', status: 'ended_abnormally', endedAt: at(3, 14), statusFacts: { endReason: 'user_stopped' } },
    { id: 'failed', status: 'ended_abnormally', endedAt: at(3, 13) },
    { id: 'unknown-ended', status: 'unknown', endedAt: at(3, 12) },
    { id: 'view-unknown', status: 'unknown', endedAt: at(3, 11), statusFacts: { executionPhase: 'succeeded' } },
    { id: 'viewed-today', status: 'completed_seen', endedAt: at(2), lastActivityAt: at(3) },
    { id: 'no-end-time', status: 'completed_seen', lastActivityAt: at(3) },
    { id: 'running', status: 'running', endedAt: at(3) },
    { id: 'future', status: 'completed_seen', endedAt: at(4) },
    { id: 'invalid', status: 'completed_seen', endedAt: 'invalid' }
  ];
  assert.deepEqual(selectSessions(rows, 'ended_today', '', now).map(s => s.id), ['stopped', 'unknown-ended', 'view-unknown', 'success']);
  assert.equal(selectSessions(rows, 'completed_unseen', '', now)[0].id, 'unread');
  assert.equal(selectSessions(rows, 'attention', '', now).some(s => s.id === 'stopped'), false);
  assert.equal(statusLabelFor(rows[5]), '已完成');
});

test('overview groups show all rows and today resets at local midnight', () => {
  const now = new Date(2026, 10, 3, 23, 59, 59);
  const rows = Array.from({ length: 6 }, (_, i) => ({
    id: String(i), status: 'completed_seen', endedAt: new Date(2026, 10, 3, i).toISOString()
  }));
  assert.equal(overviewSessions(rows, 'ended_today', now).length, 6);
  assert.deepEqual(overviewSessions(rows, 'ended_today', new Date(2026, 10, 4)), []);
  assert.equal(overviewSessions(rows.map(s => ({ ...s, status: 'running' })), 'running', now).length, 6);
  for (const status of ['needs_response', 'completed_unseen']) {
    const filter = status === 'needs_response' ? 'attention' : status;
    assert.equal(overviewSessions(rows.map(s => ({ ...s, status })), filter, now).length, 6);
  }
  const nextDayRow = { status: 'completed_seen', endedAt: new Date(2026, 10, 4, 0, 0).toISOString() };
  assert.equal(selectSessions([nextDayRow], 'ended_today', '', new Date(2026, 10, 4, 0, 1)).length, 1);
});

test('manual stops are neutral ended results, while real failures retain attention', () => {
  const stopped = { id: 'stopped', status: 'ended_abnormally', statusFacts: { endReason: 'user_stopped', viewState: 'unseen' } };
  const failed = { id: 'failed', status: 'ended_abnormally', statusFacts: { endReason: 'execution_failed' } };
  const rows = [stopped, failed, sessions[0]];
  assert.equal(statusLabelFor(stopped), '已停止');
  assert.equal(statusLabelFor(failed), '异常结束');
  assert.deepEqual(selectSessions(rows, 'attention').map((s) => s.id), ['failed', '0']);
  assert.deepEqual(selectSessions(rows, 'ended').map((s) => s.id), ['stopped', 'failed']);
  assert.deepEqual(selectSessions(rows, 'ended_abnormally').map((s) => s.id), ['failed']);
  assert.equal(selectSessions(rows, 'all').length, 3);
  assert.equal(isUserStopped({ status: 'running', statusFacts: { endReason: 'user_stopped' } }), false);
});

test('a usage limit leaves attention once Codex unread disappears', () => {
  const now = new Date(2026, 10, 3, 23, 0);
  const at = (day, hour) => new Date(2026, 10, day, hour).toISOString();
  const seenToday = {
    id: 'seen-today', status: 'ended_abnormally', endedAt: at(3, 22),
    statusFacts: { endReason: 'usage_limit', viewState: 'seen' }
  };
  const unseenToday = {
    id: 'unseen-today', status: 'ended_abnormally', endedAt: at(3, 21),
    statusFacts: { endReason: 'usage_limit', viewState: 'unseen' }
  };
  const unknownView = {
    id: 'unknown-view', status: 'ended_abnormally', endedAt: at(3, 20),
    statusFacts: { endReason: 'usage_limit', viewState: 'indeterminate' }
  };
  const seenEarlier = {
    id: 'seen-earlier', status: 'ended_abnormally', endedAt: at(2, 22),
    statusFacts: { endReason: 'usage_limit', viewState: 'seen' }
  };
  const failedSeen = {
    id: 'failed-seen', status: 'ended_abnormally', endedAt: at(3, 12),
    statusFacts: { endReason: 'execution_failed', viewState: 'seen' }
  };
  const rows = [seenToday, unseenToday, unknownView, seenEarlier, failedSeen];
  assert.equal(statusLabelFor(seenToday), '额度已用完');
  assert.deepEqual(selectSessions(rows, 'attention', '', now).map((s) => s.id), ['unseen-today', 'unknown-view']);
  assert.deepEqual(selectSessions(rows, 'ended', '', now).map((s) => s.id), rows.map((s) => s.id));
  assert.deepEqual(selectSessions(rows, 'ended_today', '', now).map((s) => s.id), ['seen-today', 'failed-seen']);
  assert.deepEqual(selectSessions(rows, 'ended_abnormally', '', now).map((s) => s.id), rows.map((s) => s.id));
});

test('overview attention and ended groups preserve distinct native states and unseen results', () => {
  assert.deepEqual(selectSessions(sessions, 'attention').map((s) => s.status), ['needs_response', 'ended_abnormally']);
  assert.deepEqual(selectSessions(sessions, 'ended').map((s) => s.status), ['completed_seen', 'ended_abnormally']);
  assert.deepEqual(selectSessions(sessions, 'completed_unseen').map((s) => s.status), ['completed_unseen']);
  assert.deepEqual(overviewGroups.map((g) => g.filter), ['attention', 'completed_unseen', 'running', 'ended_today']);
  assert.equal(selectSessions(sessions, 'unknown').length, 1);
});

test('all six states remain independently filterable and backend order is preserved', () => {
  for (const status of states) assert.equal(selectSessions(sessions, status)[0].status, status);
  const result = selectSessions(sessions, 'all');
  assert.deepEqual(result, sessions);
  assert.notEqual(result, sessions);
});

test('search combines the selected status with title, tool, project and full path', () => {
  assert.equal(selectSessions(sessions, 'running', '  CODEX  ').length, 1);
  assert.equal(selectSessions(sessions, 'running', 'longproject').length, 1);
  assert.equal(selectSessions(sessions, 'unknown', '演示').length, 1);
  assert.equal(selectSessions(sessions, 'all', '任务 0')[0].status, 'needs_response');
  assert.equal(selectSessions(sessions, 'running', '任务 0').length, 0);
  assert.equal(selectSessions([{ status: 'running' }], 'all', 'codex').length, 0);
});

test('missing, malformed and future activity timestamps never imply an old or negative activity age', () => {
  const now = Date.parse('2026-11-03T06:00:00Z');
  assert.equal(relativeTime(null, now), '时间未知');
  assert.equal(relativeTime('bad-date', now), '时间未知');
  assert.equal(relativeTime('2026-11-03T06:05:00Z', now), '刚刚');
  assert.equal(relativeTime('2026-11-03T05:30:00Z', now), '30 分钟前');
});


test('successful tasks with unknown viewing belong to ended, without claiming seen or unread', () => {
  const completed = { id: 'done', status: 'unknown', statusFacts: { executionPhase: 'succeeded', viewState: 'indeterminate' } };
  const uncertain = { id: 'uncertain', status: 'unknown', statusFacts: { executionPhase: 'unknown' } };
  const rows = [completed, uncertain];
  assert.deepEqual(selectSessions(rows, 'ended').map(s => s.id), ['done']);
  assert.deepEqual(selectSessions(rows, 'unknown').map(s => s.id), ['uncertain']);
  assert.equal(selectSessions(rows, 'completed_seen').length, 0);
  assert.equal(selectSessions(rows, 'completed_unseen').length, 0);
  assert.equal(selectSessions(rows, 'attention').length, 0);
  assert.equal(selectSessions(rows, 'all').length, 2);
  assert.equal(statusLabelFor(completed), '已完成');
});

test('project metadata omits absent and placeholder values while keeping real labels', async () => {
  const { projectNameForDisplay } = await import('../public/dashboardModel.js');
  for (const projectName of [undefined, null, '', '  ', '未知项目', '未知工作区', 'Unknown Project']) {
    assert.equal(projectNameForDisplay({ projectName }), '');
  }
  for (const projectName of ['Desktop', '本地', '云端', 'AI_Lifelog']) {
    assert.equal(projectNameForDisplay({ projectName: ` ${projectName} ` }), projectName);
  }
});

test('all-task timeline orders mixed statuses by displayed time rather than priority', async () => {
  const { allTaskSessions } = await import('../public/dashboardModel.js');
  const rows = [
    {id:'old-attention',status:'needs_response',lastActivityAt:'2026-11-01T12:00:00Z'},
    {id:'completed',status:'completed_seen',endedAt:'2026-11-08T14:00:00Z',lastActivityAt:'2026-11-08T18:00:00Z'},
    {id:'running',status:'running',lastActivityAt:'2026-11-08T16:00:00Z'},
    {id:'unread',status:'completed_unseen',endedAt:'2026-11-08T15:00:00Z'}
  ];
  assert.deepEqual(allTaskSessions(rows).map(s=>s.id),['running','unread','completed','old-attention']);
  assert.deepEqual(overviewSessions(rows,'attention').map(s=>s.id),['old-attention']);
  assert.deepEqual(rows.map(s=>s.id),['old-attention','completed','running','unread']);
});

test('timeline filters remain newest first with stable ties and missing timestamps last', async () => {
  const { allTaskSessions } = await import('../public/dashboardModel.js');
  const rows=[
    {id:'missing',status:'completed_seen'},
    {id:'first-tie',status:'completed_seen',endedAt:'2026-11-08T14:00:00Z'},
    {id:'fallback',status:'completed_seen',endedAt:'bad',lastActivityAt:'2026-11-08T15:00:00Z'},
    {id:'second-tie',status:'completed_seen',endedAt:'2026-11-08T14:00:00Z'},
    {id:'invalid',status:'completed_seen',lastActivityAt:'bad'}
  ];
  assert.deepEqual(allTaskSessions(rows,'ended').map(s=>s.id),['fallback','first-tie','second-tie','missing','invalid']);
  assert.deepEqual(allTaskSessions(rows,'running'),[]);
});
