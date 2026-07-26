import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? "null"} signal ${signal ?? "none"}`));
    });
  });
}

function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  let settled = false;
  let exit;
  const exited = new Promise((resolve, reject) => {
    exit = (code, signal) => {
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? "null"} signal ${signal ?? "none"}`));
    };
    child.once("error", (error) => {
      settled = true;
      reject(error);
    });
    child.once("exit", exit);
  });
  return {
    child,
    exited,
    get settled() {
      return settled;
    },
  };
}

async function stopTracked(process) {
  if (process.settled) return;
  process.child.kill("SIGTERM");
  await Promise.race([process.exited.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (!process.settled) process.child.kill("SIGKILL");
  if (!process.settled) await process.exited.catch(() => undefined);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve PostgreSQL port");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForPostgres(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await run("pg_isready", ["-h", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("PostgreSQL did not become ready");
}

const root = await mkdtemp(join(tmpdir(), "vicissitude-postgres-"));
const data = join(root, "data");
const socket = join(root, "socket");
const port = await reservePort();
let postgresProcess;
let testError;

try {
  await mkdir(socket);
  await run("initdb", ["-D", data, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"]);
  postgresProcess = spawnTracked("postgres", ["-D", data, "-h", "127.0.0.1", "-p", String(port), "-k", socket], {
    stdio: "inherit",
  });
  await Promise.race([waitForPostgres(port), postgresProcess.exited]);
  await run("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "vicissitude_test"]);
  await run("pnpm", ["exec", "vitest", "run", "spec"], {
    env: {
      ...process.env,
      TEST_DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/vicissitude_test`,
      VICISSITUDE_MIGRATIONS_DIR: "migrations",
    },
  });
} catch (error) {
  testError = error;
} finally {
  if (postgresProcess) await stopTracked(postgresProcess);
  await rm(root, { recursive: true, force: true });
}

if (testError) throw testError;
