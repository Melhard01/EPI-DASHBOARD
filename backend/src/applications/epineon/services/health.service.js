import { config } from '../config/index.js';

/**
 * Business logic for the Epineon health check.
 * Future checks (database, third-party APIs) belong here.
 */
export function getHealthStatus() {
  return {
    application: config.slug,
    name: config.name,
    version: config.apiVersion,
    timestamp: new Date().toISOString(),
  };
}
