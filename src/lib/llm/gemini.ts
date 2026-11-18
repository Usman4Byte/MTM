// Thin Gemini REST client. Server-side only: the API key never reaches the browser.
// Every attempt (including retries and failures) is recorded as a numbered ModelCall
// with the token counts exactly as the API reports them (null when the API sends none).

import type { CallTag, ModelCall } from "../types";

export interface LlmConfig {
  apiKey: string;
  /** primary model (first of the chain) */
  model: string;
  /** fallback chain: attempt k uses models[k-1] (last one repeats). Overload/rate-limit/timeout moves down the chain. */
  models: string[];
  /** thinking budget for Gemini 2.5 models; 0 disables thinking (fewer tokens). Ignored when undefined. */
  thinkingBudget?: number;
}

export function llmConfigFromEnv(): LlmConfig {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
  const chain = (process.env.GEMINI_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const primary = (process.env.GEMINI_MODEL ?? "").trim();
  const models = [...new Set([...(primary ? [primary] : []), ...(chain.length ? chain : DEFAULT_CHAIN)])];
  const model = models[0];
  const tb = process.env.GEMINI_THINKING_BUDGET;
  let thinkingBudget: number | undefined;
  if (tb !== undefined && tb !== "") thinkingBudget = Number(tb);
  else if (/gemini-2\.5-flash/.test(model)) thinkingBudget = 0;
  return { apiKey, model, models, thinkingBudget };
}

/** Fastest/leanest first (benchmarked on the sample pack), then higher-availability fallbacks. */
export const DEFAULT_CHAIN = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemma-4-26b-a4b-it"];

export class CallBudgetExceeded extends Error {}
export class DeadlineExceeded extends Error {}

/** Shared limits for one run: max model calls (retries count) and a wall-clock deadline. */
export class CallBudget {
  used = 0;
  constructor(
    public readonly maxCalls: number,
    public readonly deadline: number,
  ) {}
  remaining(): number {
    return this.maxCalls - this.used;
  }
  msLeft(): number {
    return this.deadline - Date.now();
  }
}

export interface CallRequest {
  area: CallTag;
  system: string;
  user: string;
  schema: object;
}

export interface CallOutcome {
  json: unknown | null;
  call: ModelCall;
}

export class GeminiClient {
  constructor(
    private cfg: LlmConfig,
    private budget: CallBudget,
    private nextCallNumber: () => number,
    private runId: number,
    private onCall: (c: ModelCall) => void,
  ) {}

  /** One logical request. Failed attempts move down the model chain while budget and time allow. */
  async callJson(req: CallRequest, maxAttempts = 3): Promise<unknown> {
    let lastErr = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.budget.remaining() <= 0) throw new CallBudgetExceeded(`model-call limit of ${this.budget.maxCalls} reached`);
      if (this.budget.msLeft() < 3000) throw new DeadlineExceeded("not enough time left for another model call");
      const { json, call } = await this.attempt(req, attempt);
      this.onCall(call);
      if (call.ok && json !== null) return json;
      lastErr = call.error ?? "unknown error";
      if (/\b(400|401|403|404)\b/.test(lastErr)) break; // not retryable
    }
    throw new Error(`model call failed (${req.area}): ${lastErr}`);
  }

  private async attempt(req: CallRequest, attempt: number): Promise<CallOutcome> {
    this.budget.used++;
    const n = this.nextCallNumber();
    const model = this.cfg.models[Math.min(attempt - 1, this.cfg.models.length - 1)] ?? this.cfg.model;
    const gemma = /^gemma/i.test(model);
    const t0 = Date.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const generationConfig: Record<string, unknown> = {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: req.schema,
    };
    if (gemma) delete generationConfig.responseSchema; // Gemma: JSON mode only; the prompt describes the shape
    if (!gemma && /gemini-2\.5/.test(model) && this.cfg.thinkingBudget !== undefined && Number.isFinite(this.cfg.thinkingBudget)) {
      generationConfig.thinkingConfig = { thinkingBudget: this.cfg.thinkingBudget };
    }
    // Gemma has no system role: the rules go first in the user turn instead.
    const body = gemma
      ? { contents: [{ role: "user", parts: [{ text: `${req.system}\n\nReply with JSON only, shaped as: ${JSON.stringify(req.schema)}\n\n${req.user}` }] }], generationConfig }
      : { systemInstruction: { parts: [{ text: req.system }] }, contents: [{ role: "user", parts: [{ text: req.user }] }], generationConfig };
    const input = gemma ? `[user]\n${body.contents[0].parts[0].text}` : `[system]\n${req.system}\n\n[user]\n${req.user}`;
    const base: ModelCall = {
      n,
      runId: this.runId,
      model,
      requestedModel: model,
      area: req.area,
      attempt,
      input,
      output: "",
      usage: { promptTokens: null, outputTokens: null, thoughtsTokens: null, totalTokens: null },
      ms: 0,
      ok: false,
    };
    const timeoutMs = Math.max(1000, Math.min(45000, this.budget.msLeft() - 1500));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.cfg.apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const raw = await res.text();
      base.ms = Date.now() - t0;
      let data: GeminiResponse | null = null;
      try {
        data = JSON.parse(raw) as GeminiResponse;
      } catch {
        /* keep raw */
      }
      if (data?.modelVersion) base.model = data.modelVersion;
      const u = data?.usageMetadata;
      if (u) {
        base.usage = {
          promptTokens: u.promptTokenCount ?? null,
          outputTokens: u.candidatesTokenCount ?? null,
          thoughtsTokens: u.thoughtsTokenCount ?? null,
          totalTokens: u.totalTokenCount ?? null,
        };
      }
      if (!res.ok) {
        base.output = raw.slice(0, 4000);
        base.error = `HTTP ${res.status}: ${data?.error?.message ?? raw.slice(0, 300)}`;
        return { json: null, call: base };
      }
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      base.output = text;
      try {
        const json = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
        base.ok = true;
        return { json, call: base };
      } catch {
        base.error = `model returned invalid JSON (finishReason=${data?.candidates?.[0]?.finishReason ?? "?"})`;
        return { json: null, call: base };
      }
    } catch (err) {
      base.ms = Date.now() - t0;
      base.error = (err as Error).name === "AbortError" ? `timed out after ${timeoutMs} ms` : (err as Error).message;
      return { json: null, call: base };
    } finally {
      clearTimeout(timer);
    }
  }
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  error?: { message?: string };
}
