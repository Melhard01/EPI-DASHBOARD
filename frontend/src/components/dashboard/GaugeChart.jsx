import { useEffect, useRef } from 'react';

/** Semicircular gauge chart matching reference design */
export function GaugeChart({ percentage = 60, label = 'Gauge', value = 60 }) {
  const canvasRef = useRef(null);
  const animatedRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height * 0.7;
    const radius = 80;

    const duration = 1800;
    const start = Date.now();

    const draw = () => {
      const elapsed = Date.now() - start;
      const progress = Math.min(elapsed / duration, 1);
      animatedRef.current = percentage * progress;

      ctx.clearRect(0, 0, width, height);

      // Dark grey background arc
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, Math.PI, 0, false);
      ctx.strokeStyle = '#3a3a3a';
      ctx.lineWidth = 3;
      ctx.stroke();

      // Purple progress arc
      ctx.beginPath();
      ctx.arc(
        centerX,
        centerY,
        radius,
        Math.PI,
        Math.PI - (Math.PI * animatedRef.current) / 100,
        true
      );
      ctx.strokeStyle = '#9670d9';
      ctx.lineWidth = 3;
      ctx.stroke();

      // Indicator dot
      const angle = Math.PI - (Math.PI * animatedRef.current) / 100;
      const dotX = centerX + radius * Math.cos(angle);
      const dotY = centerY + radius * Math.sin(angle);

      ctx.beginPath();
      ctx.arc(dotX, dotY, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#9670d9';
      ctx.fill();

      // Central text
      ctx.font = 'bold 48px Inter';
      ctx.fillStyle = '#080808';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(Math.round(animatedRef.current), centerX, centerY + 15);

      ctx.font = '12px Inter';
      ctx.fillStyle = '#999999';
      ctx.fillText(label, centerX, centerY + 45);

      if (progress < 1) requestAnimationFrame(draw);
    };

    draw();
  }, [percentage, label]);

  return (
    <canvas
      ref={canvasRef}
      width={200}
      height={150}
      className="w-full max-w-xs mx-auto"
    />
  );
}
