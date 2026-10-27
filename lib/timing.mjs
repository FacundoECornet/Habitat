// lib/timing.mjs — opt-in phase timing for the install/restore/verify pipeline.
//
// Enabled with HABITAT_TIMING=1. Each process prints one summary line on exit:
//   install total 47.2s (copy 3.2s | restore 18.4s | plugins 0.1s | verify 6.8s)
// The timer is inert (no allocations, no output) unless the env var is set, so
// normal runs and tests keep their current output contract.

const ENABLED = process.env.HABITAT_TIMING === "1";

export function createTimer(label) {
  const startedAt = performance.now();
  const phases = [];
  const active = new Map();

  const timer = {
    enabled: ENABLED,

    begin(name) {
      if (!ENABLED) return;
      active.set(name, performance.now());
    },

    end(name) {
      if (!ENABLED) return;
      const started = active.get(name);
      if (started === undefined) return;
      active.delete(name);
      phases.push([name, (performance.now() - started) / 1000]);
    },

    wrap(name, fn) {
      timer.begin(name);
      try {
        return fn();
      } finally {
        timer.end(name);
      }
    },

    async wrapAsync(name, fn) {
      timer.begin(name);
      try {
        return await fn();
      } finally {
        timer.end(name);
      }
    },

    finish() {
      if (!ENABLED) return;
      const total = (performance.now() - startedAt) / 1000;
      const detail = phases
        .map(([name, secs]) => `${name} ${secs.toFixed(1)}s`)
        .join(" | ");
      process.stdout.write(`${label} total ${total.toFixed(1)}s${detail ? ` (${detail})` : ""}\n`);
    },
  };

  return timer;
}
