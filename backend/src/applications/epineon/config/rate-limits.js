/**
 * Epineon rate limits, per form and per client network address.
 * Each form is counted separately (scope "epineon:<form>") and never shares
 * counters with any other form or website.
 *
 * Every form in ../forms/index.js MUST have an entry here; the server
 * refuses to start otherwise.
 */
export const formRateLimits = Object.freeze({
  // Unlimited for testing (very high limits)
  demo: [
    { limit: 10000, windowSeconds: 10 * 60 },
    { limit: 100000, windowSeconds: 24 * 60 * 60 },
  ],
  sales: [
    { limit: 10000, windowSeconds: 10 * 60 },
    { limit: 100000, windowSeconds: 24 * 60 * 60 },
  ],
  partnerships: [
    { limit: 10000, windowSeconds: 10 * 60 },
    { limit: 100000, windowSeconds: 24 * 60 * 60 },
  ],
});
