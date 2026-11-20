import { defineForm, FieldType } from '../../../shared/utils/validation.js';

/**
 * Disposable email domains rejected by the live Epi Well waitlist form.
 * (Same list as the live site's client-side check.)
 */
export const BLOCKED_EMAIL_DOMAINS = Object.freeze([
  'mailinator.com',
  'guerrillamail.com',
  'tempmail.com',
  'throwaway.email',
  'yopmail.com',
]);

/**
 * Epi Well: Waitlist ("Join the Waitlist"). The live form collects only an
 * email address, lower-cased, one entry per address.
 * Uniqueness is enforced by the database (see 002_add_submission_workflow.sql).
 * POST /api/v1/epi-well/forms/waitlist
 */
export const waitlistForm = defineForm({
  type: 'waitlist',
  fields: {
    email: {
      type: FieldType.EMAIL,
      required: true,
      maxLength: 254,
      lowercase: true,
      blockedDomains: BLOCKED_EMAIL_DOMAINS,
    },
  },
  // Same hidden field name as the live site's honeypot input.
  honeypot: 'website',
  timing: { minMs: 2_000, maxMs: 24 * 60 * 60 * 1_000 },
});
