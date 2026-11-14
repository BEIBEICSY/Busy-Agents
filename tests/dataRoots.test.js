import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createHttpServer, createDefaultScanner } from '../src/server/httpServer.js';
import {
  annotateConnections,
  createDataRootStore,
  parseShellExports,
  resolveToolSources,
  summarizeConnections
} from '../src/server/dataRoots.js';

const SQLITE = Buffer.from('SQLite format 3\0');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-radar-roots-'));
}

function write(filePath, contents = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function request(server, { method, url, body }) {
  return new Promise((resolve) => {
    const req = new Readable({ read() {} });
    req.method = method;
    req.url = url;
    if (body) req.push(body);
    req.push(null);
    const chunks = [];
    const res = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });
    res.writeHead = (statusCode) => {
      res.statusCode = statusCode;
      return res;
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      Writable.prototype.end.call(res);
      resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      return res;
    };
    server.emit('request', req, res);
  });
}

test('shell exports expand the home directory without executing the shell', () => {
  const parsed = parseShellExports(`
    # export CODEX_HOME=/ignored
    export CODEX_HOME="$HOME/custom codex"
    CURSOR_DATA_DIR=~/CursorData
  `, ['CODEX_HOME', 'CURSOR_DATA_DIR'], '/Users/other');
  assert.equal(parsed.CODEX_HOME, '/Users/other/custom codex');
  assert.equal(parsed.CURSOR_DATA_DIR, '/Users/other/CursorData');
});

test('profile CODEX_HOME is used and a bad database is not reported as empty', () => {
  const home = tempHome();
  const custom = path.join(home, 'custom codex');
  write(path.join(home, '.codex/state_5.sqlite'), SQLITE);
  write(path.join(custom, 'state_5.sqlite'), Buffer.from('not a database'));
  write(path.join(home, '.zshrc'), `export CODEX_HOME="${custom}"\n`);
  const sources = resolveToolSources({
    home,
    env: {},
    enabled: { cursor: false, workbuddy: false, trae: false, traework: false, lingxi: false, comate: false }
  });
  const codex = sources[0];
  assert.equal(codex.path, path.join(custom, 'state_5.sqlite'));
  assert.equal(codex.probe, 'unsupported');
  assert.equal(codex.scannerOptions.stateDbPath, path.join(custom, 'state_5.sqlite'));
  const connections = annotateConnections(sources, { sessions: [], errors: [] });
  assert.equal(connections[0].status, 'unsupported');
  assert.equal(connections[0].needsAttention, true);
  assert.equal(summarizeConnections(connections, { sessionCount: 0 }).title, '1 个工具还没连上');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a readable store with no recent task is connected and empty', () => {
  const home = tempHome();
  write(path.join(home, '.codex/config.toml'), 'model = "demo"\n');
  const sources = resolveToolSources({
    home,
    env: {},
    profileExports: {},
    enabled: { cursor: false, workbuddy: false, trae: false, traework: false, lingxi: false, comate: false }
  });
  const [connection] = annotateConnections(sources, { sessions: [], errors: [] });
  assert.equal(connection.status, 'empty');
  assert.equal(connection.needsAttention, false);
  const summary = summarizeConnections([connection], { sessionCount: 0, errorCount: 0 });
  assert.equal(summary.show, false);
  assert.match(summary.emptyDetail, /Codex 已连接/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('an installed tool without a Hook is not treated as having no tasks', () => {
  const home = tempHome();
  write(path.join(home, 'Applications/Trae.app/Contents/Info.plist'), '<plist/>');
  write(path.join(home, 'Library/Application Support/Trae/User/globalStorage/state.vscdb'), SQLITE);
  const sources = resolveToolSources({
    home,
    env: {},
    profileExports: {},
    enabled: { cursor: false, codex: false, workbuddy: false, traework: false, lingxi: false, comate: false }
  });
  const [connection] = annotateConnections(sources);
  assert.equal(connection.status, 'hook_missing');
  assert.equal(connection.needsAttention, true);
  assert.match(connection.detail, /Hook/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('WorkBuddy falls back to the legacy database and keeps an unreadable file visible', () => {
  const home = tempHome();
  const legacy = path.join(home, 'Library/Application Support/WorkBuddy/codebuddy-sessions.vscdb');
  write(legacy, SQLITE);
  const found = resolveToolSources({
    home,
    env: {},
    profileExports: {},
    enabled: { cursor: false, codex: false, trae: false, traework: false, lingxi: false, comate: false }
  })[0];
  assert.equal(found.origin, 'variant');
  assert.equal(found.scannerOptions.dbPath, legacy);

  fs.chmodSync(legacy, 0o000);
  const blocked = resolveToolSources({
    home,
    env: {},
    profileExports: {},
    enabled: { cursor: false, codex: false, trae: false, traework: false, lingxi: false, comate: false }
  })[0];
  assert.equal(blocked.probe, 'unreadable');
  fs.chmodSync(legacy, 0o600);
  fs.rmSync(home, { recursive: true, force: true });
});

test('scanner errors that mean the store cannot be read do not stay empty', () => {
  const connections = annotateConnections([{
    id: 'workbuddy',
    name: 'WorkBuddy',
    toolIds: ['workbuddy-desktop'],
    errorPattern: /WorkBuddy/,
    probe: 'ready',
    detail: '',
    path: '/tmp/workbuddy.db',
    origin: 'default',
    appInstalled: true,
    explicit: false
  }], {
    sessions: [],
    errors: ['WorkBuddy 会话扫描失败：无法识别本地会话库结构']
  });
  assert.equal(connections[0].status, 'unsupported');
  assert.equal(connections[0].needsAttention, true);
});

test('a found session counts as connected even when another tool is absent', () => {
  const connections = annotateConnections([
    {
      id: 'cursor',
      name: 'Cursor',
      toolIds: ['cursor-agent'],
      errorPattern: /Cursor/,
      probe: 'ready',
      path: '/tmp/state.vscdb',
      origin: 'default',
      appInstalled: true,
      explicit: false
    },
    {
      id: 'codex',
      name: 'Codex',
      toolIds: ['codex-desktop'],
      errorPattern: /Codex/,
      probe: 'missing',
      path: '',
      origin: 'default',
      appInstalled: false,
      explicit: false
    }
  ], {
    sessions: [{ toolId: 'cursor-agent' }, { toolId: 'codex-cli' }]
  });
  assert.equal(connections[0].status, 'connected');
  assert.equal(connections[1].status, 'missing');
  assert.equal(connections[1].needsAttention, false);
  assert.equal(summarizeConnections(connections, { sessionCount: 2 }).show, false);
});

test('manual data roots persist only when the directory can be read', () => {
  const home = tempHome();
  const codexHome = path.join(home, 'moved-codex');
  write(path.join(codexHome, 'session_index.jsonl'), '{"id":"1"}\n');
  const store = createDataRootStore({ home, filePath: path.join(home, 'data-roots.json') });
  assert.deepEqual(store.set('codex', path.join(home, 'missing')), { ok: false, message: '这个目录不存在' });
  const saved = store.set('codex', codexHome);
  assert.equal(saved.ok, true);
  assert.equal(store.read().codex, fs.realpathSync(codexHome));
  assert.equal(store.clear('codex').ok, true);
  assert.deepEqual(store.read(), {});
  fs.rmSync(home, { recursive: true, force: true });
});

test('default scanner passes the discovered Codex home and publishes connection status', async () => {
  const home = tempHome();
  const custom = path.join(home, 'custom-codex');
  write(path.join(custom, 'state_5.sqlite'), SQLITE);
  write(path.join(home, '.zshrc'), `export CODEX_HOME="${custom}"\n`);
  write(path.join(home, 'Applications/Trae.app/Contents/Info.plist'), '<plist/>');
  let seen = null;
  const scanner = createDefaultScanner({
    tools: [],
    cursorAgent: { enabled: false },
    productReaders: { workBuddy: false, traeIde: true, traeWork: false, wpsLingxi: false, wpsComate: false }
  }, {
    home,
    env: {},
    scanProcesses: async () => ({ sessions: [], errors: [] }),
    scanCursorAgents: async () => ({ sessions: [], errors: [] }),
    scanCodexThreads: async (options) => {
      seen = options;
      return { threads: [], turnStates: new Map(), unreadState: { available: false, unreadThreadIds: new Set() }, errors: [] };
    },
    scanTraeIde: async () => ({ sessions: [], errors: [] })
  });
  const result = await scanner({ bustCache: true });
  assert.equal(seen.stateDbPath, path.join(custom, 'state_5.sqlite'));
  assert.equal(result.connections.find((item) => item.id === 'codex').status, 'empty');
  assert.equal(result.connections.find((item) => item.id === 'trae').status, 'hook_missing');
  assert.equal(result.connectionSummary.show, true);
  assert.match(result.connectionSummary.title, /还没连上/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('POST /api/data-roots stores a readable directory and DELETE clears it', async () => {
  const home = tempHome();
  const codexHome = path.join(home, 'codex-home');
  write(path.join(codexHome, 'config.toml'), 'model = "demo"\n');
  const store = createDataRootStore({ home, filePath: path.join(home, 'data-roots.json') });
  const server = createHttpServer({ tools: [] }, {
    dataRootStore: store,
    scanAll: async () => ({ sessions: [], errors: [] })
  });
  const rejected = await request(server, {
    method: 'POST',
    url: '/api/data-roots',
    body: JSON.stringify({ id: 'codex', path: '/definitely/missing' })
  });
  assert.equal(rejected.status, 400);
  const saved = await request(server, {
    method: 'POST',
    url: '/api/data-roots',
    body: JSON.stringify({ id: 'codex', path: codexHome })
  });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.body).ok, true);
  const cleared = await request(server, { method: 'DELETE', url: '/api/data-roots?id=codex' });
  assert.equal(cleared.status, 200);
  assert.deepEqual(store.read(), {});
  fs.rmSync(home, { recursive: true, force: true });
});
