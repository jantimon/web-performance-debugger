/**
 * Best-effort synchronous cleanup on a fatal signal.
 *
 * A record run holds process-external resources: a Chrome child process, a temp static server, and (on
 * Firefox) a temp gecko dump file. On SIGINT/SIGTERM/SIGHUP none of the normal teardown runs, so each
 * orphans -- a Chrome process outlives the run, a temp file is left on disk. Acquisition sites register
 * a synchronous best-effort disposer here and deregister on clean release; the signal handler runs
 * whatever is still registered, then re-raises the signal so the exit code stays conventional
 * (128+signum) rather than the process hanging on its own handler.
 *
 * The disposer stays tiny and synchronous on purpose: a signal handler has no event loop to await on,
 * so a disposer must be a plain synchronous kill/unlink (`browser.process()?.kill("SIGKILL")`,
 * `unlinkSync`), never an async close
 */

export type Disposer = () => void;

const active = new Set<{ dispose: Disposer }>();
let handlersInstalled = false;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type FatalSignal = (typeof SIGNALS)[number];

/**
 * Run every still-registered disposer once, in registration order. Each handle is removed BEFORE its
 * disposer runs, so a second signal arriving mid-cleanup, or a disposer that itself throws, can never
 * double-run one. A throwing disposer is swallowed so one bad cleanup does not block the rest
 */
function runDisposers(): void {
  // Deleting the just-yielded entry mid-iteration is spec-safe for a Set, and removing it BEFORE its
  // disposer runs is the run-once guard: a second signal (or a re-entrant one) finds it already gone
  for (const handle of active) {
    active.delete(handle);
    try {
      handle.dispose();
    } catch {
      /* best-effort: one failure must not stop the others */
    }
  }
}

const handlerFor: Record<FatalSignal, () => void> = {
  SIGINT: () => onSignal("SIGINT"),
  SIGTERM: () => onSignal("SIGTERM"),
  SIGHUP: () => onSignal("SIGHUP"),
};

function onSignal(signal: FatalSignal): void {
  runDisposers();
  // Re-raise with our handler gone so the process takes the signal's default action (terminate with
  // 128+signum) instead of looping back into this handler. Removing only our own listener leaves any
  // unrelated handler in place
  process.removeListener(signal, handlerFor[signal]);
  process.kill(process.pid, signal);
}

function installSignalHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const signal of SIGNALS) process.on(signal, handlerFor[signal]);
}

/**
 * Register a synchronous best-effort disposer, run only if a fatal signal arrives before the resource
 * is released the normal way. Returns a deregister function to call on clean release, so a completed
 * run leaves nothing registered. The signal handlers install on first use
 */
export function registerDisposer(dispose: Disposer): () => void {
  installSignalHandlers();
  const handle = { dispose };
  active.add(handle);
  return () => {
    active.delete(handle);
  };
}

/** @testOnly Run the registered disposers once, standing in for a delivered signal (no re-raise) */
export function runDisposersForTest(): void {
  runDisposers();
}

/** @testOnly How many disposers are currently registered */
export function activeDisposerCount(): number {
  return active.size;
}
