/**
 * QAegis form registry. Each form listed here gets a route at
 * POST /api/v1/qaegis/forms/<type>.
 */
import { contactSalesForm } from './contact-sales.form.js';

export const forms = Object.freeze([contactSalesForm]);
