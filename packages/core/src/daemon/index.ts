// The M5 daemon: the stateless poll-driven orchestrator. Pure, I/O-free logic behind
// injected seams (ports.ts) — the CLI entrypoint supplies the real adapter / runner /
// workspace / clock / RNG and the run-forever loop. Unit-tested headless (no real
// subprocess, socket, or clock); the only real-I/O path is the gated E2E smoke (§15).

export * from './ports.js';
export * from './rate-limit-gate.js';
export * from './claims.js';
export * from './proof-streaks.js';
export * from './heartbeat.js';
export * from './clock.js';
export * from './progress-mirror.js';
export * from './scheduler.js';
export * from './executor.js';
export * from './tick.js';
export * from './run.js';
export * from './reload.js';
