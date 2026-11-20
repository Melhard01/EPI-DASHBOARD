/**
 * Epi Well application configuration.
 * Everything specific to Epi Well lives here — never in src/shared.
 */
export const config = Object.freeze({
  slug: 'epiwell',
  name: 'Epi Well',
  apiVersion: 'v1',
  // PostgreSQL schema that holds all of Epi Well's data, and nothing else.
  dbSchema: 'epiwell',
  // Migrations 001-002 were recorded under the old slug and create the old schema
  // name; 003 renames it to "epiwell". Keeping the key keeps that history intact.
  migrationKey: 'epi-well',
  legacySchemas: Object.freeze(['epi_well']),
});
