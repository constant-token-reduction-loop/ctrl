import { spawn } from "node:child_process";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

const children = [];

function start(name, command, args, envOverrides = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...envOverrides },
  });

  child.on("exit", (code, signal) => {
    const why = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`[runner] ${name} exited with ${why}`);
  });

  child.on("error", (err) => {
    console.error(`[runner] ${name} failed: ${err.message}`);
  });

  children.push(child);
}

function looksLikePlaceholder(value) {
  const v = String(value ?? "").trim();
  if (!v) return true;
  return (
    /^your[_\-\s]/i.test(v) ||
    v.includes("YOUR_") ||
    v.includes("_TOKEN_MINT") ||
    v.includes("_CONTRACT_ADDRESS")
  );
}

function resolveMint(env) {
  const candidates = [env.MINT, env.TOKEN_MINT_ADDRESS, env.CONTRACT_ADDRESS]
    .map((v) => String(v ?? "").trim())
    .filter((v) => v.length > 0 && !looksLikePlaceholder(v));
  return candidates[0] ?? "";
}

const runBurnerMode = String(process.env.CTRL_RUN_BURNER ?? "auto").toLowerCase();
const mint = resolveMint(process.env);
const shouldRunBurner =
  !(runBurnerMode === "0" || runBurnerMode === "false" || runBurnerMode === "no");

const apiEnvOverrides = shouldRunBurner
  ? {}
  : {
      CTRL_WORKER_EVENTS_URL: "",
      CTRL_WORKER_STATUS_URL: "",
    };

start("ui", "npm", ["--prefix", "ctrl-burn-dashboard-main/ctrl-burn-dashboard-main", "run", "prod:ui"]);
start(
  "api",
  "npm",
  ["--prefix", "ctrl-burn-dashboard-main/ctrl-burn-dashboard-main", "run", "prod:api"],
  apiEnvOverrides
);

if (shouldRunBurner) {
  start("burner", "npm", ["--prefix", "autoburner", "run", "start"]);
} else {
  console.warn(
    "[runner] burner skipped (CTRL_RUN_BURNER=false)."
  );
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
