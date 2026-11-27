const VARIANTS = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-soft hover:shadow-elevated transition-all duration-250',
  secondary: 'border border-line bg-surface-2 text-fg hover:bg-surface-3 shadow-soft hover:shadow-soft transition-all duration-250',
  ghost: 'text-fg hover:bg-surface-3 transition-all duration-250',
  danger: 'bg-danger text-white hover:bg-danger-hover shadow-soft hover:shadow-elevated transition-all duration-250',
};

const SIZES = {
  sm: 'h-8 px-3 text-sm font-500',
  md: 'h-10 px-4 text-sm font-500',
  lg: 'h-12 px-6 text-base font-600',
};

export default function Button({ variant = 'secondary', size = 'md', className = '', type = 'button', loading = false, disabled = false, children, ...props }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-lg btn transition-smooth disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    >
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
      {children}
    </button>
  );
}
