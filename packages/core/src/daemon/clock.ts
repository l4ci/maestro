// Injected time + randomness seams (spec §14 / M5 QA). `core/daemon` must contain NO
// real Date.now / Math.random / setTimeout — they would make adaptive-interval and
// jitter assertions flaky. The CLI entrypoint supplies the concrete implementations
// (Date.now / Math.random / a setTimeout sleep loop); the scheduling LOGIC here stays
// pure and deterministic under a fake clock + seeded RNG.

export interface Clock {
  now(): number; // epoch millis
}

export interface Rng {
  next(): number; // uniform in [0, 1)
}
