import { Dashboard } from "@/components/ctrl/Dashboard";
import { useCtrlData } from "@/hooks/useCtrlData";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import fireSolanaPng from "@/assets/fire-solana.png";

const LOOP_STEPS = [
  { step: "01", icon: "\u{1F4B0}", title: "CLAIM REWARDS", desc: "Creator rewards from pump.fun are claimed automatically." },
  { step: "02", icon: "\u{1F6D2}", title: "BUY BACK TOKENS", desc: "All claimed rewards are used to buy $CTRL on pump.fun." },
  { step: "03", icon: "\u{1F525}", title: "BURN", desc: "Purchased tokens are sent to the incinerator, permanently removing them from supply." },
  { step: "04", icon: "", title: "REPEAT", desc: "Wait 69 (nice..) seconds. Do it again. Forever." },
];

const LIVE_CANDLE_POLL_MS = 30000;
const LIVE_POINTS = 1000;
const MAX_VIEW_POINTS = 4000;
const MAX_STORED_MINUTE_CANDLES = 12000;
const CHART_HEIGHT = 240;
const INTERVALS = ["30s", "1m", "5m", "15m", "30m", "1h"] as const;
type ChartInterval = (typeof INTERVALS)[number];

type CandlePoint = { t: number; o: number; h: number; l: number; c: number };
type DevBuyEvent = { ts: number; amount: number; txUrl?: string };
type DevBuyApiEvent = { ts?: number; amount?: number; txUrl?: string; timestamp?: string };
type DexPair = { pairAddress?: string; liquidity?: { usd?: number | string } };

const INTERVAL_CFG: Record<ChartInterval, { bucketMs: number; aggregateMin: number; defaultView: number }> = {
  "30s": { bucketMs: 30_000, aggregateMin: 1, defaultView: 100 },
  "1m": { bucketMs: 60_000, aggregateMin: 1, defaultView: 90 },
  "5m": { bucketMs: 300_000, aggregateMin: 5, defaultView: 84 },
  "15m": { bucketMs: 900_000, aggregateMin: 15, defaultView: 76 },
  "30m": { bucketMs: 1_800_000, aggregateMin: 30, defaultView: 64 },
  "1h": { bucketMs: 3_600_000, aggregateMin: 60, defaultView: 56 },
};

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function formatTokenAmount(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1) return value.toFixed(4);
  if (value < 1000) return value.toFixed(2);
  return Math.round(value).toLocaleString();
}

function splitMinuteIntoThirtySec(candles: CandlePoint[]) {
  const next: CandlePoint[] = [];
  candles.forEach((candle) => {
    const mid = (candle.o + candle.c) / 2;
    const t1 = candle.t;
    const t2 = candle.t + 30_000;

    next.push({
      t: t1,
      o: candle.o,
      h: Math.max(candle.o, mid, candle.h),
      l: Math.min(candle.o, mid, candle.l),
      c: mid,
    });
    next.push({
      t: t2,
      o: mid,
      h: Math.max(mid, candle.c, candle.h),
      l: Math.min(mid, candle.c, candle.l),
      c: candle.c,
    });
  });
  return next;
}

function aggregateCandles(candles: CandlePoint[], bucketMs: number) {
  if (candles.length === 0) return [];
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const out: CandlePoint[] = [];
  let currentBucketStart = -1;
  let current: CandlePoint | null = null;

  for (const candle of sorted) {
    const bucketStart = Math.floor(candle.t / bucketMs) * bucketMs;
    if (bucketStart !== currentBucketStart || !current) {
      if (current) out.push(current);
      currentBucketStart = bucketStart;
      current = { t: bucketStart, o: candle.o, h: candle.h, l: candle.l, c: candle.c };
      continue;
    }

    current.h = Math.max(current.h, candle.h);
    current.l = Math.min(current.l, candle.l);
    current.c = candle.c;
  }

  if (current) out.push(current);
  return out;
}

function mergeCandlesUnique(existing: CandlePoint[], incoming: CandlePoint[]) {
  const byTs = new Map<number, CandlePoint>();
  for (const c of existing) byTs.set(c.t, c);
  for (const c of incoming) byTs.set(c.t, c);
  const merged = [...byTs.values()].sort((a, b) => a.t - b.t);
  if (merged.length <= MAX_STORED_MINUTE_CANDLES) return merged;
  return merged.slice(-MAX_STORED_MINUTE_CANDLES);
}

const Index = () => {
  const [params] = useSearchParams();
  const streamMode = params.get("mode") === "stream";
  const { data, tokenMint, isCtrlPressed } = useCtrlData();
  const fireCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [poolAddress, setPoolAddress] = useState<string | null>(null);
  const [selectedInterval, setSelectedInterval] = useState<ChartInterval>("1m");
  const [baseMinuteCandles, setBaseMinuteCandles] = useState<CandlePoint[]>([]);
  const [devBuyEvents, setDevBuyEvents] = useState<DevBuyEvent[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [panOffset, setPanOffset] = useState(0);
  const [viewSize, setViewSize] = useState(INTERVAL_CFG["1m"].defaultView);
  const [chartWidth, setChartWidth] = useState(560);
  const [markerHover, setMarkerHover] = useState<{ x: number; y: number; text: string } | null>(null);

  const marketChartRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startPan: number } | null>(null);
  const oldestMinuteTsRef = useRef<number | null>(null);
  const backfillInFlightRef = useRef(false);

  const stopwatchDelayMs = useMemo(() => -(Date.now() % 69_000), []);

  useEffect(() => {
    const canvas = fireCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    type ParticleType = "flame" | "blue" | "ember" | "smoke";
    type Particle = {
      type: ParticleType;
      x: number;
      y: number;
      vx: number;
      vy: number;
      size: number;
      age: number;
      life: number;
      alpha: number;
    };

    const particles: Particle[] = [];
    let raf = 0;
    let width = 0;
    let height = 0;
    let last = performance.now();

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "source-over";
    };

    const spawn = (dt: number) => {
      const baseY = height + 4;
      const flameCount = Math.max(2, Math.floor(dt * 96));

      for (let i = 0; i < flameCount; i += 1) {
        const x = Math.random() * width;
        const centerBoost = 1 - Math.min(0.8, Math.abs(x / width - 0.5));

        particles.push({
          type: "flame",
          x,
          y: baseY,
          vx: (Math.random() - 0.5) * 15,
          vy: -(62 + Math.random() * 95) * (0.8 + centerBoost * 0.5),
          size: 8 + Math.random() * 20,
          age: 0,
          life: 0.45 + Math.random() * 0.85,
          alpha: 0.3 + Math.random() * 0.42,
        });

        if (Math.random() < 0.5) {
          particles.push({
            type: "blue",
            x: x + (Math.random() - 0.5) * 10,
            y: baseY,
            vx: (Math.random() - 0.5) * 11,
            vy: -(44 + Math.random() * 72),
            size: 6 + Math.random() * 12,
            age: 0,
            life: 0.35 + Math.random() * 0.45,
            alpha: 0.24 + Math.random() * 0.28,
          });
        }

        if (Math.random() < 0.34) {
          particles.push({
            type: "smoke",
            x: x + (Math.random() - 0.5) * 12,
            y: baseY - 6,
            vx: (Math.random() - 0.5) * 18,
            vy: -(14 + Math.random() * 24),
            size: 12 + Math.random() * 24,
            age: 0,
            life: 1 + Math.random() * 1.5,
            alpha: 0.04 + Math.random() * 0.08,
          });
        }

        if (Math.random() < 0.26) {
          particles.push({
            type: "ember",
            x,
            y: baseY - 5,
            vx: (Math.random() - 0.5) * 24,
            vy: -(20 + Math.random() * 48),
            size: 1 + Math.random() * 2.8,
            age: 0,
            life: 0.5 + Math.random() * 0.9,
            alpha: 0.38 + Math.random() * 0.5,
          });
        }
      }
    };

    const drawParticle = (p: Particle) => {
      const progress = p.age / p.life;
      if (progress >= 1) return;
      const fade = 1 - progress;
      const radius = p.size * (0.56 + fade * 0.9);

      if (p.type === "smoke") {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
        g.addColorStop(0, `rgba(90, 92, 100, ${p.alpha * fade})`);
        g.addColorStop(1, "rgba(20, 22, 26, 0)");
        ctx.fillStyle = g;
      } else if (p.type === "blue") {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
        g.addColorStop(0, `rgba(210, 240, 255, ${0.86 * fade})`);
        g.addColorStop(0.4, `rgba(92, 189, 255, ${p.alpha * fade})`);
        g.addColorStop(1, "rgba(30, 96, 180, 0)");
        ctx.fillStyle = g;
      } else if (p.type === "ember") {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
        g.addColorStop(0, `rgba(255, 247, 210, ${0.98 * fade})`);
        g.addColorStop(0.55, `rgba(255, 178, 74, ${p.alpha * fade})`);
        g.addColorStop(1, "rgba(255, 95, 24, 0)");
        ctx.fillStyle = g;
      } else {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
        g.addColorStop(0, `rgba(255, 243, 206, ${0.92 * fade})`);
        g.addColorStop(0.2, `rgba(255, 202, 112, ${0.78 * fade})`);
        g.addColorStop(0.58, `rgba(255, 94, 30, ${p.alpha * fade})`);
        g.addColorStop(1, "rgba(122, 24, 8, 0)");
        ctx.fillStyle = g;
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    };

    const tick = (ts: number) => {
      const dt = Math.min(0.038, Math.max(0.008, (ts - last) / 1000));
      last = ts;

      spawn(dt);

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "rgba(8, 6, 8, 0.28)";
      ctx.fillRect(0, 0, width, height);

      ctx.globalCompositeOperation = "lighter";
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const p = particles[i];
        p.age += dt;
        if (p.age >= p.life) {
          particles.splice(i, 1);
          continue;
        }

        p.vx += (Math.random() - 0.5) * 14 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy -= 10 * dt;

        if (p.type === "flame" || p.type === "blue") p.y += Math.sin((p.age * 18) + p.x * 0.02) * dt * 20;
        if (p.type === "smoke") p.x += Math.sin((p.age * 4) + p.y * 0.01) * dt * 12;

        drawParticle(p);
      }
      ctx.globalCompositeOperation = "source-over";

      const emberBed = ctx.createLinearGradient(0, height * 0.64, 0, height);
      emberBed.addColorStop(0, "rgba(255, 98, 34, 0)");
      emberBed.addColorStop(0.45, "rgba(255, 96, 34, 0.15)");
      emberBed.addColorStop(0.8, "rgba(72, 169, 255, 0.13)");
      emberBed.addColorStop(1, "rgba(20, 14, 16, 0.38)");
      ctx.fillStyle = emberBed;
      ctx.fillRect(0, 0, width, height);

      raf = requestAnimationFrame(tick);
    };

    resize();
    const onResize = () => resize();
    window.addEventListener("resize", onResize);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    const el = marketChartRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) setChartWidth(Math.max(340, Math.floor(w)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const resolvePool = async () => {
      if (!tokenMint) return;
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
        if (!res.ok || cancelled) return;
        const body = await res.json();
        const pairs: DexPair[] = Array.isArray(body?.pairs) ? body.pairs : [];
        const best = [...pairs]
          .sort((a, b) => Number(b?.liquidity?.usd ?? 0) - Number(a?.liquidity?.usd ?? 0))[0];
        const resolved = String(best?.pairAddress ?? "").trim();
        if (resolved) setPoolAddress(resolved);
      } catch {
        // Keep previous resolved pool.
      }
    };

    resolvePool();
    return () => {
      cancelled = true;
    };
  }, [tokenMint]);

  useEffect(() => {
    setPanOffset(0);
    setViewSize(INTERVAL_CFG[selectedInterval].defaultView);
  }, [selectedInterval]);

  useEffect(() => {
    let cancelled = false;

    const pull = async () => {
      try {
        const res = await fetch("/api/ctrl/dev-buys?limit=180", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const payload = await res.json();
        const rows = Array.isArray(payload?.events) ? payload.events : [];
        const mapped = rows
          .map((event: DevBuyApiEvent) => {
            const tsRaw = Number(event.ts);
            const tsFromIso = Number.isFinite(tsRaw) ? tsRaw : new Date(String(event.timestamp ?? "")).getTime();
            if (!Number.isFinite(tsFromIso) || tsFromIso <= 0) return null;
            const amount = Number(event.amount ?? 0);
            return {
              ts: tsFromIso,
              amount: Number.isFinite(amount) ? amount : 0,
              txUrl: event.txUrl,
            } as DevBuyEvent;
          })
          .filter((row: DevBuyEvent | null): row is DevBuyEvent => row !== null)
          .sort((a, b) => a.ts - b.ts);
        setDevBuyEvents(mapped);
      } catch {
        // keep last known events
      }
    };

    pull();
    const timer = window.setInterval(pull, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    setBaseMinuteCandles([]);
    setHasMoreHistory(true);
    oldestMinuteTsRef.current = null;
    setPanOffset(0);
  }, [poolAddress]);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        if (!poolAddress) return;

        const ohlcvRes = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=1&limit=${LIVE_POINTS}`
        );
        if (!ohlcvRes.ok || cancelled) return;
        const ohlcvJson = await ohlcvRes.json();
        const rows = ohlcvJson?.data?.attributes?.ohlcv_list;
        if (!Array.isArray(rows)) return;

        const candles = rows
          .map((row: unknown) => {
            if (!Array.isArray(row) || row.length < 5) return null;
            const t = Number(row[0]) * 1000;
            const o = Number(row[1]);
            const h = Number(row[2]);
            const l = Number(row[3]);
            const c = Number(row[4]);
            if (![t, o, h, l, c].every(Number.isFinite)) return null;
            return { t, o, h, l, c };
          })
          .filter((p: CandlePoint | null): p is CandlePoint => p !== null)
          .sort((a, b) => a.t - b.t);

        if (candles.length === 0) return;
        oldestMinuteTsRef.current = candles[0].t;
        setBaseMinuteCandles((previous) => mergeCandlesUnique(previous, candles));
      } catch {
        // Keep last chart data.
      }
    };

    poll();
    const timer = window.setInterval(poll, LIVE_CANDLE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [poolAddress]);

  const liveCandles = useMemo(() => {
    if (selectedInterval === "30s") return splitMinuteIntoThirtySec(baseMinuteCandles);
    if (selectedInterval === "1m") return baseMinuteCandles;
    return aggregateCandles(baseMinuteCandles, INTERVAL_CFG[selectedInterval].bucketMs);
  }, [baseMinuteCandles, selectedInterval]);

  const maxPan = Math.max(0, liveCandles.length - viewSize);

  useEffect(() => {
    setPanOffset((prev) => clamp(prev, 0, maxPan));
  }, [maxPan]);

  useEffect(() => {
    if (!poolAddress) return;
    if (!hasMoreHistory) return;
    if (backfillInFlightRef.current) return;
    if (maxPan <= 0 || panOffset < Math.max(0, maxPan - 2)) return;
    if (!oldestMinuteTsRef.current) return;

    let cancelled = false;
    backfillInFlightRef.current = true;

    const loadOlder = async () => {
      try {
        const beforeTimestamp = Math.floor(oldestMinuteTsRef.current! / 1000) - 60;
        if (beforeTimestamp <= 0) {
          setHasMoreHistory(false);
          return;
        }

        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=1&limit=${LIVE_POINTS}&before_timestamp=${beforeTimestamp}`
        );
        if (!res.ok || cancelled) {
          if (res.status !== 429) setHasMoreHistory(false);
          return;
        }

        const payload = await res.json();
        const rows = payload?.data?.attributes?.ohlcv_list;
        if (!Array.isArray(rows) || rows.length === 0) {
          setHasMoreHistory(false);
          return;
        }

        const older = rows
          .map((row: unknown) => {
            if (!Array.isArray(row) || row.length < 5) return null;
            const t = Number(row[0]) * 1000;
            const o = Number(row[1]);
            const h = Number(row[2]);
            const l = Number(row[3]);
            const c = Number(row[4]);
            if (![t, o, h, l, c].every(Number.isFinite)) return null;
            return { t, o, h, l, c };
          })
          .filter((p: CandlePoint | null): p is CandlePoint => p !== null)
          .sort((a, b) => a.t - b.t);

        if (older.length === 0) {
          setHasMoreHistory(false);
          return;
        }

        oldestMinuteTsRef.current = older[0].t;
        setBaseMinuteCandles((previous) => mergeCandlesUnique(previous, older));
      } catch {
        // keep currently loaded history
      } finally {
        backfillInFlightRef.current = false;
      }
    };

    loadOlder();
    return () => {
      cancelled = true;
    };
  }, [hasMoreHistory, maxPan, panOffset, poolAddress]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const candlePx = Math.max(4, (chartWidth - 74) / Math.max(1, viewSize));
      const dx = e.clientX - drag.startX;
      const shift = Math.round(-dx / candlePx);
      setPanOffset(clamp(drag.startPan + shift, 0, maxPan));
    };

    const onUp = () => {
      dragRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [maxPan, chartWidth, viewSize]);

  const plotted = useMemo(() => {
    const end = liveCandles.length - panOffset;
    const start = Math.max(0, end - viewSize);
    return liveCandles.slice(start, end);
  }, [liveCandles, panOffset, viewSize]);

  const chart = useMemo(() => {
    const width = chartWidth;
    const height = CHART_HEIGHT;
    const padLeft = 8;
    const padRight = 64;
    const padTop = 8;
    const padBottom = 44;
    const plotW = Math.max(1, width - padLeft - padRight);
    const plotH = Math.max(1, height - padTop - padBottom);

    if (plotted.length === 0) {
      return { width, height, padLeft, padRight, padTop, padBottom, plotW, plotH, min: 0, max: 1 };
    }

    const min = Math.min(...plotted.map((d) => d.l));
    const max = Math.max(...plotted.map((d) => d.h));
    const span = Math.max(1e-12, max - min);
    const yPad = span * 0.08;

    return {
      width,
      height,
      padLeft,
      padRight,
      padTop,
      padBottom,
      plotW,
      plotH,
      min: min - yPad,
      max: max + yPad,
    };
  }, [chartWidth, plotted]);

  const toX = (index: number) => chart.padLeft + ((index + 0.5) / Math.max(1, plotted.length)) * chart.plotW;
  const toY = (price: number) => {
    const t = (price - chart.min) / Math.max(1e-12, chart.max - chart.min);
    return chart.padTop + (1 - t) * chart.plotH;
  };

  const fireMarkers = useMemo(() => {
    const bucketMs = INTERVAL_CFG[selectedInterval].bucketMs;
    if (plotted.length === 0 || devBuyEvents.length === 0) return [];

    const chartStart = plotted[0].t;
    const chartEnd = plotted[plotted.length - 1].t + bucketMs;
    const byIndex = new Map<number, { idx: number; amount: number; t: number; txUrl?: string; count: number }>();

    devBuyEvents.forEach((event) => {
      if (event.ts < chartStart || event.ts >= chartEnd) return;
      const idx = clamp(Math.floor((event.ts - chartStart) / bucketMs), 0, plotted.length - 1);
      const current = byIndex.get(idx);
      if (!current) {
        byIndex.set(idx, { idx, amount: event.amount, t: plotted[idx].t, txUrl: event.txUrl, count: 1 });
        return;
      }
      current.amount += event.amount;
      current.count += 1;
      if (event.txUrl) current.txUrl = event.txUrl;
      byIndex.set(idx, current);
    });

    const markers = [...byIndex.values()].sort((a, b) => a.t - b.t);
    if (markers.length === 0) {
      return [];
    }
    return markers.slice(-18);
  }, [devBuyEvents, plotted, selectedInterval]);

  const topBurnEvents = useMemo(
    () =>
      devBuyEvents
        .filter((event) => Number.isFinite(event.ts) && event.ts > 0 && Number.isFinite(event.amount) && event.amount > 0 && Boolean(event.txUrl))
        .map((event) => ({
          ts: event.ts,
          amount: event.amount,
          txUrl: event.txUrl!,
        })),
    [devBuyEvents]
  );

  if (streamMode) {
    return (
      <div className="flex h-screen items-start justify-center overflow-hidden bg-background p-1 lg:p-2">
        <Dashboard streamMode data={data} isGlitching={false} isCtrlPressed={isCtrlPressed} topBurnEvents={topBurnEvents} />
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden bg-background">
      <div className="h-full p-0">
        <div className="grid h-full w-full items-start gap-3 overflow-hidden pr-2 lg:grid-cols-[1.95fr_0.7fr]">
          <Dashboard data={data} isGlitching={false} isCtrlPressed={isCtrlPressed} topBurnEvents={topBurnEvents} />

          <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden pt-1">
            <div className="keycap-inset shrink-0 p-3">
              <h2 className="mb-2 text-center font-mono text-sm font-bold uppercase tracking-[0.2em]">What Is $CTRL?</h2>
              <p className="text-center font-mono text-xs leading-relaxed text-muted-foreground">
                <strong className="text-foreground">$CTRL (Continuous Token Reduction Loop)</strong> is an AI-orchestrated
                on-chain burn engine powered by <strong className="text-foreground">Grok AI</strong>. Every
                <strong className="text-foreground"> 69 seconds</strong>, it drives the full cycle:
                claim rewards, buy back $CTRL, and burn to the incinerator with fully verifiable
                on-chain execution.
              </p>
            </div>

            <div className="keycap-inset ctrl-loop-panel shrink-0 p-3">
              <h2 className="mb-2 text-center font-mono text-sm font-bold uppercase tracking-[0.2em]">The Loop</h2>
              <span className="ctrl-loop-panel-runner" aria-hidden="true">
                <span className="ctrl-loop-panel-coin">
                  <img src={fireSolanaPng} alt="" className="ctrl-loop-panel-coin-art" draggable={false} />
                </span>
              </span>
              <div className="space-y-2">
                {LOOP_STEPS.map((item) => (
                  <div key={item.step} className="flex items-start gap-3">
                    <span className="shrink-0 font-mono text-base font-bold text-muted-foreground">{item.step}</span>
                    {item.step === "01" ? (
                      <span className="ctrl-loop-icon ctrl-loop-icon-coin" aria-hidden="true">
                        <span className="ctrl-loop-coin-face" />
                      </span>
                    ) : item.step === "02" ? (
                      <span className="ctrl-loop-icon ctrl-loop-icon-cart" aria-hidden="true">
                        <span className="ctrl-loop-cart-body" />
                        <span className="ctrl-loop-cart-wheel ctrl-loop-cart-wheel-a" />
                        <span className="ctrl-loop-cart-wheel ctrl-loop-cart-wheel-b" />
                      </span>
                    ) : item.step === "03" ? (
                      <span className="ctrl-loop-icon ctrl-loop-icon-flame" aria-hidden="true">
                        <span className="ctrl-loop-flame-inner" />
                      </span>
                    ) : item.step === "04" ? (
                      <span className="ctrl-stopwatch" aria-hidden="true">
                        <span className="ctrl-stopwatch-ticks" />
                        <span className="ctrl-stopwatch-crown" />
                        <span
                          className="ctrl-stopwatch-hand"
                          style={{ animationDuration: "69s", animationDelay: `${stopwatchDelayMs}ms` }}
                        />
                      </span>
                    ) : (
                      <span className="shrink-0 text-lg">{item.icon}</span>
                    )}
                    <div>
                      <div className="font-mono text-xs font-bold uppercase tracking-wider">{item.title}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{item.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="keycap-inset ctrl-transparency-sheen shrink-0 p-3">
              <h2 className="mb-2 text-center font-mono text-sm font-bold uppercase tracking-[0.2em]">Transparency</h2>
              <p className="text-center font-mono text-xs leading-relaxed text-muted-foreground">
                Total transparency. No trust required. Every transaction is verifiable on-chain.
                The Grok AI bot runs publicly, the observer is live, and every burn is linked to a Solscan transaction.
                Of creator rewards, 10% is allocated to the developer/API operations and 90% is used for buybacks and burns.
              </p>
            </div>

            <div id="ctrl-burn-wallet" data-key="ctrl.wallets.burnWalletAddress" className="keycap-inset ctrl-wallet-burn-bg shrink-0 p-3 text-center font-mono text-xs">
              <canvas ref={fireCanvasRef} className="ctrl-wallet-fire-canvas" aria-hidden="true" />
              <div className="ctrl-wallet-readplate">
                <span className="text-[10px] uppercase tracking-wider text-white/90">Burn Wallet: </span>
                <a
                  href={data.wallets.burnWalletSolscanUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-bold text-ctrl-blue hover:underline"
                >
                  {data.wallets.burnWalletAddress}
                </a>
                <div className="mt-2">
                  <span className="text-[10px] uppercase tracking-wider text-white/90">Contract Address: </span>
                  <a
                    href={data.wallets.contractSolscanUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-bold text-ctrl-blue hover:underline"
                  >
                    {data.wallets.contractAddress}
                  </a>
                </div>
              </div>
            </div>

            <div id="ctrl-market-embed" className="keycap-inset mb-1 mt-auto shrink-0 p-2">
              <div className="mb-2 flex items-center gap-1 font-mono text-[10px]">
                {INTERVALS.map((interval) => (
                  <button
                    key={interval}
                    type="button"
                    onClick={() => setSelectedInterval(interval)}
                    className={
                      selectedInterval === interval
                        ? "rounded border border-ctrl-blue bg-ctrl-blue/15 px-2 py-0.5 text-ctrl-blue"
                        : "rounded border border-border bg-background/50 px-2 py-0.5 text-muted-foreground hover:text-foreground"
                    }
                  >
                    {interval}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setViewSize((v) => clamp(v + 12, 24, MAX_VIEW_POINTS))}
                  className="ml-auto rounded border border-border bg-background/50 px-2 py-0.5 text-muted-foreground hover:text-foreground"
                >
                  -
                </button>
                <button
                  type="button"
                  onClick={() => setViewSize((v) => clamp(v - 12, 24, MAX_VIEW_POINTS))}
                  className="rounded border border-border bg-background/50 px-2 py-0.5 text-muted-foreground hover:text-foreground"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPanOffset(0);
                    setViewSize(INTERVAL_CFG[selectedInterval].defaultView);
                  }}
                  className="rounded border border-border bg-background/50 px-2 py-0.5 text-muted-foreground hover:text-foreground"
                >
                  Live
                </button>
              </div>

              <div
                ref={marketChartRef}
                className="relative -mt-0.5 h-[240px] select-none cursor-grab overflow-hidden rounded-md border border-border/60 bg-background/60 active:cursor-grabbing"
                onMouseDown={(e) => {
                  e.preventDefault();
                  dragRef.current = { startX: e.clientX, startPan: panOffset };
                }}
                onMouseLeave={() => setMarkerHover(null)}
                onWheel={(e) => {
                  e.preventDefault();
                  const delta = e.deltaY > 0 ? 12 : -12;
                  setViewSize((v) => clamp(v + delta, 24, MAX_VIEW_POINTS));
                }}
              >
                <svg width={chart.width} height={chart.height} viewBox={`0 0 ${chart.width} ${chart.height}`} preserveAspectRatio="none">
                  <rect x="0" y="0" width={chart.width} height={chart.height} fill="transparent" />

                  {[0, 1, 2, 3, 4].map((i) => {
                    const y = chart.padTop + (i / 4) * chart.plotH;
                    const price = chart.max - (i / 4) * (chart.max - chart.min);
                    const labelY = i === 4 ? y - 2 : y + 3;
                    return (
                      <g key={`g-${i}`}>
                        <line x1={chart.padLeft} y1={y} x2={chart.padLeft + chart.plotW} y2={y} stroke="hsl(var(--border) / 0.35)" strokeWidth="1" />
                        <text x={chart.padLeft + chart.plotW + 4} y={labelY} fill="hsl(var(--muted-foreground))" fontSize="10" fontFamily="monospace">
                          {price.toFixed(8)}
                        </text>
                      </g>
                    );
                  })}

                  {plotted.map((candle, i) => {
                    const x = toX(i);
                    const yOpen = toY(candle.o);
                    const yClose = toY(candle.c);
                    const yHigh = toY(candle.h);
                    const yLow = toY(candle.l);
                    const bodyTop = Math.min(yOpen, yClose);
                    const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));
                    const bodyWidth = Math.max(2, (chart.plotW / Math.max(1, plotted.length)) * 0.64);
                    const color = candle.c >= candle.o ? "#22c55e" : "#ef4444";
                    return (
                      <g key={candle.t}>
                        <line x1={x} y1={yHigh} x2={x} y2={yLow} stroke={color} strokeWidth="1.2" />
                        <rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} fill={color} rx="0.8" />
                      </g>
                    );
                  })}

                  {fireMarkers.map((marker) => {
                    const candle = plotted[marker.idx];
                    const x = toX(marker.idx);
                    const y = Math.max(chart.padTop + 10, toY(candle.h) - 12);
                    const txSuffix = marker.txUrl ? marker.txUrl.split("/").pop()?.slice(0, 10) : "";
                    const tooltip = `Grok bought + burned ${formatTokenAmount(marker.amount)} tokens${txSuffix ? ` • ${txSuffix}...` : ""}`;
                    return (
                      <g
                        key={`fire-${marker.t}`}
                        className="ctrl-chart-fire-marker"
                        style={{ cursor: "help" }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                        }}
                        onMouseEnter={() => setMarkerHover({ x, y: y - 10, text: tooltip })}
                        onMouseMove={() => setMarkerHover({ x, y: y - 10, text: tooltip })}
                        onMouseLeave={() => setMarkerHover(null)}
                      >
                        <circle cx={x} cy={y - 2} r={10} fill="transparent" />
                        <text x={x} y={y + 2} textAnchor="middle" fontSize="14">
                          {"\u{1F525}"}
                        </text>
                      </g>
                    );
                  })}

                  {plotted.length > 0 && [0.15, 0.5, 0.85].map((r, i) => {
                    const idx = Math.min(plotted.length - 1, Math.max(0, Math.floor((plotted.length - 1) * r)));
                    const candle = plotted[idx];
                    const x = toX(idx);
                    const label = new Date(candle.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
                    return (
                      <g key={`t-${i}`}>
                        <line x1={x} y1={chart.padTop + chart.plotH} x2={x} y2={chart.padTop + chart.plotH + 4} stroke="hsl(var(--muted-foreground))" strokeWidth="1" />
                        <text x={x} y={chart.height - 10} textAnchor="middle" fill="hsl(var(--muted-foreground))" fontSize="10" fontFamily="monospace">
                          {label}
                        </text>
                      </g>
                    );
                  })}
                </svg>
                {markerHover && (
                  <div
                    className="pointer-events-none absolute z-20 whitespace-nowrap rounded border border-border bg-background/95 px-2 py-1 font-mono text-[10px] text-foreground shadow-lg"
                    style={{
                      left: `${Math.max(8, Math.min(chart.width - 220, markerHover.x - 105))}px`,
                      top: `${Math.max(8, markerHover.y - 26)}px`,
                    }}
                  >
                    {markerHover.text}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Index;




