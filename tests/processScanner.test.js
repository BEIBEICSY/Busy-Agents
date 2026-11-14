import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePsOutput,
  matchProcessToTool,
  buildProcessSessions,
  isRelevantAiProcess,
  parseBatchLsofCwd,
  scanProcesses
} from '../src/server/processScanner.js';

const tools = [
  {
    id: 'codex',
    name: 'Codex',
    type: ['terminal'],
    processNames: ['codex'],
    commandKeywords: ['codex'],
    windowTitleKeywords: [],
    preferredOpen: 'terminal'
  }
];

test('parsePsOutput parses pid, parent pid, elapsed time, and command', () => {
  const rows = parsePsOutput(`  PID  PPID     ELAPSED COMMAND
12345 11111       12:03 codex --ask
23456     1    01:02:03 /Applications/Cursor.app/Contents/MacOS/Cursor
`);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 12345);
  assert.equal(rows[0].ppid, 11111);
  assert.equal(rows[0].command, 'codex --ask');
  assert.equal(rows[0].elapsedSeconds, 723);
});

test('matchProcessToTool matches command keywords case-insensitively', () => {
  const match = matchProcessToTool({ command: '/usr/local/bin/codex run' }, tools);
  assert.equal(match.name, 'Codex');
});

test('buildProcessSessions returns normalized terminal rows', () => {
  const sessions = buildProcessSessions({
    processes: [
      {
        pid: 12345,
        ppid: 11111,
        command: 'codex run',
        elapsedSeconds: 120,
        cwd: '/tmp/demo'
      }
    ],
    tools,
    now: new Date('2026-06-11T10:00:00.000Z')
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].tool, 'Codex·CLI');
  assert.equal(sessions[0].toolId, 'codex-cli');
  assert.equal(sessions[0].source, 'terminal');
  assert.equal(sessions[0].projectName, 'demo');
  assert.equal(sessions[0].title, '终端任务');
  assert.equal(sessions[0].status, 'running');
  assert.equal(sessions[0].statusFacts.executionPhase, 'active');
});

test('isRelevantAiProcess ignores helper and internal app processes', () => {
  const codexTool = tools[0];
  const cursorTool = {
    id: 'cursor',
    name: 'Cursor',
    type: ['gui'],
    processNames: ['Cursor'],
    commandKeywords: ['cursor'],
    windowTitleKeywords: [],
    preferredOpen: 'cursor'
  };

  assert.equal(
    isRelevantAiProcess(
      { command: '/Applications/Codex.app/Contents/Resources/node_repl' },
      codexTool
    ),
    false
  );
  assert.equal(
    isRelevantAiProcess(
      { command: '/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://' },
      codexTool
    ),
    true
  );
  assert.equal(
    isRelevantAiProcess(
      { command: '/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled' },
      codexTool
    ),
    true
  );
  assert.equal(
    isRelevantAiProcess(
      { command: 'codex run' },
      codexTool
    ),
    true
  );
  assert.equal(
    isRelevantAiProcess(
      { command: '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper' },
      cursorTool
    ),
    false
  );
  assert.equal(
    isRelevantAiProcess(
      { command: '/Applications/Cursor.app/Contents/MacOS/Cursor' },
      cursorTool
    ),
    true
  );
});

test('parseBatchLsofCwd maps pid to cwd from lsof output', () => {
  const cwdByPid = parseBatchLsofCwd(`p12345\ncwd\nn/tmp/demo\np23456\ncwd\nn/tmp/other\n`);

  assert.equal(cwdByPid.get(12345), '/tmp/demo');
  assert.equal(cwdByPid.get(23456), '/tmp/other');
});

test('Codex exec-server services are excluded while terminal invocations remain visible', () => {
  const executable = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const excluded = [
    `${executable} -c forced_login_method="chatgpt" exec-server --remote https://example.test/api`,
    'codex exec-server',
    'codex --config \'notice="app-server and exec-server"\' --profile work exec-server',
    'codex --config=notice="app-server" exec-server'
  ];
  const included = [
    'codex',
    'codex -C /tmp/demo',
    'codex exec "explain exec-server"',
    'codex resume --last',
    'codex "exec-server"',
    'codex --config \'notice="exec-server"\' exec "hello"',
    `${executable} exec "hello"`,
    'codex app-server --listen stdio://'
  ];
  for (const command of excluded) {
    assert.equal(isRelevantAiProcess({ command }, tools[0]), false, command);
  }
  for (const command of included) {
    assert.equal(isRelevantAiProcess({ command }, tools[0]), true, command);
  }
});

test('scanProcesses filters exec-server before project deduplication and retains CLI and desktop discovery', async () => {
  const commands = [];
  const result = await scanProcesses(tools, async (command, args) => {
    commands.push({ command, args });
    if (command === 'ps') {
      return { ok: true, stdout: [
        '100 1 02:00:00 /Applications/ChatGPT.app/Contents/Resources/codex -c forced_login_method="chatgpt" exec-server',
        '101 1 00:01:00 /usr/local/bin/codex exec "hello"',
        '102 1 01:00:00 /Applications/ChatGPT.app/Contents/Resources/codex app-server'
      ].join('\n') };
    }
    assert.equal(command, 'lsof');
    return { ok: true, stdout: 'p101\nn/tmp/Resources\np102\nn/\n' };
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.sessions.map((session) => session.toolId), ['codex-cli', 'codex-desktop']);
  assert.equal(result.sessions[0].projectName, 'Resources');
  assert.equal(result.sessions[0].process.pid, 101);
  assert.equal(result.sessions[0].statusFacts.hasExecution, true);
  assert.equal(result.sessions[1].statusFacts.hasExecution, false);
  assert.equal(commands[1].args.includes('100'), false);
});

test('buildProcessSessions keeps separate Codex tasks for separate project directories', () => {
  const sessions = buildProcessSessions({
    processes: [
      {
        pid: 12345,
        ppid: 11111,
        command: '/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://',
        elapsedSeconds: 120,
        cwd: '/Users/beibei/AI_Lifelog'
      },
      {
        pid: 22345,
        ppid: 21111,
        command: '/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://',
        elapsedSeconds: 240,
        cwd: '/Users/beibei/AI_Item_Agent/20_Personal_Projects/20260611-ai-tool-session-dashboard'
      }
    ],
    tools,
    now: new Date('2026-06-11T10:00:00.000Z')
  });

  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((session) => session.projectName), [
    'AI_Lifelog',
    '20260611-ai-tool-session-dashboard'
  ]);
  assert.deepEqual(sessions.map((session) => session.title), [
    '终端任务',
    '终端任务'
  ]);
});

const claudeTool = {
  id: 'claude-code',
  name: 'Claude Code',
  type: ['terminal'],
  processNames: ['claude', 'claude-code'],
  commandKeywords: ['claude', 'claude-code'],
  windowTitleKeywords: ['Claude'],
  preferredOpen: 'terminal'
};

test('Claude desktop, keyword mentions, and unknown directories are not Claude Code tasks', () => {
  const excluded = [
    '/Applications/Claude.app/Contents/MacOS/Claude',
    'rg -i claude',
    '/Users/beibei/.claude/plugins/cache/node /Users/beibei/.claude/plugins/cache/cliDaemon.js',
    'node /Users/beibei/.claude/projects/demo/tool.js'
  ];
  for (const command of excluded) {
    assert.equal(matchProcessToTool({ command }, [claudeTool])?.id, 'claude-code', command);
    assert.equal(isRelevantAiProcess({ command }, claudeTool), false, command);
  }

  const included = [
    'claude',
    'claude --resume',
    '/usr/local/bin/claude',
    'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    'node "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"'
  ];
  for (const command of included) {
    assert.equal(isRelevantAiProcess({ command }, claudeTool), true, command);
  }

  const sessions = buildProcessSessions({
    processes: [
      {
        pid: 41,
        ppid: 1,
        command: '/usr/local/bin/claude',
        elapsedSeconds: 5,
        cwd: '/'
      },
      {
        pid: 42,
        ppid: 1,
        command: '/usr/local/bin/claude',
        elapsedSeconds: 12,
        cwd: '/tmp/demo'
      }
    ],
    tools: [claudeTool],
    now: new Date('2026-11-08T02:02:00.000Z')
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].process.pid, 42);
  assert.equal(sessions[0].tool, 'Claude Code');
  assert.equal(sessions[0].projectName, 'demo');
  assert.equal(sessions[0].title, '终端任务');
  assert.equal(sessions[0].statusFacts.hasExecution, true);
});

test('buildProcessSessions treats root cwd as unknown project without project actions', () => {
  const sessions = buildProcessSessions({
    processes: [
      {
        pid: 32345,
        ppid: 31111,
        command: '/Applications/Codex.app/Contents/Frameworks/Electron Framework',
        elapsedSeconds: 360,
        cwd: '/'
      }
    ],
    tools,
    now: new Date('2026-06-11T10:00:00.000Z')
  });

  assert.equal(sessions[0].projectName, '未知项目');
  assert.equal(sessions[0].title, '未知会话');
  assert.equal(sessions[0].projectPath, '');
  assert.equal(sessions[0].jump.canOpenProject, false);
});
