import { Router } from 'express';
import { methodNotAllowed } from '../../../shared/middleware/security.js';
import { getHealth } from '../controllers/health.controller.js';
import formsRouter from './forms.routes.js';

/**
 * All Epineon routes. Mounted by the platform at /api/v1/epineon.
 */
const router = Router();

router.route('/health').get(getHealth).all(methodNotAllowed(['GET', 'HEAD']));
router.use('/forms', formsRouter);

export default router;
