import { defineForm, FieldType } from '../../../shared/utils/validation.js';

/** "Number of users" options, as listed on the live QAegis site. */
export const USER_RANGE_OPTIONS = Object.freeze(['1-50', '51-250', '251-1000', '1000+']);

/**
 * QAegis: Contact Sales / Enterprise Access ("Request Enterprise Access").
 * Field names, limits and options match the live site
 * (public/index.html and server/api.mjs in the QAegis website repo).
 * POST /api/v1/qaegis/forms/contact-sales
 */
export const contactSalesForm = defineForm({
  type: 'contact-sales',
  table: 'contact_sales_submissions',
  fields: {
    firstName: { type: FieldType.TEXT, required: true, maxLength: 120 },
    lastName: { type: FieldType.TEXT, required: true, maxLength: 120 },
    workEmail: { type: FieldType.EMAIL, required: true, maxLength: 320 },
    companyWebsite: { type: FieldType.URL, required: false, maxLength: 500 },
    userRange: { type: FieldType.CHOICE, required: true, maxLength: 20, options: USER_RANGE_OPTIONS },
    message: { type: FieldType.TEXT, required: true, maxLength: 10_000, multiline: true },
  },
  // The live site has no honeypot yet; this hidden field is optional and
  // ready for when the site is connected. ("companyWebsite" is a REAL field here.)
  honeypot: 'website',
  timing: { minMs: 2_000, maxMs: 24 * 60 * 60 * 1_000 },
});
