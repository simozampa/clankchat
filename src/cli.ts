#!/usr/bin/env node
import { errorResult } from './errors.js';
import { runWithInstallRuntime } from './runtime.js';

const relaunched = await runWithInstallRuntime();
if (relaunched !== null) process.exit(relaunched);

const controller = new AbortController();
let signalExitCode: number | null = null;
const interrupt = () => {
  signalExitCode = 130;
  controller.abort();
};
const terminate = () => {
  signalExitCode = 143;
  controller.abort();
};
const hangup = () => {
  signalExitCode = 129;
  controller.abort();
};
const quit = () => {
  signalExitCode = 131;
  controller.abort();
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);
if (process.platform !== 'win32') {
  process.once('SIGHUP', hangup);
  process.once('SIGQUIT', quit);
}
try {
  const { run } = await import('./cli-main.js');
  await run(process.argv, controller.signal);
} catch (error) {
  if (!controller.signal.aborted) {
    process.stderr.write(`${JSON.stringify(errorResult(error))}\n`);
  }
  process.exitCode = signalExitCode ?? 1;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  process.off('SIGHUP', hangup);
  process.off('SIGQUIT', quit);
}
if (signalExitCode !== null) process.exitCode = signalExitCode;
