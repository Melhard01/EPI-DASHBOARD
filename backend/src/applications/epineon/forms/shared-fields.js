import { FieldType } from '../../../shared/utils/validation.js';

/**
 * Field building blocks shared by Epineon's own forms (not by other apps).
 * Limits and option lists match the live Epineon contact page
 * (Contact.jsx / api/_lib/validation.js in the Epineon website repo).
 */

/** "Product of interest" options, as listed on the live site. */
export const PRODUCT_OPTIONS = Object.freeze([
  'EPICRYPT',
  'EPIQUANTUM',
  'EPIWELL',
  'EPI LeGallet',
  'Epitrust',
  'SoulChain',
  'Multiple products',
  'Not sure yet',
]);

/** "Use case" options (Sales & Enterprise), as listed on the live site. */
export const USE_CASE_OPTIONS = Object.freeze([
  'Enterprise AI security',
  'Health & wellness',
  'Future intelligence / upskilling',
  'Multiple ecosystems',
  'Other',
]);

export const nameField = { type: FieldType.TEXT, required: true, maxLength: 120, column: 'name' };
export const emailField = { type: FieldType.EMAIL, required: true, maxLength: 254, lowercase: true, column: 'email' };
export const companyField = { type: FieldType.TEXT, required: true, maxLength: 160, column: 'company' };
export const roleField = { type: FieldType.TEXT, required: false, maxLength: 120, column: 'role' };
export const productField = {
  type: FieldType.CHOICE,
  required: true,
  maxLength: 40,
  options: PRODUCT_OPTIONS,
  column: 'product',
};

/** Anti-spam settings used by every Epineon form (same as the live site). */
export const EPINEON_HONEYPOT = 'companyWebsite';
export const EPINEON_TIMING = Object.freeze({ minMs: 2_000, maxMs: 24 * 60 * 60 * 1_000 });
