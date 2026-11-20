/**
 * Epi Well form registry. Each form listed here gets a route at
 * POST /api/v1/epiwell/forms/<type> and is accepted by
 * POST /api/v1/submissions with { "application": "epiwell", "formType": "<type>" }.
 *
 * The live site has one form: the waitlist (email only).
 */
import { waitlistForm } from './waitlist.form.js';

export const forms = Object.freeze([waitlistForm]);
