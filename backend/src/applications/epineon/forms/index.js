/**
 * Epineon form registry. Each form listed here gets a route at
 * POST /api/v1/epineon/forms/<type> and is accepted by
 * POST /api/v1/submissions with { "application": "epineon", "formType": "<type>" }.
 */
import { demoForm } from './demo.form.js';
import { salesForm } from './sales.form.js';
import { partnershipsForm } from './partnerships.form.js';

export const forms = Object.freeze([demoForm, salesForm, partnershipsForm]);
