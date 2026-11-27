import { useEffect, useRef } from 'react';

/** Barcode-style progress indicator matching reference design */
export function BarcodeProgress({ percentage = 0, className = '' }) {
  const ref = useRef(null);
  const animatedRef = useRef(0);

  useEffect(() => {
    if (!ref.current) return;
    const duration = 1200;
    const start = Date.now();

    const animate = () => {
      const elapsed = Date.now() - start;
      const progress = Math.min(elapsed / duration, 1);
      animatedRef.current = percentage * progress;

      const lines = ref.current?.querySelectorAll('[data-line]');
      lines?.forEach((line, i) => {
        const lineIndex = i / lines.length;
        if (lineIndex <= animatedRef.current) {
          if (lineIndex <= percentage * 0.8) {
            line.style.backgroundColor = '#080808';
          } else if (lineIndex <= percentage) {
            line.style.backgroundColor = '#9670d9';
          }
        }
      });

      if (progress < 1) requestAnimationFrame(animate);
    };

    animate();
  }, [percentage]);

  return (
    <div ref={ref} className={`flex gap-0.5 items-center h-2 ${className}`}>
      {Array.from({ length: 50 }).map((_, i) => (
        <div
          key={i}
          data-line
          className="flex-1 h-full bg-e9e0ff rounded-sm transition-colors duration-100"
          style={{ backgroundColor: '#e9e0ff' }}
        />
      ))}
    </div>
  );
}
