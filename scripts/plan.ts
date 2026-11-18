// One command for everything:  npm run plan -- <file-or-folder> [...]
// First call on an empty state = full run; every later call = update. Same pipeline, no per-message flags.
// State lives in .mtm/state.json (local machine). Outputs go to runs/.
//   npm run plan -- pack.txt          initial pack (or any supported file type)
//   npm run plan -- update1.txt       an update, same command
//   echo "message" | npm run plan     pasted text via stdin
//   npm run plan:reset                start a fresh project

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { newProject, runPipeline } from "../src/lib/agent/pipeline";
import type { RawInput } from "../src/lib/ingest";
import { llmConfigFromEnv } from "../src/lib/llm/gemini";
import { policyFromEnv } from "../src/lib/planner";
import { formatPlan, formatRun, formatTrace } from "../src/lib/report";
import type { ProjectState } from "../src/lib/types";

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);

const STATE_DIR = resolve(".mtm");
const STATE_FILE = join(STATE_DIR, "state.json");
const OUT_DIR = resolve("runs");

function collect(paths: string[]): RawInput[] {
  const out: RawInput[] = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) {
        const fp = join(p, name);
        if (statSync(fp).isFile()) out.push({ name, bytes: new Uint8Array(readFileSync(fp)) });
      }
    } else out.push({ name: basename(p), bytes: new Uint8Array(readFileSync(p)) });
  }
  return out;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--reset")) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    console.log("State cleared. The next `npm run plan -- <file>` is a full run.");
    return;
  }
  const files = collect(args);
  const pasted = files.length ? "" : await readStdin();
  if (!files.length && !pasted.trim()) {
    console.error("Usage: npm run plan -- <file-or-folder> [...]   (or pipe text on stdin)");
    process.exit(2);
  }
  const state: ProjectState = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : newProject("CLI project");
  const llm = llmConfigFromEnv();
  console.log(`Model: ${llm.model} | mode: ${state.messages.length ? "update" : "full run"} | inputs: ${files.map((f) => f.name).join(", ") || "stdin"}`);

  const { state: next, run } = await runPipeline({ state, files, pasted, llm, policy: policyFromEnv() });

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  mkdirSync(OUT_DIR, { recursive: true });
  const plan = next.plans[next.plans.length - 1];
  writeFileSync(join(OUT_DIR, "trace.txt"), formatTrace(next));
  writeFileSync(join(OUT_DIR, "trace.json"), JSON.stringify(next.runs, null, 2));
  if (plan) {
    writeFileSync(join(OUT_DIR, "plan.md"), formatPlan(plan, next));
    writeFileSync(join(OUT_DIR, "plan.json"), JSON.stringify(plan, null, 2));
  }

  console.log(formatRun(run, { state: next }));
  if (plan) {
    console.log("\n" + formatPlan(plan, next));
  }
  const all = next.runs.reduce((s, r) => s + r.totals.totalTokens, 0);
  console.log(`\nAll runs so far: ${next.runs.reduce((s, r) => s + r.calls.length, 0)} model calls, ${all} tokens (API-reported).`);
  console.log(`Saved: runs/plan.md, runs/plan.json, runs/trace.txt, runs/trace.json (state: .mtm/state.json)`);
  if (run.aborted) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
