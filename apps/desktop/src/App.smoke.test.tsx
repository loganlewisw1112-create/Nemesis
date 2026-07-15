import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import App, { DEFAULT_VISIBLE_THESIS_LIMIT, limitVisibleItems } from './App';

describe('App bridge guard', () => {
  const originalNemesis = window.nemesis;

  beforeEach(() => {
    // @ts-expect-error simulate missing preload bridge
    delete window.nemesis;
  });

  afterEach(() => {
    window.nemesis = originalNemesis;
  });

  it('shows bridge unavailable when preload missing', async () => {
    render(<App />);
    expect(await screen.findByText(/bridge unavailable/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('bounds the default theater render while retaining the full state outside the view', () => {
    const all = Array.from({ length: 500 }, (_, index) => index);
    const visible = limitVisibleItems(all);
    expect(visible).toHaveLength(DEFAULT_VISIBLE_THESIS_LIMIT);
    expect(visible.at(-1)).toBe(DEFAULT_VISIBLE_THESIS_LIMIT - 1);
    expect(all).toHaveLength(500);
    expect(limitVisibleItems(all, DEFAULT_VISIBLE_THESIS_LIMIT, 475)).toEqual(all.slice(475, 500));
  });
});
