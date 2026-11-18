// Plain-language summary of a run: did the plan change or stay, and why. Used by the UI and the text trace.

import { cleanReason, humanizeFact } from "./humanize";
import { AREAS, type Area, type Fact, type Message, type ProjectState, type Run } from "./types";

export interface MessageOutcome {
  id: string;
  from: string;
  text: string;
  status: Message["status"];
  /** one short human sentence */
  why: string;
  /** plain-English facts now used in the plan */
  used: string[];
  /** plain-English facts that were rejected, with the reason */
  rejected: { what: string; reason: string }[];
  /** plain-English facts replaced by newer messages */
  outdated: string[];
  facts: { id: string; what: string; status: Fact["status"]; reason?: string }[];
}

export interface RunVerdict {
  headline: string;
  kept: boolean; // true = plan stayed as it was
  fromVersion: number | null;
  toVersion: number | null;
  valid: boolean | null;
  outcomes: MessageOutcome[];
  changes: string[];
  modelAreas: Area[]; // planning areas that made calls (reading excluded)
  readingCalls: number;
  prediction: { predicted: Area[]; actual: Area[]; match: boolean } | null;
  problems: string[]; // file errors, aborts, unenforced constraints
}

export function runVerdict(run: Run, state: ProjectState): RunVerdict {
  const plan = state.plans.find((p) => p.version === run.planVersion) ?? null;
  const prev = run.planChanged ? state.plans.find((p) => p.version === (run.planVersion ?? 0) - 1) ?? null : plan;
  const msgs = state.messages.filter((m) => m.runId === run.id);
  const outcomes: MessageOutcome[] = msgs.map((m) => {
    const fs = state.facts.filter((f) => f.msgId === m.id && f.kind !== "note");
    const used = fs.filter((f) => f.status === "active").map(humanizeFact);
    const rejected = fs.filter((f) => f.status === "rejected").map((f) => ({ what: humanizeFact(f), reason: cleanReason(f.reason) }));
    const outdated = fs.filter((f) => f.status === "superseded").map(humanizeFact);
    let why: string;
    if (m.status === "rejected") why = `Rejected: ${rejected[0]?.reason ?? "invalid"}`;
    else if (m.status === "partial") why = `Partly rejected: ${rejected.map((r) => `${r.what} (${r.reason})`).join("; ")}`;
    else if (m.status === "superseded") why = "Out of date: a newer message replaced it.";
    else if (m.status === "irrelevant") why = m.reasons[0] ?? "Nothing for the plan (irrelevant or information only).";
    else why = `Accepted. Used: ${used.join("; ") || "information only"}.`;
    return {
      id: m.id,
      from: m.from,
      text: m.text,
      status: m.status,
      why,
      used,
      rejected,
      outdated,
      facts: fs.map((f) => ({ id: f.id, what: humanizeFact(f), status: f.status, reason: f.reason })),
    };
  });
  const modelAreas = [...new Set(run.calls.map((c) => c.area).filter((a): a is Area => (AREAS as readonly string[]).includes(a)))];
  const readingCalls = run.calls.filter((c) => c.area === "reading").length;
  const predicted = run.prediction ? (run.prediction.filter((a) => a !== "reading") as Area[]) : null;
  const prediction = predicted
    ? { predicted, actual: modelAreas, match: predicted.length === modelAreas.length && predicted.every((a) => modelAreas.includes(a)) }
    : null;
  const problems = [
    ...(run.aborted ? [`Run stopped: ${run.aborted}`] : []),
    ...run.events.filter((e) => e.kind === "error").map((e) => e.text),
  ];
  const changes = run.changes.filter((c) => c.field !== "plan").map((c) => `${c.area} · ${c.field}: ${c.from} → ${c.to}`);

  let headline: string;
  const kept = !run.planChanged;
  const rejectedMsgs = outcomes.filter((o) => o.status === "rejected" || o.status === "partial");
  if (run.aborted && !plan) headline = `Stopped — no plan was made. ${run.aborted}`;
  else if (run.aborted) headline = `Stopped — plan stayed on v${run.planVersion}. ${run.aborted}`;
  else if (run.mode === "full") headline = `New plan v${run.planVersion} created — ${plan?.valid ? "valid, all six checks pass" : "NOT valid, see conflicts"}.`;
  else if (kept && rejectedMsgs.length) headline = `Plan stayed on v${run.planVersion} — the new message was rejected, so the previous valid plan was kept.`;
  else if (kept) headline = `Plan stayed on v${run.planVersion} — the new message did not change anything in the plan.`;
  else headline = `Plan changed: v${prev?.version ?? "?"} → v${run.planVersion} — ${plan?.valid ? "still valid, all six checks pass" : "NOT valid, see conflicts"}.`;

  return {
    headline,
    kept,
    fromVersion: kept ? run.planVersion : prev?.version ?? null,
    toVersion: run.planVersion,
    valid: plan ? plan.valid : null,
    outcomes,
    changes,
    modelAreas,
    readingCalls,
    prediction,
    problems,
  };
}


export function formatVerdict(v: RunVerdict): string {
  const L: string[] = [];
  L.push(`VERDICT: ${v.headline}`);
  L.push("WHY:");
  for (const o of v.outcomes) L.push(`  ${o.id} (${o.from}): ${o.why}`);
  if (v.changes.length) {
    L.push("WHAT CHANGED:");
    v.changes.forEach((c) => L.push(`  ${c}`));
  }
  L.push(`MODEL CALLS: ${v.readingCalls} reading${v.modelAreas.length ? ` + ${v.modelAreas.join(", ")}` : " only (no planning-area calls)"}`);
  if (v.prediction)
    L.push(
      `PREDICTION: predicted ${v.prediction.predicted.join(", ") || "no area calls"} | actual ${v.prediction.actual.join(", ") || "no area calls"} | ${v.prediction.match ? "MATCH" : "MISMATCH"}`,
    );
  if (v.problems.length) {
    L.push("PROBLEMS:");
    v.problems.forEach((p) => L.push(`  ${p}`));
  }
  return L.join("\n");
}
