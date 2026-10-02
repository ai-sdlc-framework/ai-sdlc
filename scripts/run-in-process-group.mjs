#!/usr/bin/env node
/**
 * Run a command in its OWN process group, with a wall-clock timeout, and kill
 * that whole group on exit, on timeout, on SIGINT/SIGTERM/SIGHUP, and when the
 * parent that started us disappears (AISDLC-681).
 *
 * Used by scripts/check-coverage.sh so a killed pre-push hook cannot leave
 * vitest pool workers behind. Portable: macOS has no `setsid`, so we use
 * `spawn(..., { detached: true })` (which calls setsid(2) in the child) and
 * `process.kill(-pgid)`.
 *
 * Usage: run-in-process-group.mjs --timeout-sec N [--log FILE] -- cmd [args...]
 * Exit codes: the command's own code; 124 on timeout; 128+n when killed by signal n.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) {
  console.error('usage: run-in-process-group.mjs --timeout-sec N [--log FILE] -- cmd [args...]');
  process.exit(2);
}
const opts = argv.slice(0, sep);
const cmd = argv.slice(sep + 1);
let timeoutSec = 900;
let logFile;
for (let i = 0; i < opts.length; i += 2) {
  if (opts[i] === '--timeout-sec') timeoutSec = Number(opts[i + 1]);
  else if (opts[i] === '--log') logFile = opts[i + 1];
  else {
    console.error(`unknown option: ${opts[i]}`);
    process.exit(2);
  }
}
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
  console.error(`invalid --timeout-sec: ${timeoutSec}`);
  process.exit(2);
}

const logFd = logFile ? openSync(logFile, 'w') : 'inherit';
const child = spawn(cmd[0], cmd.slice(1), {
  detached: true,
  stdio: ['ignore', logFd, logFd],
});
if (typeof logFd === 'number') closeSync(logFd);

const pgid = child.pid;

/** Signal the group we created. Never pgid 0/1, never our own pid/ppid. */
function killGroup(signal) {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid || pgid === process.ppid) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: group already gone
  }
}

let finished = false;
let exitCode = null;

function finish(code) {
  if (finished) return;
  finished = true;
  exitCode = code;
  killGroup('SIGTERM');
  setTimeout(() => {
    killGroup('SIGKILL');
    process.exit(exitCode);
  }, 1500);
}

child.on('error', (err) => {
  console.error(`run-in-process-group: failed to start ${cmd[0]}: ${err.message}`);
  finish(127);
});
child.on('exit', (code, signal) => {
  finish(code ?? (signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : 1));
});

for (const [sig, n] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
]) {
  process.on(sig, () => finish(n));
}

const timer = setTimeout(() => {
  console.error(
    `[run-in-process-group] TIMEOUT: command exceeded ${timeoutSec}s wall-clock limit; killing process group`,
  );
  finish(124);
}, timeoutSec * 1000);
timer.unref();

// If whoever started us died uncleanly (SIGKILL), do not outlive them.
const parentWatch = setInterval(() => {
  if (process.ppid === 1) finish(143);
}, 1000);
parentWatch.unref();
