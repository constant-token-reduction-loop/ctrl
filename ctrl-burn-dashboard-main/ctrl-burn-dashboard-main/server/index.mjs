import http from "node:http";
import process from "node:process";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

const CYCLE_SECONDS = 69;
const TERMINAL_LIMIT = 200;
const HEARTBEAT_WINDOW = 24 * 60 * 60 * 1000;
const MOCK_CTRL = String(process.env.MOCK_CTRL ?? "false").toLowerCase() === "true";
const WORKER_BASE_URL = process.env.CTRL_WORKER_BASE_URL ?? "http://127.0.0.1:8790";
const WORKER_EVENTS_URL = process.env.CTRL_WORKER_EVENTS_URL ?? `${WORKER_BASE_URL}/events`;
const WORKER_STATUS_URL = process.env.CTRL_WORKER_STATUS_URL ?? `${WORKER_BASE_URL}/status`;
const WORKER_STATUS_POLL_MS = toNumber(process.env.CTRL_WORKER_STATUS_POLL_MS, 3000);
const HOLDERS_REFRESH_MS = toNumber(process.env.CTRL_HOLDERS_REFRESH_MS, 120000);
const CTRL_BRAND = "CTRL - Continuous Token Reduction Loop";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const DEFAULT_TOKEN_MINT = "HYxwhXhcsjwU88NHqcidhTbenztJzXDfB823pekopump";
const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const DEFAULT_GENESIS_SUPPLY = 1_000_000_000;
const DEFAULT_PUMPFUN_CREATOR_REWARDS_WALLET = "DiRCiu7KaKayiSqtfzRa1Ua6Yj24nWbCbJ3c7KvonURn";
const DEFAULT_DEV_BUY_WALLET = "ftTvZ4a6hTzTAecpRYtEMy8EaP6cGcxLzAR953KhQRv";
const CREATOR_REWARDS_REFRESH_MS = toNumber(process.env.CTRL_CREATOR_REWARDS_REFRESH_MS, 300000);
const PUMPFUN_CREATOR_FEES_BASE_URL = "https://swap-api.pump.fun/v1/creators";
const PUMPFUN_FEE_SHARING_BASE_URL = "https://swap-api.pump.fun/v1/fee-sharing/account";
const PUMPFUN_SOL_PRICE_URL = "https://frontend-api-v3.pump.fun/sol-price";

const STATUS = {
  WAITING: "WAITING",
  EXECUTING_BUY: "EXECUTING_BUY",
  BURNING: "BURNING",
  CONFIRMED: "CONFIRMED",
  ERROR: "ERROR",
};

const BURN_INCINERATOR = process.env.BURN_ACCOUNT_ADDRESS ?? "1nc1nerator11111111111111111111111111111111";
const DEFAULT_CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS ?? BURN_INCINERATOR;
const STATE_FILE_PATH = path.resolve(process.cwd(), process.env.CTRL_STATE_FILE ?? ".ctrl-runtime-state.json");

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatTxUrl(signature = "") {
  return signature ? `https://solscan.io/tx/${signature}` : "";
}

function formatAccountUrl(address = "") {
  return address ? `https://solscan.io/account/${address}` : "";
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function parseU64LeFromBase64(encoded) {
  try {
    const b64 = Array.isArray(encoded) ? encoded[0] : encoded;
    if (!b64 || typeof b64 !== "string") return 0;
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length < 8) return 0;
    let value = 0n;
    for (let i = 0; i < 8; i += 1) {
      value |= BigInt(bytes[i]) << BigInt(8 * i);
    }
    return Number(value);
  } catch {
    return 0;
  }
}

function parseTokenUiAmount(raw) {
  const ui = toNumber(raw?.uiTokenAmount?.uiAmount, NaN);
  if (Number.isFinite(ui)) return ui;
  const uiString = toNumber(raw?.uiTokenAmount?.uiAmountString, NaN);
  if (Number.isFinite(uiString)) return uiString;
  const amount = toNumber(raw?.uiTokenAmount?.amount, NaN);
  const decimals = toNumber(raw?.uiTokenAmount?.decimals, NaN);
  if (Number.isFinite(amount) && Number.isFinite(decimals)) {
    return amount / Math.pow(10, decimals);
  }
  return 0;
}

function sumWalletMintAmount(entries, walletAddress, mintAddress) {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce((sum, entry) => {
    if (String(entry?.owner ?? "") !== walletAddress) return sum;
    if (String(entry?.mint ?? "") !== mintAddress) return sum;
    return sum + parseTokenUiAmount(entry);
  }, 0);
}

function parseSignature(text) {
  const match = String(text).match(/\b[1-9A-HJ-NP-Za-km-z]{70,100}\b/);
  return match?.[0] ?? "";
}

function parseLeadingNumber(text) {
  const match = String(text).match(/-?\d[\d,]*\.?\d*/);
  if (!match) return null;
  const n = Number(match[0].replaceAll(",", ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeWorkerMessage(text) {
  let msg = String(text ?? "")
    .replace(/^\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM|A\.M\.|P\.M\.)?\s*/i, "")
    .replace(/\[\s*EL\s+MENCHO\s+BURNS\s*\]\s*/gi, "")
    .replace(/\bEL\s+MENCHO\s+BURNS\b/gi, "")
    .replace(/\bEL\s+MENCHO\b/gi, "")
    .replace(/\bMENCHO\b/gi, "")
    .replace(/EL\s+MENCHO\s+BURNS/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!msg) return "";
  if (!msg.includes(CTRL_BRAND)) {
    msg = `[${CTRL_BRAND}] ${msg}`;
  }

  return msg;
}

function containsLegacyBrand(text) {
  return /\b(el\s*mencho|mencho)\b/i.test(String(text ?? ""));
}

function buildProfessionalTerminalMessage(level, text, signature) {
  const upper = text.toUpperCase();
  const amount = parseLeadingNumber(text);

  if (level === "err" || upper.includes("ERROR") || upper.includes("FAILED")) {
    return {
      type: "error",
      message: `\u274C [${CTRL_BRAND}] EXECUTION ERROR: Recovery + retry in progress.`,
      txUrl: signature ? formatTxUrl(signature) : undefined,
    };
  }

  if (upper.includes("CLAIM")) {
    return {
      type: "reward",
      message: `\u{1F7E2} [${CTRL_BRAND}] REWARDS ARE CLAIMED${amount !== null ? `: +${Number(amount).toFixed(4)} SOL` : "."}`,
      txUrl: signature ? formatTxUrl(signature) : undefined,
      amount: amount !== null ? `${Number(amount).toFixed(4)} SOL` : undefined,
    };
  }

  if (upper.includes("BUY") || upper.includes("JUPITER TX") || upper.includes("PUMP TX") || upper.includes("BOUGHT")) {
    return {
      type: "buy",
      message: `\u{1F7E1} [${CTRL_BRAND}] BUYBACK EXECUTED${amount !== null ? `: ${Math.trunc(amount).toLocaleString()} CTRL ACQUIRED` : "."}`,
      txUrl: signature ? formatTxUrl(signature) : undefined,
    };
  }

  if (upper.includes("BURN TX") || upper.includes("CONFIRM")) {
    return {
      type: "confirm",
      message: `\u2705 [${CTRL_BRAND}] BURN CONFIRMED ON-CHAIN.`,
      txUrl: signature ? formatTxUrl(signature) : undefined,
    };
  }

  if (upper.includes("BURN") || upper.includes("INCINERATOR")) {
    return {
      type: "burn",
      message: `\u{1F525} [${CTRL_BRAND}] TOKENS SENT TO INCINERATOR${amount !== null ? `: ${Math.trunc(amount).toLocaleString()} CTRL` : "."}`,
      txUrl: signature ? formatTxUrl(signature) : undefined,
    };
  }

  if (upper.includes("NEXT BURN") || upper.includes("CYCLE")) {
    return {
      type: "info",
      message: `\u{1F7E3} [${CTRL_BRAND}] CYCLE LIVE: 69-SECOND LOOP ACTIVE.`,
      txUrl: signature ? formatTxUrl(signature) : undefined,
    };
  }

  return {
    type: "info",
    message: `\u{1F7E3} [${CTRL_BRAND}] SYSTEM UPDATE: Runtime health nominal.`,
    txUrl: signature ? formatTxUrl(signature) : undefined,
  };
}

function sanitizedMessageByType(type) {
  if (type === "reward") return `\u{1F7E2} [${CTRL_BRAND}] REWARD EVENT PROCESSED.`;
  if (type === "buy") return `\u{1F7E1} [${CTRL_BRAND}] BUYBACK EVENT PROCESSED.`;
  if (type === "burn") return `\u{1F525} [${CTRL_BRAND}] BURN EVENT PROCESSED.`;
  if (type === "confirm") return `\u2705 [${CTRL_BRAND}] CONFIRMATION EVENT PROCESSED.`;
  if (type === "error") return `\u274C [${CTRL_BRAND}] ERROR EVENT PROCESSED.`;
  return `\u{1F7E3} [${CTRL_BRAND}] INFO EVENT PROCESSED.`;
}

async function jsonRpc(rpcUrl, method, params) {
  const body = {
    jsonrpc: "2.0",
    id: `${Date.now()}-${method}`,
    method,
    params,
  };

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`RPC ${method} failed with HTTP ${res.status}`);
  }

  const payload = await res.json();
  if (payload.error) {
    throw new Error(`RPC ${method} error: ${payload.error.message ?? "unknown"}`);
  }

  return payload.result;
}

function createDefaultState() {
  const burnWalletAddress = process.env.BURN_WALLET_ADDRESS ?? BURN_INCINERATOR;
  const contractAddress = process.env.CONTRACT_ADDRESS ?? DEFAULT_CONTRACT_ADDRESS;
  const timestamp = Date.now() - 20_000;
  return {
    ctrl: {
      tokensBurned: { total: toNumber(process.env.CTRL_TOTAL_TOKENS_BURNED, 0) },
      solBurned: { total: toNumber(process.env.CTRL_TOTAL_SOL_BURNED, 0) },
      usdSpent: { total: toNumber(process.env.CTRL_TOTAL_USD_SPENT, 0) },
      cycles: { total: toNumber(process.env.CTRL_TOTAL_CYCLES, 0) },
      avgBurnPerCycle: toNumber(process.env.CTRL_AVG_BURN_PER_CYCLE, 0),
      nextBurn: { remainingSeconds: CYCLE_SECONDS, progress01: 0 },
      status: STATUS.WAITING,
      rewards: {
        walletBalanceSol: 0,
        walletBalanceUsd: 0,
        totalClaimedSol: toNumber(process.env.CTRL_TOTAL_CLAIMED_SOL, 0),
        totalClaimedUsd: toNumber(process.env.CTRL_TOTAL_CLAIMED_USD, 0),
      },
      supply: { percentBurned: toNumber(process.env.CTRL_SUPPLY_PERCENT_BURNED, 0) },
      holders: { total: toNumber(process.env.CTRL_TOTAL_HOLDERS, 0) },
      lastBurn: {
        amountTokens: toNumber(process.env.CTRL_LAST_BURN_AMOUNT, 0),
        buyTx: process.env.CTRL_LAST_BUY_TX ?? "",
        burnTx: process.env.CTRL_LAST_BURN_TX ?? "",
        timestamp,
        solscanBuyUrl: formatTxUrl(process.env.CTRL_LAST_BUY_TX ?? ""),
        solscanBurnUrl: formatTxUrl(process.env.CTRL_LAST_BURN_TX ?? ""),
      },
      wallets: {
        burnWalletAddress,
        burnWalletSolscanUrl: formatAccountUrl(burnWalletAddress),
        contractAddress,
        contractSolscanUrl: formatAccountUrl(contractAddress),
      },
      uptime: { percent: 100 },
      terminal: {
        events: [
          {
            timestamp,
            type: "info",
            message: `\u{1F7E3} ${CTRL_BRAND}: runtime initialized.`,
          },
        ],
      },
    },
    serverTime: nowIso(),
    cycleSeconds: CYCLE_SECONDS,
  };
}

function loadPersistedRuntimeState() {
  try {
    if (!fs.existsSync(STATE_FILE_PATH)) return null;
    const raw = fs.readFileSync(STATE_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.ctrl || typeof parsed.ctrl !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

class CtrlRuntime {
  constructor() {
    this.state = createDefaultState();
    const persisted = loadPersistedRuntimeState();
    if (persisted?.ctrl) {
      this.state = {
        ...this.state,
        ...persisted,
        ctrl: {
          ...this.state.ctrl,
          ...persisted.ctrl,
          nextBurn: { ...this.state.ctrl.nextBurn, ...persisted.ctrl.nextBurn },
          rewards: { ...this.state.ctrl.rewards, ...persisted.ctrl.rewards },
          supply: { ...this.state.ctrl.supply, ...persisted.ctrl.supply },
          holders: { ...this.state.ctrl.holders, ...persisted.ctrl.holders },
          cycles: { ...this.state.ctrl.cycles, ...persisted.ctrl.cycles },
          tokensBurned: { ...this.state.ctrl.tokensBurned, ...persisted.ctrl.tokensBurned },
          solBurned: { ...this.state.ctrl.solBurned, ...persisted.ctrl.solBurned },
          usdSpent: { ...this.state.ctrl.usdSpent, ...persisted.ctrl.usdSpent },
          wallets: { ...this.state.ctrl.wallets, ...persisted.ctrl.wallets },
          lastBurn: { ...this.state.ctrl.lastBurn, ...persisted.ctrl.lastBurn },
          uptime: { ...this.state.ctrl.uptime, ...persisted.ctrl.uptime },
          terminal: {
            events: Array.isArray(persisted?.ctrl?.terminal?.events)
              ? persisted.ctrl.terminal.events.slice(-TERMINAL_LIMIT)
              : this.state.ctrl.terminal.events,
          },
        },
      };
    }
    this.clients = new Set();
    this.heartbeat = [];
    this.lastPriceUsd = toNumber(process.env.SOL_USD_FALLBACK, 0);
    this.lastRefreshFailed = false;
    this.lastTerminalAt = 0;

    this.rpcUrl = process.env.SOLANA_RPC_URL ?? DEFAULT_SOLANA_RPC_URL;
    this.rewardsWallet = process.env.REWARDS_WALLET_ADDRESS ?? "";
    this.burnWallet = this.state.ctrl.wallets.burnWalletAddress;
    this.contractAddress = this.state.ctrl.wallets.contractAddress;
    this.tokenMint = process.env.TOKEN_MINT_ADDRESS ?? DEFAULT_TOKEN_MINT;
    this.totalSupplyOverride = toNumber(process.env.TOKEN_TOTAL_SUPPLY_OVERRIDE, 0);
    this.genesisSupply = toNumber(process.env.TOKEN_GENESIS_SUPPLY, DEFAULT_GENESIS_SUPPLY);
    this.creatorRewardsWallet = process.env.PUMPFUN_CREATOR_REWARDS_WALLET ?? DEFAULT_PUMPFUN_CREATOR_REWARDS_WALLET;
    this.devBuyWallet = process.env.DEV_BUY_WALLET_ADDRESS ?? DEFAULT_DEV_BUY_WALLET;
    this.creatorRewardsSyncInFlight = false;
    this.creatorRewardsUsdFromPump = false;
    this.devBuyEventsCache = [];
    this.devBuyEventsCacheAt = 0;
    this.devBuySyncInFlight = false;
    this.workerEnabled = Boolean(WORKER_EVENTS_URL || WORKER_STATUS_URL);
    this.workerReconnectMs = 2000;
    this.workerAbortController = null;
    this.seenWorkerLogs = new Set();
    this.lastWorkerStreamError = "";
    this.lastWorkerStreamErrorAt = 0;
    this.holdersLastSyncAt = 0;
    this.lastPersistSerialized = "";
  }

  start() {
    this.persistRuntimeState();

    if (!this.workerEnabled) {
      this.refreshState().catch(() => undefined);
    } else {
      this.pushTerminal({
        type: "info",
        message: `\u{1F7E3} ${CTRL_BRAND}: worker bridge enabled.`,
      });
      this.startWorkerBridge();
    }

    setInterval(() => {
      this.advanceTimer();
      this.broadcastPatch({
        ctrl: {
          status: this.state.ctrl.status,
          nextBurn: this.state.ctrl.nextBurn,
          uptime: this.state.ctrl.uptime,
        },
      });
    }, 1000);

    // Always refresh chain-derived metrics, even when worker bridge is enabled.
    setInterval(() => {
      this.refreshState().catch(() => undefined);
    }, MOCK_CTRL ? 4000 : 10000);

    setInterval(() => {
      this.refreshSolPrice().catch(() => undefined);
    }, 30000);

    this.refreshCreatorRewardsFromPumpWallet().catch(() => undefined);
    setInterval(() => {
      this.refreshCreatorRewardsFromPumpWallet().catch(() => undefined);
    }, CREATOR_REWARDS_REFRESH_MS);

    setInterval(() => {
      this.persistRuntimeState();
    }, 1500);
  }

  persistRuntimeState() {
    try {
      const payload = {
        ctrl: this.state.ctrl,
        serverTime: nowIso(),
        cycleSeconds: CYCLE_SECONDS,
      };
      const serialized = JSON.stringify(payload);
      if (serialized === this.lastPersistSerialized) return;
      fs.writeFileSync(STATE_FILE_PATH, serialized, "utf8");
      this.lastPersistSerialized = serialized;
    } catch {
      // ignore persistence errors and keep runtime live
    }
  }

  startWorkerBridge() {
    if (WORKER_STATUS_URL) {
      this.pollWorkerStatus().catch(() => undefined);
      setInterval(() => {
        this.pollWorkerStatus().catch(() => undefined);
      }, Math.max(1000, WORKER_STATUS_POLL_MS));
    }

    if (WORKER_EVENTS_URL) {
      this.connectWorkerEvents().catch(() => undefined);
    }
  }

  async pollWorkerStatus() {
    const res = await fetch(WORKER_STATUS_URL, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`Worker status HTTP ${res.status}`);
    }

    const status = await res.json();
    const patch = { ctrl: { rewards: {}, lastBurn: {}, wallets: {} } };
    const walletBalance = parseLeadingNumber(status?.sol);
    const claimedSol = parseLeadingNumber(status?.claimed);
    const burnedTokens = parseLeadingNumber(status?.burned);
    const usePumpCreatorRewards = Boolean(this.creatorRewardsWallet);

    if (walletBalance !== null) patch.ctrl.rewards.walletBalanceSol = walletBalance;
    if (!usePumpCreatorRewards && claimedSol !== null) patch.ctrl.rewards.totalClaimedSol = claimedSol;
    if (burnedTokens !== null) patch.ctrl.lastBurn.amountTokens = burnedTokens;
    if (this.lastPriceUsd > 0) {
      if (patch.ctrl.rewards.walletBalanceSol !== undefined) {
        patch.ctrl.rewards.walletBalanceUsd = Number((patch.ctrl.rewards.walletBalanceSol * this.lastPriceUsd).toFixed(2));
      }
      if (!usePumpCreatorRewards && patch.ctrl.rewards.totalClaimedSol !== undefined) {
        patch.ctrl.rewards.totalClaimedUsd = Number((patch.ctrl.rewards.totalClaimedSol * this.lastPriceUsd).toFixed(2));
      }
    }

    patch.ctrl.wallets.burnWalletSolscanUrl = formatAccountUrl(
      patch.ctrl.wallets.burnWalletAddress || this.state.ctrl.wallets.burnWalletAddress
    );
    patch.ctrl.wallets.contractSolscanUrl = formatAccountUrl(
      patch.ctrl.wallets.contractAddress || this.state.ctrl.wallets.contractAddress
    );

    this.state.ctrl = {
      ...this.state.ctrl,
      ...patch.ctrl,
      rewards: { ...this.state.ctrl.rewards, ...patch.ctrl.rewards },
      lastBurn: { ...this.state.ctrl.lastBurn, ...patch.ctrl.lastBurn },
      wallets: { ...this.state.ctrl.wallets, ...patch.ctrl.wallets },
    };

    this.recordHeartbeat(true);
    this.broadcastPatch({
      ctrl: {
        rewards: this.state.ctrl.rewards,
        lastBurn: this.state.ctrl.lastBurn,
        wallets: this.state.ctrl.wallets,
        uptime: this.state.ctrl.uptime,
      },
    });
  }

  async connectWorkerEvents() {
    this.workerAbortController = new AbortController();
    let response;
    try {
      response = await fetch(WORKER_EVENTS_URL, {
        headers: { accept: "text/event-stream" },
        signal: this.workerAbortController.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Worker events HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (!payload) continue;
          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          if (parsed.type === "log") {
            this.ingestWorkerLog(parsed.level, parsed.text);
          }
        }
      }
    } catch (error) {
      this.recordHeartbeat(false);
      this.state.ctrl.status = STATUS.ERROR;
      this.broadcastPatch({ ctrl: { status: STATUS.ERROR, uptime: this.state.ctrl.uptime } });
      const reason = error instanceof Error ? error.message : "unknown";
      const msg = `\u274C ERROR: Worker stream disconnected (${reason})`;
      const now = Date.now();
      const sameAsLast = this.lastWorkerStreamError === msg;
      const withinWindow = now - this.lastWorkerStreamErrorAt < 20000;
      if (!sameAsLast || !withinWindow) {
        this.pushTerminal({ type: "error", message: msg });
        this.lastWorkerStreamError = msg;
        this.lastWorkerStreamErrorAt = now;
      }
    } finally {
      setTimeout(() => {
        this.connectWorkerEvents().catch(() => undefined);
      }, this.workerReconnectMs);
    }
  }

  ingestWorkerLog(level, rawText) {
    const text = normalizeWorkerMessage(rawText);
    if (!text) return;
    if (this.seenWorkerLogs.has(text)) return;
    this.seenWorkerLogs.add(text);
    if (this.seenWorkerLogs.size > 600) {
      const first = this.seenWorkerLogs.values().next().value;
      this.seenWorkerLogs.delete(first);
    }

    const sig = parseSignature(text);
    if (text.includes("Burn Tx") && sig) {
      this.state.ctrl.lastBurn.burnTx = sig;
      this.state.ctrl.lastBurn.solscanBurnUrl = formatTxUrl(sig);
      this.state.ctrl.lastBurn.timestamp = nowIso();
      this.state.ctrl.status = STATUS.CONFIRMED;
      this.state.ctrl.cycles.total += 1;
    } else if ((text.includes("Pump Tx") || text.includes("Jupiter Tx")) && sig) {
      this.state.ctrl.lastBurn.buyTx = sig;
      this.state.ctrl.lastBurn.solscanBuyUrl = formatTxUrl(sig);
    }

    if (text.includes("Burned ")) {
      const burned = parseLeadingNumber(text);
      if (burned !== null) {
        this.state.ctrl.lastBurn.amountTokens = burned;
      }
      this.state.ctrl.status = STATUS.BURNING;
    } else if (text.includes("Burn value:")) {
      const solMatch = text.match(/([\d.]+)\s*SOL/i);
      const usdMatch = text.match(/\$([\d.]+)/);
      if (solMatch) {
        const burnedSol = toNumber(solMatch[1], 0);
        this.state.ctrl.solBurned.total = Number((toNumber(this.state.ctrl.solBurned.total, 0) + burnedSol).toFixed(6));
      }
      if (usdMatch) {
        const burnedUsd = toNumber(usdMatch[1], 0);
        this.state.ctrl.usdSpent.total = Number((toNumber(this.state.ctrl.usdSpent.total, 0) + burnedUsd).toFixed(2));
      }
    } else if (text.includes("Bought ")) {
      this.state.ctrl.status = STATUS.EXECUTING_BUY;
    } else if (text.includes("Next burn in ")) {
      this.state.ctrl.status = STATUS.WAITING;
    } else if (text.includes("Claimed creator fees")) {
      this.state.ctrl.status = STATUS.EXECUTING_BUY;
    } else if (level === "err" || text.includes("ERROR")) {
      this.state.ctrl.status = STATUS.ERROR;
    }

    const event = buildProfessionalTerminalMessage(level, text, sig);
    this.pushTerminal(event);

    this.broadcastPatch({
      ctrl: {
        status: this.state.ctrl.status,
        tokensBurned: this.state.ctrl.tokensBurned,
        cycles: this.state.ctrl.cycles,
        lastBurn: this.state.ctrl.lastBurn,
      },
    });
  }

  addClient(ws) {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.send(JSON.stringify({
      type: "snapshot",
      payload: this.getSnapshot(),
    }));
    ws.send(JSON.stringify({
      type: "terminal",
      payload: {
        timestamp: nowIso(),
        type: "info",
        message: `\u{1F7E3} [${CTRL_BRAND}] LIVE FEED CONNECTED.`,
      },
    }));
  }

  getSnapshot() {
    const terminal = {
      events: this.state.ctrl.terminal.events.map((event) => ({
        ...event,
        message: containsLegacyBrand(event.message) ? sanitizedMessageByType(event.type) : event.message,
      })),
    };
    return {
      ctrl: {
        ...this.state.ctrl,
        terminal,
      },
      serverTime: nowIso(),
      cycleSeconds: CYCLE_SECONDS,
      tokenMint: this.tokenMint,
      devBuyWallet: this.devBuyWallet,
    };
  }

  async getDevBuyEvents(limit = 120) {
    if (MOCK_CTRL) return [];
    if (!this.devBuyWallet || !this.tokenMint) return [];

    const cacheTtlMs = 20_000;
    if (Date.now() - this.devBuyEventsCacheAt < cacheTtlMs && this.devBuyEventsCache.length > 0) {
      return this.devBuyEventsCache.slice(0, limit);
    }
    if (this.devBuySyncInFlight) {
      return this.devBuyEventsCache.slice(0, limit);
    }

    this.devBuySyncInFlight = true;
    try {
      const signatures = await jsonRpc(this.rpcUrl, "getSignaturesForAddress", [
        this.devBuyWallet,
        { limit: Math.max(20, Math.min(200, limit)), commitment: "confirmed" },
      ]);

      const normalizedSignatures = Array.isArray(signatures) ? signatures : [];
      const out = [];
      for (const row of normalizedSignatures) {
        const signature = String(row?.signature ?? "");
        if (!signature) continue;

        let tx;
        try {
          tx = await jsonRpc(this.rpcUrl, "getTransaction", [
            signature,
            { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
          ]);
        } catch {
          continue;
        }
        const meta = tx?.meta;
        if (!meta) continue;

        const pre = sumWalletMintAmount(meta?.preTokenBalances, this.devBuyWallet, this.tokenMint);
        const post = sumWalletMintAmount(meta?.postTokenBalances, this.devBuyWallet, this.tokenMint);
        const delta = post - pre;
        if (!(delta > 0)) continue;

        const tsMs = toNumber(tx?.blockTime, 0) * 1000;
        out.push({
          timestamp: tsMs > 0 ? new Date(tsMs).toISOString() : nowIso(),
          ts: tsMs > 0 ? tsMs : Date.now(),
          amount: Number(delta.toFixed(6)),
          txUrl: formatTxUrl(signature),
          signature,
        });
      }

      out.sort((a, b) => a.ts - b.ts);
      this.devBuyEventsCache = out;
      this.devBuyEventsCacheAt = Date.now();
      return out.slice(0, limit);
    } finally {
      this.devBuySyncInFlight = false;
    }
  }

  recordHeartbeat(ok) {
    const ts = Date.now();
    this.heartbeat.push({ ts, ok });
    const cutoff = ts - HEARTBEAT_WINDOW;
    while (this.heartbeat.length && this.heartbeat[0].ts < cutoff) {
      this.heartbeat.shift();
    }

    const total = this.heartbeat.length;
    const good = this.heartbeat.filter((item) => item.ok).length;
    this.state.ctrl.uptime.percent = total === 0 ? 100 : Number(((good / total) * 100).toFixed(2));
  }

  pushTerminal(event) {
    const base = { timestamp: nowIso(), ...event };
    const e = {
      ...base,
      message: containsLegacyBrand(base.message) ? sanitizedMessageByType(base.type) : base.message,
    };
    const events = this.state.ctrl.terminal.events;
    events.push(e);
    if (events.length > TERMINAL_LIMIT) {
      events.splice(0, events.length - TERMINAL_LIMIT);
    }

    const json = JSON.stringify({ type: "terminal", payload: e });
    this.clients.forEach((client) => {
      if (client.readyState === 1) client.send(json);
    });
  }

  broadcastPatch(payload) {
    const json = JSON.stringify({ type: "patch", payload });
    this.clients.forEach((client) => {
      if (client.readyState === 1) client.send(json);
    });
  }

  advanceTimer() {
    const status = this.state.ctrl.status;
    if (status === STATUS.ERROR) {
      this.state.ctrl.nextBurn.remainingSeconds = clamp(this.state.ctrl.nextBurn.remainingSeconds, 0, CYCLE_SECONDS);
      this.state.ctrl.nextBurn.progress01 = clamp(this.state.ctrl.nextBurn.progress01, 0, 1);
      return;
    }

    if (status === STATUS.EXECUTING_BUY || status === STATUS.BURNING) {
      return;
    }

    const lastBurnMs = new Date(this.state.ctrl.lastBurn.timestamp).getTime();
    const elapsed = Math.floor((Date.now() - lastBurnMs) / 1000);
    const remaining = clamp(CYCLE_SECONDS - (elapsed % CYCLE_SECONDS), 0, CYCLE_SECONDS);
    const progress = clamp((CYCLE_SECONDS - remaining) / CYCLE_SECONDS, 0, 1);

    this.state.ctrl.nextBurn.remainingSeconds = remaining;
    this.state.ctrl.nextBurn.progress01 = Number(progress.toFixed(4));

    if (remaining === 0) {
      this.startCycle();
    }
  }

  startCycle() {
    const cycleNumber = this.state.ctrl.cycles.total + 1;
    this.state.ctrl.status = STATUS.EXECUTING_BUY;
    this.pushTerminal({ type: "info", message: `\u{1F7E3} ${CTRL_BRAND}: cycle #${cycleNumber} started.` });
    this.pushTerminal({ type: "buy", message: `\u{1F7E1} ${CTRL_BRAND}: executing buyback order...` });

    setTimeout(() => {
      this.state.ctrl.status = STATUS.BURNING;
      this.pushTerminal({ type: "burn", message: `\u{1F525} ${CTRL_BRAND}: sending tokens to burn wallet...` });
    }, 2200);

    setTimeout(() => {
      this.state.ctrl.status = STATUS.CONFIRMED;
      this.state.ctrl.cycles.total += 1;
      this.state.ctrl.lastBurn.timestamp = nowIso();
      this.pushTerminal({
        type: "confirm",
        message: `\u2705 ${CTRL_BRAND}: burn confirmed on-chain.`,
        txUrl: this.state.ctrl.lastBurn.solscanBurnUrl || undefined,
      });

      setTimeout(() => {
        this.state.ctrl.status = STATUS.WAITING;
      }, 1200);
    }, 4200);
  }

  async refreshSolPrice() {
    if (MOCK_CTRL) {
      this.lastPriceUsd = 140 + Math.random() * 35;
      return;
    }

    try {
      const primary = await fetch("https://price.jup.ag/v4/price?ids=SOL", { headers: { accept: "application/json" } });
      if (primary.ok) {
        const body = await primary.json();
        const p = toNumber(body?.data?.SOL?.price, 0);
        if (p > 0) {
          this.lastPriceUsd = p;
          return;
        }
      }
    } catch {
      // fallback below
    }

    try {
      const fallback = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", {
        headers: { accept: "application/json" },
      });
      if (!fallback.ok) return;
      const body = await fallback.json();
      const p = toNumber(body?.solana?.usd, 0);
      if (p > 0) this.lastPriceUsd = p;
    } catch {
      // keep last cached price
    }
  }

  async refreshState() {
    try {
      if (MOCK_CTRL) {
        this.applyMockRefresh();
      } else {
        await this.applyLiveRefresh();
      }
      this.recordHeartbeat(true);

      if (this.lastRefreshFailed && this.state.ctrl.status === STATUS.ERROR) {
        this.state.ctrl.status = STATUS.WAITING;
      }
      this.lastRefreshFailed = false;

      this.state.serverTime = nowIso();
      this.broadcastPatch({
        ctrl: {
          tokensBurned: this.state.ctrl.tokensBurned,
          solBurned: this.state.ctrl.solBurned,
          usdSpent: this.state.ctrl.usdSpent,
          cycles: this.state.ctrl.cycles,
          avgBurnPerCycle: this.state.ctrl.avgBurnPerCycle,
          rewards: this.state.ctrl.rewards,
          supply: this.state.ctrl.supply,
          holders: this.state.ctrl.holders,
          lastBurn: this.state.ctrl.lastBurn,
          wallets: this.state.ctrl.wallets,
          uptime: this.state.ctrl.uptime,
        },
      });
    } catch (error) {
      this.lastRefreshFailed = true;
      this.state.ctrl.status = STATUS.ERROR;
      this.recordHeartbeat(false);
      this.broadcastPatch({ ctrl: { status: STATUS.ERROR, uptime: this.state.ctrl.uptime } });
    }
  }

  applyMockRefresh() {
    const rewardDelta = Number((Math.random() * 0.08).toFixed(4));
    const burnDelta = Math.floor(350000 + Math.random() * 950000);

    this.state.ctrl.rewards.walletBalanceSol = Number((this.state.ctrl.rewards.walletBalanceSol + rewardDelta).toFixed(4));
    this.state.ctrl.rewards.totalClaimedSol = Number((this.state.ctrl.rewards.totalClaimedSol + rewardDelta).toFixed(4));

    const solSpentDelta = rewardDelta * (0.75 + Math.random() * 0.25);
    this.state.ctrl.solBurned.total = Number((this.state.ctrl.solBurned.total + solSpentDelta).toFixed(4));

    if (this.lastPriceUsd > 0) {
      const spentUsd = solSpentDelta * this.lastPriceUsd;
      this.state.ctrl.rewards.walletBalanceUsd = Number((this.state.ctrl.rewards.walletBalanceSol * this.lastPriceUsd).toFixed(2));
      this.state.ctrl.rewards.totalClaimedUsd = Number((this.state.ctrl.rewards.totalClaimedSol * this.lastPriceUsd).toFixed(2));
      this.state.ctrl.usdSpent.total = Number((this.state.ctrl.usdSpent.total + spentUsd).toFixed(2));
    }

    if (Math.random() > 0.55) {
      this.state.ctrl.tokensBurned.total = Number((this.state.ctrl.tokensBurned.total + burnDelta).toFixed(0));
      this.state.ctrl.lastBurn.amountTokens = burnDelta;
      this.state.ctrl.lastBurn.buyTx = this.randomSignature();
      this.state.ctrl.lastBurn.burnTx = this.randomSignature();
      this.state.ctrl.lastBurn.solscanBuyUrl = formatTxUrl(this.state.ctrl.lastBurn.buyTx);
      this.state.ctrl.lastBurn.solscanBurnUrl = formatTxUrl(this.state.ctrl.lastBurn.burnTx);

      this.pushTerminal({
        type: "reward",
        message: `\u{1F7E2} ${CTRL_BRAND}: reward received +${rewardDelta.toFixed(4)} SOL`,
        amount: rewardDelta.toFixed(4),
      });
      this.pushTerminal({
        type: "buy",
        message: `\u{1F7E1} ${CTRL_BRAND}: buyback filled ${burnDelta.toLocaleString()} CTRL`,
        txUrl: this.state.ctrl.lastBurn.solscanBuyUrl,
      });
      this.pushTerminal({
        type: "burn",
        message: `\u{1F525} ${CTRL_BRAND}: tokens routed to burn wallet.`,
        txUrl: this.state.ctrl.lastBurn.solscanBurnUrl,
      });
      this.pushTerminal({
        type: "confirm",
        message: `\u2705 ${CTRL_BRAND}: burn confirmed on-chain.`,
        txUrl: this.state.ctrl.lastBurn.solscanBurnUrl,
      });
    } else if (Math.random() > 0.7) {
      this.pushTerminal({
        type: "info",
        message: `\u{1F7E3} ${CTRL_BRAND}: monitoring cycle integrity and awaiting next burn window.`,
      });
    }

    const supply = toNumber(process.env.TOKEN_TOTAL_SUPPLY_OVERRIDE, 1_000_000_000_000);
    const percent = supply > 0 ? (this.state.ctrl.tokensBurned.total / supply) * 100 : 0;
    this.state.ctrl.supply.percentBurned = Number(clamp(percent, 0, 100).toFixed(6));
    this.state.ctrl.holders.total = Math.max(0, Math.floor(toNumber(this.state.ctrl.holders.total, 1000) + (Math.random() > 0.5 ? 1 : 0)));

    this.recomputeAverages();
  }

  async applyLiveRefresh() {
    if (!this.burnWallet) {
      throw new Error("BURN_WALLET_ADDRESS is required in live mode");
    }

    const [balance, signatures] = await Promise.all([
      this.rewardsWallet
        ? jsonRpc(this.rpcUrl, "getBalance", [this.rewardsWallet, { commitment: "confirmed" }])
        : Promise.resolve({ value: 0 }),
      jsonRpc(this.rpcUrl, "getSignaturesForAddress", [this.burnWallet, { limit: 10, commitment: "confirmed" }]),
    ]);

    this.state.ctrl.rewards.walletBalanceSol = Number((toNumber(balance?.value, 0) / 1_000_000_000).toFixed(4));

    if (this.lastPriceUsd > 0) {
      this.state.ctrl.rewards.walletBalanceUsd = Number((this.state.ctrl.rewards.walletBalanceSol * this.lastPriceUsd).toFixed(2));
    }

    if (Array.isArray(signatures) && signatures.length) {
      const newestSig = signatures[0]?.signature ?? "";
      if (newestSig && newestSig !== this.state.ctrl.lastBurn.burnTx) {
        this.state.ctrl.lastBurn.burnTx = newestSig;
        this.state.ctrl.lastBurn.solscanBurnUrl = formatTxUrl(newestSig);
        this.state.ctrl.lastBurn.timestamp = signatures[0]?.blockTime ? signatures[0].blockTime * 1000 : nowIso();
        this.state.ctrl.status = STATUS.CONFIRMED;

        this.pushTerminal({
          type: "confirm",
          message: "\u2705 BURN CONFIRMED",
          txUrl: this.state.ctrl.lastBurn.solscanBurnUrl,
        });
      }
    }

    if (this.tokenMint) {
      const [supplyRaw, burnTokenAccounts, mintAccount] = await Promise.all([
        jsonRpc(this.rpcUrl, "getTokenSupply", [this.tokenMint, { commitment: "confirmed" }]),
        jsonRpc(this.rpcUrl, "getTokenAccountsByOwner", [BURN_INCINERATOR, { mint: this.tokenMint }, { encoding: "jsonParsed", commitment: "confirmed" }]),
        jsonRpc(this.rpcUrl, "getAccountInfo", [this.tokenMint, { encoding: "jsonParsed", commitment: "confirmed" }]),
      ]);

      const totalSupply = this.totalSupplyOverride > 0
        ? this.totalSupplyOverride
        : toNumber(supplyRaw?.value?.uiAmountString ?? supplyRaw?.value?.amount, 0);

      const burnedAmount = Array.isArray(burnTokenAccounts?.value)
        ? burnTokenAccounts.value.reduce((sum, acc) => {
          const amount = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString
            ?? acc?.account?.data?.parsed?.info?.tokenAmount?.amount
            ?? 0;
          return sum + toNumber(amount, 0);
        }, 0)
        : 0;

      const derivedBurnedFromSupply = Math.max(0, this.genesisSupply - totalSupply);
      const effectiveBurned = Math.max(burnedAmount, derivedBurnedFromSupply);

      this.state.ctrl.tokensBurned.total = Number(effectiveBurned.toFixed(0));
      this.state.ctrl.supply.percentBurned = this.genesisSupply > 0
        ? Number(clamp((effectiveBurned / this.genesisSupply) * 100, 0, 100).toFixed(6))
        : (totalSupply > 0 ? Number(clamp((effectiveBurned / totalSupply) * 100, 0, 100).toFixed(6)) : 0);

      // Derive SOL/USD burned from the token mint's most-liquid market pair.
      try {
        const pairsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${this.tokenMint}`, {
          headers: { accept: "application/json" },
        });
        if (pairsRes.ok) {
          const pairsJson = await pairsRes.json();
          const pairs = Array.isArray(pairsJson?.pairs) ? pairsJson.pairs : [];
          if (pairs.length > 0) {
            const selectedPair = [...pairs].sort((a, b) => {
              const aLiquidity = toNumber(a?.liquidity?.usd, 0);
              const bLiquidity = toNumber(b?.liquidity?.usd, 0);
              return bLiquidity - aLiquidity;
            })[0];

            const quoteSymbol = String(selectedPair?.quoteToken?.symbol ?? "").toUpperCase();
            const nativePrice = toNumber(selectedPair?.priceNative, 0);
            const priceInUsd = toNumber(selectedPair?.priceUsd, 0);
            const priceInSol = quoteSymbol === "SOL" || quoteSymbol === "WSOL"
              ? nativePrice
              : (priceInUsd > 0 && this.lastPriceUsd > 0 ? priceInUsd / this.lastPriceUsd : 0);

            if (priceInSol > 0) {
              this.state.ctrl.solBurned.total = Number((effectiveBurned * priceInSol).toFixed(6));
            }
            if (priceInUsd > 0) {
              this.state.ctrl.usdSpent.total = Number((effectiveBurned * priceInUsd).toFixed(2));
            } else if (this.lastPriceUsd > 0 && this.state.ctrl.solBurned.total > 0) {
              this.state.ctrl.usdSpent.total = Number((this.state.ctrl.solBurned.total * this.lastPriceUsd).toFixed(2));
            }
          }
        }
      } catch {
        // Keep previously computed totals if external pricing is unavailable.
      }

      if (Date.now() - this.holdersLastSyncAt > HOLDERS_REFRESH_MS) {
        this.holdersLastSyncAt = Date.now();
        try {
          const mintProgramOwner = String(mintAccount?.value?.owner ?? TOKEN_PROGRAM_ID);
          const tokenProgram = mintProgramOwner === TOKEN_2022_PROGRAM_ID ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
          const tokenAccounts = await jsonRpc(this.rpcUrl, "getProgramAccounts", [
            tokenProgram,
            {
              commitment: "confirmed",
              encoding: "base64",
              dataSlice: { offset: 64, length: 8 },
              filters: [{ memcmp: { offset: 0, bytes: this.tokenMint } }],
            },
          ]);

          if (Array.isArray(tokenAccounts)) {
            const holders = tokenAccounts.reduce((count, account) => {
              const amountRaw = parseU64LeFromBase64(account?.account?.data);
              return count + (amountRaw > 0 ? 1 : 0);
            }, 0);
            this.state.ctrl.holders.total = holders;
          }
        } catch {
          // keep last cached holders total
        }
      }
    }

    if (!this.state.ctrl.lastBurn.buyTx) {
      this.state.ctrl.lastBurn.buyTx = process.env.CTRL_LAST_BUY_TX ?? "";
      this.state.ctrl.lastBurn.solscanBuyUrl = formatTxUrl(this.state.ctrl.lastBurn.buyTx);
    }

    this.recomputeAverages();
  }

  async refreshCreatorRewardsFromPumpWallet() {
    if (MOCK_CTRL) return;
    if (this.creatorRewardsSyncInFlight) return;
    if (!this.creatorRewardsWallet) return;

    this.creatorRewardsSyncInFlight = true;
    try {
      const totalsUrl = `${PUMPFUN_FEE_SHARING_BASE_URL}/${this.creatorRewardsWallet}/totals`;
      const feesUrl = `${PUMPFUN_CREATOR_FEES_BASE_URL}/${this.creatorRewardsWallet}/fees/total`;
      const [totalsRes, feesRes, solPriceRes] = await Promise.all([
        fetch(totalsUrl, { headers: { accept: "application/json" } }),
        fetch(feesUrl, { headers: { accept: "application/json" } }),
        fetch(PUMPFUN_SOL_PRICE_URL, { headers: { accept: "application/json" } }),
      ]);
      let pumpSolPriceUsd = 0;
      if (solPriceRes.ok) {
        const pricePayload = await solPriceRes.json();
        pumpSolPriceUsd = toNumber(pricePayload?.solPrice, 0);
      }
      if (!(pumpSolPriceUsd > 0)) {
        pumpSolPriceUsd = this.lastPriceUsd;
      }

      let totalClaimedSol = 0;
      let totalClaimedUsd = 0;

      // This mirrors pump.fun profile "Total across all coins" for the creator wallet.
      if (totalsRes.ok) {
        const totalsPayload = await totalsRes.json();
        const totalEarned = totalsPayload?.shareholderTotalEarned ?? totalsPayload?.shareholderClaimed ?? null;
        totalClaimedSol = toNumber(totalEarned?.sol, 0);
        totalClaimedUsd = toNumber(totalEarned?.usd, 0);
      }

      if (!(totalClaimedSol > 0) && feesRes.ok) {
        const feesPayload = await feesRes.json();
        totalClaimedSol = toNumber(feesPayload?.totalFeesSOL, 0);
        if (!(totalClaimedSol > 0)) {
          const totalLamports = toNumber(feesPayload?.totalFees, 0);
          totalClaimedSol = totalLamports > 0 ? totalLamports / 1_000_000_000 : 0;
        }
      }

      if (!(totalClaimedUsd > 0) && totalClaimedSol > 0 && pumpSolPriceUsd > 0) {
        totalClaimedUsd = totalClaimedSol * pumpSolPriceUsd;
      }

      this.state.ctrl.rewards.totalClaimedSol = Number(totalClaimedSol.toFixed(4));
      if (totalClaimedUsd > 0) {
        this.state.ctrl.rewards.totalClaimedUsd = Number(totalClaimedUsd.toFixed(2));
        this.creatorRewardsUsdFromPump = true;
      } else {
        this.creatorRewardsUsdFromPump = false;
      }
      this.broadcastPatch({
        ctrl: {
          rewards: this.state.ctrl.rewards,
        },
      });
    } catch {
      // Keep previous creator reward totals if external enrichment is unavailable.
    } finally {
      this.creatorRewardsSyncInFlight = false;
    }
  }

  recomputeAverages() {
    const cycles = Math.max(this.state.ctrl.cycles.total, 1);
    this.state.ctrl.avgBurnPerCycle = Number((this.state.ctrl.tokensBurned.total / cycles).toFixed(2));

    if (this.lastPriceUsd > 0) {
      if (!this.creatorRewardsUsdFromPump) {
        this.state.ctrl.rewards.totalClaimedUsd = Number((this.state.ctrl.rewards.totalClaimedSol * this.lastPriceUsd).toFixed(2));
      }
      this.state.ctrl.usdSpent.total = Number((this.state.ctrl.solBurned.total * this.lastPriceUsd).toFixed(2));
    }
  }

  randomSignature() {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let out = "";
    for (let i = 0; i < 88; i += 1) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

const runtime = new CtrlRuntime();
runtime.start();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/ctrl/state") {
    sendJson(res, 200, runtime.getSnapshot());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/ctrl/dev-buys") {
    const limit = toNumber(url.searchParams.get("limit"), 120);
    runtime.getDevBuyEvents(limit).then((events) => {
      sendJson(res, 200, {
        wallet: runtime.devBuyWallet,
        tokenMint: runtime.tokenMint,
        events,
      });
    }).catch(() => {
      sendJson(res, 200, {
        wallet: runtime.devBuyWallet,
        tokenMint: runtime.tokenMint,
        events: [],
      });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, now: nowIso() });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname !== "/api/ctrl/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    runtime.addClient(ws);
  });
});

const port = toNumber(process.env.CTRL_BACKEND_PORT, 8787);
server.listen(port, () => {
  console.log(`[ctrl-backend] listening on :${port} (${MOCK_CTRL ? "mock" : "live"} mode)`);
});
