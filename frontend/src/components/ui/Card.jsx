export default function Card({ title, actions, children, className = '', padded = true, as: Tag = 'section', ...props }) {
  return (
    <Tag className={`card-premium ${className}`} {...props}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-5 sm:gap-4 bg-transparent">
          {title && <h2 className="text-lg font-500 text-fg">{title}</h2>}
          {actions}
        </header>
      )}
      <div className={padded ? 'p-6 sm:p-7' : ''}>{children}</div>
    </Tag>
  );
}
