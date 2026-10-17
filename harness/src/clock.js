// Time and randomness the live harness runs on. Production uses the wall clock, real timers and
// Math.random; tests pass a virtual clock (and a seeded rng) so scheduling is deterministic and instant.

/** The real thing: Date.now, setTimeout. */
export const realClock = Object.freeze({
  virtual: false,
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, Math.max(0, ms)),
  clearTimer: (h) => clearTimeout(h),
});

/**
 * A virtual clock. Time only moves when you call advance()/runNext()/runAll(). Timers fire in due-time
 * order, ties in the order they were set, so a run is fully reproducible.
 */
export function createVirtualClock(start = 0) {
  let t = Number(start) || 0;
  let nextId = 1;
  const timers = new Map(); // id -> { at, fn, order }
  const due = () => [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[1].order - b[1].order)[0];
  const clock = {
    virtual: true,
    now: () => t,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: t + Math.max(0, Number(ms) || 0), fn, order: id });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    get pending() { return timers.size; },
    /** Fire the earliest timer (moving time to it). Returns false when none are left. */
    runNext() {
      const d = due();
      if (!d) return false;
      const [id, { at, fn }] = d;
      timers.delete(id);
      if (at > t) t = at;
      fn();
      return true;
    },
    /** Move time forward by ms, firing every timer due on the way. */
    advance(ms) {
      const end = t + Math.max(0, Number(ms) || 0);
      for (let d = due(); d && d[1].at <= end; d = due()) clock.runNext();
      t = end;
    },
  };
  return clock;
}

/** Let pending promise callbacks run (one macrotask turn). */
export const settleTick = () => new Promise((r) => setImmediate(r));
