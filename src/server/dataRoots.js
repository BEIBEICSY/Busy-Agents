import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOL_IDS = ['cursor', 'codex', 'workbuddy', 'trae', 'traework', 'lingxi', 'comate'];
const PROFILE_NAMES = ['.zshenv', '.zprofile', '.zshrc', '.bash_profile', '.bashrc'];
const EXPORT_KEYS = ['CODEX_HOME', 'CURSOR_DATA_DIR'];

export function expandHome(value, home) {
  const text = String(value || '').trim();
  if (!text) return '';
  const expanded = text === '~' ? home : text.startsWith('~/') ? path.join(home, text.slice(2)) : text;
  return expanded.replaceAll('${HOME}', home).replaceAll('$HOME', home);
}

export function parseShellExports(text, keys, home) {
  const wanted = new Set(keys);
  const found = {};
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || !wanted.has(match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    value = expandHome(value, home);
    if (value) found[match[1]] = value;
  }
  return found;
}

export function loadProfileExports(home, fsImpl = fs, keys = EXPORT_KEYS) {
  const merged = {};
  for (const name of PROFILE_NAMES) {
    const filePath = path.join(home, name);
    if (!exists(filePath, fsImpl)) continue;
    try {
      Object.assign(merged, parseShellExports(fsImpl.readFileSync(filePath, 'utf8'), keys, home));
    } catch {
      // A shell profile the app cannot read is not a tool data failure.
    }
  }
  return merged;
}

function exists(filePath, fsImpl) {
  try {
    return Boolean(fsImpl.existsSync(filePath));
  } catch {
    return false;
  }
}

function hasApp(names, home, fsImpl) {
  const roots = ['/Applications', path.join(home, 'Applications')];
  return names.some((name) => roots.some((root) => exists(path.join(root, name), fsImpl)));
}

function probeSqlite(filePath, fsImpl) {
  let fd;
  try {
    fd = fsImpl.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    const size = fsImpl.readSync(fd, buffer, 0, 16, 0);
    if (buffer.subarray(0, size).toString('utf8').startsWith('SQLite format 3')) {
      return { status: 'ready' };
    }
    return { status: 'unsupported', detail: '数据格式暂不支持，需要更新看板' };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', detail: '没有读取权限' };
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* ignore a file that is already closed */ }
    }
  }
}

function probeDir(dir, fsImpl) {
  try {
    const stat = fsImpl.statSync(dir);
    if (!stat.isDirectory()) return { status: 'unsupported', detail: '指定位置不是文件夹' };
    fsImpl.readdirSync(dir);
    return { status: 'ready' };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', detail: '没有读取权限' };
  }
}

function probeReadableFile(filePath, fsImpl) {
  let fd;
  try {
    if (!fsImpl.statSync(filePath).isFile()) return { status: 'missing' };
    fd = fsImpl.openSync(filePath, 'r');
    const buffer = Buffer.alloc(1);
    fsImpl.readSync(fd, buffer, 0, 1, 0);
    return { status: 'ready' };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', detail: '没有读取权限' };
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* ignore a file that is already closed */ }
    }
  }
}

function source(fields) {
  return {
    explicit: false,
    appInstalled: false,
    origin: 'default',
    detail: '',
    path: '',
    scannerOptions: {},
    ...fields
  };
}

function resolveCursor({ home, env, overrides, profileExports, fsImpl }) {
  const projectsRoot = path.join(home, '.cursor', 'projects');
  const standardDb = path.join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  const explicit = overrides.cursor || env.CURSOR_DATA_DIR || profileExports.CURSOR_DATA_DIR || '';
  const origin = overrides.cursor ? 'override' : env.CURSOR_DATA_DIR ? 'environment' : profileExports.CURSOR_DATA_DIR ? 'profile' : 'default';
  let dbPath = standardDb;
  if (explicit) {
    const resolved = expandHome(explicit, home);
    dbPath = resolved.endsWith('state.vscdb')
      ? resolved
      : path.join(resolved, 'User/globalStorage/state.vscdb');
  }
  const database = probeSqlite(dbPath, fsImpl);
  const projects = probeDir(projectsRoot, fsImpl);
  const appInstalled = hasApp(['Cursor.app'], home, fsImpl);
  const options = { stateDbPath: dbPath, projectsRoot };
  let probe = 'missing';
  let detail = '';
  let found = '';
  if (database.status === 'ready') {
    probe = 'ready';
    found = dbPath;
  } else if (database.status === 'unreadable' || database.status === 'unsupported') {
    probe = database.status;
    detail = database.detail;
    found = dbPath;
  } else if (!explicit && projects.status === 'ready') {
    probe = 'ready';
    found = projectsRoot;
  } else if (explicit) {
    detail = '指定的 Cursor 数据位置不存在';
    found = dbPath;
  } else if (appInstalled) {
    detail = '已安装，还没有可读的本机任务记录';
  }
  return source({
    id: 'cursor',
    name: 'Cursor',
    toolIds: ['cursor-agent', 'cursor-ide'],
    errorPattern: /Cursor/,
    explicit: Boolean(explicit),
    appInstalled,
    origin: explicit ? origin : 'default',
    probe,
    detail,
    path: found,
    scannerOptions: explicit || probe === 'ready' || probe === 'unreadable' || probe === 'unsupported' ? options : {}
  });
}

function codexOptions(dir) {
  return {
    stateDbPath: path.join(dir, 'state_5.sqlite'),
    threadHistoryDbPath: path.join(dir, 'thread_history_1.sqlite'),
    sessionIndexPath: path.join(dir, 'session_index.jsonl'),
    globalStatePath: path.join(dir, '.codex-global-state.json'),
    socketPath: path.join(dir, 'ipc', 'ipc.sock')
  };
}

function resolveCodex({ home, env, overrides, profileExports, fsImpl }) {
  let dir = path.join(home, '.codex');
  let origin = 'default';
  let explicit = false;
  if (overrides.codex) {
    dir = expandHome(overrides.codex, home);
    origin = 'override';
    explicit = true;
  } else if (env.CODEX_HOME) {
    dir = expandHome(env.CODEX_HOME, home);
    origin = 'environment';
    explicit = true;
  } else if (profileExports.CODEX_HOME) {
    dir = expandHome(profileExports.CODEX_HOME, home);
    origin = 'profile';
    explicit = true;
  }
  const options = codexOptions(dir);
  const folder = probeDir(dir, fsImpl);
  const state = probeSqlite(options.stateDbPath, fsImpl);
  const hasMarker = ['session_index.jsonl', 'thread_history_1.sqlite', 'config.toml', '.codex-global-state.json']
    .some((name) => exists(path.join(dir, name), fsImpl));
  const appInstalled = hasApp(['Codex.app', 'ChatGPT.app'], home, fsImpl);
  let probe = 'missing';
  let detail = '';
  let found = '';
  if (state.status === 'unreadable' || state.status === 'unsupported') {
    probe = state.status;
    detail = state.detail;
    found = options.stateDbPath;
  } else if (state.status === 'ready' || (folder.status === 'ready' && hasMarker)) {
    probe = 'ready';
    found = dir;
  } else if (folder.status === 'unreadable') {
    probe = 'unreadable';
    detail = '没有读取权限';
    found = dir;
  } else if (folder.status === 'ready' && explicit) {
    probe = 'unsupported';
    detail = '这个位置没有 Codex 数据文件';
    found = dir;
  } else if (explicit) {
    detail = '指定的 Codex 数据目录不存在';
    found = dir;
  } else if (appInstalled) {
    detail = '已安装，还没有可读的本机任务记录';
  }
  return source({
    id: 'codex',
    name: 'Codex',
    toolIds: ['codex-desktop'],
    errorPattern: /Codex/,
    explicit,
    appInstalled,
    origin,
    probe,
    detail,
    path: found,
    scannerOptions: explicit || probe !== 'missing' ? options : {}
  });
}

function resolveWorkBuddy({ home, overrides, fsImpl }) {
  const explicit = overrides.workbuddy || '';
  const native = path.join(home, '.workbuddy/workbuddy.db');
  const legacy = path.join(home, 'Library/Application Support/WorkBuddy/codebuddy-sessions.vscdb');
  const candidates = [];
  if (explicit) {
    const resolved = expandHome(explicit, home);
    if (resolved.endsWith('.vscdb')) candidates.push({ file: resolved, kind: 'legacy' });
    else if (resolved.endsWith('.db')) candidates.push({ file: resolved, kind: 'native' });
    else {
      candidates.push({ file: path.join(resolved, 'workbuddy.db'), kind: 'native' });
      candidates.push({ file: path.join(resolved, 'codebuddy-sessions.vscdb'), kind: 'legacy' });
    }
  } else {
    candidates.push({ file: native, kind: 'native' });
    candidates.push({ file: legacy, kind: 'legacy' });
  }
  const appInstalled = hasApp(['WorkBuddy.app'], home, fsImpl);
  for (const candidate of candidates) {
    const result = probeSqlite(candidate.file, fsImpl);
    if (result.status === 'missing') continue;
    const scannerOptions = candidate.kind === 'native'
      ? {
        nativeDbPath: candidate.file,
        dbPath: candidate.file,
        levelDbPath: path.join(path.dirname(candidate.file), 'app/session/Local Storage/leveldb')
      }
      : {
        dbPath: candidate.file,
        legacyDbPath: candidate.file,
        levelDbPath: path.join(path.dirname(candidate.file), 'Local Storage/leveldb')
      };
    return source({
      id: 'workbuddy',
      name: 'WorkBuddy',
      toolIds: ['workbuddy-desktop'],
      errorPattern: /WorkBuddy/,
      explicit: Boolean(explicit),
      appInstalled,
      origin: explicit ? 'override' : candidate.file === native ? 'default' : 'variant',
      probe: result.status,
      detail: result.detail || '',
      path: candidate.file,
      scannerOptions
    });
  }
  return source({
    id: 'workbuddy',
    name: 'WorkBuddy',
    toolIds: ['workbuddy-desktop'],
    errorPattern: /WorkBuddy/,
    explicit: Boolean(explicit),
    appInstalled,
    origin: explicit ? 'override' : 'default',
    probe: 'missing',
    detail: explicit ? '指定的 WorkBuddy 数据位置不存在' : appInstalled ? '已安装，还没有可读的本机任务记录' : '',
    path: explicit ? expandHome(explicit, home) : '',
    scannerOptions: explicit ? { nativeDbPath: expandHome(explicit, home), dbPath: expandHome(explicit, home) } : {}
  });
}

function hookPaths(home) {
  return [
    path.join(home, 'Library/Application Support/DesktopPet/trae_ai_task_events.jsonl'),
    path.join(home, 'Library/Application Support/DesktopPet/trae_hook_debug.jsonl')
  ];
}

function resolveHookedProduct({
  id, name, toolIds, errorPattern, folders, apps, home, overrides, fsImpl
}) {
  const explicit = overrides[id] || '';
  const dirs = explicit
    ? [expandHome(explicit, home)]
    : folders.map((folder) => path.join(home, 'Library/Application Support', folder));
  let dataRoot = '';
  let dataStatus = 'missing';
  let dataDetail = '';
  for (const dir of dirs) {
    const result = probeDir(dir, fsImpl);
    if (result.status === 'missing') continue;
    dataRoot = dir;
    dataStatus = result.status;
    dataDetail = result.detail || '';
    break;
  }
  const hooks = hookPaths(home).map((file) => ({ file, result: probeReadableFile(file, fsImpl) }));
  const hookReady = hooks.find((item) => item.result.status === 'ready');
  const hookBlocked = hooks.find((item) => item.result.status === 'unreadable');
  const appInstalled = hasApp(apps, home, fsImpl);
  const present = Boolean(dataRoot) || appInstalled || Boolean(explicit);
  const scannerOptions = {
    ...(dataRoot ? { dataRoot } : {}),
    eventPaths: hookPaths(home)
  };
  let probe = 'missing';
  let detail = '';
  let found = dataRoot;
  if (hookBlocked && !hookReady) {
    probe = 'unreadable';
    detail = hookBlocked.result.detail;
    found = hookBlocked.file;
  } else if (dataStatus === 'unreadable' || dataStatus === 'unsupported') {
    probe = dataStatus;
    detail = dataDetail;
  } else if (present && !hookReady) {
    probe = 'hook_missing';
    detail = '已找到这个工具，但本机没有任务 Hook。新电脑需要安装 Hook 后才能看到任务';
    found = dataRoot || (explicit ? expandHome(explicit, home) : '');
  } else if (hookReady && present) {
    probe = 'ready';
    found = dataRoot || hookReady.file;
  } else if (explicit) {
    detail = '指定的数据目录不存在';
    found = expandHome(explicit, home);
  }
  return source({
    id,
    name,
    toolIds,
    errorPattern,
    explicit: Boolean(explicit),
    appInstalled,
    origin: explicit ? 'override' : 'default',
    probe,
    detail,
    path: found,
    scannerOptions: present || explicit ? scannerOptions : {}
  });
}

function lingxiOptions(root, home) {
  return {
    partitionsRoot: path.join(root, 'Partitions'),
    cacheRoot: path.join(root, 'Partitions/lingxi.wps.cn/Cache/Cache_Data'),
    levelDbRoot: path.join(root, 'Partitions/lingxi.wps.cn/Local Storage/leveldb'),
    appServerStateRoot: path.join(root, 'app-server-data/state/accounts'),
    logRoot: path.join(home, 'Library/Logs/WPS 灵犀/app')
  };
}

function resolveDirectoryProduct({
  id, name, toolIds, errorPattern, folders, apps, home, overrides, fsImpl, optionsFor
}) {
  const explicit = overrides[id] || '';
  const dirs = explicit
    ? [expandHome(explicit, home)]
    : folders.map((folder) => path.join(home, 'Library/Application Support', folder));
  const appInstalled = hasApp(apps, home, fsImpl);
  for (const dir of dirs) {
    const result = probeDir(dir, fsImpl);
    if (result.status === 'missing') continue;
    return source({
      id,
      name,
      toolIds,
      errorPattern,
      explicit: Boolean(explicit),
      appInstalled,
      origin: explicit ? 'override' : dir.endsWith(folders[0]) ? 'default' : 'variant',
      probe: result.status,
      detail: result.detail || '',
      path: dir,
      scannerOptions: optionsFor(dir, home)
    });
  }
  const chosen = explicit ? expandHome(explicit, home) : '';
  return source({
    id,
    name,
    toolIds,
    errorPattern,
    explicit: Boolean(explicit),
    appInstalled,
    origin: explicit ? 'override' : 'default',
    probe: 'missing',
    detail: explicit ? '指定的数据目录不存在' : appInstalled ? '已安装，还没有可读的本机任务记录' : '',
    path: chosen,
    scannerOptions: explicit ? optionsFor(chosen, home) : {}
  });
}

function resolveComate({ home, overrides, fsImpl }) {
  const explicit = overrides.comate || '';
  const standard = path.join(home, '.wpscomate/data/chat_history.db');
  let dbPath = standard;
  if (explicit) {
    const resolved = expandHome(explicit, home);
    dbPath = resolved.endsWith('.db') ? resolved : path.join(resolved, 'data/chat_history.db');
  }
  const result = probeSqlite(dbPath, fsImpl);
  const root = path.dirname(path.dirname(dbPath));
  const appInstalled = hasApp(['WPS Comate.app', 'WPSComate.app'], home, fsImpl);
  const scannerOptions = {
    dbPath,
    logRoot: path.join(root, 'agent/logs'),
    stateDbPath: path.join(root, 'data/client-state.db')
  };
  if (result.status === 'missing') {
    return source({
      id: 'comate',
      name: 'WPS Comate',
      toolIds: ['wps-comate-desktop'],
      errorPattern: /Comate/,
      explicit: Boolean(explicit),
      appInstalled,
      origin: explicit ? 'override' : 'default',
      probe: 'missing',
      detail: explicit ? '指定的 WPS Comate 数据位置不存在' : appInstalled ? '已安装，还没有可读的本机任务记录' : '',
      path: explicit ? dbPath : '',
      scannerOptions: explicit ? scannerOptions : {}
    });
  }
  return source({
    id: 'comate',
    name: 'WPS Comate',
    toolIds: ['wps-comate-desktop'],
    errorPattern: /Comate/,
    explicit: Boolean(explicit),
    appInstalled,
    origin: explicit ? 'override' : 'default',
    probe: result.status,
    detail: result.detail || '',
    path: dbPath,
    scannerOptions
  });
}

export function resolveToolSources({
  home = os.homedir(),
  env = process.env,
  overrides = {},
  profileExports,
  fs: fsImpl = fs,
  enabled = {}
} = {}) {
  const profiles = profileExports || loadProfileExports(home, fsImpl);
  const context = { home, env, overrides, profileExports: profiles, fsImpl };
  const flags = {
    cursor: true,
    codex: true,
    workbuddy: true,
    trae: true,
    traework: true,
    lingxi: true,
    comate: true,
    ...enabled
  };
  const sources = [
    flags.cursor ? resolveCursor(context) : null,
    flags.codex ? resolveCodex(context) : null,
    flags.workbuddy ? resolveWorkBuddy(context) : null,
    flags.trae ? resolveHookedProduct({
      id: 'trae',
      name: 'Trae',
      toolIds: ['trae-ide'],
      errorPattern: /Trae·IDE/,
      folders: ['Trae', 'Trae CN'],
      apps: ['Trae.app'],
      ...context
    }) : null,
    flags.traework ? resolveHookedProduct({
      id: 'traework',
      name: 'TraeWork',
      toolIds: ['traework-desktop'],
      errorPattern: /TraeWork/,
      folders: ['TRAE SOLO CN', 'TRAE Work CN', 'TraeWork'],
      apps: ['TRAE SOLO CN.app', 'TRAE Work CN.app', 'TraeWork.app'],
      ...context
    }) : null,
    flags.lingxi ? resolveDirectoryProduct({
      id: 'lingxi',
      name: 'WPS 灵犀',
      toolIds: ['wps-lingxi-desktop'],
      errorPattern: /灵犀/,
      folders: ['WPS 灵犀', 'WPS Lingxi'],
      apps: ['WPS 灵犀.app', 'WPS Lingxi.app'],
      optionsFor: lingxiOptions,
      ...context
    }) : null,
    flags.comate ? resolveComate(context) : null
  ];
  return sources.filter(Boolean);
}

export function scannerOptionsFor(sources, id) {
  return sources.find((item) => item.id === id)?.scannerOptions || {};
}

export function annotateConnections(sources, { sessions = [], errors = [] } = {}) {
  return sources.map((item) => {
    const count = sessions.filter((session) => item.toolIds.includes(session.toolId || session.tool)).length;
    const ownErrors = errors.filter((error) => item.errorPattern.test(String(error || '')));
    const blocking = ownErrors.filter((error) => !/未读状态读取失败|已查看状态读取失败/.test(error));
    let status = item.probe;
    let detail = item.detail || '';
    if (count > 0) {
      status = 'connected';
      detail = '';
    } else if (status === 'ready' && blocking.length) {
      const text = blocking.join(' ');
      if (/无法识别|格式/.test(text)) {
        status = 'unsupported';
        detail = '数据格式暂不支持，需要更新看板';
      } else {
        status = 'unreadable';
        detail = /权限|EPERM|EACCES|Operation not permitted|unable to open database/i.test(text)
          ? '没有读取权限'
          : '已找到数据，但没有读成功';
      }
    } else if (status === 'ready') {
      status = 'empty';
      detail = '已连接，最近 7 天没有任务';
    }
    const needsAttention = ['unreadable', 'unsupported', 'hook_missing'].includes(status)
      || (status === 'missing' && (item.appInstalled || item.explicit));
    return {
      id: item.id,
      name: item.name,
      status,
      detail,
      path: item.path || '',
      origin: item.origin,
      needsAttention,
      canChoosePath: true
    };
  });
}

export function summarizeConnections(connections, { sessionCount = 0, errorCount = 0 } = {}) {
  const attention = connections.filter((item) => item.needsAttention);
  if (attention.length) {
    return { show: true, tone: 'warning', title: `${attention.length} 个工具还没连上`, emptyDetail: '' };
  }
  const linked = connections.filter((item) => item.status === 'connected' || item.status === 'empty');
  if (sessionCount === 0 && errorCount === 0 && linked.length === 0) {
    return {
      show: true,
      tone: 'quiet',
      title: '还没有发现本机 AI 工具的数据',
      emptyDetail: '可指定工具的数据目录，或先在工具里执行一次任务'
    };
  }
  if (sessionCount === 0 && errorCount === 0 && linked.length > 0) {
    return {
      show: false,
      tone: 'ok',
      title: '',
      emptyDetail: `${linked.map((item) => item.name).join('、')} 已连接，最近 7 天没有任务`
    };
  }
  return { show: false, tone: 'ok', title: '', emptyDetail: '' };
}

function normalizeChosenPath(rawPath, home, fsImpl) {
  const expanded = expandHome(rawPath, home);
  if (!expanded || expanded.includes('\0')) return { ok: false, message: '请填写数据目录' };
  if (!path.isAbsolute(expanded)) return { ok: false, message: '请填写完整路径' };
  const resolved = path.resolve(expanded);
  if (resolved === '/' || resolved === '/Users') return { ok: false, message: '这个路径太宽，请指到工具自己的数据目录' };
  let real = resolved;
  try {
    real = fsImpl.realpathSync(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, message: '这个目录不存在' };
    return { ok: false, message: '没有读取权限' };
  }
  const allowed = ['/Users/', '/Volumes/', '/private/', '/tmp/', '/var/', '/opt/'];
  if (!allowed.some((prefix) => real === prefix.slice(0, -1) || real.startsWith(prefix))) {
    return { ok: false, message: '请选择用户目录里的数据位置' };
  }
  return { ok: true, path: real };
}

function validateChosen(id, chosenPath, home, fsImpl) {
  const sources = resolveToolSources({
    home,
    env: {},
    overrides: { [id]: chosenPath },
    profileExports: {},
    fs: fsImpl
  });
  const found = sources.find((item) => item.id === id);
  if (!found) return { ok: false, message: '未知工具' };
  if (found.probe === 'ready' || found.probe === 'hook_missing') return { ok: true };
  return { ok: false, message: found.detail || '这个位置还不能作为该工具的数据目录' };
}

export function createDataRootStore({ filePath, fs: fsImpl = fs, home = os.homedir() } = {}) {
  const target = filePath || path.join(home, 'Library/Application Support/AI Task Radar/data-roots.json');

  function read() {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
      const clean = {};
      for (const id of TOOL_IDS) {
        if (typeof parsed?.[id] === 'string' && parsed[id].trim()) clean[id] = parsed[id].trim();
      }
      return clean;
    } catch {
      return {};
    }
  }

  function write(data) {
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    fsImpl.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fsImpl.renameSync(temporary, target);
  }

  return {
    filePath: target,
    read,
    set(id, rawPath) {
      if (!TOOL_IDS.includes(id)) return { ok: false, message: '未知工具' };
      const chosen = normalizeChosenPath(rawPath, home, fsImpl);
      if (!chosen.ok) return chosen;
      const verdict = validateChosen(id, chosen.path, home, fsImpl);
      if (!verdict.ok) return verdict;
      const next = read();
      next[id] = chosen.path;
      write(next);
      return { ok: true, id, path: chosen.path };
    },
    clear(id) {
      if (!TOOL_IDS.includes(id)) return { ok: false, message: '未知工具' };
      const next = read();
      delete next[id];
      write(next);
      return { ok: true, id };
    }
  };
}
