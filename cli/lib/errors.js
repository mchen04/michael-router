// Exit codes (DESIGN §9) and the error type every command throws.

export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2, // bad command line or invalid input; nothing was sent
  GATEWAY: 3, // the router refused: wrong/missing password, wrong-password backoff or block
  UPSTREAM: 4, // a provider failed (or rejected a key)
  NETWORK: 5, // the router could not be reached, redirected, timed out or cut the connection
  INTERRUPTED: 130, // Ctrl-C at a prompt
});

/** An error with an exit code. `message` is printed as is, so it must never contain a secret. */
export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   * @param {{hint?: string, timeout?: boolean, status?: number, code?: string, upstreamStatus?: number}} [options]
   *   `status`, `code` and `upstreamStatus` (the provider's HTTP status) describe a router error response
   */
  constructor(message, exitCode = EXIT.ERROR, { hint, timeout = false, status, code, upstreamStatus } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.hint = hint;
    this.timeout = timeout;
    this.status = status;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

/** @param {string} message @param {string} [hint] */
export const usageError = (message, hint) => new CliError(message, EXIT.USAGE, { hint });
