#!/usr/bin/env node
// mrouter: command-line client for Michael Router (DESIGN §9, docs/CLI.md).
import { main } from './lib/main.js';

// A closed pipe (`mrouter ask … | head -1`) ends the run quietly instead of with a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw err;
  });
}

process.exitCode = await main(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
