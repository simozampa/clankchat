import { spawnSync } from 'node:child_process';

const executable = process.env.SAMETREE_BIN || 'sametree';
const script = /\.[cm]?js$/iu.test(executable);
const command = script ? process.execPath : executable;
const args = [...(script ? [executable] : []), 'hook', 'worktree-guard'];
const env = {
  ...process.env,
  SAMETREE_CWD: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
};
let input = '';
for await (const chunk of process.stdin) input += chunk;

const result = spawnSync(command, args, {
  encoding: 'utf8',
  env,
  input,
  maxBuffer: 1024 * 1024,
  shell: process.platform === 'win32' && !script,
  timeout: 3_000,
  windowsHide: true,
});

if (result.status !== 0 || result.error) {
  let reason = 'SameTree could not verify this tool call remains in its launch worktree.';
  try {
    const failure = JSON.parse(result.stderr);
    if (typeof failure?.error?.message === 'string') reason = failure.error.message;
  } catch {}
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
}
