import { sendSuccess } from '../../../shared/utils/response.js';
import { config } from '../config/index.js';
import { getHealthStatus } from '../services/health.service.js';

/**
 * GET /api/v1/qaegis/health
 */
export function getHealth(req, res) {
  return sendSuccess(res, {
    message: `${config.name} API is running`,
    data: getHealthStatus(),
  });
}
