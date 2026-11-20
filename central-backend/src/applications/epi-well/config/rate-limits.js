/**
 * Epi Well rate limits, per form and per client network address.
 * Each form is counted separately (scope "epi-well:<form>") and never shares
 * counters with any other form or website.
 *
 * Every form in ../forms/index.js MUST have an entry here; the server
 * refuses to start otherwise.
 */
export const formRateLimits = Object.freeze({
  waitlist: [
    { limit: 5, windowSeconds: 10 * 60 },
    { limit: 20, windowSeconds: 24 * 60 * 60 },
  ],
});
