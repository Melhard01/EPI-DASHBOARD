export default function Card({ title, actions, children, className = '', padded = true, as: Tag = 'section', ...props }) {
  return (
    <Tag className={`card-premium ${className}`} {...props}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:gap-4">
          {title && <h2 className="text-base font-semibold text-fg">{title}</h2>}
          {actions}
        </header>
      )}
      <div className={padded ? 'p-5 sm:p-6' : ''}>{children}</div>
    </Tag>
  );
}
