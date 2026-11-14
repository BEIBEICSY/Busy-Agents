import { execFile } from 'node:child_process';

export function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let child;

    try {
      child = execFile(command, args, {
        timeout: options.timeoutMs || 5000,
        maxBuffer: options.maxBuffer || 1024 * 1024
      }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: error ? error.message : ''
        });
      });
    } catch (error) {
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        error: error.message
      });
      return;
    }

    if (typeof options.input === 'string' && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}
