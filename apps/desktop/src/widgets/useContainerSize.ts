import { useEffect, useRef, useState } from 'react';

export function useContainerSize(defaultW = 240, defaultH = 80) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: defaultW, h: defaultH });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    // Seed initial size immediately
    const rect = el.getBoundingClientRect();
    if (rect.width > 0) setSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) });
    return () => ro.disconnect();
  }, []);

  return [ref, size] as const;
}
