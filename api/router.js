// Vercel entry: every /v1/* and /control/* request is rewritten here (see vercel.json).
// attachDatabasePool keeps the instance alive for the pool's idle timeout plus about 100 ms after
// each client release, so pg-pool closes its idle database clients before the instance suspends.
import { attachDatabasePool, waitUntil } from '@vercel/functions';
import { createHandler } from '../src/handler.js';

const handle = createHandler({ env: process.env, waitUntil, attachDatabasePool });

export default {
  /** @param {Request} request */
  fetch(request) {
    return handle(request);
  },
};
