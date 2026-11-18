// POST /api/run — the single entry point for full runs and updates.
// Stateless: the browser sends its saved project state (from local storage) plus new files/text,
// the server runs the pipeline with the server-side Gemini key and returns the new state.

import { NextResponse } from "next/server";
import { newProject, runPipeline } from "@/lib/agent/pipeline";
import { MAX_FILE_BYTES, type RawInput } from "@/lib/ingest";
import { llmConfigFromEnv } from "@/lib/llm/gemini";
import { policyFromEnv } from "@/lib/planner";
import type { ProjectState } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data (Vercel caps request bodies at 4.5 MB)." }, { status: 400 });
  }
  const rawState = form.get("state");
  let state: ProjectState;
  try {
    state = typeof rawState === "string" && rawState ? (JSON.parse(rawState) as ProjectState) : newProject();
    if (!Array.isArray(state.messages) || !Array.isArray(state.facts) || !state.counters) throw new Error("bad state");
  } catch {
    return NextResponse.json({ error: "Saved project state is not valid JSON." }, { status: 400 });
  }
  // The browser keeps past run traces itself; the server only needs counters, messages, facts and plans.
  const priorRuns = state.runs ?? [];
  state.runs = [];

  const files: RawInput[] = [];
  for (const entry of form.getAll("files")) {
    if (typeof entry === "string") continue;
    // oversize files are passed through so ingestion reports them (too_large) instead of dropping them
    void MAX_FILE_BYTES;
    files.push({ name: entry.name || "upload", bytes: new Uint8Array(await entry.arrayBuffer()), mime: entry.type || undefined });
  }
  const text = form.get("text");
  const pasted = typeof text === "string" ? text : "";
  if (!files.length && !pasted.trim()) return NextResponse.json({ error: "Nothing to process: add a file or paste a message." }, { status: 400 });

  try {
    const { state: next, run } = await runPipeline({ state, files, pasted, llm: llmConfigFromEnv(), policy: policyFromEnv() });
    next.runs = [...priorRuns, ...next.runs];
    return NextResponse.json({ state: next, run });
  } catch (err) {
    return NextResponse.json({ error: `Pipeline error: ${(err as Error).message}` }, { status: 500 });
  }
}
