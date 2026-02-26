import "dotenv/config";
import fetch from "node-fetch";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAccount,
  getMint,
  createBurnCheckedInstruction,
  ACCOUNT_SIZE,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

const PUMPPORTAL_TRADE_LOCAL = "https://pumpportal.fun/api/trade-local";
const PUMPPORTAL_TRADE_LIGHTNING = "https://pumpportal.fun/api/trade";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const state = {
  bondingComplete: false,
  claimCooldown: 0,
  claimReplay: null,
  cycleCount: 0,
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function parseSecretKey(secretRaw) {
  let secret = String(secretRaw ?? "").trim();
  if (!secret) throw new Error("Wallet secret is empty");
  const forcedFormat = String(process.env.WALLET_SECRET_KEY_FORMAT ?? "").trim().toLowerCase();

  // Railway/UI env editors sometimes wrap JSON values in quotes.
  if (
    (secret.startsWith('"') && secret.endsWith('"')) ||
    (secret.startsWith("'") && secret.endsWith("'"))
  ) {
    secret = secret.slice(1, -1).trim();
  }

  const compact = secret.replace(/\s+/g, "");
  const looksLikeJsonArray =
    compact.startsWith("[") ||
    /^\d+(,\d+)+$/.test(compact) ||
    (/^\[?[\d,\s]+\]?$/.test(secret) && secret.includes(","));

  if (forcedFormat === "json" || looksLikeJsonArray) {
    let arr;
    try {
      const normalized = compact.startsWith("[") ? compact : `[${compact}]`;
      arr = JSON.parse(normalized);
    } catch {
      try {
        // Fallback for double-encoded JSON strings.
        const once = JSON.parse(`"${secret.replace(/"/g, '\\"')}"`);
        const normalized = String(once).replace(/\s+/g, "");
        arr = JSON.parse(normalized.startsWith("[") ? normalized : `[${normalized}]`);
      } catch {
        throw new Error("Invalid wallet secret array JSON format");
      }
    }
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error("Wallet secret array must contain exactly 64 numbers");
    }
    if (!arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error("Wallet secret array must contain bytes (0-255)");
    }
    return Uint8Array.from(arr);
  }

  try {
    const decoded = bs58.decode(secret);
    if (decoded.length !== 64) {
      throw new Error("Wallet secret base58 must decode to exactly 64 bytes");
    }
    return decoded;
  } catch {
    throw new Error(
      "Invalid wallet secret format. Use base58 or JSON byte array like [1,2,3,...]."
    );
  }
}

function parseSolToLamports(solStr) {
  const s = String(solStr).trim();
  if (!s) return 0n;
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "000000000").slice(0, 9);
  const w = BigInt(whole || "0");
  const f = BigInt(fracPadded || "0");
  return w * 1000000000n + f;
}

function lamportsToSolString(lamports) {
  const sign = lamports < 0n ? "-" : "";
  const abs = lamports < 0n ? -lamports : lamports;
  const whole = abs / 1000000000n;
  const frac = abs % 1000000000n;
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return sign + whole.toString() + (fracStr ? `.${fracStr}` : "");
}

function expandPlaceholders(str, env) {
  return str.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => env[key] ?? "");
}

function parseRpcUrls(env) {
  const raw = env.RPC_URLS || env.RPC_URL || "";
  if (!raw) throw new Error("Missing env var: RPC_URLS (or RPC_URL)");
  return raw
    .split(",")
    .map((s) => expandPlaceholders(s.trim(), env))
    .filter((s) => s.length > 0);
}

const logBuffer = [];
const logSubscribers = new Set();
const uiState = {
  wallet: "-",
  mint: "-",
  sol: "-",
  claimed: "-",
  lastAction: "-",
  next: "-",
  solUsd: "SOL: -",
  tokenUsd: "TOKEN: -",
  burned: "-",
  burnValue: "-",
};
const LOG_BRAND = "CTRL - Continuous Token Reduction Loop";

function emitLog(level, text) {
  const line = `${new Date().toLocaleTimeString()} ${text}`;
  logBuffer.push({ level, text: line });
  if (logBuffer.length > 300) logBuffer.shift();
  const payload = JSON.stringify({ type: "log", level, text: line });
  for (const res of logSubscribers) {
    res.write(`data: ${payload}\n\n`);
  }
}

function emitStatus() {
  const payload = JSON.stringify({ type: "status" });
  for (const res of logSubscribers) {
    res.write(`data: ${payload}\n\n`);
  }
}

const log = {
  info: (msg) => {
    const line = `[${LOG_BRAND}] INFO  ${msg}`;
    console.log(line);
    emitLog("info", line);
  },
  ok: (msg) => {
    const line = `[${LOG_BRAND}] OK    ${msg}`;
    console.log(line);
    emitLog("ok", line);
  },
  warn: (msg) => {
    const line = `[${LOG_BRAND}] WARN  ${msg}`;
    console.warn(line);
    emitLog("warn", line);
  },
  err: (msg) => {
    const line = `[${LOG_BRAND}] ERROR ${msg}`;
    console.error(line);
    emitLog("err", line);
  },
  section: (title) => {
    const line = `${LOG_BRAND} :: ${title}\n${"=".repeat(48)}`;
    console.log(`\n${line}`);
    emitLog("info", line);
  },
  price: (src, price, meta) => {
    const line = `📊 Price ${src.padEnd(14)} $${price.toFixed(8)}  ${meta ? `(${meta})` : ""}`;
    console.log(line);
    emitLog("info", line);
  },
  tx: (label, sig) => {
    const line = `🧾 ${label}: ${sig}`;
    console.log(line);
    emitLog("info", line);
  },
  burn: (msg) => {
    const line = `[${LOG_BRAND}] BURN  ${msg}`;
    console.log(line);
    emitLog("ok", line);
  },
};

function redactApiKey(url) {
  if (!url) return url;
  return String(url)
    .replace(/([?&]api-key=)[^&]+/gi, "$1***")
    .replace(/([?&]apikey=)[^&]+/gi, "$1***")
    .replace(/([?&]key=)[^&]+/gi, "$1***");
}

class RpcPool {
  constructor(urls, commitment = "confirmed") {
    if (!urls.length) throw new Error("No RPC URLs configured");
    this.urls = urls;
    this.commitment = commitment;
    this.idx = 0;
    this.connections = urls.map((url) => new Connection(url, commitment));
  }

  current() {
    return this.connections[this.idx];
  }

  currentUrl() {
    return this.urls[this.idx];
  }

  rotate() {
    this.idx = (this.idx + 1) % this.connections.length;
  }

  async withRetry(fn, label) {
    let lastErr;
    for (let i = 0; i < this.connections.length; i += 1) {
      const conn = this.current();
      const url = redactApiKey(this.currentUrl());
      try {
        return await fn(conn);
      } catch (err) {
        const msg = err?.message ?? String(err);
        const noRetry =
          msg.includes("BondingCurveComplete") ||
          msg.includes("custom program error: 0x1775") ||
          msg.includes("Error Code: BondingCurveComplete") ||
          msg.includes("custom program error: 0x1") ||
          msg.includes("insufficient lamports");
        if (noRetry) {
          throw err;
        }
        lastErr = err;
        // Suppress RPC error logs per user request.
        this.rotate();
      }
    }
    throw lastErr;
  }
}

async function rpcRequest(rpcPool, method, params) {
  let lastErr;
  for (let i = 0; i < rpcPool.connections.length; i += 1) {
    const url = rpcPool.currentUrl();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      if (json?.error) {
        throw new Error(json.error.message || "RPC error");
      }
      return json.result;
    } catch (err) {
      lastErr = err;
      // Suppress RPC error logs per user request.
      rpcPool.rotate();
    }
  }
  throw lastErr;
}

async function claimTxHadNoRewards(rpcPool, signature) {
  try {
    const tx = await rpcRequest(rpcPool, "getTransaction", [
      signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
    const logs = Array.isArray(tx?.meta?.logMessages) ? tx.meta.logMessages : [];
    return logs.some(
      (l) =>
        typeof l === "string" &&
        (l.includes("No creator fee to collect") || l.includes("No coin creator fee to collect"))
    );
  } catch {
    return false;
  }
}

async function fetchJson(url, options = {}) {
  const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS ?? "8000");
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

async function sendPumpPortalTx(rpcPool, keypair, body) {
  const res = await fetch(PUMPPORTAL_TRADE_LOCAL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PumpPortal error ${res.status}: ${text}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const tx = VersionedTransaction.deserialize(new Uint8Array(arrayBuffer));
  tx.sign([keypair]);
  const sig = await rpcPool.withRetry(
    (conn) => conn.sendTransaction(tx, { maxRetries: 3 }),
    "sendTransaction"
  );
  await rpcPool.withRetry((conn) => conn.confirmTransaction(sig, "confirmed"), "confirmTransaction");
  return sig;
}

async function sendPumpPortalLightning(apiKey, body) {
  if (!apiKey) throw new Error("Missing PUMPPORTAL_API_KEY for lightning claim");
  const res = await fetch(`${PUMPPORTAL_TRADE_LIGHTNING}?api-key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error(`PumpPortal lightning ${res.status}: ${JSON.stringify(data)}`);
  }
  const sig = data?.signature || data?.txSignature || data?.result;
  if (!sig) {
    throw new Error(`PumpPortal lightning: missing signature ${JSON.stringify(data)}`);
  }
  return sig;
}

async function buildReplayTransaction(rpcPool, signature, newBlockhash) {
  if (state.claimReplay?.sig === signature && state.claimReplay?.rawTx) {
    const tx = VersionedTransaction.deserialize(state.claimReplay.rawTx);
    tx.message.recentBlockhash = newBlockhash;
    tx.signatures = tx.signatures.map(() => Buffer.alloc(64));
    return tx;
  }
  const txResp = await rpcRequest(rpcPool, "getTransaction", [
    signature,
    { encoding: "base64", maxSupportedTransactionVersion: 0 },
  ]);
  const txField = txResp?.transaction;
  const raw = Array.isArray(txField) ? txField[0] : txField;
  if (!raw) {
    throw new Error("Replay claim: transaction not found");
  }
  const rawBuf = Buffer.from(raw, "base64");
  state.claimReplay = { sig: signature, rawTx: rawBuf };
  const tx = VersionedTransaction.deserialize(rawBuf);
  tx.message.recentBlockhash = newBlockhash;
  tx.signatures = tx.signatures.map(() => Buffer.alloc(64));
  return tx;
}

async function buyViaJupiter({
  rpcPool,
  keypair,
  mint,
  inLamports,
  slippagePct,
  jupiterApiKey,
  priorityFeeLamports,
}) {
  const slippageBps = Math.max(1, Math.round(slippagePct * 100));
  const quoteUrl =
    `https://api.jup.ag/swap/v1/quote?` +
    `inputMint=${SOL_MINT}&outputMint=${mint.toBase58()}` +
    `&amount=${inLamports.toString()}` +
    `&slippageBps=${slippageBps}`;

  const quoteResponse = await fetchJson(quoteUrl, {
    headers: buildJupiterHeaders(jupiterApiKey),
  });
  if (!quoteResponse || !quoteResponse.routePlan || quoteResponse.routePlan.length === 0) {
    throw new Error("Jupiter quote returned no route");
  }

  const body = {
    quoteResponse,
    userPublicKey: keypair.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: true,
  };

  if (priorityFeeLamports > 0n) {
    body.prioritizationFeeLamports = {
      priorityLevelWithMaxLamports: {
        maxLamports: Number(priorityFeeLamports),
        priorityLevel: "veryHigh",
      },
    };
  }

  const swapResponse = await fetchJson("https://api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildJupiterHeaders(jupiterApiKey),
    },
    body: JSON.stringify(body),
  });

  if (!swapResponse?.swapTransaction) {
    throw new Error("Jupiter swap returned no transaction");
  }

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapResponse.swapTransaction, "base64")
  );
  tx.sign([keypair]);

  const sig = await rpcPool.withRetry(
    (conn) => conn.sendTransaction(tx, { maxRetries: 3 }),
    "sendTransaction"
  );
  await rpcPool.withRetry((conn) => conn.confirmTransaction(sig, "confirmed"), "confirmTransaction");
  return sig;
}

async function getTokenProgramId(rpcPool, mint) {
  const info = await rpcPool.withRetry(
    (conn) => conn.getAccountInfo(mint, "confirmed"),
    "getAccountInfo"
  );
  if (!info) throw new Error("Mint account not found");
  const owner = info.owner.toBase58();
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function getMintInfo(rpcPool, mint, programId) {
  return await rpcPool.withRetry(
    (conn) => getMint(conn, mint, "confirmed", programId),
    "getMint"
  );
}

async function burnAllTokens({ rpcPool, payer, mint, pricing }) {
  const programId = await getTokenProgramId(rpcPool, mint);
  const ata = await getAssociatedTokenAddress(mint, payer.publicKey, false, programId);
  let account;
  try {
    account = await rpcPool.withRetry(
      (conn) => getAccount(conn, ata, "confirmed", programId),
      "getAccount"
    );
  } catch {
    log.info("No token account to burn.");
    return null;
  }

  if (account.amount === 0n) {
    log.info("Token balance is zero; nothing to burn.");
    return null;
  }

  const mintInfo = await getMintInfo(rpcPool, mint, programId);
  const ix = createBurnCheckedInstruction(
    ata,
    mint,
    payer.publicKey,
    account.amount,
    mintInfo.decimals,
    [],
    programId
  );

  const latest = await rpcPool.withRetry(
    (conn) => conn.getLatestBlockhash("confirmed"),
    "getLatestBlockhash"
  );
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = latest.blockhash;

  const sig = await rpcPool.withRetry(
    (conn) => conn.sendTransaction(tx, [payer], { maxRetries: 3 }),
    "sendTransaction"
  );
  await rpcPool.withRetry((conn) => conn.confirmTransaction(sig, "confirmed"), "confirmTransaction");
  const burnedTokens = Number(account.amount) / 10 ** mintInfo.decimals;
  log.burn(`Burned ${burnedTokens.toLocaleString()} tokens.`);
  if (pricing?.tokenUsd && pricing?.solUsd) {
    const burnedUsd = burnedTokens * pricing.tokenUsd;
    const burnedSol = burnedUsd / pricing.solUsd;
    log.burn(`Burn value: ${formatSol(burnedSol)} (${formatUsd(burnedUsd)}).`);
  }
  log.tx("Burn Tx", sig);
  return { sig, burnedTokens };
}

async function hasTokenAccount(rpcPool, owner, mint, programId) {
  const ata = await getAssociatedTokenAddress(mint, owner, false, programId);
  try {
    await rpcPool.withRetry(
      (conn) => getAccount(conn, ata, "confirmed", programId),
      "getAccount"
    );
    return true;
  } catch {
    return false;
  }
}

async function ensureTokenAccount({ rpcPool, payer, mint, programId }) {
  const ata = await getAssociatedTokenAddress(mint, payer.publicKey, false, programId);
  try {
    await rpcPool.withRetry(
      (conn) => getAccount(conn, ata, "confirmed", programId),
      "getAccount"
    );
    return { ata, created: false, ready: true };
  } catch {
    const ix = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      payer.publicKey,
      mint,
      programId
    );
    try {
      const latest = await rpcPool.withRetry(
        (conn) => conn.getLatestBlockhash("confirmed"),
        "getLatestBlockhash"
      );
      const tx = new Transaction().add(ix);
      tx.feePayer = payer.publicKey;
      tx.recentBlockhash = latest.blockhash;
      const sig = await rpcPool.withRetry(
        (conn) => conn.sendTransaction(tx, [payer], { maxRetries: 3 }),
        "sendTransaction"
      );
      await rpcPool.withRetry((conn) => conn.confirmTransaction(sig, "confirmed"), "confirmTransaction");
      log.ok("Created token account (ATA).");
      log.tx("ATA Create Tx", sig);
      return { ata, created: true, ready: true };
    } catch (err) {
      return { ata: null, created: false, ready: false, error: err?.message ?? String(err) };
    }
  }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function formatUsd(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `$${value.toFixed(6)}`;
}

function formatSol(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${value.toFixed(6)} SOL`;
}

function startUiServer(port) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const indexPath = path.join(__dirname, "..", "public", "index.html");
  const indexHtml = fs.readFileSync(indexPath, "utf8");

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", "http://localhost");
    const pathname = reqUrl.pathname;
    if (pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      logSubscribers.add(res);
      for (const entry of logBuffer) {
        res.write(`data: ${JSON.stringify({ type: "log", level: entry.level, text: entry.text })}\n\n`);
      }
      res.on("close", () => logSubscribers.delete(res));
      return;
    }
    if (pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(uiState));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(indexHtml);
  });

  server.listen(port, () => {
    log.ok(`UI server running on http://localhost:${port}`);
  });
}

function buildJupiterHeaders(apiKey) {
  if (!apiKey) return undefined;
  return { "x-api-key": apiKey };
}

async function getSolUsdFromJupiter(jupiterApiKey) {
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=1000000000&slippageBps=50`;
  const data = await fetchJson(url, { headers: buildJupiterHeaders(jupiterApiKey) });
  const outAmount = Number(data.outAmount ?? 0);
  if (!outAmount) return null;
  return outAmount / 1_000_000;
}

async function getTokenPriceFromJupiter({ mint, decimals, quoteSolLamports, jupiterApiKey }) {
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${mint.toBase58()}&amount=${quoteSolLamports}&slippageBps=50`;
  const data = await fetchJson(url, { headers: buildJupiterHeaders(jupiterApiKey) });
  const outAmountRaw = Number(data.outAmount ?? 0);
  if (!outAmountRaw) return null;
  const outTokens = outAmountRaw / 10 ** decimals;
  const inSol = Number(quoteSolLamports) / 1_000_000_000;
  if (!outTokens || !inSol) return null;
  const solPerToken = inSol / outTokens;
  return solPerToken;
}

async function hasJupiterRoute({ mint, quoteSolLamports, jupiterApiKey }) {
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${mint.toBase58()}&amount=${quoteSolLamports}&slippageBps=50`;
  const data = await fetchJson(url, { headers: buildJupiterHeaders(jupiterApiKey) });
  return Number(data.outAmount ?? 0) > 0;
}

async function getTokenPriceFromDexScreener(mint) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${mint.toBase58()}`;
  const data = await fetchJson(url);
  const pairs = Array.isArray(data.pairs) ? data.pairs : [];
  const solPairs = pairs.filter((p) => p.chainId === "solana");
  if (!solPairs.length) return null;
  solPairs.sort((a, b) => {
    const aLiq = Number(a?.liquidity?.usd ?? 0);
    const bLiq = Number(b?.liquidity?.usd ?? 0);
    return bLiq - aLiq;
  });
  const priceUsd = Number(solPairs[0]?.priceUsd ?? 0);
  if (!priceUsd) return null;
  return priceUsd;
}

async function getTokenPriceFromBirdeye(mint, apiKey) {
  if (!apiKey) return null;
  const url = `https://public-api.birdeye.so/defi/price?address=${mint.toBase58()}`;
  const data = await fetchJson(url, {
    headers: { "X-API-KEY": apiKey },
  });
  const value = Number(data?.data?.value ?? 0);
  if (!value) return null;
  return value;
}

async function collectPriceSignals({ mint, decimals, quoteSolLamports, birdeyeApiKey, jupiterApiKey }) {
  const results = [];

  let solUsd = null;
  try {
    solUsd = await getSolUsdFromJupiter(jupiterApiKey);
    if (solUsd) results.push({ source: "jupiter-sol-usd", priceUsd: solUsd, meta: "SOL" });
  } catch (err) {
    log.warn(`Price: Jupiter SOL/USD failed: ${err.message}`);
  }

  try {
    const solPerToken = await getTokenPriceFromJupiter({ mint, decimals, quoteSolLamports, jupiterApiKey });
    if (solPerToken && solUsd) {
      const tokenUsd = solPerToken * solUsd;
      results.push({ source: "jupiter-token", priceUsd: tokenUsd, meta: "SOL route" });
    }
  } catch (err) {
    log.warn(`Price: Jupiter token quote failed: ${err.message}`);
  }

  try {
    const tokenUsd = await getTokenPriceFromDexScreener(mint);
    if (tokenUsd) results.push({ source: "dexscreener", priceUsd: tokenUsd, meta: "USD" });
  } catch (err) {
    log.warn(`Price: DexScreener failed: ${err.message}`);
  }

  try {
    const tokenUsd = await getTokenPriceFromBirdeye(mint, birdeyeApiKey);
    if (tokenUsd) results.push({ source: "birdeye", priceUsd: tokenUsd, meta: "USD" });
  } catch (err) {
    log.warn(`Price: Birdeye failed: ${err.message}`);
  }

  return results;
}

function evaluatePriceGuard(prices, guardMode, maxDeviationPct) {
  if (guardMode === "off") return { ok: true, reason: "guard off" };
  if (prices.length === 0) {
    if (guardMode === "on") return { ok: false, reason: "no price sources" };
    return { ok: true, reason: "no price sources" };
  }
  if (prices.length === 1) {
    if (guardMode === "on") return { ok: false, reason: "only one price source" };
    return { ok: true, reason: "single price source" };
  }

  const values = prices.map((p) => p.priceUsd);
  const med = median(values);
  if (!med) return { ok: false, reason: "median failed" };

  const maxDev = maxDeviationPct;
  const bad = prices.filter((p) => Math.abs((p.priceUsd - med) / med) * 100 > maxDev);
  if (bad.length) {
    return { ok: false, reason: `price deviation > ${maxDev}%` };
  }

  return { ok: true, reason: "price consensus" };
}

async function runOnce(config) {
  try {
  const {
    rpcPool,
    keypair,
    mint,
    slippage,
    priorityFee,
    pool,
    claimPool,
    buyRoute,
    minSolKeep,
    buyFeeBuffer,
    minSolRequired,
    claimFeeBuffer,
    minBuySol,
    claimMinSol,
    claimCooldownCycles,
    claimMethod,
    claimRefSig,
    claimTreasuryAddress,
    claimTreasuryBps,
    pumpPortalApiKey,
    priceGuardMode,
    maxPriceDeviationPct,
    quoteSolLamports,
    birdeyeApiKey,
    jupiterApiKey,
  } = config;
  state.cycleCount += 1;
  const cycleId = state.cycleCount;

  const balanceBefore = BigInt(
    await rpcPool.withRetry((conn) => conn.getBalance(keypair.publicKey, "confirmed"), "getBalance")
  );
  log.section("CTRL CYCLE");
  log.info("CTRL cycle start.");
  log.info(`CYCLE #${cycleId} PRE-FLIGHT CHECK COMPLETE. BURN ENGINE ARMED.`);
  log.info(`SOL before claim: ${lamportsToSolString(balanceBefore)}`);
  log.info(`Buy route: ${buyRoute}${state.bondingComplete ? " (bonded)" : ""}`);
  uiState.sol = lamportsToSolString(balanceBefore);
  uiState.lastAction = "Cycle start";
  emitStatus();

  if (balanceBefore < claimMinSol) {
    log.warn(
      `Skipping claim: balance ${lamportsToSolString(balanceBefore)} below claim minimum ${claimMinSol} SOL.`
    );
  } else {
    if (state.claimCooldown > 0) {
      log.warn(`Skipping claim: cooldown ${state.claimCooldown} cycles remaining.`);
    } else {
    try {
      let claimedSig = null;
      const resolvedClaimMethod =
        claimMethod === "auto"
          ? claimRefSig
            ? "replay"
            : pumpPortalApiKey
              ? "lightning"
              : "local"
          : claimMethod;
      const replayPool = claimPool === "multi" ? pool : claimPool;
      const claimPools =
        resolvedClaimMethod === "replay"
          ? [replayPool ?? pool].filter(Boolean)
          : claimPool === "multi"
            ? ["pump", "pump-amm", "auto", "raydium-cpmm", "raydium"]
            : claimPool === "pump"
              ? ["pump", "pump-amm", "auto", "raydium-cpmm", "raydium"]
              : [claimPool ?? pool].filter(Boolean);
      for (const p of claimPools) {
        try {
          const claimPriorityFees = [priorityFee];
          if (priorityFee <= 0) {
            claimPriorityFees.push(0.00001, 0.00005);
          }
          for (const claimPriority of claimPriorityFees) {
            try {
              const baseClaimBody = {
                publicKey: keypair.publicKey.toBase58(),
                action: "collectCreatorFee",
                priorityFee: claimPriority,
              };
              const claimBodies =
                p === "pump"
                  ? [baseClaimBody, { ...baseClaimBody, pool: p }]
                  : [{ ...baseClaimBody, pool: p }, { ...baseClaimBody, pool: p, mint: mint.toBase58() }];

              let sig = null;
              for (const claimBody of claimBodies) {
                if (resolvedClaimMethod === "replay") {
                  const latest = await rpcPool.withRetry(
                    (conn) => conn.getLatestBlockhash("confirmed"),
                    "getLatestBlockhash"
                  );
                  const tx = await buildReplayTransaction(rpcPool, claimRefSig, latest.blockhash);
                  tx.sign([keypair]);
                  sig = await rpcPool.withRetry(
                    (conn) => conn.sendTransaction(tx, { maxRetries: 3 }),
                    "sendTransaction"
                  );
                  await rpcPool.withRetry((conn) => conn.confirmTransaction(sig, "confirmed"), "confirmTransaction");
                } else if (resolvedClaimMethod === "lightning") {
                  sig = await sendPumpPortalLightning(pumpPortalApiKey, claimBody);
                } else {
                  sig = await sendPumpPortalTx(rpcPool, keypair, claimBody);
                }
                if (!sig) continue;
                const noRewards = await claimTxHadNoRewards(rpcPool, sig);
                if (noRewards) {
                  sig = null;
                  continue;
                }
                break;
              }
              if (!sig) continue;
              claimedSig = sig;
              log.ok(`Claimed creator fees (pool=${p}, method=${resolvedClaimMethod}).`);
              log.tx("Claim Tx", sig);
              uiState.lastAction = "Claimed";
              break;
            } catch (err) {
              const lastPriority = claimPriority === claimPriorityFees[claimPriorityFees.length - 1];
              if (lastPriority) {
                log.warn(`Claim attempt failed (pool=${p}): ${err.message}`);
              }
            }
          }
          if (claimedSig) break;
        } catch (err) {
          log.warn(`Claim attempt failed (pool=${p}): ${err.message}`);
        }
      }
      if (!claimedSig) {
        log.err("Claim failed on all pools.");
      }
    } catch (err) {
      log.err(`Claim failed: ${err.message}`);
    }
    }
  }

  let balanceAfter = BigInt(
    await rpcPool.withRetry((conn) => conn.getBalance(keypair.publicKey, "confirmed"), "getBalance")
  );
  const claimed = balanceAfter - balanceBefore;
  log.info(`SOL after claim: ${lamportsToSolString(balanceAfter)} (claimed ${lamportsToSolString(claimed)})`);
  uiState.sol = lamportsToSolString(balanceAfter);
  uiState.claimed = lamportsToSolString(claimed);
  emitStatus();
  if (claimed > 0n && claimTreasuryAddress && claimTreasuryBps > 0) {
    try {
      const treasuryLamports = (claimed * BigInt(claimTreasuryBps)) / 10000n;
      if (treasuryLamports > 0n) {
        const treasuryPk = new PublicKey(claimTreasuryAddress);
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: treasuryPk,
            lamports: treasuryLamports,
          })
        );
        const treasurySig = await rpcPool.withRetry(
          (conn) => conn.sendTransaction(tx, [keypair], { maxRetries: 3 }),
          "treasuryTransfer"
        );
        await rpcPool.withRetry(
          (conn) => conn.confirmTransaction(treasurySig, "confirmed"),
          "confirmTreasuryTransfer"
        );
        balanceAfter -= treasuryLamports;
        uiState.sol = lamportsToSolString(balanceAfter);
        emitStatus();
      }
    } catch {
      // treasury transfer remains silent by request
    }
  }
  if (claimed <= 0n) {
    state.claimCooldown = claimCooldownCycles;
  } else {
    state.claimCooldown = 0;
  }

  const claimedSol = Number(claimed) / 1_000_000_000;

  // Burn any existing tokens before attempting a buy
  try {
    await burnAllTokens({ rpcPool, payer: keypair, mint });
  } catch (err) {
    log.err(`Burn (pre-buy) failed: ${err.message}`);
  }

  let programId = null;
  let mintDecimals = null;
  let mintSupply = null;
  try {
    programId = await getTokenProgramId(rpcPool, mint);
    const mintInfo = await getMintInfo(rpcPool, mint, programId);
    mintDecimals = mintInfo.decimals;
    mintSupply = mintInfo.supply;
  } catch (err) {
    log.warn(`Mint decimals fetch failed: ${err.message}`);
  }

  let ataReady = true;
  let rentLamports = 0n;
  if (programId) {
    const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false, programId);
    let ataExists = false;
    try {
      await rpcPool.withRetry(
        (conn) => getAccount(conn, ata, "confirmed", programId),
        "getAccount"
      );
      ataExists = true;
    } catch {
      ataExists = false;
    }

    if (!ataExists) {
      const rent = await rpcPool.withRetry(
        (conn) => conn.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
        "getMinimumBalanceForRentExemption"
      );
      rentLamports = BigInt(rent);
      const needed = rentLamports + minSolKeep + buyFeeBuffer;
      if (balanceAfter < needed) {
        ataReady = false;
        log.warn(
          `ATA rent not covered. Need ${lamportsToSolString(needed)} SOL, have ${lamportsToSolString(balanceAfter)}.`
        );
      } else {
        const ataStatus = await ensureTokenAccount({ rpcPool, payer: keypair, mint, programId });
        if (!ataStatus?.ready) {
          ataReady = false;
          if (ataStatus?.error) {
            log.warn(`ATA create/check failed: ${ataStatus.error}`);
          }
        } else {
          const refreshed = await rpcPool.withRetry(
            (conn) => conn.getBalance(keypair.publicKey, "confirmed"),
            "getBalance"
          );
          balanceAfter = BigInt(refreshed);
        }
      }
    }
  }

    const priceSignals = mintDecimals !== null
    ? await collectPriceSignals({
        mint,
        decimals: mintDecimals,
        quoteSolLamports,
        birdeyeApiKey,
        jupiterApiKey,
      })
    : [];

  if (mintSupply !== null && mintDecimals !== null) {
    const supplyUi = Number(mintSupply) / 10 ** mintDecimals;
    log.info(`Tokens remaining (supply): ${supplyUi.toLocaleString()} (mint ${mint.toBase58()})`);
  }

  let solUsd = null;
  let tokenUsd = null;
  if (priceSignals.length) {
    log.info("Price signals:");
    for (const p of priceSignals) {
      log.price(p.source, p.priceUsd, p.meta);
    }
    const solEntry = priceSignals.find((p) => p.source === "jupiter-sol-usd");
    solUsd = solEntry ? solEntry.priceUsd : null;
    const tokenPrices = priceSignals
      .filter((p) => p.source !== "jupiter-sol-usd")
      .map((p) => p.priceUsd);
    tokenUsd = median(tokenPrices);
  } else {
    log.info("Price signals: none available.");
  }

  if (buyRoute === "auto") {
    try {
      const routeExists = await hasJupiterRoute({
        mint,
        quoteSolLamports,
        jupiterApiKey,
      });
      state.bondingComplete = routeExists;
    } catch (err) {
      log.warn(`Bonded check failed: ${err.message}`);
    }
  }

  if (solUsd !== null) {
    const claimedUsd = claimedSol * solUsd;
    log.info(`Claimed rewards: ${formatSol(claimedSol)} (${formatUsd(claimedUsd)})`);
    log.info(`CYCLE #${cycleId} CLAIM EXECUTED +${claimedSol.toFixed(2)} SOL (${claimedUsd.toFixed(2)} USD).`);
    uiState.claimed = `${formatSol(claimedSol)} (${formatUsd(claimedUsd)})`;
    uiState.solUsd = `SOL: ${formatUsd(solUsd)}`;
  } else {
    log.info(`Claimed rewards: ${formatSol(claimedSol)} (USD n/a)`);
    log.info(`CYCLE #${cycleId} CLAIM EXECUTED +${claimedSol.toFixed(2)} SOL (USD N/A).`);
    uiState.claimed = `${formatSol(claimedSol)} (USD n/a)`;
  }
  if (tokenUsd !== null) {
    uiState.tokenUsd = `TOKEN: ${formatUsd(tokenUsd)}`;
  }
  emitStatus();

  const guard = evaluatePriceGuard(priceSignals, priceGuardMode, maxPriceDeviationPct);
  if (!guard.ok) {
    log.warn(`Price guard blocked buy: ${guard.reason}`);
  }

  if (guard.ok) {
    if (!ataReady) {
      log.warn("Token account not ready (rent/fees). Skipping buy this cycle.");
      return;
    }
    const reserveLamports = minSolKeep + buyFeeBuffer;
    const maxSpendable = balanceAfter - reserveLamports;
    let spendLamports = maxSpendable;
    if (spendLamports < 0n) spendLamports = 0n;
    log.info(
      `CYCLE #${cycleId} BUY ROUTE LOCKED. DEPLOYING ${lamportsToSolString(spendLamports)} SOL.`
    );
    const minBuyLamports = parseSolToLamports(String(minBuySol));

    if (spendLamports >= minBuyLamports && spendLamports > 0n) {
      let attemptLamports = spendLamports;
      const backoffSteps = [
        0n,
        200000n,  // 0.0002 SOL
        500000n,  // 0.0005 SOL
        1000000n, // 0.001 SOL
        2000000n, // 0.002 SOL
      ];
      let warnedBonding = false;
      let success = false;
      for (let i = 0; i < backoffSteps.length; i += 1) {
        const reduceBy = backoffSteps[i];
        const adjusted = attemptLamports - reduceBy;
        if (adjusted <= 0n) continue;
        const amountSol = lamportsToSolString(adjusted);
        try {
          let sig;
          const useJupiter = buyRoute === "jupiter" || (buyRoute === "auto" && state.bondingComplete);
          if (useJupiter) {
            sig = await buyViaJupiter({
              rpcPool,
              keypair,
              mint,
              inLamports: adjusted,
              slippagePct: slippage,
              jupiterApiKey,
              priorityFeeLamports: parseSolToLamports(String(priorityFee)),
            });
            const buySol = Number(adjusted) / 1_000_000_000;
            const buyUsd = solUsd !== null ? buySol * solUsd : null;
            log.ok(`Bought ${formatSol(buySol)} (${formatUsd(buyUsd)}) via Jupiter.`);
            log.tx("Jupiter Tx", sig);
            log.info(`CYCLE #${cycleId} BUY CONFIRMED. INVENTORY FILLED. PREPARING BURN PIPELINE.`);
            uiState.lastAction = "Bought";
          } else {
            sig = await sendPumpPortalTx(rpcPool, keypair, {
              publicKey: keypair.publicKey.toBase58(),
              action: "buy",
              mint: mint.toBase58(),
              denominatedInSol: "true",
              amount: amountSol,
              slippage,
              priorityFee,
              pool,
            });
            const buySol = Number(adjusted) / 1_000_000_000;
            const buyUsd = solUsd !== null ? buySol * solUsd : null;
            log.ok(`Bought ${formatSol(buySol)} (${formatUsd(buyUsd)}) via Pump.`);
            log.tx("Pump Tx", sig);
            log.info(`CYCLE #${cycleId} BUY CONFIRMED. INVENTORY FILLED. PREPARING BURN PIPELINE.`);
            uiState.lastAction = "Bought";
          }
          success = true;
          break;
        } catch (err) {
          const msg = err.message ?? String(err);
          const isPumpBadRequest = msg.includes("PumpPortal error 400");
          const isBondingComplete =
            msg.includes("BondingCurveComplete") ||
            msg.includes("custom program error: 0x1775") ||
            msg.includes("Error Code: BondingCurveComplete");
          if (isBondingComplete) {
            state.bondingComplete = true;
            if (buyRoute === "pump") {
              if (!warnedBonding) {
                log.warn("Bonding curve complete. Pump buy disabled by config.");
                warnedBonding = true;
              }
              break;
            }
            if (!warnedBonding) {
              log.warn("Bonding curve complete. Switching to Jupiter buy.");
              warnedBonding = true;
            }
            continue;
          }
          if (isPumpBadRequest) {
            if (buyRoute !== "pump") {
              state.bondingComplete = true;
              if (!warnedBonding) {
                log.warn("Pump buy rejected. Switching to Jupiter buy.");
                warnedBonding = true;
              }
              continue;
            }
          }
          if (msg.includes("Jupiter")) {
            log.warn(`Jupiter buy failed: ${msg}`);
          }
          const noRoute =
            msg.includes("no route") ||
            msg.includes("Jupiter quote returned no route") ||
            msg.includes("Jupiter swap returned no transaction");
          if (noRoute) {
            log.warn("No Jupiter route for this amount. Skipping buy this cycle.");
            break;
          }
          const isInsufficient =
            msg.includes("insufficient") ||
            msg.includes("Transaction results in an account") ||
            msg.includes("custom program error: 0x1");
          if (isInsufficient) {
            log.warn("Buy failed (insufficient funds). Skipping buy this cycle.");
            break;
          }
          log.err(`Buy failed: ${msg}`);
          break;
        }
      }
      if (!success) {
        log.info("Buy did not succeed after retries.");
      }
    } else {
      if (spendLamports < minBuyLamports) {
        log.info(
          `Spendable SOL ${lamportsToSolString(spendLamports)} is below minimum buy ${minBuySol} SOL. Skipping buy.`
        );
      }
      log.info(
        `Not enough SOL to buy after reserve. Balance ${lamportsToSolString(balanceAfter)}, reserve ${lamportsToSolString(minSolKeep)}, buffer ${lamportsToSolString(buyFeeBuffer)}.`
      );
    }
  } else {
    log.info("Price guard blocked buy; skipping.");
  }

  try {
    log.info(`CYCLE #${cycleId} BURN PREP COMPLETE. STAGING TOKENS.`);
    const burnResult = await burnAllTokens({
      rpcPool,
      payer: keypair,
      mint,
      pricing: { tokenUsd, solUsd },
    });
    if (burnResult?.burnedTokens !== undefined) {
      uiState.burned = `${burnResult.burnedTokens.toLocaleString()} tokens`;
      if (tokenUsd !== null && solUsd !== null) {
        const burnedUsd = burnResult.burnedTokens * tokenUsd;
        const burnedSol = burnedUsd / solUsd;
        uiState.burnValue = `${formatSol(burnedSol)} (${formatUsd(burnedUsd)})`;
      }
      log.info(`CYCLE #${cycleId} BURN TX SUBMITTED. SUPPLY REDUCTION IN FLIGHT.`);
      log.info(
        `CYCLE #${cycleId} BURN CONFIRMED. ${Math.round(burnResult.burnedTokens).toLocaleString()} TOKENS REMOVED FROM CIRCULATION.`
      );
      uiState.lastAction = "Burned";
    }
    emitStatus();
  } catch (err) {
    log.err(`Burn (post-buy) failed: ${err.message}`);
  }
  } catch (err) {
    log.err(`Cycle failed: ${err.message ?? String(err)}`);
  }
}

async function main() {
  process.on("unhandledRejection", (reason) => {
    const msg = reason?.message ?? String(reason);
    log.err(`Unhandled rejection: ${msg}`);
  });
  process.on("uncaughtException", (err) => {
    const msg = err?.message ?? String(err);
    log.err(`Uncaught exception: ${msg}`);
  });

  const rpcUrls = parseRpcUrls(process.env);
  const secret = requireEnv("WALLET_SECRET_KEY_BASE58");
  const mintStr = requireEnv("MINT");

  const slippage = Number(process.env.SLIPPAGE ?? "1");
  const priorityFee = Number(process.env.PRIORITY_FEE ?? "0.0001");
  const pool = process.env.POOL ?? "pump";
  const claimPool = process.env.CLAIM_POOL ?? null;
  const claimMethod = (process.env.CLAIM_METHOD ?? "auto").toLowerCase();
  const claimRefSig = process.env.CLAIM_REF_SIG ?? "";
  const claimTreasuryAddress = process.env.CLAIM_TREASURY_ADDRESS ?? "";
  const claimTreasuryBps = Number(process.env.CLAIM_TREASURY_BPS ?? "0");
  const pumpPortalApiKey = process.env.PUMPPORTAL_API_KEY ?? "";
  const buyRoute = (process.env.BUY_ROUTE ?? "auto").toLowerCase();
  const intervalMs = Number(process.env.INTERVAL_MS ?? "180000");
  const uiEnable = (process.env.UI_ENABLE ?? "1") !== "0";
  const uiPort = Number(process.env.UI_PORT ?? "8787");
  const minSolKeep = parseSolToLamports(process.env.MIN_SOL_KEEP ?? "0");
  const buyFeeBuffer = parseSolToLamports(process.env.BUY_SOL_FEE_BUFFER ?? "0");
  const minSolRequired = parseSolToLamports(process.env.MIN_SOL_REQUIRED ?? "0");
  const effectiveMinKeep = minSolKeep;
  const effectiveMinRequired = minSolRequired;
  const claimFeeBuffer = parseSolToLamports(process.env.CLAIM_FEE_BUFFER ?? "0.00001");
  const claimMinSol = Number(process.env.CLAIM_MIN_SOL ?? "0");
  const claimCooldownCycles = Number(process.env.CLAIM_COOLDOWN_CYCLES ?? "3");
  const minBuySol = Number(process.env.MIN_BUY_SOL ?? "0.0005");
  const priceGuardMode = (process.env.PRICE_GUARD_MODE ?? "auto").toLowerCase();
  const maxPriceDeviationPct = Number(process.env.MAX_PRICE_DEVIATION_PCT ?? "15");
  const quoteSolLamports = Number(process.env.PRICE_QUOTE_SOL_LAMPORTS ?? "100000000");
  const birdeyeApiKey = process.env.BIRDEYE_API_KEY ?? "";
  const jupiterApiKey = process.env.JUPITER_API_KEY ?? "";

  const keypair = Keypair.fromSecretKey(parseSecretKey(secret));
  const mint = new PublicKey(mintStr);
  const rpcPool = new RpcPool(rpcUrls, "confirmed");
  log.section("CTRL - Continuous Token Reduction Loop");
  log.info("CTRL runtime initialized.");
  log.info(`Wallet: ${keypair.publicKey.toBase58()}`);
  log.info(`Mint: ${mint.toBase58()}`);
  log.info(`RPCs: ${rpcUrls.length} (active ${redactApiKey(rpcPool.currentUrl())})`);
  log.info(`Interval: ${intervalMs}ms`);
  log.info(`Buy route: ${buyRoute}`);
  uiState.wallet = keypair.publicKey.toBase58();
  uiState.mint = mint.toBase58();
  emitStatus();

  if (uiEnable) {
    startUiServer(uiPort);
  }

  try {
    await runOnce({
      rpcPool,
      keypair,
      mint,
    slippage,
    priorityFee,
    pool,
    claimPool,
    claimMethod,
    claimRefSig,
    claimTreasuryAddress,
    claimTreasuryBps,
    pumpPortalApiKey,
    buyRoute,
    minSolKeep: effectiveMinKeep,
    buyFeeBuffer,
    minSolRequired: effectiveMinRequired,
    claimFeeBuffer,
    minBuySol,
    claimMinSol,
    claimCooldownCycles,
    priceGuardMode,
    maxPriceDeviationPct,
    quoteSolLamports,
    birdeyeApiKey,
    jupiterApiKey,
  });
  } catch (err) {
    log.err(`Initial run failed: ${err.message ?? String(err)}`);
  }

  while (true) {
    const nextAt = new Date(Date.now() + intervalMs);
    log.info(`CYCLE #${state.cycleCount} COOLDOWN LIVE. WAIT ${Math.round(intervalMs / 1000)} (NICE..) SECONDS. NEXT STRIKE QUEUED.`);
    log.info(`Next burn in ${Math.round(intervalMs / 1000)}s at ${nextAt.toLocaleTimeString()}.`);
    uiState.next = nextAt.toLocaleTimeString();
    emitStatus();
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      await runOnce({
        rpcPool,
        keypair,
        mint,
        slippage,
        priorityFee,
      pool,
      claimPool,
      claimMethod,
      claimRefSig,
      claimTreasuryAddress,
      claimTreasuryBps,
      pumpPortalApiKey,
      buyRoute,
        minSolKeep: effectiveMinKeep,
        buyFeeBuffer,
        minSolRequired: effectiveMinRequired,
        claimFeeBuffer,
        minBuySol,
        claimMinSol,
        claimCooldownCycles,
        priceGuardMode,
        maxPriceDeviationPct,
        quoteSolLamports,
        birdeyeApiKey,
        jupiterApiKey,
      });
    } catch (err) {
      log.err(`Run failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  log.err(err.message ?? String(err));
  process.exit(1);
});
