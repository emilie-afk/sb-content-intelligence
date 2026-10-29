/**
 * deadline.js — one absolute deadline per run, shared by every model call, internal
 * HTTP call and database operation started under it.
 *
 *   const d = createDeadline(8500);
 *   d.remaining()         ms left (never negative)
 *   d.signal              AbortSignal that fires AT the deadline (reason: DeadlineError)
 *   d.child(ms)           signal = deadline OR an extra per-call timeout (whichever first)
 *   d.expired()           true once the deadline has passed
 *   isDeadlineError(err)  true for aborts caused by the deadline (not provider failures)
 */
class DeadlineError extends Error {
  constructor(message = "Run deadline reached") {
    super(message);
    this.name = "DeadlineError";
    this.isDeadline = true;
  }
}

function createDeadline(ms) {
  const at = Date.now() + ms;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineError()), Math.max(0, ms));
  if (timer.unref) timer.unref();
  return {
    at,
    signal: controller.signal,
    remaining: () => Math.max(0, at - Date.now()),
    expired: () => Date.now() >= at || controller.signal.aborted,
    child(extraMs) {
      return extraMs ? AbortSignal.any([controller.signal, AbortSignal.timeout(extraMs)]) : controller.signal;
    },
    dispose() { clearTimeout(timer); },
  };
}

function isDeadlineError(err, signal) {
  if (!err) return false;
  if (err.isDeadline) return true;
  if (signal && signal.aborted && signal.reason && signal.reason.isDeadline) return true;
  return false;
}

module.exports = { createDeadline, DeadlineError, isDeadlineError };
