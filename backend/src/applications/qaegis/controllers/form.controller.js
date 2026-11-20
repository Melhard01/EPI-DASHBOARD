import { sendSuccess } from '../../../shared/utils/response.js';
import { toReceipt } from '../../../shared/utils/submission.js';
import { submitForm } from '../services/form.service.js';

/**
 * Builds the request handler for one QAegis form.
 * The response contains only the receipt, never the submitted data.
 * (Express 5 forwards rejected promises to the central error handler.)
 */
export function createFormHandler(form) {
  return async function handleFormSubmission(req, res) {
    const submission = await submitForm(form, req.body);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Form submitted successfully',
      data: { data: toReceipt(submission) },
    });
  };
}
