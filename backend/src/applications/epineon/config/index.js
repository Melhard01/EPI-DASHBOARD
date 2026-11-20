/**
 * Epineon application configuration.
 * Everything specific to Epineon lives here — never in src/shared.
 */
export const config = Object.freeze({
  slug: 'epineon',
  name: 'Epineon',
  apiVersion: 'v1',
  // PostgreSQL schema that holds all of Epineon's data, and nothing else.
  dbSchema: 'epineon',
});
