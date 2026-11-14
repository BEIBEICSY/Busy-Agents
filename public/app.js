import { statusLabels, statusLabelFor, isUserStopped, isUsageLimited, overviewGroups, overviewSessions, selectSessions, relativeTime, allTaskSessions, projectNameForDisplay } from './dashboardModel.js';

const $ = (selector) => document.querySelector(selector);
const icons = {
  back: '<path d="m12 5-7 7 7 7M5 12h15"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 18 17"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  settings: '<path d="m9 3-.6 2.3-2 .9-2.1-.7-2 3.5L4 10.6v2.8L2.3 15l2 3.5 2.1-.7 2 .9L9 21h4l.6-2.3 2-.9 2.1.7 2-3.5-1.7-1.6v-2.8l1.7-1.6-2-3.5-2.1.7-2-.9L13 3z"/><circle cx="11" cy="12" r="3"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  forward: '<path d="M6 18 18 6M7 6h11v11"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3h.01"/>',
  unread: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-8M8 10h5M8 14h7M8 18h4"/><circle cx="18" cy="5" r="3" fill="currentColor" stroke="none"/>',
  running: '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/>',
  layers: '<path d="m3 7 9-5 9 5-9 5zM3 12l9 5 9-5M3 17l9 5 9-5"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  unknown: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2.5M12 17h.01"/>',
  tray: '<path d="m4 5-2 9v6h20v-6l-2-9zM2 14h6l2 3h4l2-3h6"/>',
  terminal: '<path d="m5 7 5 5-5 5m8 0h6"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/>'
};
function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.code}</svg>`;
}
for (const [id, name] of Object.entries({ backButton: 'back', refreshButton: 'refresh', allTasksArrow: 'arrow' })) {
  $(`#${id}`).innerHTML = icon(name);
}

let sessions = [];
let errors = [];
let connections = [];
let connectionSummary = { show: false, tone: 'ok', title: '', emptyDetail: '' };
let connectionMarkup = '';
let activeFilter = 'all';
let page = 'overview';
let isRefreshing = false;
let lastScannedAt = null;
let query = '';
let searchOpen = false;
let listOpener = null;
const collapsedGroups = new Set();
const pendingActions = new Set();
const knownStatuses = Object.keys(statusLabels);

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function toolIcon(tool, isOverview = false) {
  if (isOverview) {
    const name = String(tool).toLowerCase();
    const brand = name.includes('claude') ? 'claude' : name.includes('hermes') ? 'hermes'
      : name.includes('灵犀') ? 'lingxi' : name.includes('traework') ? 'traework'
      : name.includes('comate') ? 'comate' : name.includes('workbuddy') ? 'workbuddy'
      : name.includes('codex') ? 'codex' : name.includes('cursor') ? 'cursor'
      : name.includes('trae') ? 'trae' : null;
    if (brand) return `<span class="tool-icon"><img src="/icons/${brand}.png" alt="" aria-hidden="true"></span>`;
  }
  const name = String(tool).toLowerCase();
  if (name.includes('cli') || name.includes('claude')) return `<span class="tool-icon cli">${icon('terminal')}</span>`;
  if (name.includes('comate')) return '<span class="tool-icon comate">W.</span>';
  if (name.includes('workbuddy')) return '<span class="tool-icon workbuddy">W</span>';
  if (name.includes('codex')) return `<span class="tool-icon codex">${icon('code')}</span>`;
  if (name.includes('trae')) return '<span class="tool-icon trae">T</span>';
  if (name.includes('cursor')) return '<span class="tool-icon">C</span>';
  return '<span class="tool-icon">✧</span>';
}

function reasonFor(session) {
  if (session.status === 'unknown' && session.statusFacts?.executionPhase === 'succeeded') {
    return session.statusReason || '已完成，查看状态未知';
  }
  return ['needs_response', 'ended_abnormally', 'unknown'].includes(session.status)
    ? session.statusReason || session.attentionReason || '' : '';
}

function taskMarkup(session, isOverview = false) {
  const title = session.title || '未知会话';
  const project = projectNameForDisplay(session);
  const status = knownStatuses.includes(session.status) ? session.status : 'unknown';
  const tone = isUserStopped(session) ? 'stopped' : isUsageLimited(session) ? 'usage_limit' : status;
  const label = statusLabelFor(session);
  const reason = reasonFor(session);
  const canGo = session.jump?.canActivateApp === true;
  const hint = canGo ? `前往 ${session.tool}，可能需要手动选择对应会话` : '当前暂不支持前往';
  const displayTime = session.endedAt || session.lastActivityAt;
  return `<button class="task-main" type="button" data-action="go-to" data-id="${escapeHtml(session.id)}" title="${escapeHtml(hint + (isOverview && reason ? `；${reason}` : ''))}" ${canGo ? '' : 'disabled'}>
    ${toolIcon(session.tool, isOverview)}
    <div class="task-content">
      <div class="task-top"><span class="task-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span><span class="status ${tone}" title="${status === 'completed_unseen' ? '已完成待查看' : label}">${status === 'running' ? '<span class="running-indicator" aria-hidden="true"></span>' : ''}${label}</span></div>
      <div class="task-meta"><span class="tool-name">${escapeHtml(session.tool)}</span>${project ? `<span aria-hidden="true">·</span><span class="project-name" title="${escapeHtml(session.projectPath || project)}">${escapeHtml(project)}</span>` : ''}<time class="task-time" ${displayTime ? `datetime="${escapeHtml(displayTime)}"` : ''} title="${escapeHtml(`${session.endedAt ? '结束时间' : '最后活动'}：${displayTime || '未知'}`)}">${relativeTime(displayTime)}</time></div>
      ${reason && !isOverview ? `<div class="task-reason" title="${escapeHtml(reason)}">${escapeHtml(reason)}</div>` : ''}
    </div>
    <span class="task-forward">${icon('forward')}</span>
  </button>`;
}

// Reuse existing row elements across polls; avoid replacing the scroll container.
function renderRows(container, items) {
  const current = new Map([...container.children].filter((el) => el.dataset.id).map((el) => [el.dataset.id, el]));
  const wanted = new Set(items.map((session) => session.id));
  for (const child of [...container.children]) {
    if (!wanted.has(child.dataset.id)) child.remove();
  }
  items.forEach((session, index) => {
    let row = current.get(session.id);
    if (!row) {
      row = document.createElement('article');
      row.className = 'task-row';
      row.dataset.id = session.id;
    }
    const markup = taskMarkup(session, container.classList.contains('group-tasks') || container.id === 'sessionRows');
    if (row._markup !== markup) {
      const focused = row.contains(document.activeElement);
      row.innerHTML = markup;
      row._markup = markup;
      if (focused) row.querySelector('.task-main')?.focus({ preventScroll: true });
    }
    if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
    row.dataset.place = container.id === 'sessionRows'
      ? `全部任务 / ${{ all: '全部', attention: '待你处理', completed_unseen: '待查看', running: '进行中', ended: '已结束', unknown: '状态不明' }[activeFilter] || activeFilter}`
      : `概览 / ${overviewGroups.find((group) => container.id === `group-${group.filter}`)?.label || ''}`;
  });
}

$('#overviewGroups').innerHTML = overviewGroups.map((group) => `<section class="group ${group.filter}">
  <div class="group-heading">
    <button class="group-toggle" type="button" data-toggle-group="${group.filter}" aria-expanded="true" aria-controls="content-${group.filter}" aria-label="${group.label}" title="收起${group.label}"><span class="fold-chevron" aria-hidden="true">${icon('arrow')}</span><span class="group-label">${group.label}</span><span class="group-count zero" id="count-${group.filter}">0</span></button>
  </div>
  <div class="group-content" id="content-${group.filter}">
    <div class="group-tasks" id="group-${group.filter}"></div>
  </div>
</section>`).join('');

function updateGroupDisclosure(group) {
  const collapsed = collapsedGroups.has(group.filter);
  const toggle = document.querySelector(`[data-toggle-group="${group.filter}"]`);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.title = `${collapsed ? '展开' : '收起'}${group.label}`;
  $(`#content-${group.filter}`).hidden = collapsed;
}

function toggleGroup(key) {
  if (collapsedGroups.has(key)) collapsedGroups.delete(key);
  else collapsedGroups.add(key);
  updateGroupDisclosure(overviewGroups.find((group) => group.filter === key));
}

function updateSyncLabel() {
  $('.radar').classList.toggle('is-overview', page === 'overview');
  const refreshButton = $('#refreshButton');
  const wasRefreshing = refreshButton.classList.contains('is-refreshing');
  refreshButton.disabled = isRefreshing;
  refreshButton.classList.toggle('is-refreshing', isRefreshing);
  refreshButton.setAttribute('aria-busy', String(isRefreshing));
  refreshButton.title = isRefreshing ? '正在扫描' : '立即扫描';
  refreshButton.setAttribute('aria-label', isRefreshing ? '正在扫描' : '立即扫描');
  if (wasRefreshing !== isRefreshing) {
    refreshButton.innerHTML = isRefreshing
      ? '<span class="refresh-spinner" aria-hidden="true"></span>'
      : icon('refresh');
  }
  $('#scanNotice').hidden = errors.length === 0;
  $('#scanNoticeTitle').textContent = sessions.length ? '部分扫描失败，当前列表可能不完整' : '扫描暂不可用，正在自动重试';
  $('#scanErrors').textContent = errors.join('\n');
  renderConnections();
}

const connectionLabels = {
  connected: '已连接，有任务',
  empty: '已连接，最近没有任务',
  missing: '未找到数据',
  unreadable: '不可读',
  unsupported: '格式不支持',
  hook_missing: '缺少 Hook'
};

function renderConnections() {
  const notice = $('#connectionNotice');
  notice.hidden = !connectionSummary.show;
  notice.classList.toggle('is-quiet', connectionSummary.tone !== 'warning');
  $('#connectionNoticeTitle').textContent = connectionSummary.title || '本机工具';
  const visible = connectionSummary.tone === 'quiet' ? connections : connections.filter((item) => item.needsAttention);
  const markup = JSON.stringify(visible.map((item) => [item.id, item.status, item.detail, item.path, item.origin]));
  if (markup !== connectionMarkup) {
    connectionMarkup = markup;
    $('#connectionList').innerHTML = visible.map((item) => {
      const label = connectionLabels[item.status] || item.status;
      const text = item.detail ? `${label}。${item.detail}` : label;
      const restore = item.origin === 'override' ? `<button type="button" data-clear-root="${escapeHtml(item.id)}">恢复自动查找</button>` : '';
      return `<div class="connection-row"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(text)}</span>${item.canChoosePath ? `<form data-root="${escapeHtml(item.id)}"><input name="path" type="text" placeholder="数据目录" value="${escapeHtml(item.path || '')}" aria-label="${escapeHtml(item.name)}数据目录"><button type="submit">使用此目录</button>${restore}</form>` : ''}</div>`;
    }).join('');
  }
  const linked = $('#linkedEmpty');
  const showLinked = !sessions.length && !errors.length && !connectionSummary.show && connectionSummary.emptyDetail;
  linked.hidden = !showLinked;
  linked.textContent = showLinked ? connectionSummary.emptyDetail : '';
}

function emptyCopy() {
  if (isRefreshing && !sessions.length) return ['正在查找本机任务', '正在读取最近 7 天的任务记录'];
  if (errors.length && !sessions.length) return ['暂时无法读取任务', '可展开上方提示查看原因，稍后会自动重试'];
  if (activeFilter === 'all' && !query && connectionSummary.emptyDetail) return ['暂时没有任务记录', connectionSummary.emptyDetail];
  if (query) return ['没有找到匹配的任务', '换个关键词，或查看全部任务'];
  return {
    attention: ['暂时没有需要你处理的任务', '需要你回应或处理异常的任务会显示在这里'],
    completed_unseen: ['暂时没有待查看的结果', '任务完成后，尚未查看的结果会显示在这里'],
    running: ['暂时没有正在进行的任务', 'Agent 开始执行后，任务会显示在这里'],
    ended: ['暂时没有已结束的任务', '可在这里回顾已完成、已停止或异常结束的任务'],
    unknown: ['暂时没有状态不明的任务', '执行状态暂时无法确认的任务会显示在这里']
  }[activeFilter] || ['暂时没有任务记录', '在支持的 AI 工具中执行任务后，可在这里查看'];
}

function render() {
  requestAnimationFrame(updateBottomFade);
  updateSyncLabel();
  $('#totalCount').textContent = `最近 7 天，共 ${sessions.length} 任务`;
  for (const group of overviewGroups) {
    const items = selectSessions(sessions, group.filter);
    const count = $(`#count-${group.filter}`);
    count.textContent = items.length;
    count.classList.toggle('zero', items.length === 0);
    renderRows($(`#group-${group.filter}`), overviewSessions(sessions, group.filter));
    updateGroupDisclosure(group);
  }

  for (const button of document.querySelectorAll('[data-filter]')) {
    const selected = button.dataset.filter === activeFilter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  const visible = allTaskSessions(sessions, activeFilter, query);
  $('#allTasksSubtitle').textContent = `最近 7 天任务记录 · 共 ${visible.length} 个任务`;
  renderRows($('#sessionRows'), visible);
  if (!visible.length) {
    const [title, detail] = emptyCopy();
    $('#sessionRows').innerHTML = `<div class="empty-state">${icon(query ? 'search' : 'tray')}<strong>${title}</strong><p>${detail}</p>${query || activeFilter !== 'all' ? '<button type="button" data-reset>查看全部任务</button>' : ''}</div>`;
  }
}

function openAll(filter, opener) {
  listOpener = opener;
  if (filter !== undefined) {
    if (activeFilter !== filter || query) $('#sessionRows').scrollTop = 0;
    activeFilter = filter;
    query = '';
  }
  page = 'all';
  $('#overviewPage').hidden = true;
  $('#allPage').hidden = false;
  $('#pageTitle').textContent = '全部任务';
  $('#backButton').hidden = false;
  $('#allTasksSubtitle').hidden = false;
  $('#allTasksButton').hidden = true;
  $('#listFooter').hidden = false;
  render();
  $('#backButton').focus({ preventScroll: true });
}

function goBack() {
  requestAnimationFrame(updateBottomFade);
  page = 'overview';
  $('#overviewPage').hidden = false;
  $('#allPage').hidden = true;
  $('#pageTitle').textContent = 'Agents 在忙啥';
  $('#backButton').hidden = true;
  $('#allTasksSubtitle').hidden = true;
  $('#allTasksButton').hidden = false;
  $('#listFooter').hidden = true;
  updateSyncLabel();
  (listOpener?.isConnected ? listOpener : $('#allTasksButton')).focus({ preventScroll: true });
}

function chooseFilter(value) {
  activeFilter = value;
  $('#sessionRows').scrollTop = 0;
  render();
}

async function refresh(force = false) {
  if (isRefreshing) return;
  isRefreshing = true;
  updateSyncLabel();
  const started = performance.now();
  try {
    const response = await fetch(force ? '/api/sessions?fresh=1' : '/api/sessions', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.sessions)) throw new Error('扫描数据格式不正确');
    sessions = payload.sessions;
    errors = Array.isArray(payload.errors) ? payload.errors : [];
    connections = Array.isArray(payload.connections) ? payload.connections : [];
    connectionSummary = payload.connectionSummary || { show: false, tone: 'ok', title: '', emptyDetail: '' };
    const scanned = payload.scannedAt ? new Date(payload.scannedAt) : new Date();
    lastScannedAt = Number.isNaN(scanned.getTime()) ? new Date() : scanned;
  } catch (error) {
    errors = [`读取本机任务失败：${error.message}。保留上次结果，正在自动重试。`];
  } finally {
    const remaining = 450 - (performance.now() - started);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    isRefreshing = false;
    render();
  }
}

function showActionMessage(message) {
  $('#actionMessage').textContent = message;
  $('#actionNotice').hidden = false;
}

async function runAction(action, id) {
  const key = `${action}:${id}`;
  if (pendingActions.has(key)) return;
  pendingActions.add(key);
  try {
    if (action === 'go-to') $('#actionNotice').hidden = true;
    else showActionMessage('正在执行…');
    const response = await fetch(`/api/actions/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(8000)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || `HTTP ${response.status}`);
    if (action !== 'go-to') showActionMessage(result.message);
  } catch (error) {
    showActionMessage(`操作失败：${error.message}`);
  } finally {
    pendingActions.delete(key);
  }
}

$('#backButton').addEventListener('click', goBack);
// Reopening preserves the last list search/filter; the initial entry is "全部".
$('#allTasksButton').addEventListener('click', (event) => openAll(undefined, event.currentTarget));
$('#refreshButton').addEventListener('click', () => refresh(true));
$('#dismissNoticeButton').addEventListener('click', () => { $('#actionNotice').hidden = true; });
const feedbackFormURL = 'https://f.kdocs.cn/g/h09CF9me/';
let feedbackSessionId = '';

function hideFeedbackMenu() {
  $('#taskFeedbackMenu').hidden = true;
  feedbackSessionId = '';
}

async function copyDiagnostic(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error('剪贴板不可用');
  }
}

async function reportSession(id) {
  const session = sessions.find((item) => item.id === id);
  const place = document.querySelector(`.task-row[data-id="${CSS.escape(id)}"]`)?.dataset.place || '';
  if (!session) {
    showActionMessage('没有找到这条任务，请刷新后再反馈');
    return;
  }
  try {
    const response = await fetch('/api/session-diagnostic', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session,
        place,
        appVersion: '网页',
        generatedAt: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        osVersion: navigator.userAgent,
        scannedAt: lastScannedAt instanceof Date ? lastScannedAt.toISOString() : '',
        errors,
        connections
      })
    });
    const result = await response.json();
    if (!response.ok || !result.ok || !result.text) throw new Error(result.message || '诊断没有生成');
    try {
      await copyDiagnostic(result.text);
    } catch (error) {
      showActionMessage(`诊断没有复制到剪贴板：${error.message}`);
      return;
    }
    window.open(feedbackFormURL, '_blank', 'noopener');
    showActionMessage('请在打开的表单中粘贴当前数据的排查日志');
  } catch (error) {
    showActionMessage(`诊断没有生成：${error.message}`);
  }
}

document.addEventListener('contextmenu', (event) => {
  const row = event.target.closest('.task-row');
  const menu = $('#taskFeedbackMenu');
  if (!row?.dataset.id) {
    hideFeedbackMenu();
    return;
  }
  event.preventDefault();
  feedbackSessionId = row.dataset.id;
  menu.hidden = false;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideFeedbackMenu();
});

document.addEventListener('click', (event) => {
  if (event.target.closest('#taskFeedbackMenu button')) {
    const id = feedbackSessionId;
    hideFeedbackMenu();
    reportSession(id);
    return;
  }
  hideFeedbackMenu();
  const action = event.target.closest('[data-action]');
  if (action && !action.disabled) runAction(action.dataset.action, action.dataset.id);
  const toggle = event.target.closest('[data-toggle-group]');
  if (toggle) toggleGroup(toggle.dataset.toggleGroup);
  const group = event.target.closest('[data-open-filter]');
  if (group) openAll(group.dataset.openFilter, group);
  const filter = event.target.closest('[data-filter]');
  if (filter) chooseFilter(filter.dataset.filter);
  if (event.target.closest('[data-reset]')) {
    query = ''; chooseFilter('all');
  }
  const clearRoot = event.target.closest('[data-clear-root]');
  if (clearRoot) saveDataRoot(clearRoot.dataset.clearRoot, '', true);
});
document.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-root]');
  if (!form) return;
  event.preventDefault();
  saveDataRoot(form.dataset.root, new FormData(form).get('path'), false);
});

async function saveDataRoot(id, rootPath, clear) {
  try {
    const response = await fetch(clear ? `/api/data-roots?id=${encodeURIComponent(id)}` : '/api/data-roots', {
      method: clear ? 'DELETE' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: clear ? undefined : JSON.stringify({ id, path: rootPath }),
      signal: AbortSignal.timeout(8000)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || `HTTP ${response.status}`);
    connectionMarkup = '';
    while (isRefreshing) await new Promise((resolve) => setTimeout(resolve, 100));
    await refresh(true);
  } catch (error) {
    showActionMessage(error.message || '没有保存数据目录');
  }
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && page === 'all') { goBack(); event.preventDefault(); }
});
render();
refresh(true);
setInterval(() => refresh(false), 10000);

const scrollFade = document.createElement('div');
scrollFade.className = 'bottom-scroll-fade';
scrollFade.setAttribute('aria-hidden', 'true');
$('.radar').append(scrollFade);
function updateBottomFade() {
  const scroll = page === 'overview' ? $('#overviewPage') : $('#sessionRows');
  const more = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 1;
  scrollFade.hidden = !more;
  if (!more) return;
  const rect = scroll.getBoundingClientRect(), panel = $('.radar'), outer = panel.getBoundingClientRect();
  Object.assign(scrollFade.style, { left: `${rect.left - outer.left - panel.clientLeft}px`, top: `${rect.bottom - outer.top - panel.clientTop - 12}px`, width: `${scroll.clientWidth}px` });
}
for (const element of [$('#overviewPage'), $('#sessionRows')]) element.addEventListener('scroll', updateBottomFade, { passive: true });
new ResizeObserver(updateBottomFade).observe($('.radar'));
