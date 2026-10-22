// Vercel entry: every /v1/* and /control/* request is rewritten here (see vercel.json).
// attachDatabasePool keeps an instance alive until its idle database clients are closed.
import { attachDatabasePool, waitUntil } from '@vercel/functions';
import { createHandler } from '../src/handler.js';

const handle = createHandler({ env: process.env, waitUntil, attachDatabasePool });

export default {
  /** @param {Request} request */
  fetch(request) {
    return handle(request);
  },
};
