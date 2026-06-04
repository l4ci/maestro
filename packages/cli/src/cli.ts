#!/usr/bin/env node
// Executable entry for the `maestro` bin (package.json → bin.maestro → dist/cli.js).
// Marshals real argv into run() and maps its resolved exit code onto the process. Kept
// separate from main.ts so run() stays unit-testable without a process-level side effect.

import { run } from './main.js';

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    // run() already maps its own failures to exit 1; this guards a truly unexpected throw.
    console.error((err as Error).message);
    process.exitCode = 1;
  },
);
