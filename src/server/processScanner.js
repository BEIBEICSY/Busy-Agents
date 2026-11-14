import path from 'node:path';
import { runCommand } from './shell.js';

function parseElapsedToSeconds(value) {
  const parts = String(value || '').trim().split('-');
  const dayPart = parts.length === 2 ? Number(parts[0]) : 0;
  const timePart = parts.length === 2 ? parts[1] : parts[0];
  const segments = timePart.split(':').map((part) => Number(part));

  if (segments.some((part) => Number.isNaN(part))) return 0;
  if (segments.length === 3) return dayPart * 86400 + segments[0] * 3600 + segments[1] * 60 + segments[2];
  if (segments.length === 2) return dayPart * 86400 + segments[0] * 60 + segments[1];
  if (segments.length === 1) return dayPart * 86400 + segments[0];
  return 0;
}

export function parsePsOutput(output) {
  return String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.toUpperCase().startsWith('PID '))
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return null;

      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        elapsedSeconds: parseElapsedToSeconds(match[3]),
        command: match[4]
      };
    })
    .filter(Boolean);
}

function includesAny(haystack, needles) {
  const normalized = String(haystack || '').toLowerCase();
  return needles.some((needle) => normalized.includes(String(needle).toLowerCase()));
}

export function matchProcessToTool(processInfo, tools) {
  return tools.find((tool) => {
    return includesAny(processInfo.command, tool.commandKeywords)
      || includesAny(processInfo.command, tool.processNames);
  }) || null;
}

const PROCESS_NOISE_PATTERNS = [
  /crashpad/i,
  /xpcservices/i,
  /cursoruiview/i,
  /\bhelper\b/i,
  /\brenderer\b/i,
  /gpu\.app/i,
  /node_repl/i,
  /sparkle/i,
  /extension-host/i,
  /computer-use/i,
  /analytics-default/i,
  /\.framework\//i
];

const CODEX_OPTIONS_WITH_VALUE = new Set([
  '-c', '--config', '-p', '--profile', '-C', '--cd', '-m', '--model',
  '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image',
  '--enable', '--disable', '--local-provider', '--add-dir'
]);

function commandTokens(command) {
  return (String(command || '').match(/(?:[^\s"'\\]|\\.|"(?:\\.|[^"\\])*"|'[^']*')+/g) || [])
    .map((token) => {
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        return token.slice(1, -1);
      }
      return token.replace(/\\(.)/g, '$1');
    });
}

function commandBasename(token) {
  const parts = String(token || '').split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

export function isClaudeCodeCli(command) {
  const tokens = commandTokens(command);
  if (!tokens.length) return false;

  let executable = tokens[0];
  if (/^(?:node|nodejs)$/i.test(commandBasename(executable))) {
    const script = tokens.slice(1).find((token) => token && !token.startsWith('-'));
    executable = script || '';
  }

  const name = commandBasename(executable);
  if (name === 'claude' || name === 'claude-code') return true;
  return name === 'cli.js' && /\/@anthropic-ai\/claude-code\//.test(executable);
}

function isCodexExecServer(command) {
  // Keep quoted config values together so their contents cannot act as a subcommand.
  const tokens = command.match(/(?:[^\s"'\\]|\\.|"(?:\\.|[^"\\])*"|'[^']*')+/g) || [];
  const executableIndex = tokens.findIndex((token) => /(^|\/)codex$/i.test(token));
  if (executableIndex === -1) return false;

  for (let index = executableIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') return false;
    if (CODEX_OPTIONS_WITH_VALUE.has(token)) {
      index += 1;
    } else if (!token.startsWith('-')) {
      // Only the first positional argument can be the service subcommand.
      return token === 'exec-server';
    }
  }
  return false;
}

export function isRelevantAiProcess(processInfo, tool) {
  const command = String(processInfo.command || '');

  if (tool.id === 'codex') {
    const isCodexExecutable = /(^|\s|\/)codex(?:\s|$)/i.test(command);
    if (isCodexExecServer(command)) return false;
    if (isCodexExecutable && /\bapp-server\b/i.test(command)) return true;
    if (PROCESS_NOISE_PATTERNS.some((pattern) => pattern.test(command))) return false;
    return isCodexExecutable;
  }

  if (PROCESS_NOISE_PATTERNS.some((pattern) => pattern.test(command))) {
    return false;
  }

  if (tool.id === 'cursor-ide' || tool.id === 'cursor') {
    return /\/Cursor\.app\/Contents\/MacOS\/Cursor\b/.test(command);
  }

  if (tool.id === 'claude-code') {
    return isClaudeCodeCli(command);
  }

  return true;
}

export function parseBatchLsofCwd(output) {
  const cwdByPid = new Map();
  let currentPid = null;

  for (const line of String(output || '').split('\n')) {
    if (line.startsWith('p')) {
      currentPid = Number(line.slice(1));
      continue;
    }

    if (line.startsWith('n/') && currentPid) {
      cwdByPid.set(currentPid, line.slice(1).trim());
    }
  }

  return cwdByPid;
}

export async function readProcessCwdsBatch(pids, runCommandImpl = runCommand) {
  if (!pids.length) return new Map();

  const args = pids.flatMap((pid) => ['-p', String(pid)]);
  const result = await runCommandImpl('lsof', [...args, '-a', '-d', 'cwd', '-Fn'], { timeoutMs: 5000 });

  return result.ok ? parseBatchLsofCwd(result.stdout) : new Map();
}

function dedupeProcessesByProject(processes, tools) {
  const byKey = new Map();

  for (const processInfo of processes) {
    const tool = matchProcessToTool(processInfo, tools);
    if (!tool) continue;

    const projectPath = normalizeProjectPath(processInfo.cwd);
    const key = `${tool.id}:${projectPath || processInfo.pid}`;
    const existing = byKey.get(key);

    if (!existing || processInfo.elapsedSeconds > existing.elapsedSeconds) {
      byKey.set(key, processInfo);
    }
  }

  return [...byKey.values()];
}

export function inferProjectName(cwd) {
  const projectPath = normalizeProjectPath(cwd);
  if (!projectPath) return '未知项目';
  return path.basename(projectPath) || projectPath;
}

export function normalizeProjectPath(cwd) {
  const value = String(cwd || '').trim();
  if (!value || value === '/') return '';
  return value;
}

export function inferSessionTitle(tool, projectName) {
  if (projectName && projectName !== '未知项目') {
    if (tool.id === 'cursor-ide' || tool.id === 'cursor') return '编辑器';
    if (tool.type.includes('terminal')) return '终端任务';
    return '工作区';
  }

  return '未知会话';
}

export function buildProcessSessions({ processes, tools, now }) {
  return processes
    .map((processInfo) => {
      const tool = matchProcessToTool(processInfo, tools);
      if (!tool) return null;
      const projectPath = normalizeProjectPath(processInfo.cwd);
      if (tool.id === 'claude-code' && (!projectPath || !isClaudeCodeCli(processInfo.command))) return null;
      const projectName = inferProjectName(projectPath);
      const isCodex = tool.id === 'codex';
      const isCodexDesktop = isCodex && /\bapp-server\b/i.test(processInfo.command);
      const surface = isCodex
        ? {
          tool: isCodexDesktop ? 'Codex·Desktop' : 'Codex·CLI',
          toolId: isCodexDesktop ? 'codex-desktop' : 'codex-cli',
          appName: isCodexDesktop ? 'ChatGPT' : 'Terminal'
        }
        : { tool: tool.name, toolId: tool.id, appName: tool.name };
      const observedAt = now.toISOString();

      return {
        id: `process:${processInfo.pid}`,
        tool: surface.tool,
        toolId: surface.toolId,
        appName: surface.appName,
        source: tool.type.includes('terminal') ? 'terminal' : 'process',
        title: inferSessionTitle(tool, projectName),
        projectName,
        projectPath,
        status: 'running',
        statusReason: '',
        attentionReason: '',
        lastActivityAt: observedAt,
        statusFacts: {
          hasExecution: !isCodexDesktop,
          executionPhase: isCodexDesktop ? 'unknown' : 'active',
          viewState: 'indeterminate',
          nativeStatus: 'process-active',
          signalSource: 'process',
          signalObservedAt: observedAt
        },
        process: {
          pid: processInfo.pid,
          ppid: processInfo.ppid,
          command: processInfo.command,
          elapsedSeconds: processInfo.elapsedSeconds
        },
        jump: {
          canActivateApp: true,
          canOpenProject: Boolean(projectPath),
          canCopyPath: Boolean(projectPath)
        }
      };
    })
    .filter(Boolean);
}

export async function readProcessCwd(pid) {
  const result = await runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeoutMs: 2000 });
  if (!result.ok) return '';

  const cwdLine = result.stdout.split('\n').find((line) => line.startsWith('n/'));
  return cwdLine ? cwdLine.slice(1).trim() : '';
}

export async function scanProcesses(tools, runCommandImpl = runCommand) {
  const result = await runCommandImpl('ps', ['-axo', 'pid=,ppid=,etime=,command='], { timeoutMs: 5000 });
  if (!result.ok) {
    return { sessions: [], errors: [`进程扫描失败：${result.error || result.stderr}`] };
  }

  const matched = parsePsOutput(result.stdout)
    .map((processInfo) => {
      const tool = matchProcessToTool(processInfo, tools);
      return tool ? { processInfo, tool } : null;
    })
    .filter(Boolean)
    .filter(({ processInfo, tool }) => isRelevantAiProcess(processInfo, tool))
    .map(({ processInfo }) => processInfo);

  const cwdByPid = await readProcessCwdsBatch(matched.map((processInfo) => processInfo.pid), runCommandImpl);
  const withCwd = matched.map((processInfo) => ({
    ...processInfo,
    cwd: cwdByPid.get(processInfo.pid) || ''
  }));
  const deduped = dedupeProcessesByProject(withCwd, tools);

  return {
    sessions: buildProcessSessions({ processes: deduped, tools, now: new Date() }),
    errors: []
  };
}
