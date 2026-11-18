// Thin Gemini REST client. Server-side only: the API key never reaches the browser.
// Every attempt (including retries and failures) is recorded as a numbered ModelCall
// with the token counts exactly as the API reports them (null when the API sends none).

import type { CallTag, ModelCall } from "../types";

export interface LlmConfig {
  /** first key (kept for "is a key configured" checks) */
  apiKey: string;
  /** all configured keys; each model is tried on every key before falling back to the next model */
  apiKeys: string[];
  /** primary model (first of the chain) */
  model: string;
  /** fallback chain: attempt k uses models[k-1] (last one repeats). Overload/rate-limit/timeout moves down the chain. */
  models: string[];
  /** thinking budget for Gemini 2.5 models; 0 disables thinking (fewer tokens). Ignored when undefined. */
  thinkingBudget?: number;
}

export function llmConfigFromEnv(): LlmConfig {
  const apiKeys = [
    ...new Set(
      [
        process.env.GEMINI_API_KEY,
        process.env.GOOGLE_API_KEY,
        ...(process.env.GEMINI_API_KEYS ?? "").split(","),
        ...Array.from({ length: 8 }, (_, i) => process.env[`GEMINI_API_KEY_${i + 2}`]),
      ]
        .map((k) => (k ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const apiKey = apiKeys[0] ?? "";
  const chain = (process.env.GEMINI_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const primary = (process.env.GEMINI_MODEL ?? "").trim();
  const models = [...new Set([...(primary ? [primary] : []), ...(chain.length ? chain : DEFAULT_CHAIN)])];
  const model = models[0];
  const tb = process.env.GEMINI_THINKING_BUDGET;
  let thinkingBudget: number | undefined;
  if (tb !== undefined && tb !== "") thinkingBudget = Number(tb);
  else if (/gemini-2\.5-flash/.test(model)) thinkingBudget = 0;
  return { apiKey, apiKeys, model, models, thinkingBudget };
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

  /** Attempt order: each model on every key, then the next model (fast model on a free key beats a slower model). */
  private routes(): { model: string; key: string; slot: number }[] {
    const keys = this.cfg.apiKeys.length ? this.cfg.apiKeys : [this.cfg.apiKey];
    return this.cfg.models.flatMap((model) => keys.map((key, i) => ({ model, key, slot: i + 1 })));
  }

  /** One logical request. Failed attempts move along the key x model routes while budget and time allow. */
  async callJson(req: CallRequest, maxAttempts = 4): Promise<unknown> {
    let lastErr = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.budget.remaining() <= 0) throw new CallBudgetExceeded(`model-call limit of ${this.budget.maxCalls} reached`);
      if (this.budget.msLeft() < 3000) throw new DeadlineExceeded("not enough time left for another model call");
      const { json, call } = await this.attempt(req, attempt);
      this.onCall(call);
      if (call.ok && json !== null) return json;
      lastErr = call.error ?? "unknown error";
      // only a malformed request (400) is hopeless; 401/403 (bad key), 404 (model unavailable),
      // 429/503 (busy) and timeouts move on to the next key or model
      if (/^HTTP 400\b/.test(lastErr) && !/api key|permission|quota/i.test(lastErr)) break;
    }
    throw new Error(`model call failed (${req.area}): ${lastErr}`);
  }

  private async attempt(req: CallRequest, attempt: number): Promise<CallOutcome> {
    this.budget.used++;
    const n = this.nextCallNumber();
    const routes = this.routes();
    const route = routes[Math.min(attempt - 1, routes.length - 1)];
    const model = route.model;
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
      keySlot: route.slot,
      area: req.area,
      attempt,
      input,
      output: "",
      usage: { promptTokens: null, outputTokens: null, thoughtsTokens: null, totalTokens: null },
      ms: 0,
      ok: false,
    };
    // cap each attempt so a slow model leaves time to fall back: 50 s in a full run (120 s budget), 25 s in an update (60 s)
    const timeoutMs = Math.max(1000, Math.min(this.budget.maxCalls > 5 ? 50000 : 25000, this.budget.msLeft() - 1500));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": route.key },
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
