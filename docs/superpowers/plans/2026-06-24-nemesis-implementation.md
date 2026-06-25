# NEMESIS Implementation Plan

> Milestone-gated auto-loop. Do not advance until verification gate passes.

## M0 — Runnable shell

- [x] Monorepo scaffold (pnpm workspaces)
- [x] packages/core — Kalshi client, fees, guardrails, thesis qualification
- [x] packages/connectors — registry
- [x] apps/desktop — Electron + React + Vite
- [x] Guardrail banner (demo + dry-run)
- [x] Markets list from Kalshi REST (fixture fallback)
- [x] Unit tests for core

## M1 — Edge Theater MVP

- [x] Thesis Card model + ranker
- [x] Trade qualification gates
- [x] Edge Theater feed + filters
- [x] Flow Hunter pod (market-derived theses)
- [x] Session Journal + CSV export
- [x] Profit Station basics (fee waterfall, equity skeleton)
- [x] Explain Move panel

## M2 — Category pods + dry-run

- [x] Weather Wing, Macro Pulse, Crypto Lead, Release Radar pods
- [x] Predictability score on cards
- [x] Source disagreement (weather/crypto)
- [x] Dry-run execution (book walk)
- [x] Journal 100-signal progress bar

## M3 — Profit protection + capital

- [x] No-trade regime detection
- [x] Strategy quarantine
- [x] Global Pulse + Infra Watch pods
- [x] Regime banner, invalidation panel
- [x] Connector health UI

## M4 — Live pilot ready

- [x] RSA-PSS signer module
- [x] Reconciliation engine
- [x] Kill-switch (Ctrl+Shift+K)
- [x] 8-gate cockpit UI
- [x] electron-builder config (unsigned)

## M5 — Ship

- [x] README + DISCLAIMER + LICENSE
- [x] Design spec doc
