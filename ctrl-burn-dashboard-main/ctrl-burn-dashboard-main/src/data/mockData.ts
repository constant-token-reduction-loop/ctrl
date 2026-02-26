export type CtrlStatus = "WAITING" | "EXECUTING_BUY" | "BURNING" | "CONFIRMED" | "ERROR";

export interface TerminalEvent {
  timestamp: string | number;
  type: "info" | "reward" | "buy" | "burn" | "confirm" | "error";
  message: string;
  txUrl?: string;
  amount?: string | number;
}

export interface CtrlData {
  tokensBurned: { total: number | string };
  solBurned: { total: number | string };
  usdSpent: { total: number | string };
  cycles: { total: number };
  avgBurnPerCycle: number | string;
  nextBurn: { remainingSeconds: number; progress01: number };
  status: CtrlStatus;
  rewards: {
    walletBalanceSol: number | string;
    walletBalanceUsd: number | string;
    totalClaimedSol: number | string;
    totalClaimedUsd: number | string;
  };
  supply: { percentBurned: number };
  holders: { total: number | string };
  lastBurn: {
    amountTokens: number | string;
    buyTx: string;
    burnTx: string;
    timestamp: string | number;
    solscanBuyUrl: string;
    solscanBurnUrl: string;
  };
  wallets: {
    burnWalletAddress: string;
    burnWalletSolscanUrl: string;
    contractAddress: string;
    contractSolscanUrl: string;
  };
  uptime: { percent: number };
  terminal: { events: TerminalEvent[] };
}

export interface CtrlSnapshotResponse {
  ctrl: CtrlData;
  serverTime: string;
  cycleSeconds: number;
  tokenMint?: string;
}

const now = Date.now();

export const MOCK_DATA: CtrlData = {
  tokensBurned: { total: 128456789000 },
  solBurned: { total: 5432.17 },
  usdSpent: { total: 720580 },
  cycles: { total: 420 },
  avgBurnPerCycle: 306000,
  nextBurn: { remainingSeconds: 42, progress01: 0.39 },
  status: "WAITING",
  rewards: {
    walletBalanceSol: 1.24,
    walletBalanceUsd: 189.34,
    totalClaimedSol: 12345.67,
    totalClaimedUsd: 1650000,
  },
  supply: { percentBurned: 8.88 },
  holders: { total: 12456 },
  lastBurn: {
    amountTokens: 306200000,
    buyTx: "5Uy8xQ3r",
    burnTx: "9Kp2mW7z",
    timestamp: now - 120000,
    solscanBuyUrl: "https://solscan.io/tx/5Uy8xQ3r",
    solscanBurnUrl: "https://solscan.io/tx/9Kp2mW7z",
  },
  wallets: {
    burnWalletAddress: "DevBurnWallet12345xyz",
    burnWalletSolscanUrl: "https://solscan.io/account/DevBurnWallet12345xyz",
    contractAddress: "DevContractAddress12345xyz",
    contractSolscanUrl: "https://solscan.io/account/DevContractAddress12345xyz",
  },
  uptime: { percent: 99.8 },
  terminal: {
    events: [
      { timestamp: now - 240000, type: "reward", message: "?? REWARD RECEIVED: +4.20 SOL", amount: "4.20" },
      { timestamp: now - 230000, type: "buy", message: "?? EXECUTING BUY…" },
      { timestamp: now - 220000, type: "burn", message: "?? SENDING TO BURN WALLET…" },
      { timestamp: now - 210000, type: "confirm", message: "? BURN CONFIRMED", txUrl: "https://solscan.io/tx/9Kp2mW7z" },
    ],
  },
};
