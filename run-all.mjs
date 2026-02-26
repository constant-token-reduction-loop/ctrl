import { spawn } from "node:child_process";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

const children = new Map();
let shuttingDown = false;

function startManaged(name, command, args, options = {}) {
  const {
    envOverrides = {},
    restartOnFail = false,
    restartDelayMs = 5000,
  } = options;

  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...envOverrides },
  });

  children.set(name, { child, command, args, options });

  child.on("exit", (code, signal) => {
    const why = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`[runner] ${name} exited with ${why}`);

    if (shuttingDown) return;

    if (restartOnFail && code !== 0) {
      console.error(`[runner] restarting ${name} in ${Math.round(restartDelayMs / 1000)}s...`);
      setTimeout(() => {
        if (!shuttingDown) startManaged(name, command, args, options);
      }, restartDelayMs);
    }
  });

  child.on("error", (err) => {
    console.error(`[runner] ${name} failed: ${err.message}`);
  });
}

const runBurnerMode = String(process.env.CTRL_RUN_BURNER ?? "auto").toLowerCase();
const shouldRunBurner = !(runBurnerMode === "0" || runBurnerMode === "false" || runBurnerMode === "no");

startManaged("ui", "npm", ["--prefix", "ctrl-burn-dashboard-main/ctrl-burn-dashboard-main", "run", "prod:ui"], {
  restartOnFail: true,
  restartDelayMs: 4000,
});
startManaged("api", "npm", ["--prefix", "ctrl-burn-dashboard-main/ctrl-burn-dashboard-main", "run", "prod:api"], {
  restartOnFail: true,
  restartDelayMs: 4000,
});

if (shouldRunBurner) {
  startManaged("burner", "npm", ["--prefix", "autoburner", "run", "start"], {
    restartOnFail: true,
    restartDelayMs: 8000,
  });
} else {
  console.warn("[runner] burner skipped (CTRL_RUN_BURNER=false).");
}

function shutdown() {
  shuttingDown = true;
  for (const { child } of children.values()) {
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
