import { defineForm, FieldType } from '../../../shared/utils/validation.js';
import {
  nameField,
  emailField,
  companyField,
  roleField,
  productField,
  USE_CASE_OPTIONS,
  EPINEON_HONEYPOT,
  EPINEON_TIMING,
} from './shared-fields.js';

/**
 * Epineon: Sales & Enterprise ("Sales & Enterprise" tab on the live contact page).
 * POST /api/v1/epineon/forms/sales
 */
export const salesForm = defineForm({
  type: 'sales',
  fields: {
    name: nameField,
    email: emailField,
    company: companyField,
    role: roleField,
    product: productField,
    useCase: { type: FieldType.CHOICE, required: true, maxLength: 60, options: USE_CASE_OPTIONS },
    message: { type: FieldType.TEXT, required: true, maxLength: 5000, multiline: true },
  },
  honeypot: EPINEON_HONEYPOT,
  timing: EPINEON_TIMING,
});
