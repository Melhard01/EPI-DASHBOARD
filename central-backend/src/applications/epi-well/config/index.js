/**
 * Epi Well application configuration.
 * Everything specific to Epi Well lives here — never in src/shared.
 */
export const config = Object.freeze({
  slug: 'epi-well',
  name: 'Epi Well',
  apiVersion: 'v1',
  // PostgreSQL schema that holds all of Epi Well's data, and nothing else.
  dbSchema: 'epi_well',
});
