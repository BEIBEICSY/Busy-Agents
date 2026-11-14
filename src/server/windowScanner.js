import { runCommand } from './shell.js';
import { isMetaCursorWindowTitle } from './cursorAgentScanner.js';

const windowScript = `
const systemEvents = Application('System Events');
const processes = systemEvents.processes.whose({ backgroundOnly: false })();
const windows = [];

for (const process of processes) {
  let app = '';
  try {
    app = process.name();
  } catch (_) {
    app = '';
  }

  let processWindows = [];
  try {
    processWindows = process.windows();
  } catch (_) {
    processWindows = [];
  }

  for (const window of processWindows) {
    let title = '';
    try {
      title = window.name();
    } catch (_) {
      title = '';
    }

    if (app && title) {
      windows.push({ app, title });
    }
  }
}

JSON.stringify(windows);
`;

function includesAny(value, needles) {
  const normalized = String(value || '').toLowerCase();
  return needles.some((needle) => normalized.includes(String(needle).toLowerCase()));
}

export function parseWindowJson(output) {
  try {
    const parsed = JSON.parse(output || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.app === 'string' && typeof item.title === 'string')
      : [];
  } catch {
    return [];
  }
}

function matchWindowToTool(windowInfo, tools) {
  return tools.find((tool) => {
    return includesAny(windowInfo.app, tool.processNames)
      || includesAny(windowInfo.title, tool.windowTitleKeywords);
  }) || null;
}

function inferProjectFromTitle(title) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return '未知项目';
  const firstPart = cleanTitle.split(' - ')[0] || cleanTitle;
  return firstPart.trim() || '未知项目';
}

export function inferWindowSessionTitle(tool, windowTitle) {
  if (tool.id === 'cursor-ide' || tool.id === 'cursor') return '编辑器';
  if (tool.type?.includes('terminal')) return '终端窗口';
  return inferProjectFromTitle(windowTitle);
}

export function buildWindowSessions({ windows, tools, now }) {
  return windows
    .map((windowInfo, index) => {
      const tool = matchWindowToTool(windowInfo, tools);
      if (!tool || isMetaCursorWindowTitle(windowInfo.title)) return null;

      return {
        id: `window:${tool.id}:${index}:${windowInfo.title}`,
        tool: tool.name,
        toolId: tool.id,
        source: 'window',
        title: inferWindowSessionTitle(tool, windowInfo.title),
        projectName: inferProjectFromTitle(windowInfo.title),
        projectPath: '',
        status: 'running',
        statusReason: '',
        attentionReason: '',
        lastActivityAt: now.toISOString(),
        statusFacts: {
          hasExecution: false,
          executionPhase: 'unknown',
          viewState: 'indeterminate',
          nativeStatus: 'window-visible',
          signalSource: 'window',
          signalObservedAt: now.toISOString()
        },
        process: null,
        window: {
          app: windowInfo.app,
          title: windowInfo.title
        },
        jump: {
          canActivateApp: true,
          canOpenProject: false,
          canCopyPath: false
        }
      };
    })
    .filter(Boolean);
}

let windowScanCache = null;
const WINDOW_SCAN_CACHE_MS = 5000;

export async function scanWindows(tools, options = {}) {
  const now = Date.now();
  if (!options.bustCache && windowScanCache && now - windowScanCache.at < WINDOW_SCAN_CACHE_MS) {
    return windowScanCache.value;
  }

  const result = await runCommand('osascript', ['-l', 'JavaScript', '-e', windowScript], { timeoutMs: 5000 });
  if (!result.ok) {
    return {
      sessions: [],
      errors: ['窗口扫描不可用：可能需要在 macOS 设置中为当前终端或运行工具开启辅助功能权限。']
    };
  }

  const value = {
    sessions: buildWindowSessions({ windows: parseWindowJson(result.stdout), tools, now: new Date() }),
    errors: []
  };
  windowScanCache = { at: now, value };
  return value;
}
