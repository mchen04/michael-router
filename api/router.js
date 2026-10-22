// Vercel entry: every /v1/* and /control/* request is rewritten here (see vercel.json).
import { waitUntil } from '@vercel/functions';
import { createHandler } from '../src/handler.js';

const handle = createHandler({ env: process.env, waitUntil });

export default {
  /** @param {Request} request */
  fetch(request) {
    return handle(request);
  },
};
