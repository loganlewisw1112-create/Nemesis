# NEMESIS

**Kalshi-native desktop trading command center.**

Thesis-driven edge discovery, category monitor pods, profit protection guardrails, and safety-first execution — demo + dry-run by default.

## Quickstart

Requires Node.js 18+ and pnpm.

```bash
cd nemesis
pnpm install
pnpm dev
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Launch Electron app in development |
| `pnpm test` | Run unit tests |
| `pnpm build` | Build all packages |
| `pnpm package` | Build Windows installer (unsigned) |

## Safety defaults

- Kalshi **demo** mode ON
- **Dry-run** ON — no real orders until all 8 gates pass
- Kill-switch: `Ctrl+Shift+K`
- Live trading requires deliberate multi-step unlock

## Architecture

```
apps/desktop/     Electron shell
packages/core/    Kalshi client, fees, thesis engine, guardrails
packages/pods/    Monitor pods (Flow Hunter, Weather Wing, etc.)
packages/ui/      React components
packages/connectors/  Connector registry
packages/journal/ Session journal
packages/execution/   Dry-run + signing
packages/capital/     Allocator + quarantine
packages/charts/      Profit Station graphs
```

## License

MIT — see [LICENSE](LICENSE) and [DISCLAIMER.md](DISCLAIMER.md).

**Not financial advice.** Trading carries risk. Use demo + dry-run first.
