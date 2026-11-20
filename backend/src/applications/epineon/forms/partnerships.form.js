import { defineForm, FieldType } from '../../../shared/utils/validation.js';
import { nameField, emailField, EPINEON_HONEYPOT, EPINEON_TIMING } from './shared-fields.js';

/**
 * Epineon: Partnerships & Ventures ("Partnerships & Ventures" tab on the live
 * contact page; the live form id is "partnerships").
 * POST /api/v1/epineon/forms/partnerships
 */
export const partnershipsForm = defineForm({
  type: 'partnerships',
  table: 'partnerships_submissions',
  fields: {
    name: nameField,
    email: emailField,
    organization: { type: FieldType.TEXT, required: true, maxLength: 160 },
    nature: { type: FieldType.TEXT, required: true, maxLength: 5000, multiline: true },
  },
  honeypot: EPINEON_HONEYPOT,
  timing: EPINEON_TIMING,
});
