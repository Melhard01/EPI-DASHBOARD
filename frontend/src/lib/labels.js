// Display names. The backend is the source of truth for WHICH applications, forms
// and statuses exist (via /me); these maps only make them friendlier to read.

export const STATUSES = ['new', 'in_progress', 'replied', 'closed', 'archived'];

export const STATUS_LABELS = {
  new: 'New',
  in_progress: 'In progress',
  replied: 'Replied',
  closed: 'Closed',
  archived: 'Archived',
};

const FORM_LABELS = {
  demo: 'Demo',
  sales: 'Sales',
  partnerships: 'Partnerships',
  'contact-sales': 'Contact Sales',
  waitlist: 'Waitlist',
};

const FIELD_LABELS = {
  name: 'Name',
  email: 'Email',
  company: 'Company',
  role: 'Role',
  product: 'Product of interest',
  useCase: 'Use case',
  message: 'Message',
  organization: 'Organization',
  nature: 'Nature of partnership',
  firstName: 'First name',
  lastName: 'Last name',
  workEmail: 'Work email',
  companyWebsite: 'Company website',
  userRange: 'Number of users',
};

export const AUDIT_ACTION_LABELS = {
  'submission.status_changed': 'Status changed',
  'submission.marked_read': 'Marked as read',
  'submission.marked_unread': 'Marked as unread',
  'submission.deleted': 'Submission deleted',
  'admin_user.created': 'Admin created',
  'admin_user.updated': 'Admin updated',
  'admin_user.bootstrapped': 'Super Admin bootstrapped',
};

const titleCase = (text) =>
  text
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());

export const formLabel = (formType) => FORM_LABELS[formType] ?? titleCase(formType);
export const fieldLabel = (field) => FIELD_LABELS[field] ?? titleCase(field);
export const statusLabel = (status) => STATUS_LABELS[status] ?? titleCase(status);
export const actionLabel = (action) => AUDIT_ACTION_LABELS[action] ?? titleCase(action.replace('.', ' '));

/** Best-effort "who is this" and "what is it about" for a submission's data. */
export function contactOf(data = {}) {
  const name = data.name || [data.firstName, data.lastName].filter(Boolean).join(' ') || '';
  const email = data.email || data.workEmail || '';
  return { name, email, title: name || email || '—' };
}

export function summaryOf(data = {}) {
  return data.company || data.organization || data.product || data.userRange || '';
}
