import { runCommand as defaultRunCommand } from './shell.js';

function appNameForSession(session) {
  if (session.appName) return session.appName;
  if (session.window?.app) return session.window.app;
  if (String(session.source || '').includes('terminal')) return 'Terminal';
  if ((session.toolId || '').toLowerCase() === 'codex') return 'ChatGPT';
  return session.tool;
}

export function createActions({ runCommand = defaultRunCommand } = {}) {
  return {
    async goTo(session) {
      const appName = appNameForSession(session);
      const script = `tell application ${JSON.stringify(appName)} to activate`;
      const result = await runCommand('osascript', ['-e', script], { timeoutMs: 3000 });

      return result.ok
        ? { ok: true, message: `已前往 ${appName}` }
        : { ok: false, message: `无法前往 ${appName}：${result.error || result.stderr}` };
    },

    async openProject(session) {
      if (!session.projectPath) {
        return { ok: false, message: '没有可打开的项目路径' };
      }

      const result = await runCommand('open', [session.projectPath], { timeoutMs: 3000 });
      return result.ok
        ? { ok: true, message: '已打开项目' }
        : { ok: false, message: `无法打开项目：${result.error || result.stderr}` };
    },

    async copyPath(session) {
      if (!session.projectPath) {
        return { ok: false, message: '没有可复制的项目路径' };
      }

      const result = await runCommand('pbcopy', [], {
        timeoutMs: 3000,
        input: session.projectPath
      });

      return result.ok
        ? { ok: true, message: '已复制路径' }
        : { ok: false, message: `无法复制路径：${result.error || result.stderr}` };
    }
  };
}
