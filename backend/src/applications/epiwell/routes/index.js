import { Router } from 'express';
import { methodNotAllowed } from '../../../shared/middleware/security.js';
import { getHealth } from '../controllers/health.controller.js';
import formsRouter from './forms.routes.js';

/**
 * All Epi Well routes. Mounted by the platform at /api/v1/epiwell.
 */
const router = Router();

router.route('/health').get(getHealth).all(methodNotAllowed(['GET', 'HEAD']));
router.use('/forms', formsRouter);

export default router;
