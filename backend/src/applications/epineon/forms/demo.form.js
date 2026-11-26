import { defineForm, FieldType } from '../../../shared/utils/validation.js';
import {
  nameField,
  emailField,
  companyField,
  roleField,
  productField,
  EPINEON_HONEYPOT,
  EPINEON_TIMING,
} from './shared-fields.js';

/**
 * Epineon: Demo request ("Demo request" tab on the live contact page).
 * POST /api/v1/epineon/forms/demo
 */
export const demoForm = defineForm({
  type: 'demo',
  table: 'demo_submissions',
  fields: {
    name: nameField,
    email: emailField,
    company: companyField,
    role: roleField,
    product: productField,
    // "What would you like to see?" (optional on the live site)
    message: { type: FieldType.TEXT, required: false, maxLength: 5000, multiline: true, column: 'message' },
  },
  honeypot: EPINEON_HONEYPOT,
  timing: EPINEON_TIMING,
});
