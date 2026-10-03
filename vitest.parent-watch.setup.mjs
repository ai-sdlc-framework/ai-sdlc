/**
 * Vitest per-worker setup (AISDLC-681): exit when the parent dies.
 *
 * A vitest pool worker is a child of the vitest main process. When that
 * process is killed uncleanly (SIGKILL, a Bash-tool timeout, a dead session)
 * the workers are reparented to pid 1 and keep running, holding gigabytes.
 * Poll the parent pid every 2 s; once it becomes 1 (or changes at all, which
 * covers container subreapers) the parent is gone and the worker terminates itself.
 *
 * Termination is `process.kill(process.pid, 'SIGKILL')`, NOT `process.exit(1)`:
 * vitest replaces `process.exit` inside workers with a function that throws,
 * so an exit call from the watchdog would be swallowed and the orphan would
 * live on (AISDLC-685). The timer is unref'd so it never keeps a healthy
 * worker alive.
 */
const POLL_MS = 2000;

const initialParent = process.ppid;

if (initialParent > 1) {
  const timer = setInterval(() => {
    if (process.ppid === 1 || process.ppid !== initialParent) process.kill(process.pid, 'SIGKILL');
  }, POLL_MS);
  timer.unref();
}
