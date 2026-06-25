import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import App from './App';

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
});
