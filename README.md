# CTRL

<p align="center">
  <img src="./CTRL_logo_3200x900.png" alt="CTRL" width="880" />
</p>

<p align="center"><strong>Continuous Token Reduction Loop</strong><br/>AI-orchestrated buyback + burn system running every 69 seconds.</p>

<p align="center">
  <img alt="Status" src="https://img.shields.io/badge/status-live-16a34a" />
  <img alt="Loop" src="https://img.shields.io/badge/loop-69s-f97316" />
  <img alt="Network" src="https://img.shields.io/badge/network-Solana-2563eb" />
  <img alt="UI" src="https://img.shields.io/badge/ui-Vite%20%2B%20React-0f172a" />
  <img alt="API" src="https://img.shields.io/badge/api-Node.js-111827" />
</p>

## Overview

CTRL is split into a dashboard + API stack and an autoburn worker:

- `ctrl-burn-dashboard-main/ctrl-burn-dashboard-main`: public dashboard, live API, websocket feed, chart, token metrics
- `autoburner`: on-chain worker that claims creator rewards, buys token, burns token, repeats on interval
- `constant-token-reduction-loop-profile`: profile-style README content for GitHub presentation

## Core Flow

1. Claim creator rewards.
2. Route funds into buyback.
3. Burn purchased tokens.
4. Publish status/logs/metrics to dashboard.
5. Repeat every loop interval (`69s` target).

## Runtime Components

### Dashboard + API

- Frontend: React + Vite + Tailwind
- Backend: Node server with REST + WS
- Market data: GeckoTerminal + DexScreener integrations
- Live metrics: holders, supply burned %, creator rewards, burn stats
- Runtime orchestration: **Powered by Grok 4 AI**

Main entry points:

- `ctrl-burn-dashboard-main/ctrl-burn-dashboard-main/src/pages/Index.tsx`
- `ctrl-burn-dashboard-main/ctrl-burn-dashboard-main/src/components/ctrl/Dashboard.tsx`
- `ctrl-burn-dashboard-main/ctrl-burn-dashboard-main/server/index.mjs`

### Autoburn Worker

- Main loop: `autoburner/src/auto_burner.js`
- Handles claim -> buy -> burn -> cooldown cycle
- Uses env-driven config for RPCs, wallet, mint, slippage, fees, cooldown, guards

