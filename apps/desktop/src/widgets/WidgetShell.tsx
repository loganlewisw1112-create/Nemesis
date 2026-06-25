interface WidgetShellProps {
  title: string;
  children: React.ReactNode;
  /** Extra controls to render in the header bar (right of title, left of ×) */
  headerExtra?: React.ReactNode;
}

export function WidgetShell({ title, children, headerExtra }: WidgetShellProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg-card)', border: '1px solid var(--border)', overflow: 'hidden' }}>
      {/* Drag handle header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0 8px',
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border)',
          height: 26,
          flexShrink: 0,
          // @ts-expect-error electron css property
          WebkitAppRegion: 'drag',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
          NEMESIS · {title}
        </span>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 4, // @ts-expect-error
            WebkitAppRegion: 'no-drag' }}
        >
          {headerExtra}
          <button
            type="button"
            onClick={() => window.nemesis.closeThisWidget()}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px' }}
          >
            ×
          </button>
        </div>
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  );
}
