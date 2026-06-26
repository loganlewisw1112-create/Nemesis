import type { CSSProperties, ReactNode } from 'react';
import { buildLinePath } from '@nemesis/charts';
import { ChartPanel } from './ChartPanel.js';

export interface CommandNavItem<T extends string = string> {
  id: T;
  label: string;
  title: string;
}

export function CommandShell({
  ribbon,
  nav,
  children,
  rail,
}: {
  ribbon: ReactNode;
  nav: ReactNode;
  children: ReactNode;
  rail?: ReactNode;
}) {
  return (
    <div style={shellStyle}>
      {ribbon}
      <div style={bodyStyle}>
        {nav}
        <main style={mainStyle}>{children}</main>
        {rail}
      </div>
    </div>
  );
}

export function CommandRibbon({
  title,
  eyebrow = 'GEA COMMAND RIBBON',
  leftMeta,
  right,
}: {
  title: string;
  eyebrow?: string;
  leftMeta?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header style={ribbonStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
        <div>
          <div style={eyebrowStyle}>{eyebrow}</div>
          <div style={titleStyle}>{title}</div>
        </div>
        {leftMeta}
      </div>
      {right && <div style={ribbonRightStyle}>{right}</div>}
    </header>
  );
}

export function CommandNavRail<T extends string>({
  items,
  activeId,
  onSelect,
  footer,
}: {
  items: CommandNavItem<T>[];
  activeId: T;
  onSelect: (id: T) => void;
  footer?: ReactNode;
}) {
  return (
    <nav style={navStyle} aria-label="GEA command navigation">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          title={item.title}
          onClick={() => onSelect(item.id)}
          style={navButtonStyle(activeId === item.id)}
        >
          {item.label}
        </button>
      ))}
      {footer && <div style={navFooterStyle}>{footer}</div>}
    </nav>
  );
}

export function OperationalRail({
  title = 'OPERATIONAL RAIL',
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside style={railStyle}>
      <div style={railHeaderStyle}>{title}</div>
      <div style={{ display: 'grid', gap: 12 }}>{children}</div>
    </aside>
  );
}

export function PanelCard({
  title,
  meta,
  children,
  tone = 'default',
  style,
}: {
  title?: string;
  meta?: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'accent';
  style?: CSSProperties;
}) {
  return (
    <section style={{ ...panelStyle(tone), ...style }}>
      {(title || meta) && (
        <div style={panelHeaderStyle}>
          {title && <h2 style={panelTitleStyle}>{title}</h2>}
          {meta && <div style={panelMetaStyle}>{meta}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function MetricTile({
  label,
  value,
  detail,
  color = 'var(--text)',
  minWidth = 120,
}: {
  label: string;
  value: string | number;
  detail?: ReactNode;
  color?: string;
  minWidth?: number;
}) {
  return (
    <div style={{ ...metricStyle, minWidth }}>
      <div style={metricLabelStyle}>{label}</div>
      <div style={{ ...metricValueStyle, color }}>{value}</div>
      {detail && <div style={metricDetailStyle}>{detail}</div>}
    </div>
  );
}

export function RealtimeChartPanel({
  title,
  subtitle,
  values,
  color,
  width = 248,
  height = 72,
  baseline,
  emptyLabel,
  ariaLabel,
}: {
  title: string;
  subtitle?: string;
  values: number[];
  color: string;
  width?: number;
  height?: number;
  baseline?: number;
  emptyLabel?: string;
  ariaLabel?: string;
}) {
  return (
    <ChartPanel
      title={title}
      subtitle={subtitle}
      path={buildLinePath(values, width, height)}
      color={color}
      width={width}
      height={height}
      baseline={baseline}
      marginBottom={0}
      live
      emptyLabel={emptyLabel}
      ariaLabel={ariaLabel}
      pulseKey={`${title}:${values.length}:${values.at(-1) ?? 'empty'}`}
    />
  );
}

function navButtonStyle(active: boolean): CSSProperties {
  return {
    background: active ? 'var(--accent)' : 'transparent',
    border: 'none',
    color: active ? '#fff' : 'var(--text-muted)',
    padding: 8,
    borderRadius: 6,
    fontSize: 10,
    cursor: 'pointer',
    textTransform: 'uppercase',
    transition: 'background var(--dur-fast), color var(--dur-fast)',
    width: 40,
    minHeight: 32,
  };
}

function panelStyle(tone: 'default' | 'success' | 'warning' | 'danger' | 'accent'): CSSProperties {
  const borderColor = tone === 'default' ? 'var(--border)' : `var(--${tone})`;
  return {
    padding: 16,
    background: 'var(--bg-elevated)',
    border: `1px solid ${borderColor}`,
    borderRadius: 8,
    minWidth: 0,
  };
}

const shellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  minWidth: 0,
  fontFamily: 'var(--font)',
};

const bodyStyle: CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
};

const mainStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

const ribbonStyle: CSSProperties = {
  minHeight: 34,
  padding: '7px 14px',
  background: 'var(--bg-elevated)',
  borderBottom: '1px solid var(--border)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
  flexShrink: 0,
};

const eyebrowStyle: CSSProperties = {
  color: 'var(--accent)',
  fontSize: 10,
  letterSpacing: 2,
  fontWeight: 800,
  lineHeight: 1,
};

const titleStyle: CSSProperties = {
  color: 'var(--text)',
  fontSize: 13,
  fontWeight: 800,
  lineHeight: 1.2,
  marginTop: 3,
};

const ribbonRightStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 10,
  flexWrap: 'wrap',
  minWidth: 0,
  fontSize: 11,
};

const navStyle: CSSProperties = {
  width: 56,
  background: 'var(--bg-elevated)',
  borderRight: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: 8,
  flexShrink: 0,
};

const navFooterStyle: CSSProperties = {
  marginTop: 'auto',
  borderTop: '1px solid var(--border)',
  paddingTop: 8,
};

const railStyle: CSSProperties = {
  width: 'clamp(180px, 24vw, 280px)',
  borderLeft: '1px solid var(--border)',
  background: 'var(--bg-elevated)',
  overflow: 'auto',
  padding: 12,
  flexShrink: 0,
};

const railHeaderStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 1,
  marginBottom: 12,
  textTransform: 'uppercase',
};

const panelHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
  marginBottom: 10,
};

const panelTitleStyle: CSSProperties = {
  fontSize: 13,
  margin: 0,
  textTransform: 'uppercase',
  letterSpacing: 1,
};

const panelMetaStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 11,
  textAlign: 'right',
};

const metricStyle: CSSProperties = {
  padding: '10px 12px',
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  minWidth: 0,
};

const metricLabelStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 9,
  letterSpacing: 1,
  textTransform: 'uppercase',
  marginBottom: 4,
};

const metricValueStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  lineHeight: 1.15,
  wordBreak: 'break-word',
};

const metricDetailStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 10,
  marginTop: 4,
  lineHeight: 1.35,
};
