// The coordinating agent. One pipeline for every input: full runs and updates take the same path.
//
//   ingest (code) → reading call (model, always 1) → route custom constraints (code)
//   → area calls (model, only for areas with a constraint no fact kind can express)
//   → supersession (code) → plan (code) → validate (code) → conflict resolution (code)
//
// Routing rule (predictable before an update): exactly one "reading" call, plus one call per area
// that receives a constraint the reading call could not express as a standard fact. Nothing else
// calls the model. Updates are capped at 5 calls (retries included) and 60 s.

import { activeFacts, describeFact, factKey, normLabel, refreshMessageStatuses, resolveSupersession, isNewer } from "../facts";
import { ingestAll, numberLines, type RawInput } from "../ingest";
import { CallBudget, GeminiClient, type LlmConfig } from "../llm/gemini";
import { buildPlan, type PlannerPolicy } from "../planner";
import { diffPlans } from "../planner/diff";
import { rs } from "../planner/time";
import { isGrounded } from "../numbers";
import {
  AREAS,
  FACT_KINDS,
  type Area,
  type CallTag,
  type CheckResult,
  type Fact,
  type FactKind,
  type Message,
  type ModelCall,
  type Plan,
  type ProjectState,
  type Run,
  type TraceEvent,
} from "../types";
import { AREA_SCHEMA, READING_SCHEMA, areaSystemPrompt, areaUserPrompt, readingSystemPrompt, readingUserPrompt } from "./prompts";

/** Label for text typed or pasted into the tool without a sender: the organisers themselves. */
export const MANUAL_ENTRY = "Manual entry (organiser)";

/** Kinds whose num is an amount of money (checked against the message text). */
/** True when the sentence says the feature is ABSENT: "no projector", "without a ramp", "lift nahi hai". */
function negated(sentence: string, words: string[]): boolean {
  const w = words[0];
  if (!w) return false;
  const words_ = sentence.split(/\s+/).filter(Boolean);
  const NEG_BEFORE = /^(no|not|without|lack|lacks|lacking|nahi|nahin|bina)$/;
  const NEG_AFTER = /^(nahi|nahin|unavailable)$/;
  return words_.some((x, i) => {
    if (x !== w) return false;
    const pre = words_.slice(Math.max(0, i - 3), i);
    const post = words_.slice(i + 1, i + 4);
    return pre.some((p) => NEG_BEFORE.test(p)) || post.some((p) => NEG_AFTER.test(p)) || (post[0] === "not" && post[1] === "available");
  });
}

/** Organiser requirements: never auto-rejected in a full run (an unmeetable one is a reported conflict). */
const REQUIREMENT_KINDS = new Set<FactKind>(["venue_require", "venue_min_capacity", "break", "block", "end_by", "judges_min", "lunch_min"]);

const MONEY_KINDS = new Set<FactKind>(["budget_total", "committed", "cost", "request", "food_fee", "honorarium"]);

export const LIMITS = {
  full: { maxCalls: 10, maxMs: 120_000, safetyMs: 110_000 },
  update: { maxCalls: 5, maxMs: 60_000, safetyMs: 55_000 },
};

export interface PipelineInput {
  state: ProjectState;
  files: RawInput[];
  pasted?: string;
  llm: LlmConfig;
  policy: PlannerPolicy;
}

export interface PipelineResult {
  state: ProjectState;
  run: Run;
}

export { newProject } from "../project";

/** Which fact kinds can be blamed for a failing check (used to find the message that broke the plan). */
const IMPLICATED: Record<CheckResult["id"], FactKind[]> = {
  figures: ["students", "team_size", "teams", "food_order_qty", "staff", "extra_people", "food_special"],
  budget: ["budget_total", "committed", "cost", "food_option", "venue_option", "food_fee", "food_use", "honorarium", "extra_people", "venue_require", "venue_exclude", "venue_min_capacity", "judges_min", "students", "staff"],
  venue: ["venue_option", "venue_require", "venue_exclude", "venue_min_capacity", "extra_people", "students", "staff"],
  schedule: ["duration_min", "start_time", "end_by", "break", "block", "judge_late_min", "minutes_per_team", "max_teams_per_judge"],
  judges: ["judges_confirmed", "max_teams_per_judge", "judges_min", "team_size", "teams", "students"],
  coverage: ["venue_exclude", "venue_require", "venue_min_capacity", "food_use"],
};

function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

interface RawFact {
  msg?: string;
  kind?: string;
  label?: string;
  num?: number;
  price?: number;
  features?: string[];
  text?: string;
  replaces?: string;
  reject?: string;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  // Work on a deep copy so a failed run never corrupts the caller's state.
  const state: ProjectState = structuredClone(input.state);
  const t0 = Date.now();
  const mode: Run["mode"] = state.messages.length ? "update" : "full";
  const lim = LIMITS[mode];
  const runId = ++state.counters.run;
  const events: TraceEvent[] = [];
  const calls: ModelCall[] = [];
  const ev = (kind: TraceEvent["kind"], text: string, extra: Partial<TraceEvent> = {}) => events.push({ kind, text, ...extra });
  const budget = new CallBudget(lim.maxCalls, t0 + lim.safetyMs);
  const client = new GeminiClient(input.llm, budget, () => ++state.counters.call, runId, (c) => calls.push(c));
  const prevPlan = state.plans.length ? state.plans[state.plans.length - 1] : null;

  const finish = (plan: Plan | null, aborted?: string): PipelineResult => {
    const totals = calls.reduce(
      (s, c) => ({
        promptTokens: s.promptTokens + (c.usage.promptTokens ?? 0),
        outputTokens: s.outputTokens + (c.usage.outputTokens ?? 0),
        thoughtsTokens: s.thoughtsTokens + (c.usage.thoughtsTokens ?? 0),
        totalTokens: s.totalTokens + (c.usage.totalTokens ?? 0),
      }),
      { promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, totalTokens: 0 },
    );
    if (calls.some((c) => c.usage.totalTokens === null)) ev("info", "Some calls returned no usage data from the API; their tokens are shown as n/a and counted as 0 in totals.");
    const changes = plan ? diffPlans(prevPlan, plan) : [];
    let planChanged = false;
    if (plan && (changes.length > 0 || !prevPlan)) {
      plan.version = (prevPlan?.version ?? 0) + 1;
      state.plans.push(plan);
      planChanged = true;
    }
    if (!planChanged) changes.length = 0;
    const run: Run = {
      id: runId,
      mode,
      startedAt: new Date(t0).toISOString(),
      ms: Date.now() - t0,
      calls,
      events,
      planVersion: state.plans.length ? state.plans[state.plans.length - 1].version : null,
      planChanged,
      changes,
      areasCalled: [...new Set(calls.map((c) => c.area))],
      totals,
      limits: { maxCalls: lim.maxCalls, maxMs: lim.maxMs },
      aborted,
    };
    state.runs.push(run);
    return { state, run };
  };

  // ---------- 1. ingest (code) ----------
  const ing = await ingestAll(input.files, input.pasted);
  for (const d of ing.docs) ev("file", `Read "${d.name}" as ${d.detectedType} (${d.sizeBytes} bytes, ${d.text.split("\n").length} lines).${d.cleanNote ? ` ${d.cleanNote}` : ""}`);
  for (const i of ing.issues) ev("error", `File "${i.name}" (${i.detectedType}) NOT read — ${i.problem}: ${i.detail}`);
  for (const w of ing.warnings) ev("error", w);
  if (!ing.docs.length) return finish(null, "No readable content was submitted.");
  if (!input.llm.apiKey) return finish(null, "GEMINI_API_KEY is not set on the server.");

  // ---------- 2. reading call (model) ----------
  const lines = numberLines(ing.docs);
  const numbered = lines.map((l) => `${l.n}| ${l.text.replace(/<\/?data>/gi, (m) => m.replace("<", "‹"))}`).join("\n");
  ev("route", mode === "full" ? "Full run: 1 reading call for all messages, then area calls only for constraints no fact kind can express." : "Update: 1 reading call, then area calls only for constraints no fact kind can express (limit 5 calls incl. retries, 60 s).");
  let reading: { messages?: unknown[]; facts?: unknown[]; custom?: unknown[] };
  try {
    reading = (await client.callJson({
      area: "reading",
      system: readingSystemPrompt(new Date().getFullYear()),
      user: readingUserPrompt(numbered, state.facts, state.messages),
      schema: READING_SCHEMA,
    })) as typeof reading;
  } catch (err) {
    ev("error", `Reading failed: ${(err as Error).message}. Nothing was changed; the previous plan is still in effect.`);
    return finish(null, (err as Error).message);
  }

  // ---------- 3. messages: slice the original lines by the ranges the model gave ----------
  const lineByN = new Map(lines.map((l) => [l.n, l]));
  const maxN = lines.length;
  const claimed = new Set<number>();
  const refToId = new Map<string, string>();
  const newMessages: Message[] = [];
  const rawMsgs = (Array.isArray(reading.messages) ? reading.messages : []) as {
    ref?: string;
    first?: number;
    last?: number;
    from?: string;
    date?: string | null;
    relevance?: Message["relevance"];
  }[];
  rawMsgs.sort((a, b) => (a.first ?? 0) - (b.first ?? 0));
  const makeMessage = (from: string, date: string | null, relevance: Message["relevance"], ns: number[], reasons: string[] = []): Message => {
    const ls = ns.map((n) => lineByN.get(n)!).filter((l) => l && !l.header);
    const doc = ing.docs[ls[0]?.doc ?? 0];
    const m: Message = {
      id: `M${++state.counters.msg}`,
      runId,
      seq: state.counters.msg,
      // text typed/pasted into the tool with no sender is the organisers' own manual entry
      from: !from || /^(unknown|unknown sender|n\/?a|none|-)$/i.test(from.trim()) ? (doc.detectedType === "text" ? MANUAL_ENTRY : "unknown sender") : from,
      date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      relevance,
      text: ls.map((l) => l.text).join("\n").trim(),
      source: { name: doc.name, detectedType: doc.detectedType, sizeBytes: doc.sizeBytes, lines: [ns[0], ns[ns.length - 1]] },
      status: "pending",
      reasons,
    };
    newMessages.push(m);
    return m;
  };
  for (const r of rawMsgs) {
    const first = Math.max(1, Math.min(maxN, Math.round(r.first ?? 0)));
    const last = Math.max(first, Math.min(maxN, Math.round(r.last ?? first)));
    const ns: number[] = [];
    for (let n = first; n <= last; n++) if (!claimed.has(n) && lineByN.get(n) && !lineByN.get(n)!.header && lineByN.get(n)!.text.trim()) ns.push(n);
    if (!ns.length) continue;
    ns.forEach((n) => claimed.add(n));
    const m = makeMessage(String(r.from ?? ""), r.date ?? null, (["relevant", "request", "info", "irrelevant"] as const).includes(r.relevance as never) ? r.relevance! : "relevant", ns);
    if (r.ref) refToId.set(String(r.ref), m.id);
  }
  // never skip silently: any non-blank line the model did not assign becomes its own message
  let block: number[] = [];
  const flush = () => {
    if (block.length) {
      const m = makeMessage("(unassigned text)", null, "info", block, ["The reading model did not assign these lines to any message. Kept and shown here; no facts were taken from them."]);
      ev("error", `Lines ${block[0]}–${block[block.length - 1]} were not assigned to a message by the model; stored as ${m.id} for review.`, { msgId: m.id });
    }
    block = [];
  };
  for (const l of lines) {
    if (l.header || !l.text.trim() || claimed.has(l.n)) {
      if (l.header || claimed.has(l.n)) flush();
      continue;
    }
    block.push(l.n);
  }
  flush();
  for (const m of newMessages) ev("info", `${m.id} from ${m.from}${m.date ? ` (${m.date})` : ""} — ${m.relevance}.`, { msgId: m.id });
  state.messages.push(...newMessages);

  // ---------- 4. facts ----------
  const newFacts: Fact[] = [];
  const existingById = new Map(state.facts.map((f) => [f.id, f]));
  const addFact = (rf: RawFact, msgId: string, origin: CallTag): Fact | null => {
    const kind = rf.kind as FactKind;
    if (!kind || !(kind in FACT_KINDS)) {
      ev("error", `Ignored a fact with unknown kind "${rf.kind}" from ${msgId}.`, { msgId });
      return null;
    }
    const f: Fact = {
      id: `F${++state.counters.fact}`,
      msgId,
      kind,
      area: FACT_KINDS[kind].area,
      key: "",
      label: rf.label?.trim() || undefined,
      num: isNum(rf.num) ? rf.num : undefined,
      price: isNum(rf.price) ? rf.price : undefined,
      features: Array.isArray(rf.features) ? rf.features.map(String).filter(Boolean) : undefined,
      text: rf.text?.trim() || undefined,
      status: "active",
      origin,
      runId,
    };
    const replaced = rf.replaces ? existingById.get(rf.replaces) ?? newFacts.find((x) => x.id === rf.replaces) : undefined;
    f.key = replaced && replaced.kind === f.kind ? replaced.key : factKey(f);
    const srcText = state.messages.find((m) => m.id === msgId)?.text ?? newMessages.find((m) => m.id === msgId)?.text ?? "";
    const ungrounded = [
      ...(f.price !== undefined && !isGrounded(f.price, srcText) ? [f.price] : []),
      ...(MONEY_KINDS.has(f.kind) && f.num !== undefined && !isGrounded(f.num, srcText) ? [f.num] : []),
    ];
    if ((f.num !== undefined && f.num < 0) || (f.price !== undefined && f.price < 0)) {
      f.status = "rejected";
      f.reason = "Negative number is not a valid value.";
    } else if (ungrounded.length) {
      f.status = "rejected";
      f.reason = `Model misread: Rs ${ungrounded.join(", ")} is not written in the message, so this figure was not used.`;
    } else if (rf.reject) {
      f.status = "rejected";
      f.reason = `Reading check: ${rf.reject}`;
    }
    newFacts.push(f);
    if (f.status === "rejected") ev("reject", `${f.id} (${describeFact(f)}) from ${msgId} rejected — ${f.reason}`, { msgId, factId: f.id });
    return f;
  };
  for (const rf of (Array.isArray(reading.facts) ? reading.facts : []) as RawFact[]) {
    const msgId = refToId.get(String(rf.msg ?? ""));
    if (!msgId) {
      ev("error", `Model returned a fact for unknown message "${rf.msg}" (${rf.kind}); ignored.`);
      continue;
    }
    addFact(rf, msgId, "reading");
  }

  // ---------- 5. route custom constraints to area calls ----------
  const custom = ((Array.isArray(reading.custom) ? reading.custom : []) as { msg?: string; area?: string; text?: string }[]).filter(
    (c) => c.text && AREAS.includes(c.area as Area) && refToId.has(String(c.msg)),
  );
  const byArea = new Map<Area, { msg: string; text: string }[]>();
  for (const c of custom) {
    const list = byArea.get(c.area as Area) ?? [];
    list.push({ msg: refToId.get(String(c.msg))!, text: c.text! });
    byArea.set(c.area as Area, list);
  }
  // Feature grounding: a feature the model gives a venue must be stated in a sentence that names that
  // venue ("Only Halls 2 and 3 … ramp access" gives ramp access to Halls 2 and 3, never to Hall 1).
  for (const m of newMessages) {
    const opts = newFacts.filter((f) => f.msgId === m.id && f.kind === "venue_option" && f.status === "active");
    if (!opts.length) continue;
    const sentences = m.text.split(/(?<=[.!?])\s+|\n+/).map((x) => ` ${normLabel(x)} `);
    for (const o of opts) {
      if (!o.features?.length) continue;
      const own = normLabel(o.label).split(" ").filter(Boolean);
      const others = opts.filter((x) => x !== o).map((x) => normLabel(x.label).split(" "));
      const distinct = own.filter((t) => !others.every((ws) => ws.includes(t)) || !others.length);
      const kept = o.features.filter((feat) => {
        const fw = normLabel(feat).split(" ").filter(Boolean);
        const where = sentences.filter((s) => fw.every((w) => s.includes(` ${w} `)));
        if (!where.length) return true; // paraphrased tag: cannot check, keep it
        return where.some((s) => distinct.some((t) => s.includes(` ${t} `)) && !negated(s, fw));
      });
      const dropped = o.features.filter((x) => !kept.includes(x));
      if (dropped.length) {
        o.features = kept;
        ev("reject", `${o.id}: removed "${dropped.join(", ")}" from ${o.label}: the message does not say ${o.label} has it.`, { msgId: m.id, factId: o.id });
      }
    }
  }

  // Requirement grounding (both directions): a venue has a required feature when a sentence of its own
  // message names that venue and contains the requirement's words. Adds features the model forgot.
  {
    const allOpts = [...state.facts, ...newFacts].filter((f) => f.kind === "venue_option" && f.status === "active");
    const reqs = [...state.facts, ...newFacts].filter((f) => f.kind === "venue_require" && f.status === "active");
    const msgText = (id: string) => [...state.messages, ...newMessages].find((m) => m.id === id)?.text ?? "";
    for (const r of reqs) {
      const rw = normLabel(r.text ?? r.label).split(" ").filter(Boolean);
      if (!rw.length) continue;
      for (const o of allOpts) {
        const siblings = allOpts.filter((x) => x !== o && x.msgId === o.msgId).map((x) => normLabel(x.label).split(" "));
        const own = normLabel(o.label).split(" ").filter(Boolean);
        const distinct = siblings.length ? own.filter((t) => !siblings.every((ws) => ws.includes(t))) : own;
        const said = msgText(o.msgId)
          .split(/(?<=[.!?])\s+|\n+/)
          .map((x) => ` ${normLabel(x)} `)
          .some(
            (s) =>
              rw.every((w) => s.includes(` ${w} `)) &&
              distinct.some((t) => s.includes(` ${t} `)) &&
              !negated(s, rw), // "Lotus Room … (no projector)" does NOT have a projector
          );
        const tag = r.text ?? r.label!;
        if (said && !(o.features ?? []).some((x) => normLabel(x) === normLabel(tag))) {
          o.features = [...(o.features ?? []), tag];
          ev("info", `${o.id}: ${o.label} has "${tag}" (stated in ${o.msgId}), added from the message text.`, { factId: o.id });
        }
      }
    }
  }

  // A venue requirement whose wording matches no venue feature (e.g. "step-free access" vs "ramp access")
  // needs meaning, not string matching: route it to one venue call.
  {
    const opts = [...state.facts, ...newFacts].filter((f) => f.kind === "venue_option" && f.status === "active");
    for (const r of newFacts.filter((f) => f.kind === "venue_require" && f.status === "active")) {
      const need = normLabel(r.text ?? r.label);
      const hit = opts.some((o) => [...(o.features ?? []), o.label ?? "", o.text ?? ""].some((x) => {
        const h = normLabel(x);
        return h && need && (h === need || h.includes(need) || need.includes(h));
      }));
      if (!hit && opts.length) {
        const list = byArea.get("venue") ?? [];
        list.push({ msg: r.msgId, text: `Requirement ${r.id} "${r.text ?? r.label}" matches no venue's wording. Venues: ${opts.map((o) => `${o.id} ${o.label} [${[...(o.features ?? []), o.text ?? ""].filter(Boolean).join("; ")}]`).join(" | ")}. Venue messages (the source text): ${[...new Set(opts.map((o) => o.msgId))].map((id) => `"${[...state.messages, ...newMessages].find((m) => m.id === id)?.text ?? ""}"`).join(" ")}. Return venue_require with text equal to the feature that satisfies it and replaces=${r.id}, plus venue_option with replaces=<its id> and that feature in features for each venue that has it; or say unsupported.` });
        byArea.set("venue", list);
      }
    }
  }
  ev("route", byArea.size ? `Area calls needed for: ${[...byArea.keys()].join(", ")} (constraints that no standard fact kind covers).` : "No area calls needed: every constraint fit a standard fact kind; planning is done in code.");
  // plan state before area calls, so the area model sees the current area section
  state.facts.push(...newFacts);
  resolveSupersession(state.facts, state.messages);
  const draft = buildPlan(activeFacts(state.facts), 0, runId, input.policy);
  for (const area of AREAS) {
    const items = byArea.get(area);
    if (!items) continue;
    if (budget.remaining() <= 0 || budget.msLeft() < 4000) {
      for (const it of items) {
        ev("error", `Constraint not applied (call limit/time reached): "${it.text}"`, { msgId: it.msg });
        state.messages.find((m) => m.id === it.msg)?.reasons.push(`Constraint not applied automatically (model-call limit reached): ${it.text}`);
      }
      continue;
    }
    try {
      const res = (await client.callJson(
        {
          area,
          system: areaSystemPrompt(area),
          user: areaUserPrompt(area, items, activeFacts(state.facts).filter((f) => f.area === area), areaSummary(draft, area)),
          schema: AREA_SCHEMA,
        },
        budget.remaining() > 1 ? 2 : 1,
      )) as { facts?: RawFact[]; unsupported?: string };
      const before = newFacts.length;
      for (const rf of res.facts ?? []) addFact(rf, items[0].msg, area);
      state.facts.push(...newFacts.slice(before));
      if (res.unsupported) {
        ev("error", `${area}: constraint cannot be enforced automatically — ${res.unsupported}`, { msgId: items[0].msg });
        state.messages.find((m) => m.id === items[0].msg)?.reasons.push(`Not enforceable automatically: ${res.unsupported}`);
      }
    } catch (err) {
      ev("error", `${area} call failed: ${(err as Error).message}. Constraint not applied.`, { msgId: items[0].msg });
      state.messages.find((m) => m.id === items[0].msg)?.reasons.push(`Constraint not applied (model call failed): ${items.map((i) => i.text).join("; ")}`);
    }
  }

  // ---------- 6. supersession (code) ----------
  for (const s of resolveSupersession(state.facts, state.messages)) {
    const f = state.facts.find((x) => x.id === s.factId)!;
    const by = state.facts.find((x) => x.id === s.byId)!;
    ev("supersede", `${f.id} (${describeFact(f)}, ${f.msgId}) superseded by ${by.id} (${describeFact(by)}, ${by.msgId}).`, { factId: f.id, msgId: f.msgId });
  }

  // ---------- 7. plan + validation + conflict resolution (code) ----------
  let plan = buildPlan(activeFacts(state.facts), 0, runId, input.policy);
  const runFactIds = new Set(newFacts.map((f) => f.id));
  const msgById = new Map(state.messages.map((m) => [m.id, m]));
  let guard = 0;
  while (!plan.valid && guard++ < 4) {
    const failing = plan.checks.filter((c) => !c.pass);
    // Requirements stated by organisers are never dropped just to make a full run pass: an unmeetable
    // requirement is a real conflict and is reported as such.
    const kinds = new Set(
      failing.flatMap((c) => (mode === "full" && c.id === "budget" ? [] : IMPLICATED[c.id])).filter((k) => !(mode === "full" && REQUIREMENT_KINDS.has(k))),
    );
    const pool = state.facts
      .filter((f) => f.status === "active" && kinds.has(f.kind) && (mode === "full" || runFactIds.has(f.id)))
      .sort((a, b) => {
        const ma = msgById.get(a.msgId)!;
        const mb = msgById.get(b.msgId)!;
        return ma === mb ? Number(b.id.slice(1)) - Number(a.id.slice(1)) : isNewer(ma, mb) ? -1 : 1;
      });
    let fixed = false;
    for (const cand of pool) {
      const snapshot = state.facts.map((f) => ({ ...f }));
      cand.status = "rejected";
      resolveSupersession(state.facts, state.messages);
      const trial = buildPlan(activeFacts(state.facts), 0, runId, input.policy);
      const before = failing.length;
      const after = trial.checks.filter((c) => !c.pass).length;
      if (trial.valid || after < before) {
        const why = failing
          .filter((c) => IMPLICATED[c.id].includes(cand.kind))
          .map((c) => `${c.name}: ${c.details.filter((d) => /missing|fewer|over|<|not|only|mismatch|do not|cannot|excluded|needs|must/i.test(d)).join(" ") || c.details.join(" ")}`)
          .join(" | ");
        cand.reason = `Breaks the plan — ${why}. Plan kept valid without it.`;
        ev("reject", `${cand.id} (${describeFact(cand)}) from ${cand.msgId} rejected — ${cand.reason}`, { msgId: cand.msgId, factId: cand.id });
        plan = trial;
        fixed = true;
        break;
      }
      // undo
      state.facts.forEach((f, i) => Object.assign(f, snapshot[i]));
    }
    if (!fixed) break;
  }
  if (!plan.valid && mode === "update" && prevPlan?.valid) {
    const failing = plan.checks.filter((c) => !c.pass);
    const why = failing.map((c) => `${c.name}: ${c.details.join(" ")}`).join(" | ");
    for (const f of state.facts) {
      if (runFactIds.has(f.id) && f.status !== "rejected" && f.kind !== "note") {
        f.status = "rejected";
        f.reason = `Applying this update leaves no valid plan — ${why}. Previous valid plan kept; needs an organiser decision.`;
        ev("reject", `${f.id} (${describeFact(f)}) from ${f.msgId} rejected — ${f.reason}`, { msgId: f.msgId, factId: f.id });
      }
    }
    resolveSupersession(state.facts, state.messages);
    plan = buildPlan(activeFacts(state.facts), 0, runId, input.policy);
  }
  if (!plan.valid) {
    const failing = plan.checks.filter((c) => !c.pass);
    ev("conflict", `No feasible plan from the current facts. Failing: ${failing.map((c) => `${c.name} (${c.details.join(" ")})`).join(" | ")}${plan.conflicts.length ? ` Conflicts: ${plan.conflicts.join(" ")}` : ""}`);
  } else ev("accept", `Plan valid: all six checks pass. Spend ${rs(plan.budget.total)} of ${rs(plan.budget.cap)}.`);

  refreshMessageStatuses(state.messages, state.facts);
  for (const m of newMessages) {
    if (m.status === "rejected" || m.status === "partial") ev("reject", `${m.id} (${m.from}) ${m.status}: ${m.reasons.join(" ")}`, { msgId: m.id });
  }
  return finish(plan);
}

function areaSummary(p: Plan, area: Area): string {
  switch (area) {
    case "venue":
      return p.venue.chosen ? `${p.venue.chosen.label}, ${p.venue.chosen.capacity} seats, ${rs(p.venue.chosen.price)}; need ${p.headcount.total ?? "?"} seats` : "no venue";
    case "food":
      return p.food.option ? `${p.food.meals} × ${p.food.option.label} @ ${rs(p.food.option.price)}` : "no meal option";
    case "judging":
      return `${p.judging.used ?? "?"} judges, ${p.judging.teams ?? "?"} teams, ${p.judging.blockMinutes ?? "?"} min block`;
    case "schedule":
      return p.schedule.items.map((i) => `${i.start} ${i.label} ${i.minutes}m`).join("; ");
    case "budget":
      return `cap ${rs(p.budget.cap)}, spend ${rs(p.budget.total)}`;
  }
}
