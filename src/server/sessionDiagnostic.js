import os from 'node:os';
import { projectNameForDisplay, relativeTime, statusLabelFor } from '../../public/dashboardModel.js';

const FACT_LABELS = [
  ['hasExecution', '是否执行过'],
  ['executionPhase', '执行阶段'],
  ['viewState', '查看状态'],
  ['endReason', '结束原因'],
  ['nativeStatus', '原生状态'],
  ['nativeErrorType', '原生错误'],
  ['waitingReason', '等待原因'],
  ['runtimeStatus', '运行时'],
  ['activeFlags', '运行标记'],
  ['signalSource', '信号来源'],
  ['signalObservedAt', '信号时间']
];

const CONNECTION_BY_TOOL = {
  'cursor-agent': 'cursor',
  'cursor-ide': 'cursor',
  cursor: 'cursor',
  'codex-desktop': 'codex',
  'codex-cli': 'codex',
  codex: 'codex',
  'workbuddy-desktop': 'workbuddy',
  'trae-ide': 'trae',
  'traework-desktop': 'traework',
  'wps-lingxi-desktop': 'lingxi',
  'wps-comate-desktop': 'comate'
};

const ERROR_PATTERN_BY_CONNECTION = {
  cursor: /Cursor/,
  codex: /Codex/,
  workbuddy: /WorkBuddy/,
  trae: /Trae·IDE|Trae IDE/,
  traework: /TraeWork/,
  lingxi: /灵犀/,
  comate: /Comate/
};

const ORIGIN_LABELS = {
  default: '自动查找',
  override: '手动指定',
  environment: '环境变量',
  profile: '配置文件',
  variant: '变体目录'
};

const CONNECTION_STATUS_LABELS = {
  connected: '已连接，有任务',
  empty: '已连接，最近没有任务',
  missing: '未找到数据',
  unreadable: '不可读',
  unsupported: '格式不支持',
  hook_missing: '缺少 Hook'
};

function blank(value) {
  return value === undefined || value === null || value === '' ? '无' : String(value);
}

function line(label, value) {
  return `${label}：${blank(value)}`;
}

function scalar(value) {
  if (value === undefined || value === null || value === '') return '无';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (Array.isArray(value)) {
    const parts = value.filter((item) => ['string', 'number'].includes(typeof item)).map(String);
    return parts.length ? parts.join('、') : '无';
  }
  return '无';
}

function redact(value, home) {
  const text = String(value ?? '');
  if (!text) return '';
  let result = text;
  if (home && (result === home || result.startsWith(`${home}/`))) {
    result = `~${result.slice(home.length)}`;
  }
  return result.replace(/\/(?:Users|home)\/[^/\s]+/g, '~');
}

function connectionFor(session, connections) {
  const toolId = session.toolId || session.tool;
  const id = CONNECTION_BY_TOOL[toolId];
  if (!id) return null;
  return (Array.isArray(connections) ? connections : []).find((item) => item?.id === id) || { id };
}

export function formatSessionDiagnostic(input = {}, options = {}) {
  const session = input.session && typeof input.session === 'object' ? input.session : null;
  if (!session?.id) return { ok: false, message: '没有这条任务的诊断数据' };

  const generatedAt = typeof input.generatedAt === 'string' && !Number.isNaN(Date.parse(input.generatedAt))
    ? input.generatedAt
    : new Date().toISOString();
  const now = new Date(generatedAt);
  const home = options.home || os.homedir();
  const facts = session.statusFacts && typeof session.statusFacts === 'object' ? session.statusFacts : {};
  const displayTime = session.endedAt || session.lastActivityAt || '';
  const timeBasis = session.endedAt ? '结束时间' : session.lastActivityAt ? '最后活动' : '时间未知';
  const shownTime = displayTime ? `${relativeTime(displayTime, now.getTime())}（${timeBasis}）` : '时间未知';
  const connection = connectionFor(session, input.connections);
  const errorPattern = connection ? ERROR_PATTERN_BY_CONNECTION[connection.id] : null;
  const ownErrors = (Array.isArray(input.errors) ? input.errors : [])
    .map((error) => String(error || '').trim())
    .filter((error) => error && (!errorPattern || errorPattern.test(error)));
  const projectPath = redact(session.projectPath, home);
  const transcriptPath = redact(session.agent?.transcriptPath, home);
  const processId = session.process?.pid;

  const factLines = FACT_LABELS.map(([key, label]) => line(label, scalar(facts[key])));
  const text = [
    'Busy Agents 任务诊断',
    line('生成时间', generatedAt),
    line('应用版本', input.appVersion),
    line('系统', input.osVersion),
    line('时区', input.timezone),
    line('上次扫描', input.scannedAt),
    '',
    '这条任务',
    line('位置', input.place),
    line('编号', session.id),
    line('工具', session.tool),
    line('工具编号', session.toolId),
    line('来源', session.source),
    line('标题', session.title || '未知会话'),
    line('项目', projectNameForDisplay(session)),
    line('项目路径', projectPath),
    line('界面状态', statusLabelFor(session)),
    line('内部状态', session.status),
    line('状态原因', session.statusReason || session.attentionReason),
    line('界面时间', shownTime),
    line('活动时间', session.lastActivityAt),
    line('结束时间', session.endedAt),
    line('线程编号', session.codexThread?.id),
    line('会话编号', session.agent?.chatId),
    line('轮次数', scalar(session.agent?.turnCount)),
    line('进展提示', session.agent?.progressHint),
    line('记录文件', transcriptPath),
    line('进程号', processId),
    line('已运行秒数', scalar(session.process?.elapsedSeconds)),
    line('可打开应用', scalar(session.jump?.canActivateApp)),
    '',
    '状态证据',
    ...factLines,
    '',
    '本机连接',
    line('工具数据', connection?.name),
    line('目录来源', ORIGIN_LABELS[connection?.origin] || connection?.origin),
    line('连接状态', CONNECTION_STATUS_LABELS[connection?.status] || connection?.status),
    line('连接说明', connection?.detail),
    line('数据目录', redact(connection?.path, home)),
    line('扫描错误', ownErrors.length ? ownErrors.join(' | ') : ''),
    '',
    '说明',
    '只包含这条任务的状态证据、界面标题和项目名。不含聊天正文和命令行。'
  ].join('\n');

  return { ok: true, text };
}
