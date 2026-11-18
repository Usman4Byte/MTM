// GET /api/config — what the server is configured to use (never returns the key itself).
import { NextResponse } from "next/server";
import { LIMITS } from "@/lib/agent/pipeline";
import { llmConfigFromEnv } from "@/lib/llm/gemini";
import { policyFromEnv } from "@/lib/planner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const llm = llmConfigFromEnv();
  const policy = policyFromEnv();
  return NextResponse.json({
    model: llm.model,
    models: llm.models,
    hasKey: Boolean(llm.apiKey),
    keyCount: llm.apiKeys.length,
    thinkingBudget: llm.thinkingBudget ?? null,
    judgePolicy: policy.judgePolicy,
    defaultStart: policy.defaultStart,
    limits: { full: { maxCalls: LIMITS.full.maxCalls, maxMs: LIMITS.full.maxMs }, update: { maxCalls: LIMITS.update.maxCalls, maxMs: LIMITS.update.maxMs } },
  });
}
