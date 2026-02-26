# CTRL

**Constant Token Reduction Loop. Public by default.**

![API](https://img.shields.io/badge/API-live-1f2937)
![MODE](https://img.shields.io/badge/MODE-69s%20LOOP-f97316)
![STATUS](https://img.shields.io/badge/STATUS-ACTIVE-16a34a)
![NETWORK](https://img.shields.io/badge/NETWORK-SOLANA-2563eb)
![LICENSE](https://img.shields.io/badge/license-MIT-0f172a)

[website](https://ctrl.example.com) | [x](https://x.com/ctrl_loop) | [docs](https://docs.ctrl.example.com) | [solscan](https://solscan.io/account/1nc1nerator11111111111111111111111111111111) | [security](https://github.com/constant-token-reduction-loop/ctrl/security)

---

<p align="center">
  <img src="../assets/banner.png" alt="CTRL banner" width="92%" />
</p>

---

## The Lore

CTRL runs a strict 69-second reduction loop.
Reward in. Buyback. Burn. Confirm. Repeat.

---

## Architecture

```text
Dashboard + Profile Surface
        |
REST snapshot + WS live stream
        |
CTRL runtime (cache + cycle + terminal + uptime)
        |
Solana RPC + price feed
```

---

## Pipeline

`Reward -> Buyback -> Burn -> Confirm -> Reset (69s)`

---

## Transparency

Everything shown is verifiable through API payloads and Solscan links.

---

## Quickstart

```bash
npm install
npm run dev
```

---

## API / WS Contract

- `GET /api/ctrl/state`
- `WS /api/ctrl/ws`
- WS types: `snapshot`, `patch`, `terminal`

---

## Roadmap

- [x] Live public endpoints
- [x] Mock mode support
- [ ] Durable historical archive

---

## License

MIT

