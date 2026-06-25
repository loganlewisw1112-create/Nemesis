# Trade Discovery & Executable Tiers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Paginate Kalshi universe, depth-verify fillable size at Scout/Solid/Whale tiers, and surface tier-badged thesis cards with Discovery Cockpit controls.

**Architecture:** `DiscoveryOrchestrator` in main process owns universe cache + depth pass; `@nemesis/core/discovery` holds tier math; renderer gets Discovery Cockpit + tier filters in Edge Theater.

**Tech Stack:** Electron, TypeScript, Vitest, Playwright

**Spec:** `docs/superpowers/specs/2026-06-24-trade-discovery-tiers-design.md`

---

## Status

- [x] M1: `executableTier.ts`, `DiscoveryOrchestrator`, Scout+ depth gate, Cockpit read-only metrics
- [x] M2: Solid/Whale tiers, presets, Cockpit controls, IPC
- [x] M3: Edge-scanner depthContext, tier filters/badges in UI, decoupled universe refresh (60s)

## Verification

```bash
cd nemesis && npm test && npm run typecheck && npm run build && npm run test:e2e
```
