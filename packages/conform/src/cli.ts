#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { runConformance, type ConformConfig, type ConformReport } from "./index.js";

const HELP = `boundary-conform — prove an HTTP API honors the Boundary error contract.

Usage:
  boundary-conform <baseUrl> [options]

Options:
  --config <path>    Probe configuration (default: ./boundary-conform.json if present)
  --reporter <name>  "pretty" (default) or "json"
  --help             Show this help

The suite is black-box: it only speaks HTTP. Configure probes for the
checks that need a route on your API (validation, 429/503, redirects):

  {
    "probes": {
      "validation":  { "method": "POST", "path": "/orders", "body": {} },
      "rateLimited": { "path": "/rate-limited" },
      "unavailable": { "path": "/unavailable" },
      "redirect":    { "path": "/old-path" },
      "errors":      [{ "path": "/boom" }]
    }
  }

Exit code is 0 when every non-skipped check passes, 1 otherwise.`;

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

function printPretty(report: ConformReport): void {
  const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  const paint = (color: string, text: string) => (useColor ? `${color}${text}${RESET}` : text);
  console.log(`boundary-conform against ${report.baseUrl}\n`);
  for (const result of report.results) {
    if (result.status === "pass") {
      console.log(`${paint(GREEN, "✓")} ${result.title}`);
    } else if (result.status === "skip") {
      console.log(`${paint(DIM, `- ${result.title} (skipped: ${result.details?.[0] ?? "no probe"})`)}`);
    } else {
      console.log(`${paint(RED, "✗")} ${result.title}`);
      for (const detail of result.details ?? []) {
        console.log(`    ${paint(RED, detail)}`);
      }
    }
  }
  console.log(
    `\n${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`,
  );
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: "string" },
      reporter: { type: "string", default: "pretty" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length !== 1) {
    console.log(HELP);
    return values.help ? 0 : 2;
  }

  const baseUrl = positionals[0]!;
  let config: ConformConfig = {};
  const configPath = values.config ?? (existsSync("boundary-conform.json") ? "boundary-conform.json" : undefined);
  if (configPath) {
    try {
      config = JSON.parse(await readFile(configPath, "utf8")) as ConformConfig;
    } catch (error) {
      console.error(`Could not read config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  const report = await runConformance(baseUrl, config);
  if (values.reporter === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printPretty(report);
  }
  return report.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(2);
  },
);
