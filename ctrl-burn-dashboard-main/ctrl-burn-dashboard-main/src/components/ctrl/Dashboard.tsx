import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { CtrlData, TerminalEvent } from "@/data/mockData";
import plugCordPng from "@/assets/plug-cord.png";
import pumpfunLogoPng from "@/assets/pumpfun-logo.png";
import ctrlLogoPng from "@/assets/ctrl-logo-3200x900.png";
import { Flame, Github } from "lucide-react";

interface DashboardProps {
  streamMode?: boolean;
  data: CtrlData;
  isGlitching: boolean;
  isCtrlPressed: boolean;
  topBurnEvents?: Array<{ ts: number; amount: number; txUrl?: string }>;
}

interface TopBurn {
  id: string;
  amount: number;
  timestamp: string | number;
  txUrl?: string;
}

interface Sparkle {
  id: string;
  left: number;
  top: number;
  size: number;
  opacity: number;
  lifeMs: number;
  bornAt: number;
}

interface MockCycleMetrics {
  cycle: number;
  claimSol: number;
  claimUsd: number;
  buySol: number;
  buyUsd: number;
  burnTokens: number;
}

const PLUG_POSITION_STORAGE_KEY = "ctrl.dashboard.plugPosition.v2";
const DEFAULT_PLUG_POSITION = { left: 302, bottom: 138 };
const ENABLE_PLUG_CALIBRATION = false;

const TOP_BURNS_STORAGE_KEY = "ctrl.dashboard.topBurns.v3";
const TOP_BURNS_LIMIT = 5;
const TOP_BURNS_POSITION_STORAGE_KEY = "ctrl.dashboard.topBurnsPosition.v2";
const DEFAULT_TOP_BURNS_POSITION = { left: 122, top: 158 };
const ENABLE_TOP_BURNS_CALIBRATION = false;
const GITHUB_URL = import.meta.env.VITE_GITHUB_URL ?? "https://github.com";
const PUMPFUN_URL = import.meta.env.VITE_PUMPFUN_URL ?? "https://pump.fun";
const X_URL = import.meta.env.VITE_X_URL ?? "https://x.com";
const SATOSHEH_X_URL = import.meta.env.VITE_SATOSHEH_X_URL ?? X_URL;

const CYCLE_SECONDS = 69;
const CYCLE_MS = CYCLE_SECONDS * 1000;
const TYPING_SPEED_MS = 44;
const MOCK_CYCLE_LOOKBACK = 2;
const TERMINAL_LOG_LIMIT = 50;
const BURN_EXECUTE_SECOND = 43;
type MockStageKey =
  | "preflight"
  | "claim"
  | "buy_route"
  | "buy_confirm"
  | "burn_prep"
  | "burn_submit"
  | "burn_confirm"
  | "cooldown";

const KEYBOARD_ROWS: Array<Array<{ label: string; span: number }>> = [
  [
    { label: "ESC", span: 2 }, { label: "1", span: 2 }, { label: "2", span: 2 }, { label: "3", span: 2 },
    { label: "4", span: 2 }, { label: "5", span: 2 }, { label: "6", span: 2 }, { label: "7", span: 2 },
    { label: "8", span: 2 }, { label: "9", span: 2 }, { label: "0", span: 2 }, { label: "-", span: 2 },
    { label: "=", span: 2 }, { label: "\\", span: 2 }, { label: "DEL", span: 2 },
  ],
  [
    { label: "TAB", span: 3 }, { label: "Q", span: 2 }, { label: "W", span: 2 }, { label: "E", span: 2 },
    { label: "R", span: 2 }, { label: "T", span: 2 }, { label: "Y", span: 2 }, { label: "U", span: 2 },
    { label: "I", span: 2 }, { label: "O", span: 2 }, { label: "P", span: 2 }, { label: "[", span: 2 },
    { label: "]", span: 2 }, { label: "BKSP", span: 3 },
  ],
  [
    { label: "CAPS", span: 4 }, { label: "A", span: 2 }, { label: "S", span: 2 }, { label: "D", span: 2 },
    { label: "F", span: 2 }, { label: "G", span: 2 }, { label: "H", span: 2 }, { label: "J", span: 2 },
    { label: "K", span: 2 }, { label: "L", span: 2 }, { label: ";", span: 2 }, { label: "'", span: 2 },
    { label: "ENTER", span: 4 },
  ],
  [
    { label: "SHIFT", span: 4 }, { label: "Z", span: 2 }, { label: "X", span: 2 }, { label: "C", span: 2 },
    { label: "V", span: 2 }, { label: "B", span: 2 }, { label: "N", span: 2 }, { label: "M", span: 2 },
    { label: ",", span: 2 }, { label: ".", span: 2 }, { label: "/", span: 2 }, { label: "SHIFT", span: 6 },
  ],
  [
    { label: "CTRL", span: 3 }, { label: "WIN", span: 2 }, { label: "ALT", span: 3 }, { label: "SPACE", span: 12 },
    { label: "ALT", span: 3 }, { label: "FN", span: 3 }, { label: "MENU", span: 2 }, { label: "CTRL", span: 2 },
  ],
];

const MOCK_LOG_STAGES: Array<{
  key: MockStageKey;
  second: number;
  type: TerminalEvent["type"];
  txSuffix?: string;
  message: (metrics: MockCycleMetrics) => string;
}> = [
  {
    key: "preflight",
    second: 2,
    type: "info",
    message: (m) => buildMockStageMessage("preflight", m),
  },
  {
    key: "claim",
    second: 8,
    type: "reward",
    message: (m) => buildMockStageMessage("claim", m),
  },
  {
    key: "buy_route",
    second: 16,
    type: "buy",
    message: (m) => buildMockStageMessage("buy_route", m),
  },
  {
    key: "buy_confirm",
    second: 24,
    type: "buy",
    txSuffix: "buy",
    message: (m) => buildMockStageMessage("buy_confirm", m),
  },
  {
    key: "burn_prep",
    second: 34,
    type: "burn",
    message: (m) => buildMockStageMessage("burn_prep", m),
  },
  {
    key: "burn_submit",
    second: 43,
    type: "burn",
    txSuffix: "burn",
    message: (m) => buildMockStageMessage("burn_submit", m),
  },
  {
    key: "burn_confirm",
    second: 53,
    type: "confirm",
    txSuffix: "confirm",
    message: (m) => buildMockStageMessage("burn_confirm", m),
  },
  {
    key: "cooldown",
    second: 61,
    type: "info",
    message: (m) => buildMockStageMessage("cooldown", m),
  },
];

function asNumber(value: number | string): number {
  const n = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
  return Number.isFinite(n) ? n : 0;
}

function formatAmount(value: number | string, decimals = 2) {
  if (typeof value === "string" && value.trim() !== "" && Number.isNaN(Number(value.replaceAll(",", "")))) {
    return value;
  }

  const n = asNumber(value);
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

function formatAmountFixed(value: number | string, decimals = 2) {
  const n = asNumber(value);
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatWhole(value: number) {
  return Math.round(value).toLocaleString();
}

function formatTimestamp(ts: string | number | undefined) {
  if (ts === undefined || ts === null) return "--:--:--";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toLocaleTimeString([], { hour12: false });
}

function parseAmountFromText(message: string): number {
  const sanitized = message.replace(/https?:\/\/\S+/g, " ");
  const matches = sanitized.match(/\d[\d,]*(?:\.\d+)?/g);
  if (!matches) return 0;
  return matches.reduce((max, token) => {
    const value = Number(token.replaceAll(",", ""));
    if (!Number.isFinite(value)) return max;
    return Math.max(max, value);
  }, 0);
}

function asBurnAmount(amount: string | number | undefined, message: string): number {
  if (amount !== undefined) {
    const direct = asNumber(amount);
    if (direct > 0) return direct;
  }
  return parseAmountFromText(message);
}

function mergeTopBurns(previous: TopBurn[], incoming: TopBurn[]): TopBurn[] {
  const byId = new Map<string, TopBurn>();
  [...previous, ...incoming].forEach((entry) => {
    if (entry.amount <= 0) return;
    byId.set(entry.id, entry);
  });

  return [...byId.values()]
    .sort((a, b) => (b.amount - a.amount) || (new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()))
    .slice(0, TOP_BURNS_LIMIT);
}

function sameTopBurns(a: TopBurn[], b: TopBurn[]) {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return entry.id === other.id && entry.amount === other.amount && entry.timestamp === other.timestamp && entry.txUrl === other.txUrl;
  });
}

function createSparkle(now: number): Sparkle {
  return {
    id: `s-${Math.floor(Math.random() * 1_000_000)}-${now}`,
    left: Math.random() * 100,
    top: Math.random() * 100,
    size: 1.6 + Math.random() * 2.8,
    opacity: 0.68 + Math.random() * 0.32,
    lifeMs: 420 + Math.random() * 980,
    bornAt: now,
  };
}

function renderKeyboardKeyContent(label: string, rowIndex: number, keyIndex: number) {
  if (label === "TAB") {
    return (
      <span className="ctrl-key-logo-wrap" aria-label="GitHub">
        <Github className="ctrl-key-logo-icon" strokeWidth={2.2} />
      </span>
    );
  }

  if (label === "CAPS") {
    return (
      <span className="ctrl-key-logo-wrap" aria-label="pump.fun">
        <img src={pumpfunLogoPng} alt="pump.fun" className="ctrl-key-logo-pumpfun" draggable={false} />
      </span>
    );
  }

  const isLeftShift = label === "SHIFT" && rowIndex === 3 && keyIndex === 0;
  if (isLeftShift) {
    return (
      <span className="ctrl-key-logo-wrap" aria-label="X">
        <svg viewBox="0 0 24 24" className="ctrl-key-logo-icon" aria-hidden="true">
          <path
            fill="currentColor"
            d="M18.244 2h3.108l-6.79 7.758L22.55 22h-6.254l-4.897-6.995L5.28 22H2.17l7.263-8.302L1.75 2h6.413l4.427 6.324L18.244 2Zm-1.09 18.14h1.722L7.223 3.764H5.376L17.154 20.14Z"
          />
        </svg>
      </span>
    );
  }

  const isLeftCtrl = label === "CTRL" && rowIndex === 4 && keyIndex === 0;
  if (isLeftCtrl) {
    return (
      <span className="ctrl-key-ctrl-wrap">
        <Flame className="ctrl-key-logo-fire" strokeWidth={2.4} />
        <span>CTRL</span>
      </span>
    );
  }

  const isRightShift = label === "SHIFT" && rowIndex === 3 && keyIndex !== 0;
  if (isRightShift) {
    return <span className="ctrl-key-satosheh">satoshEH_</span>;
  }

  return label;
}

function getKeyboardKeyLink(label: string, rowIndex: number, keyIndex: number) {
  if (label === "TAB") return GITHUB_URL;
  if (label === "CAPS") return PUMPFUN_URL;
  if (label === "SHIFT" && rowIndex === 3 && keyIndex === 0) return X_URL;
  if (label === "SHIFT" && rowIndex === 3 && keyIndex !== 0) return SATOSHEH_X_URL;
  return "";
}

function seeded(cycle: number, salt: number) {
  const x = Math.sin(cycle * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function pickVariant(cycle: number, salt: number, options: string[]) {
  if (options.length === 0) return "";
  const idx = Math.floor(seeded(cycle, salt) * options.length) % options.length;
  return options[idx];
}

function buildMockStageMessage(stage: MockStageKey, metrics: MockCycleMetrics) {
  const c = metrics.cycle;

  if (stage === "preflight") {
    const lead = pickVariant(c, 11, [
      "AI CORE SYNCHRONIZED.",
      "INFERENCE STACK LOCKED.",
      "TACTICAL MODEL ONLINE.",
      "SIGNAL ENGINE STABLE.",
    ]);
    const tail = pickVariant(c, 12, [
      "BURN ROUTE ARMED.",
      "LATENCY FLOOR CLEARED.",
      "EXECUTION LANE GREEN.",
      "SUPPLY PRESSURE PRIMED.",
    ]);
    return `CYCLE #${c} ${lead} ${tail}`;
  }

  if (stage === "claim") {
    const tail = pickVariant(c, 13, [
      "YIELD CAPTURE OPTIMAL.",
      "CAPITAL REDEPLOY WINDOW OPEN.",
      "TREASURY INPUT VERIFIED.",
      "ENGINE REINVEST PATH CONFIRMED.",
    ]);
    return `CYCLE #${c} CLAIM LOCKED +${metrics.claimSol.toFixed(2)} SOL (${metrics.claimUsd.toFixed(2)} USD). ${tail}`;
  }

  if (stage === "buy_route") {
    const tail = pickVariant(c, 14, [
      "SLIPPAGE GUARD ACTIVE.",
      "ROUTE QUALITY A+.",
      "PRICE IMPACT CONTAINED.",
      "ORDERFLOW CALIBRATED.",
    ]);
    return `CYCLE #${c} BUY INTENT CONFIRMED. DEPLOYING ${metrics.buySol.toFixed(2)} SOL (${metrics.buyUsd.toFixed(2)} USD). ${tail}`;
  }

  if (stage === "buy_confirm") {
    const tail = pickVariant(c, 15, [
      "INVENTORY READY FOR INCINERATION.",
      "BURN PIPELINE PREHEATED.",
      "TOKEN STACK STAGED.",
      "INCINERATOR LANE RESERVED.",
    ]);
    return `CYCLE #${c} BUY FILLED. ${tail}`;
  }

  if (stage === "burn_prep") {
    const tail = pickVariant(c, 16, [
      "DEFICIT PRESSURE RISING.",
      "SUPPLY COMPRESSION PRIMED.",
      "BURN VECTOR LOCKED.",
      "DEFLATION WINDOW OPEN.",
    ]);
    return `CYCLE #${c} BURN PREP LIVE. TARGET ${formatWhole(metrics.burnTokens)} TOKENS. ${tail}`;
  }

  if (stage === "burn_submit") {
    const tail = pickVariant(c, 17, [
      "SIGNATURE PROPAGATING.",
      "MEMPOOL IMPACT TRACKED.",
      "FINALITY PATH ACTIVE.",
      "CHAIN ROUTE CLEAN.",
    ]);
    return `CYCLE #${c} BURN TX FIRED. SUPPLY REDUCTION IN FLIGHT. ${tail}`;
  }

  if (stage === "burn_confirm") {
    const tail = pickVariant(c, 18, [
      "SCARCITY SCORE UP.",
      "DEFLATION THRUST CONFIRMED.",
      "SUPPLY CURVE COMPRESSED.",
      "MARKET PRESSURE BOOSTED.",
    ]);
    return `CYCLE #${c} ON-CHAIN CONFIRMATION LOCKED. ${formatWhole(metrics.burnTokens)} TOKENS ERASED. ${tail}`;
  }

  const tail = pickVariant(c, 19, [
    "AI MONITORING NEXT EXECUTION.",
    "ENGINE HOLDING FOR NEXT WINDOW.",
    "LOOP STABILITY NOMINAL.",
    "NEXT STRIKE QUEUED.",
  ]);
  return `CYCLE #${c} COOLDOWN LIVE. WAIT 69 (NICE..) SECONDS. ${tail}`;
}

function buildCycleMetrics(cycle: number): MockCycleMetrics {
  const claimSol = 0.35 + seeded(cycle, 1) * 2.75;
  const buySol = 1.9 + seeded(cycle, 2) * 8.4;
  const burnTokens = Math.round(190_000_000 + seeded(cycle, 3) * 880_000_000);

  return {
    cycle,
    claimSol,
    claimUsd: claimSol * 146,
    buySol,
    buyUsd: buySol * 146,
    burnTokens,
  };
}

function buildMockCycleEvent(cycle: number, cycleStart: number, stageIndex: number): TerminalEvent {
  const stage = MOCK_LOG_STAGES[stageIndex];
  const metrics = buildCycleMetrics(cycle);
  const timestamp = cycleStart + stage.second * 1000;

  return {
    timestamp,
    type: stage.type,
    message: stage.message(metrics),
    txUrl: stage.txSuffix ? `https://solscan.io/tx/mock-${cycle}-${stage.txSuffix}` : undefined,
  };
}

function buildMockTimeline(now: number): TerminalEvent[] {
  const cycle = Math.floor(now / CYCLE_MS);
  const firstCycle = Math.max(0, cycle - MOCK_CYCLE_LOOKBACK);
  const events: TerminalEvent[] = [];

  for (let c = firstCycle; c <= cycle; c += 1) {
    const cycleStart = c * CYCLE_MS;
    const elapsed = c === cycle ? Math.floor((now - cycleStart) / 1000) : CYCLE_SECONDS;

    MOCK_LOG_STAGES.forEach((stage, stageIndex) => {
      if (stage.second > elapsed) return;
      events.push(buildMockCycleEvent(c, cycleStart, stageIndex));
    });
  }

  return events.slice(-TERMINAL_LOG_LIMIT);
}

function eventId(event: TerminalEvent) {
  const ts = new Date(event.timestamp).getTime();
  return `${ts}|${event.type}|${event.message}|${event.txUrl ?? ""}`;
}

export function Dashboard({ streamMode = false, data, isGlitching, isCtrlPressed, topBurnEvents = [] }: DashboardProps) {
  const countdownDisplay = `00:${String(data.nextBurn.remainingSeconds).padStart(2, "0")}`;

  const [mockTerminalEvents, setMockTerminalEvents] = useState<TerminalEvent[]>(() => buildMockTimeline(Date.now()));
  const [typedLengths, setTypedLengths] = useState<Record<string, number>>({});
  const [pressedKey, setPressedKey] = useState<string | null>(null);
  const [plugPosition, setPlugPosition] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_PLUG_POSITION;
    try {
      const raw = window.localStorage.getItem(PLUG_POSITION_STORAGE_KEY);
      if (!raw) return DEFAULT_PLUG_POSITION;
      const parsed = JSON.parse(raw) as { left?: number; bottom?: number };
      if (typeof parsed.left !== "number" || typeof parsed.bottom !== "number") return DEFAULT_PLUG_POSITION;
      return { left: parsed.left, bottom: parsed.bottom };
    } catch {
      return DEFAULT_PLUG_POSITION;
    }
  });

  const dragStartRef = useRef<{ x: number; y: number; left: number; bottom: number } | null>(null);
  const topBurnsDragStartRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const typingQueueRef = useRef<string[]>([]);
  const activeTypingRef = useRef<string | null>(null);
  const textByEventIdRef = useRef<Record<string, string>>({});
  const initialTypingLoadRef = useRef(false);
  const clearKeyTimerRef = useRef<number | null>(null);
  const nextTypeDelayRef = useRef<number>(TYPING_SPEED_MS);
  const lastCtrlPressCycleRef = useRef<number>(-1);

  const [topBurnsPosition, setTopBurnsPosition] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_TOP_BURNS_POSITION;
    try {
      const raw = window.localStorage.getItem(TOP_BURNS_POSITION_STORAGE_KEY);
      if (!raw) return DEFAULT_TOP_BURNS_POSITION;
      const parsed = JSON.parse(raw) as { left?: number; top?: number };
      if (typeof parsed.left !== "number" || typeof parsed.top !== "number") return DEFAULT_TOP_BURNS_POSITION;
      return { left: parsed.left, top: parsed.top };
    } catch {
      return DEFAULT_TOP_BURNS_POSITION;
    }
  });

  const [topBurns, setTopBurns] = useState<TopBurn[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(TOP_BURNS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as TopBurn[];
      if (!Array.isArray(parsed)) return [];
      const cleaned = parsed
        .filter(
          (entry) =>
            entry &&
            typeof entry.id === "string" &&
            typeof entry.amount === "number" &&
            typeof entry.txUrl === "string" &&
            entry.txUrl.length > 0 &&
            !String(entry.id).startsWith("mock-")
        )
        .slice(0, TOP_BURNS_LIMIT);
      return cleaned;
    } catch {
      return [];
    }
  });

  const [topSparkles, setTopSparkles] = useState<Sparkle[]>([]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMockTerminalEvents(buildMockTimeline(Date.now()));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const cycle = Math.floor(now / CYCLE_MS);
      const secondInCycle = Math.floor((now - cycle * CYCLE_MS) / 1000);

      if (secondInCycle === BURN_EXECUTE_SECOND && lastCtrlPressCycleRef.current !== cycle) {
        lastCtrlPressCycleRef.current = cycle;
        setPressedKey("CTRL");
        if (clearKeyTimerRef.current !== null) window.clearTimeout(clearKeyTimerRef.current);
        clearKeyTimerRef.current = window.setTimeout(() => setPressedKey(null), 220);
      }
    };

    tick();
    const timer = window.setInterval(tick, 80);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!ENABLE_PLUG_CALIBRATION) return;

    const onMove = (e: MouseEvent) => {
      const drag = dragStartRef.current;
      if (!drag) return;

      const next = {
        left: drag.left + (e.clientX - drag.x),
        bottom: drag.bottom - (e.clientY - drag.y),
      };

      setPlugPosition(next);
      window.localStorage.setItem(PLUG_POSITION_STORAGE_KEY, JSON.stringify(next));
    };

    const onUp = () => {
      dragStartRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  useEffect(() => {
    if (!ENABLE_TOP_BURNS_CALIBRATION) return;

    const onMove = (e: MouseEvent) => {
      const drag = topBurnsDragStartRef.current;
      if (!drag) return;

      const next = {
        left: drag.left + (e.clientX - drag.x),
        top: drag.top + (e.clientY - drag.y),
      };

      setTopBurnsPosition(next);
      window.localStorage.setItem(TOP_BURNS_POSITION_STORAGE_KEY, JSON.stringify(next));
    };

    const onUp = () => {
      topBurnsDragStartRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const combinedEventsChronological = useMemo(() => {
    const source = data.terminal.events.length > 0 ? data.terminal.events : mockTerminalEvents;
    return [...source]
      .filter((event) => {
        const msg = String(event.message ?? "").trim();
        if (!msg) return false;
        if (/rpc|retrying|getsignaturesforaddress|gettokensupply|connectivity recovered/i.test(msg)) return false;
        return true;
      })
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(-TERMINAL_LOG_LIMIT);
  }, [data.terminal.events, mockTerminalEvents]);

  const terminalEvents = useMemo(() => [...combinedEventsChronological].reverse(), [combinedEventsChronological]);

  useEffect(() => {
    const nextTextById: Record<string, string> = {};
    combinedEventsChronological.forEach((event) => {
      nextTextById[eventId(event)] = event.message;
    });
    textByEventIdRef.current = nextTextById;

    if (!initialTypingLoadRef.current) {
      const full: Record<string, number> = {};
      combinedEventsChronological.forEach((event) => {
        const id = eventId(event);
        full[id] = event.message.length;
      });
      setTypedLengths(full);
      initialTypingLoadRef.current = true;
      return;
    }

    setTypedLengths((previous) => {
      const next: Record<string, number> = {};
      const currentIds = new Set<string>();

      combinedEventsChronological.forEach((event) => {
        const id = eventId(event);
        currentIds.add(id);
        if (previous[id] === undefined) {
          next[id] = 0;
          typingQueueRef.current.push(id);
        } else {
          next[id] = previous[id];
        }
      });

      Object.keys(previous).forEach((id) => {
        if (!currentIds.has(id)) {
          const queueIndex = typingQueueRef.current.indexOf(id);
          if (queueIndex !== -1) typingQueueRef.current.splice(queueIndex, 1);
          if (activeTypingRef.current === id) activeTypingRef.current = null;
        }
      });

      return next;
    });
  }, [combinedEventsChronological]);

  useEffect(() => {
    let timer: number | null = null;

    const scheduleNext = () => {
      const delay = Math.max(40, nextTypeDelayRef.current);
      timer = window.setTimeout(typeTick, delay);
    };

    const typeTick = () => {
      const current = activeTypingRef.current;
      if (!current) {
        const nextId = typingQueueRef.current.shift() ?? null;
        activeTypingRef.current = nextId;
        nextTypeDelayRef.current = TYPING_SPEED_MS + Math.random() * 42;
        scheduleNext();
        return;
      }

      const text = textByEventIdRef.current[current] ?? "";
      if (text.length === 0) {
        activeTypingRef.current = null;
        nextTypeDelayRef.current = TYPING_SPEED_MS + Math.random() * 42;
        scheduleNext();
        return;
      }

      setTypedLengths((previous) => {
        const currentLength = previous[current] ?? 0;
        if (currentLength >= text.length) {
          activeTypingRef.current = null;
          nextTypeDelayRef.current = TYPING_SPEED_MS + 52 + Math.random() * 66;
          return previous;
        }

        const step = Math.random() < 0.84 ? 1 : 2;
        const nextLength = Math.min(text.length, currentLength + step);
        const typedChunk = text.slice(currentLength, nextLength).toUpperCase();
        const keyMatch = [...typedChunk].reverse().find((char) => /^[A-Z0-9]$/.test(char));
        const lastTyped = typedChunk[typedChunk.length - 1] ?? "";

        if (keyMatch) {
          setPressedKey(keyMatch);
          if (clearKeyTimerRef.current !== null) window.clearTimeout(clearKeyTimerRef.current);
          clearKeyTimerRef.current = window.setTimeout(() => setPressedKey(null), 65);
        }

        let nextDelay = TYPING_SPEED_MS + (Math.random() * 34 - 10);
        if (/[.,:;!?]/.test(lastTyped)) {
          nextDelay += 62 + Math.random() * 84;
        } else if (lastTyped === " ") {
          nextDelay += 24 + Math.random() * 42;
        } else if (Math.random() < 0.1) {
          nextDelay += 36 + Math.random() * 62;
        }
        nextTypeDelayRef.current = nextDelay;

        if (nextLength >= text.length) {
          activeTypingRef.current = null;
          nextTypeDelayRef.current += 44 + Math.random() * 68;
        }

        return {
          ...previous,
          [current]: nextLength,
        };
      });

      scheduleNext();
    };

    scheduleNext();

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      if (clearKeyTimerRef.current !== null) window.clearTimeout(clearKeyTimerRef.current);
    };
  }, []);

  const incomingBurns = useMemo(() => {
    const fromChartDevBuys: TopBurn[] = topBurnEvents
      .filter((event) => Number.isFinite(event.ts) && event.ts > 0 && Number.isFinite(event.amount) && event.amount > 0 && Boolean(event.txUrl))
      .map((event) => ({
        id: `chart:${event.ts}:${event.txUrl ?? event.amount}`,
        amount: event.amount,
        timestamp: event.ts,
        txUrl: event.txUrl!,
      }));

    return fromChartDevBuys;
  }, [topBurnEvents]);

  useEffect(() => {
    if (incomingBurns.length === 0) return;
    setTopBurns((previous) => {
      const next = mergeTopBurns(previous, incomingBurns);
      if (sameTopBurns(previous, next)) return previous;
      window.localStorage.setItem(TOP_BURNS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, [incomingBurns]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTopSparkles((previous) => {
        const alive = previous.filter((sparkle) => now - sparkle.bornAt < sparkle.lifeMs);
        const roll = Math.random();
        const spawnCount = roll < 0.16 ? 0 : roll < 0.58 ? 1 : roll < 0.86 ? 2 : 3;
        if (spawnCount === 0) return alive;
        const spawned = Array.from({ length: spawnCount }, () => createSparkle(now));
        return [...alive, ...spawned].slice(-72);
      });
    }, 96);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      id="ctrl-dashboard"
      className={cn(
        "keyboard-body relative mx-auto mt-[1px] h-[calc(100%-4px)] w-full overflow-hidden",
        streamMode ? "max-w-none p-3 lg:p-4" : "max-w-none p-3 lg:p-4"
      )}
    >
      <div className="keyboard-title-bar mb-4 px-6 py-3 text-center">
        <img
          src={ctrlLogoPng}
          alt="CTRL Continuous Token Reduction Loop powered by Grok AI"
          draggable={false}
          className={cn("mx-auto h-[76px] w-full object-fill translate-y-[7px] drop-shadow-[0_1px_2px_rgba(0,0,0,0.38)]", streamMode ? "max-h-[100px] scale-x-[0.46] scale-y-[1.02]" : "max-h-[76px] scale-x-[0.46] scale-y-[1.02]")}
        />
      </div>

      <div className="keycap-inset crt-scanlines mb-4 px-4 py-3" id="ctrl-summary-bar">
        <div id="ctrl-next-burn" className="mt-2">
          <div className="relative h-8 overflow-hidden rounded-sm bg-accent" data-key="ctrl.nextBurn.progress01">
            <div
              className="h-full rounded-sm transition-all duration-1000 ease-linear"
              style={{
                width: `${data.nextBurn.progress01 * 100}%`,
                background: "linear-gradient(90deg, hsl(var(--ctrl-green)), hsl(var(--ctrl-green)) 60%, hsl(var(--ctrl-yellow)))",
              }}
            />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="font-mono text-[11px] font-bold tracking-wider text-foreground" data-key="ctrl.nextBurn.remainingSeconds">
                NEXT BURN IN: {countdownDisplay}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className={cn("relative mb-4 grid gap-4", streamMode ? "grid-cols-[0.671fr_1.329fr]" : "grid-cols-1 md:grid-cols-[0.671fr_1.329fr]")}>
        <div className="grid auto-rows-min grid-cols-1 content-start gap-2 self-start md:justify-self-start md:max-w-[520px]">
          <div className="keycap-inset crt-scanlines h-fit p-3 text-center">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Tokens Burned</div>
            <div className="mt-1 whitespace-nowrap font-mono text-[clamp(0.8rem,1.3vw,0.98rem)] font-bold leading-tight tracking-[-0.02em] tabular-nums" data-key="ctrl.tokensBurned.total">{formatAmount(data.tokensBurned.total, 0)}</div>
          </div>
          <div className="keycap-inset crt-scanlines h-fit p-3 text-center">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">SOL Burned</div>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums" data-key="ctrl.solBurned.total">{formatAmountFixed(data.solBurned.total, 2)}</div>
            <div className="font-mono text-[10px] text-muted-foreground" data-key="ctrl.usdSpent.total">({formatAmountFixed(data.usdSpent.total, 2)} USD)</div>
          </div>
          <div className="keycap-inset crt-scanlines h-fit p-3 text-center">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Burn Cycles</div>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums" data-key="ctrl.cycles.total">{data.cycles.total}</div>
          </div>
          <div id="ctrl-rewards" className="keycap-inset crt-scanlines h-fit p-3 text-center">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Creator Rewards</div>
            <div className="mt-1 font-mono text-lg font-bold tabular-nums" data-key="ctrl.rewards.totalClaimedSol">{formatAmountFixed(data.rewards.totalClaimedSol, 2)} SOL</div>
            <div className="font-mono text-[10px] text-muted-foreground" data-key="ctrl.rewards.totalClaimedUsd">({formatAmountFixed(data.rewards.totalClaimedUsd, 2)} USD)</div>
          </div>
          <div id="ctrl-supply-burned" className="keycap-inset crt-scanlines h-fit p-3 text-center">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Supply Burned</div>
            <div className="mt-1 font-mono text-2xl font-bold text-ctrl-red" data-key="ctrl.supply.percentBurned">{asNumber(data.supply.percentBurned).toFixed(4)}%</div>
          </div>
          <div className="keycap-inset crt-scanlines h-fit p-3 text-center">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Total Holders</div>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums" data-key="ctrl.holders.total">{formatAmount(data.holders?.total ?? 0, 0)}</div>
          </div>
        </div>

        <div className="keycap-inset crt-scanlines ctrl-terminal-shell h-[496px] overflow-hidden p-3" id="ctrl-terminal">
          <div className="ctrl-terminal-scroll h-full space-y-1 overflow-y-scroll pr-1 font-mono text-xs" data-key="ctrl.terminal.events">
            {terminalEvents.map((event) => {
              const id = eventId(event);
              const baseMessage = event.message.replace(/\s*\[VIEW ON SOLSCAN\]/i, "");
              const maxLength = Math.min(typedLengths[id] ?? baseMessage.length, baseMessage.length);
              const typedMessage = baseMessage.slice(0, maxLength);
              if (maxLength === 0) return null;
              const hasTx = Boolean(event.txUrl);
              const showTx = hasTx && maxLength >= baseMessage.length;

              return (
                <div key={id} className="relative min-h-[42px] rounded-sm border border-border/60 bg-background/35 px-2 py-0.5">
                  <span className="absolute right-2 top-0.5 z-10 bg-background/80 px-1 tabular-nums text-[10px] text-muted-foreground">
                    {formatTimestamp(event.timestamp)}
                  </span>
                  <div className="flex min-h-[32px] items-center justify-start gap-2 overflow-hidden whitespace-nowrap pr-[126px] text-left font-bold uppercase leading-snug">
                    <span className="min-w-0 truncate">{typedMessage}</span>
                    {hasTx && (
                      <span className="ml-2 inline-flex min-w-[118px] justify-end">
                        <a
                          href={event.txUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cn(
                            "text-[10px] font-bold uppercase tracking-wider text-ctrl-blue hover:underline",
                            showTx ? "opacity-100" : "pointer-events-none opacity-0"
                          )}
                        >
                          [VIEW ON SOLSCAN]
                        </a>
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div
          id="ctrl-top-burns"
          className={cn(
            "hidden lg:block absolute w-[303px]",
            ENABLE_TOP_BURNS_CALIBRATION && "cursor-grab active:cursor-grabbing"
          )}
          style={{ left: `${topBurnsPosition.left}px`, top: `${topBurnsPosition.top}px` }}
          onMouseDown={(e) => {
            if (!ENABLE_TOP_BURNS_CALIBRATION) return;
            const target = e.target as HTMLElement | null;
            if (target?.closest("a")) return;
            e.preventDefault();
            topBurnsDragStartRef.current = {
              x: e.clientX,
              y: e.clientY,
              left: topBurnsPosition.left,
              top: topBurnsPosition.top,
            };
          }}
        >
          <div className="keycap-inset crt-scanlines h-fit p-3">
            <div className="mb-2 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Top 5 Largest Burns
            </div>
            <div className="space-y-2">
              {topBurns.length === 0 && (
                <div className="rounded-sm border border-border/60 bg-background/35 px-2 py-2 text-center font-mono text-[11px] text-muted-foreground">
                  Waiting For Burn Data
                </div>
              )}
              {topBurns.map((burn, index) => (
                <div
                  key={burn.id}
                  className={cn(
                    "rounded-sm border px-2 py-1.5",
                    index === 0
                      ? "ctrl-top-burn-gold"
                      : "border-border/60 bg-background/35"
                  )}
                >
                  {index === 0 && (
                    <div className="ctrl-top-burn-sparkles" aria-hidden="true">
                      {topSparkles.map((sparkle) => (
                        <span
                          key={sparkle.id}
                          className="ctrl-top-burn-sparkle"
                          style={{
                            left: `${sparkle.left}%`,
                            top: `${sparkle.top}%`,
                          width: `${sparkle.size}px`,
                          height: `${sparkle.size}px`,
                          opacity: sparkle.opacity,
                          transform: "translate(-50%, -50%)",
                          animationDuration: `${sparkle.lifeMs}ms`,
                        }}
                      />
                      ))}
                    </div>
                  )}
                  <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    <span className={cn("font-bold", index === 0 && "text-[#7a4f00]")}>#{index + 1}</span>
                    <span className="ml-auto tabular-nums">{formatTimestamp(burn.timestamp)}</span>
                  </div>
                  <div className="font-mono text-sm font-bold tabular-nums text-foreground">
                    {formatAmount(burn.amount, 0)} TOKENS
                    {burn.txUrl && (
                      <a
                        href={burn.txUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 text-[10px] font-bold uppercase tracking-wider text-ctrl-blue hover:underline"
                      >
                        [TX]
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-[2.5rem] h-10" aria-hidden="true" />
      <div className="-mt-[6.1rem] flex justify-center">
        <div className="ctrl-oldboard-wrap ctrl-oldboard-shrink w-full max-w-[1080px]">
          <div className="ctrl-oldboard">
            {KEYBOARD_ROWS.map((row, rowIndex) => (
              <div key={`row-${rowIndex}`} className="ctrl-old-row">
                {row.map((key, keyIndex) => {
                  const keyLink = getKeyboardKeyLink(key.label, rowIndex, keyIndex);
                  return (
                  <button
                    key={`${key.label}-${rowIndex}-${keyIndex}`}
                    type="button"
                    className={cn(
                      "ctrl-old-key",
                      keyLink && "ctrl-old-key-link",
                      pressedKey === key.label && "is-typing-key"
                    )}
                    style={{ gridColumn: `span ${key.span} / span ${key.span}` }}
                    aria-label={`${key.label} key`}
                    onClick={() => {
                      if (!keyLink) return;
                      window.open(keyLink, "_blank", "noopener,noreferrer");
                    }}
                  >
                    {renderKeyboardKeyContent(key.label, rowIndex, keyIndex)}
                  </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <img
        src={plugCordPng}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn("ctrl-plug-image", ENABLE_PLUG_CALIBRATION && "ctrl-plug-draggable")}
        style={{ left: `${plugPosition.left}px`, bottom: `${plugPosition.bottom}px` }}
        onMouseDown={(e) => {
          if (!ENABLE_PLUG_CALIBRATION) return;
          e.preventDefault();
          dragStartRef.current = {
            x: e.clientX,
            y: e.clientY,
            left: plugPosition.left,
            bottom: plugPosition.bottom,
          };
        }}
      />
    </div>
  );
}

