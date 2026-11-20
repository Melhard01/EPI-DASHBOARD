/**
 * QAegis application configuration.
 * Everything specific to QAegis lives here — never in src/shared.
 */
export const config = Object.freeze({
  slug: 'qaegis',
  name: 'QAegis',
  apiVersion: 'v1',
  // PostgreSQL schema that holds all of QAegis's data, and nothing else.
  dbSchema: 'qaegis',
});
