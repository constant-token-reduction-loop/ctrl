import { spawn } from "node:child_process";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

const children = [];

function start(name, command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: true,
    env: process.env,
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

start("ui", "npm", ["--prefix", "ctrl-burn-dashboard-main/ctrl-burn-dashboard-main", "run", "prod:ui"]);
start("api", "npm", ["--prefix", "ctrl-burn-dashboard-main/ctrl-burn-dashboard-main", "run", "prod:api"]);
start("burner", "npm", ["--prefix", "autoburner", "run", "start"]);

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
