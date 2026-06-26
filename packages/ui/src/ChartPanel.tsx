import { useEffect, useId, useState } from 'react';

interface ChartPanelProps {
  title: string;
  subtitle?: string;
  path: string;
  color: string;
  width: number;
  height: number;
  baseline?: number;
  marginBottom?: number;
  live?: boolean;
  emptyLabel?: string;
  ariaLabel?: string;
  drawOnMount?: boolean;
  pulseKey?: string | number;
}

export function ChartPanel({
  title,
  subtitle,
  path,
  color,
  width,
  height,
  baseline,
  marginBottom = 10,
  live = true,
  emptyLabel,
  ariaLabel,
  drawOnMount = true,
  pulseKey,
}: ChartPanelProps) {
  const gradId = useId();
  const reducedMotion = usePrefersReducedMotion();

  // Parse last point for the live pulse dot
  const pts = path ? path.trim().split(/\s+/).filter(Boolean) : [];
  const lastPt = pts.length >= 2 ? pts.at(-1) : null;
  const [lx, ly] = lastPt ? lastPt.split(',').map(Number) : [0, 0];
  const hasPoints = pts.length >= 2;

  // Area fill: close the polygon at the bottom corners
  const areaPts = hasPoints ? `${path} ${width},${height} 0,${height}` : '';
  const shouldAnimate = drawOnMount && !reducedMotion;
  const showPulse = live && !reducedMotion;

  return (
    <div
      style={{
        background: 'var(--bg-card)',
        borderRadius: 8,
        padding: 10,
        marginBottom,
        transition: 'box-shadow 0.2s',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
          {title}
        </span>
        {subtitle && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{subtitle}</span>}
      </div>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel ?? `${title} chart`}
        style={{ display: 'block', width: '100%', overflow: 'visible' }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {baseline !== undefined && (
          <line
            x1={0} y1={height / 2} x2={width} y2={height / 2}
            stroke="var(--border)" strokeDasharray="4 4"
          />
        )}

        {hasPoints && (
          <>
            {/* Gradient area fill */}
            <polygon points={areaPts} fill={`url(#${gradId})`} />

            {/* Animated line draw — key restarts animation on each path update */}
            <polyline
              key={path}
              fill="none"
              stroke={color}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={path}
              style={shouldAnimate ? {
                strokeDasharray: 9999,
                strokeDashoffset: 9999,
                animation: 'chartDraw 0.65s cubic-bezier(0.16,1,0.3,1) forwards',
              } : undefined}
            />

            {/* Pulsing dot at latest data point */}
            {lastPt && (
              <>
                <circle cx={lx} cy={ly} r={3} fill={color} opacity={0.9} />
                {showPulse && (
                  <circle
                    key={pulseKey ?? `${lx}-${ly}`}
                    cx={lx}
                    cy={ly}
                    r={3}
                    fill={color}
                    style={{ animation: 'chartPulse 1.1s ease-out forwards' }}
                  />
                )}
              </>
            )}
          </>
        )}
      </svg>
      {!hasPoints && emptyLabel && (
        <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 6 }}>{emptyLabel}</div>
      )}
    </div>
  );
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  return reduced;
}
