import { useId } from 'react';
import { controlClass as control } from './controlClass.js';

export function Field({ label, error, hint, children, htmlFor }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextInput({ label, error, hint, className = '', ...props }) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} htmlFor={id}>
      <input id={id} aria-invalid={error ? true : undefined} className={`${control} ${className}`} {...props} />
    </Field>
  );
}

export function SelectInput({ label, error, children, className = '', ...props }) {
  const id = useId();
  return (
    <Field label={label} error={error} htmlFor={id}>
      <select id={id} aria-invalid={error ? true : undefined} className={`${control} ${className}`} {...props}>
        {children}
      </select>
    </Field>
  );
}

export function Checkbox({ label, description, className = '', ...props }) {
  const id = useId();
  return (
    <div className={`flex items-start gap-3 ${className}`}>
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-line accent-[var(--accent)]" {...props} />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </label>
    </div>
  );
}

