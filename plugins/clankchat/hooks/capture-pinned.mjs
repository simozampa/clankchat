import { spawn } from 'node:child_process';

// Chat awareness must never prevent Claude from accepting a user prompt.
const executable = process.env.CLANKCHAT_BIN || 'clankchat';
const script = /\.[cm]?js$/iu.test(executable);
const command = script ? process.execPath : executable;
const args = [...(script ? [executable] : []), '--harness', 'claude-code', 'message', 'capture'];
const env = {
  ...process.env,
  CLANKCHAT_CWD: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
};

try {
  const child = spawn(command, args, {
    env,
    shell: process.platform === 'win32' && !script,
    stdio: ['inherit', 'ignore', 'ignore'],
    windowsHide: true,
  });
  const timeout = setTimeout(() => {
    child.kill();
    process.exit(0);
  }, 2_000);
  const finish = () => {
    clearTimeout(timeout);
    process.exitCode = 0;
  };
  child.once('error', finish);
  child.once('close', finish);
} catch {
  process.exitCode = 0;
}
