// Smoke test: boot the example server, run the boundary-conform CLI
// against it over real HTTP, exit with the CLI's exit code.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 4123;
const baseUrl = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, [path.join(root, "examples/express-basic/server.mjs")], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "inherit", "inherit"],
});

async function waitForReady(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/orders/ord_1001`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("example server did not come up in time");
}

let exitCode = 1;
try {
  await waitForReady();
  exitCode = await new Promise((resolve) => {
    const cli = spawn(
      process.execPath,
      [
        path.join(root, "packages/conform/dist/cli.js"),
        baseUrl,
        "--config",
        path.join(root, "examples/express-basic/boundary-conform.json"),
      ],
      { stdio: "inherit" },
    );
    cli.on("exit", (code) => resolve(code ?? 1));
  });
} finally {
  server.kill("SIGTERM");
}
process.exit(exitCode);
