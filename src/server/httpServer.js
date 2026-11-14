import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActions } from './actions.js';
import {
  annotateConnections,
  createDataRootStore,
  resolveToolSources,
  scannerOptionsFor,
  summarizeConnections
} from './dataRoots.js';
import {
  buildCodexAppThreadSessions,
  enrichCodexSessions,
  scanCodexThreads
} from './codexSessionScanner.js';
import { scanCursorAgents } from './cursorAgentScanner.js';
import { scanProcesses } from './processScanner.js';
import { mergeSessions } from './sessionNormalizer.js';
import { formatSessionDiagnostic } from './sessionDiagnostic.js';
import { createSessionStore } from './sessionStore.js';
import { createTerminalSessionLog } from './terminalSessionLog.js';
import { createScanCache } from './scanCache.js';
import { finalizeSessions } from './statusModel.js';
import { scanWorkBuddy } from './workBuddySessionScanner.js';
import { scanTraeIde, scanTraeWork } from './traeSessionScanner.js';
import { scanWpsLingxi } from './wpsLingxiSessionScanner.js';
import { scanWpsComate } from './wpsComateSessionScanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const publicRoot = path.join(projectRoot, 'public');

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function contentType(filePath) {
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'text/html; charset=utf-8';
}

export function createDefaultScanner(config, options = {}) {
  const store = createSessionStore();
  const terminalLog = options.terminalSessionLogPath
    ? createTerminalSessionLog({ filePath: options.terminalSessionLogPath })
    : null;
  const scanCache = options.scanCache || createScanCache(options.scanCacheTtlMs || 3000);
  const scanProcessesImpl = options.scanProcesses || scanProcesses;
  const scanCursorAgentsImpl = options.scanCursorAgents || scanCursorAgents;
  const scanCodexThreadsImpl = options.scanCodexThreads || scanCodexThreads;
  const scanWorkBuddyImpl = options.scanWorkBuddy || scanWorkBuddy;
  const scanTraeIdeImpl = options.scanTraeIde || scanTraeIde;
  const scanTraeWorkImpl = options.scanTraeWork || scanTraeWork;
  const scanWpsLingxiImpl = options.scanWpsLingxi || scanWpsLingxi;
  const scanWpsComateImpl = options.scanWpsComate || scanWpsComate;
  const getNow = typeof options.now === 'function' ? options.now : () => options.now || new Date();
  const homeDir = options.home || os.homedir();
  const fsImpl = options.fs || fs;
  const dataRootStore = options.dataRootStore || createDataRootStore({ home: homeDir, fs: fsImpl });

  return async function scanAll(scanOptions = {}) {
    const bustCache = Boolean(scanOptions.bustCache);
    if (!bustCache) {
      const cached = scanCache.get();
      if (cached) return cached;
    }

    const now = getNow();
    const readerOptions = { now, lookbackDays: config.sessionLookbackDays || 7 };
    const emptyResult = () => Promise.resolve({ sessions: [], errors: [] });
    let sources = [];
    let rootError = '';
    try {
      sources = resolveToolSources({
        home: homeDir,
        env: options.env || process.env,
        overrides: dataRootStore.read(),
        profileExports: options.profileExports,
        fs: fsImpl,
        enabled: {
          cursor: config.cursorAgent?.enabled !== false,
          codex: true,
          workbuddy: config.productReaders?.workBuddy !== false,
          trae: config.productReaders?.traeIde !== false,
          traework: config.productReaders?.traeWork !== false,
          lingxi: config.productReaders?.wpsLingxi !== false,
          comate: config.productReaders?.wpsComate !== false
        }
      });
    } catch (error) {
      rootError = `数据目录检查失败：${error.message}`;
    }
    const [
      processResult,
      cursorAgentResult,
      codexThreadResult,
      workBuddyResult,
      traeIdeResult,
      traeWorkResult,
      wpsLingxiResult,
      wpsComateResult
    ] = await Promise.all([
      scanProcessesImpl(config.tools),
      config.cursorAgent?.enabled === false
        ? Promise.resolve({ sessions: [], errors: [] })
        : scanCursorAgentsImpl({
          ...scannerOptionsFor(sources, 'cursor'),
          activeWithinMs: (config.cursorAgent?.activeWithinHours || 24) * 60 * 60 * 1000
        }),
      scanCodexThreadsImpl({
        ...scannerOptionsFor(sources, 'codex'),
        now,
        activeWithinMs: (config.codex?.activeWithinHours || 24) * 60 * 60 * 1000
      }),
      config.productReaders?.workBuddy === false ? emptyResult() : scanWorkBuddyImpl({
        ...readerOptions,
        ...scannerOptionsFor(sources, 'workbuddy')
      }),
      config.productReaders?.traeIde === false ? emptyResult() : scanTraeIdeImpl({
        ...readerOptions,
        ...scannerOptionsFor(sources, 'trae')
      }),
      config.productReaders?.traeWork === false ? emptyResult() : scanTraeWorkImpl({
        ...readerOptions,
        ...scannerOptionsFor(sources, 'traework')
      }),
      config.productReaders?.wpsLingxi === false ? emptyResult() : scanWpsLingxiImpl({
        ...readerOptions,
        ...scannerOptionsFor(sources, 'lingxi')
      }),
      config.productReaders?.wpsComate === false ? emptyResult() : scanWpsComateImpl({
        ...readerOptions,
        ...scannerOptionsFor(sources, 'comate')
      })
    ]);

    const codexActiveWithinMs = (config.codex?.activeWithinHours || 24) * 60 * 60 * 1000;
    const processSessions = enrichCodexSessions(
      processResult.sessions,
      codexThreadResult.threads || [],
      { now, activeWithinMs: codexActiveWithinMs }
    );
    const codexAppThreadSessions = buildCodexAppThreadSessions(
      codexThreadResult.threads || [],
      processResult.sessions,
      {
        now: options.now ? now : new Date(),
        activeWithinMs: codexActiveWithinMs,
        turnStates: codexThreadResult.turnStates,
        unreadState: codexThreadResult.unreadState,
        runtimeStates: codexThreadResult.runtimeStates
      }
    );
    const codexThreadScanSucceeded = !(codexThreadResult.errors || []).length;
    const visibleProcessSessions = processSessions.filter((session) => {
      const command = String(session.process?.command || '');
      const isGenericAppServer = ['codex', 'codex-desktop'].includes(session.toolId || session.tool)
        && !session.projectPath
        && !session.codexThread
        && /\bapp-server\b/i.test(command);

      if (session.statusFacts?.hasExecution === false) return false;
      if (session.source === 'process') return false;
      return !isGenericAppServer || !codexThreadScanSucceeded;
    });
    const processScanOk = !(processResult.errors || []).length;
    const retainedTerminalSessions = terminalLog
      ? terminalLog.sync(visibleProcessSessions, {
        now,
        lookbackDays: config.sessionLookbackDays || 7,
        processScanOk
      })
      : [];
    const merged = mergeSessions([
      ...visibleProcessSessions,
      ...retainedTerminalSessions,
      ...codexAppThreadSessions,
      ...cursorAgentResult.sessions,
      ...workBuddyResult.sessions,
      ...traeIdeResult.sessions,
      ...traeWorkResult.sessions,
      ...wpsLingxiResult.sessions,
      ...wpsComateResult.sessions
    ]);
    const withFinished = store.update(merged, now);
    const sessions = finalizeSessions({
      sessions: withFinished,
      now,
      lookbackDays: config.sessionLookbackDays || 7
    });

    const errors = [
      ...(rootError ? [rootError] : []),
      ...processResult.errors,
      ...cursorAgentResult.errors,
      ...(codexThreadResult.errors || []),
      ...workBuddyResult.errors,
      ...traeIdeResult.errors,
      ...traeWorkResult.errors,
      ...wpsLingxiResult.errors,
      ...wpsComateResult.errors
    ];
    const connections = annotateConnections(sources, { sessions, errors });
    return scanCache.set({
      sessions,
      errors,
      connections,
      connectionSummary: summarizeConnections(connections, {
        sessionCount: sessions.length,
        errorCount: errors.length
      }),
      scannedAt: new Date().toISOString()
    });
  };
}

export function createHttpServer(config, dependencies = {}) {
  const actions = dependencies.actions || createActions();
  const dataRootStore = dependencies.dataRootStore || createDataRootStore({
    home: dependencies.home,
    fs: dependencies.fs
  });
  const scanAll = dependencies.scanAll || createDefaultScanner(config, {
    terminalSessionLogPath: dependencies.terminalSessionLogPath,
    dataRootStore,
    home: dependencies.home,
    env: dependencies.env,
    fs: dependencies.fs
  });
  let latestSessions = [];

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'ai-tool-session-dashboard',
        schemaVersion: 2,
        status: 'ready'
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const result = await scanAll({ bustCache: url.searchParams.has('fresh') });
      latestSessions = result.sessions;
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/session-diagnostic') {
      const body = await readBody(req);
      const result = formatSessionDiagnostic(body);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/data-roots') {
      const body = await readBody(req);
      const result = dataRootStore.set(body.id, body.path);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/api/data-roots') {
      const result = dataRootStore.clear(url.searchParams.get('id'));
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/actions/')) {
      const body = await readBody(req);
      const session = latestSessions.find((item) => item.id === body.id);
      if (!session) {
        sendJson(res, 404, { ok: false, message: '没有找到对应会话，请刷新后重试' });
        return;
      }

      const actionName = url.pathname.split('/').pop();
      const actionMap = {
        'go-to': actions.goTo,
        'open-project': actions.openProject,
        'copy-path': actions.copyPath
      };
      const action = actionMap[actionName];

      if (!action) {
        sendJson(res, 404, { ok: false, message: '未知操作' });
        return;
      }

      const result = await action(session);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.normalize(path.join(publicRoot, requestedPath));

    if (!filePath.startsWith(publicRoot) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'content-type': contentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
  });
}
