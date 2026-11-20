export default function Card({ title, actions, children, className = '', padded = true, as: Tag = 'section', ...props }) {
  return (
    <Tag className={`rounded-xl border border-line bg-surface shadow-sm ${className}`} {...props}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {actions}
        </header>
      )}
      <div className={padded ? 'p-4 sm:p-5' : ''}>{children}</div>
    </Tag>
  );
}
