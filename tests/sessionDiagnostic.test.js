import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createHttpServer } from '../src/server/httpServer.js';
import { formatSessionDiagnostic } from '../src/server/sessionDiagnostic.js';

const secretCommand = '/Applications/ChatGPT.app/Contents/Resources/codex app-server --secret';

function sampleInput() {
  return {
    session: {
      id: 'codex-thread:abc',
      tool: 'Codex·Desktop',
      toolId: 'codex-desktop',
      source: 'codex-thread',
      title: '比较知识库 RAG 与 Agent',
      projectName: '20261109-1个月内找到工作',
      projectPath: '/Users/beibei/work/20261109-1个月内找到工作',
      status: 'completed_unseen',
      statusReason: 'Codex 已完成，尚未查看',
      lastActivityAt: '2026-11-14T07:28:00.000Z',
      endedAt: '2026-11-14T07:28:00.000Z',
      statusFacts: {
        hasExecution: true,
        executionPhase: 'succeeded',
        viewState: 'unseen',
        nativeStatus: 'completed',
        signalSource: 'codex-thread-history+codex-unread-state',
        signalObservedAt: '2026-11-14T07:28:00.000Z',
        prompt: '不要把这段提问正文放进反馈'
      },
      process: { pid: 42, command: secretCommand, elapsedSeconds: 9 },
      codexThread: { id: 'abc', title: '比较知识库 RAG 与 Agent' },
      agent: { transcriptPath: '/Users/beibei/Library/transcript.jsonl', chatId: 'chat-1', turnCount: 2 }
    },
    place: '概览 / 待查看',
    appVersion: '0.2.0',
    generatedAt: '2026-11-14T07:32:00.000Z',
    timezone: 'Asia/Shanghai',
    osVersion: 'Version 26.0',
    scannedAt: '2026-11-14T07:31:00.000Z',
    errors: ['Cursor 数据不可读', 'Codex 会话标题扫描失败：数据库不可读'],
    connections: [{
      id: 'codex',
      name: 'Codex',
      status: 'connected',
      detail: '',
      path: '/Users/beibei/.codex',
      origin: 'default'
    }]
  };
}

test('session diagnostic keeps the status evidence and redacts the home directory', () => {
  const result = formatSessionDiagnostic(sampleInput(), { home: '/Users/beibei' });

  assert.equal(result.ok, true);
  assert.match(result.text, /位置：概览 \/ 待查看/);
  assert.match(result.text, /标题：比较知识库 RAG 与 Agent/);
  assert.match(result.text, /项目：20261109-1个月内找到工作/);
  assert.match(result.text, /项目路径：~\/work\/20261109-1个月内找到工作/);
  assert.match(result.text, /界面状态：待查看/);
  assert.match(result.text, /内部状态：completed_unseen/);
  assert.match(result.text, /界面时间：4 分钟前（结束时间）/);
  assert.match(result.text, /信号来源：codex-thread-history\+codex-unread-state/);
  assert.match(result.text, /查看状态：unseen/);
  assert.match(result.text, /数据目录：~\/\.codex/);
  assert.match(result.text, /目录来源：自动查找/);
  assert.match(result.text, /Codex 会话标题扫描失败/);
  assert.match(result.text, /记录文件：~\/Library\/transcript\.jsonl/);
  assert.doesNotMatch(result.text, /\/Users\/beibei/);
  assert.doesNotMatch(result.text, /secret/);
  assert.doesNotMatch(result.text, /不要把这段提问正文/);
  assert.doesNotMatch(result.text, /Cursor 数据不可读/);
});

test('session diagnostic rejects a missing task', () => {
  const result = formatSessionDiagnostic({ session: {} });
  assert.equal(result.ok, false);
});

function request(server, { method, url, body }) {
  return new Promise((resolve) => {
    const req = new Readable({ read() {} });
    req.method = method;
    req.url = url;
    req.push(body || null);
    req.push(null);

    const chunks = [];
    const res = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });
    res.writeHead = (statusCode, headers) => {
      res.statusCode = statusCode;
      res.headers = headers;
      return res;
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      Writable.prototype.end.call(res);
      resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      });
      return res;
    };

    server.emit('request', req, res);
  });
}

test('POST /api/session-diagnostic formats the posted task without scanning', async () => {
  let scanned = false;
  const server = createHttpServer({ tools: [] }, {
    scanAll: async () => {
      scanned = true;
      return { sessions: [], errors: [] };
    }
  });

  const response = await request(server, {
    method: 'POST',
    url: '/api/session-diagnostic',
    body: JSON.stringify(sampleInput())
  });
  const payload = JSON.parse(response.body);

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.match(payload.text, /比较知识库 RAG 与 Agent/);
  assert.equal(scanned, false);

  const missing = await request(server, {
    method: 'POST',
    url: '/api/session-diagnostic',
    body: JSON.stringify({ session: null })
  });
  assert.equal(missing.status, 400);
});
