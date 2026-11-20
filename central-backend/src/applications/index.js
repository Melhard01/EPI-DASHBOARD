/**
 * Application registry.
 *
 * Every website served by this backend is registered here exactly once.
 * The platform mounts each application's router at /api/v1/<slug>.
 * To add a new website, create its module folder and add it to this list.
 */
import { epineon } from './epineon/index.js';
import { qaegis } from './qaegis/index.js';
import { epiWell } from './epi-well/index.js';

export const applications = Object.freeze([epineon, qaegis, epiWell]);
