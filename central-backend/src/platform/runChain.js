/**
 * Runs an array of Express middleware functions in order, the way a route
 * would, forwarding errors (thrown, passed to next, or rejected promises)
 * to `done`. Used to reuse an application's own form handler chain from the
 * unified POST /api/v1/submissions endpoint.
 */
export function runChain(chain, req, res, done) {
  let index = 0;
  const step = (err) => {
    if (err) return done(err);
    const handler = chain[index++];
    if (!handler) return done();
    try {
      const result = handler(req, res, step);
      if (result && typeof result.then === 'function') result.catch(done);
    } catch (thrown) {
      done(thrown);
    }
    return undefined;
  };
  step();
}
