import { useEffect, useMemo, useRef, useState } from "react";
import { MOCK_DATA, type CtrlData, type CtrlStatus, type CtrlSnapshotResponse, type TerminalEvent } from "@/data/mockData";

interface WsSnapshotMessage {
  type: "snapshot";
  payload: CtrlSnapshotResponse;
}

interface WsPatchMessage {
  type: "patch";
  payload: { ctrl: Partial<CtrlData> };
}

interface WsTerminalMessage {
  type: "terminal";
  payload: TerminalEvent;
}

type WsMessage = WsSnapshotMessage | WsPatchMessage | WsTerminalMessage;

const CYCLE_SECONDS = 69;
const CYCLE_STORAGE_KEY = "ctrl.cycles.persist.v1";
const CYCLE_FALLBACK_FLOOR = 69;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeDeep<T extends Record<string, unknown>>(target: T, patch: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...target };

  Object.entries(patch).forEach(([key, value]) => {
    const current = next[key];
    if (isObject(current) && isObject(value)) {
      next[key] = mergeDeep(current, value);
      return;
    }

    next[key] = value;
  });

  return next as T;
}

function normalizeStatus(status: string): CtrlStatus {
  if (status === "WAITING" || status === "EXECUTING_BUY" || status === "BURNING" || status === "CONFIRMED" || status === "ERROR") {
    return status;
  }
  return "WAITING";
}

function normalizeCtrl(raw: CtrlData): CtrlData {
  const merged = mergeDeep(MOCK_DATA as Record<string, unknown>, raw as Record<string, unknown>) as CtrlData;
  return {
    ...merged,
    status: normalizeStatus(merged.status),
    terminal: {
      events: Array.isArray(merged.terminal?.events) ? merged.terminal.events.slice(-200) : [],
    },
  };
}

function getWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/api/ctrl/ws`;
}

export function useCtrlData() {
  const [data, setData] = useState<CtrlData>(MOCK_DATA);
  const [tokenMint, setTokenMint] = useState<string>(import.meta.env.VITE_TOKEN_MINT_ADDRESS ?? "");
  const [isGlitching] = useState(false);
  const [isCtrlPressed, setIsCtrlPressed] = useState(false);

  const cycleSecondsRef = useRef<number>(CYCLE_SECONDS);
  const pollIntervalRef = useRef<number | null>(null);
  const lastTerminalPushAtRef = useRef<number>(0);
  const cycleFloorRef = useRef<number>(CYCLE_FALLBACK_FLOOR);

  const applyCyclePersistence = (cyclesTotal: number) => {
    const incoming = Number.isFinite(cyclesTotal) ? Math.max(0, Math.floor(cyclesTotal)) : 0;
    const next = Math.max(cycleFloorRef.current, incoming, CYCLE_FALLBACK_FLOOR);
    cycleFloorRef.current = next;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(CYCLE_STORAGE_KEY, String(next));
      } catch {
        // ignore storage errors
      }
    }
    return next;
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(CYCLE_STORAGE_KEY);
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) {
        cycleFloorRef.current = Math.max(CYCLE_FALLBACK_FLOOR, Math.floor(n));
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  const setFromSnapshot = (snapshot: CtrlSnapshotResponse) => {
    cycleSecondsRef.current = snapshot.cycleSeconds || CYCLE_SECONDS;
    if (typeof snapshot.tokenMint === "string" && snapshot.tokenMint.trim() !== "") {
      setTokenMint(snapshot.tokenMint);
    }
    const next = normalizeCtrl(snapshot.ctrl);
    next.cycles.total = applyCyclePersistence(next.cycles?.total ?? 0);
    setData(next);
  };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const stopPolling = () => {
      if (pollIntervalRef.current !== null) {
        window.clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };

    const pollState = async () => {
      try {
        const res = await fetch("/api/ctrl/state", { cache: "no-store" });
        if (!res.ok) return;
        const snapshot = (await res.json()) as CtrlSnapshotResponse;
        setFromSnapshot(snapshot);
      } catch {
        // keep existing in-memory state
      }
    };

    const startPolling = () => {
      if (pollIntervalRef.current !== null) return;
      pollState();
      pollIntervalRef.current = window.setInterval(pollState, 2000);
    };

    const connectWs = () => {
      stopPolling();
      ws = new WebSocket(getWsUrl());

      ws.onmessage = (event) => {
        let parsed: WsMessage;
        try {
          parsed = JSON.parse(event.data) as WsMessage;
        } catch {
          return;
        }

        if (parsed.type === "snapshot") {
          setFromSnapshot(parsed.payload);
          return;
        }

        if (parsed.type === "patch") {
          setData((prev) => {
            const next = normalizeCtrl(
              mergeDeep(prev as Record<string, unknown>, parsed.payload.ctrl as Record<string, unknown>) as CtrlData
            );
            next.cycles.total = applyCyclePersistence(next.cycles?.total ?? 0);
            return next;
          });
          return;
        }

        if (parsed.type === "terminal") {
          setData((prev) => ({
            ...prev,
            terminal: (() => {
              const incoming = parsed.payload;
              const msg = String(incoming?.message ?? "").trim();
              if (!msg) return prev.terminal;

              // Drop malformed glyph-only fragments.
              if (msg.length <= 3 && /^[^\w\d]+$/i.test(msg)) return prev.terminal;
              if (msg.length <= 6 && /^(?:�|🔥|🟣|🟡|🟢|❌|✅|🧾|📊|\s)+$/u.test(msg)) return prev.terminal;

              const now = Date.now();
              const events = [...prev.terminal.events];
              const last = events[events.length - 1];

              if (last) {
                const lastMsg = String(last.message ?? "").trim();
                const lastTs = new Date(last.timestamp).getTime();
                const curTs = new Date(incoming.timestamp).getTime();
                const sameType = last.type === incoming.type;
                const nearTs = Number.isFinite(lastTs) && Number.isFinite(curTs) && Math.abs(curTs - lastTs) <= 1500;

                if (sameType && nearTs) {
                  if (msg.startsWith(lastMsg)) {
                    events[events.length - 1] = incoming;
                    lastTerminalPushAtRef.current = now;
                    return { events: events.slice(-200) };
                  }
                  if (lastMsg.startsWith(msg)) {
                    return prev.terminal;
                  }
                }

                if (sameType && msg === lastMsg) {
                  return prev.terminal;
                }
              }

              // Emergency anti-flood guard.
              if (now - lastTerminalPushAtRef.current < 80) {
                return prev.terminal;
              }
              lastTerminalPushAtRef.current = now;

              return { events: [...events, incoming].slice(-200) };
            })(),
          }));
        }
      };

      ws.onclose = () => {
        startPolling();
        reconnectTimer = window.setTimeout(connectWs, 2000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    pollState();
    connectWs();

    return () => {
      stopPolling();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setData((prev) => {
        if (prev.status === "ERROR" || prev.status === "EXECUTING_BUY" || prev.status === "BURNING") {
          return prev;
        }

        const lastBurnMs = new Date(prev.lastBurn.timestamp).getTime();
        const elapsed = Math.max(0, Math.floor((Date.now() - lastBurnMs) / 1000));
        const cycle = cycleSecondsRef.current || CYCLE_SECONDS;
        const remainingSeconds = Math.max(0, cycle - (elapsed % cycle));
        const progress01 = Number(((cycle - remainingSeconds) / cycle).toFixed(4));

        if (remainingSeconds === prev.nextBurn.remainingSeconds && progress01 === prev.nextBurn.progress01) {
          return prev;
        }

        return {
          ...prev,
          nextBurn: { remainingSeconds, progress01 },
        };
      });
    }, 250);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (data.status === "CONFIRMED") {
      setIsCtrlPressed(true);
      const timeout = window.setTimeout(() => setIsCtrlPressed(false), 250);
      return () => window.clearTimeout(timeout);
    }
  }, [data.status]);

  const derived = useMemo(() => ({ data, tokenMint, isGlitching, isCtrlPressed }), [data, tokenMint, isGlitching, isCtrlPressed]);

  return derived;
}
