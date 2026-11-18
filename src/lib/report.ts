// Plain-text trace and plan reports. Pure functions: used by the CLI and by browser downloads.

import { rs } from "./planner/time";
import type { Plan, ProjectState, Run } from "./types";
import { formatVerdict, runVerdict } from "./verdict";

const n = (x: number | null) => (x === null ? "n/a" : String(x));

export function formatRun(run: Run, opts: { full?: boolean; state?: ProjectState } = {}): string {
  const out: string[] = [];
  out.push(`================ RUN ${run.id} (${run.mode}) — ${run.startedAt} — ${(run.ms / 1000).toFixed(1)} s ================`);
  if (opts.state) {
    out.push(formatVerdict(runVerdict(run, opts.state)));
    out.push("");
  }
  out.push(`Limits: ${run.limits.maxCalls} model calls, ${run.limits.maxMs / 1000} s. Used: ${run.calls.length} calls. Areas with model calls: ${run.areasCalled.join(", ") || "none"}.`);
  for (const c of run.calls) {
    out.push("");
    out.push(`--- CALL #${c.n} | model: ${c.model} | area: ${c.area} | ${c.keySlot ? `key ${c.keySlot} | ` : ""}attempt ${c.attempt} | ${c.ms} ms | ${c.ok ? "ok" : `FAILED: ${c.error}`}`);
    out.push(`tokens (API-reported): input=${n(c.usage.promptTokens)} output=${n(c.usage.outputTokens)} thinking=${n(c.usage.thoughtsTokens)} total=${n(c.usage.totalTokens)}`);
    if (opts.full !== false) {
      out.push(">>> INPUT");
      out.push(c.input);
      out.push("<<< OUTPUT");
      out.push(c.output || "(empty)");
    }
  }
  out.push("");
  out.push("--- DECISIONS");
  for (const e of run.events) out.push(`[${e.kind}] ${e.text}`);
  if (run.changes.length) {
    out.push("");
    out.push(`--- PLAN CHANGES (now v${run.planVersion})`);
    for (const c of run.changes) out.push(`${c.area} · ${c.field}: ${c.from} → ${c.to}`);
  } else if (run.planVersion) out.push(`--- Plan unchanged (still v${run.planVersion}).`);
  if (run.aborted) out.push(`!!! Run stopped: ${run.aborted}`);
  out.push("");
  out.push(
    `RUN ${run.id} TOTAL TOKENS: input=${run.totals.promptTokens} output=${run.totals.outputTokens} thinking=${run.totals.thoughtsTokens} total=${run.totals.totalTokens} (${run.calls.length} calls)`,
  );
  return out.join("\n");
}

export function formatTrace(state: ProjectState): string {
  const runs = state.runs.map((r) => formatRun(r, { state })).join("\n\n");
  const t = state.runs.reduce(
    (s, r) => ({ c: s.c + r.calls.length, p: s.p + r.totals.promptTokens, o: s.o + r.totals.outputTokens, th: s.th + r.totals.thoughtsTokens, tt: s.tt + r.totals.totalTokens }),
    { c: 0, p: 0, o: 0, th: 0, tt: 0 },
  );
  return `${runs}\n\n================ GRAND TOTAL: ${t.c} model calls | input=${t.p} output=${t.o} thinking=${t.th} total=${t.tt} tokens ================\n`;
}

export function formatPlan(plan: Plan, state?: ProjectState): string {
  const L: string[] = [];
  L.push(`# Hackathon plan v${plan.version} — ${plan.valid ? "VALID (all six checks pass)" : "NOT VALID"}`);
  L.push("");
  L.push("## Checks");
  for (const c of plan.checks) L.push(`- [${c.pass ? "PASS" : "FAIL"}] ${c.name}: ${c.details.join(" ")}`);
  if (plan.conflicts.length) {
    L.push("");
    L.push("## Conflicts");
    plan.conflicts.forEach((c) => L.push(`- ${c}`));
  }
  const h = plan.headcount;
  L.push("");
  L.push("## Venue");
  L.push(plan.venue.chosen ? `${plan.venue.chosen.label}: ${plan.venue.chosen.capacity} seats, ${rs(plan.venue.chosen.price)}${plan.venue.chosen.features.length ? `, ${plan.venue.chosen.features.join(", ")}` : ""} (source ${plan.venue.chosen.factId})` : "No venue.");
  L.push(`Needs: ${plan.venue.requirements.join(", ")}. People: ${h.students} students + ${h.judges} judges + ${h.staff} staff${h.extra.map((e) => ` + ${e.num} ${e.label}`).join("")} = ${h.total}.`);
  for (const r of plan.venue.rejectedOptions) L.push(`- not chosen: ${r.label} (${r.why})`);
  L.push("");
  L.push(`## Schedule (${plan.schedule.start}–${plan.schedule.end}, ${plan.schedule.durationMin} min)`);
  for (const i of plan.schedule.items) L.push(`- ${i.start}–${i.end} ${i.label} (${i.minutes} min)`);
  L.push("");
  L.push("## Food");
  L.push(plan.food.option ? `${plan.food.ordered} × ${plan.food.option.label} @ ${rs(plan.food.option.price)} = ${rs(plan.food.cost)}` : "No meal option.");
  for (const s of plan.food.specials) L.push(`- includes ${s.count} ${s.label} @ ${rs(s.price)}`);
  for (const f of plan.food.fees) L.push(`- fee: ${f.label} ${rs(f.amount)}`);
  L.push("");
  L.push("## Judging");
  const j = plan.judging;
  L.push(`${j.teams} teams; ${j.confirmed ?? "?"} confirmed, ${j.required ?? "?"} required, ${j.used} used, ${j.reserves ?? 0} reserve; ${j.minutesPerTeam} min/team, max ${j.maxTeamsPerJudge}/judge; block ${j.blockMinutes} min; honorarium ${rs(j.honorarium)}.`);
  L.push(j.assignments.map((a) => `${a.judge}: ${a.teams.join(",")}`).join(" | "));
  L.push("");
  L.push("## Budget");
  for (const l of plan.budget.lines) L.push(`- ${l.label}: ${rs(l.amount)} (${l.formula}; ${l.factIds.join(", ")})`);
  L.push(`Total ${rs(plan.budget.total)} of ${rs(plan.budget.cap)}; remaining ${rs(plan.budget.remaining)}.`);
  for (const r of plan.budget.requests) L.push(`- not included (unapproved request): ${r.label} ${rs(r.amount)}${r.wouldFit ? " — would fit if approved" : " — would not fit"}`);
  if (plan.assumptions.length) {
    L.push("");
    L.push("## Assumptions");
    plan.assumptions.forEach((a) => L.push(`- ${a}`));
  }
  if (state) {
    L.push("");
    L.push("## Messages");
    for (const m of state.messages) L.push(`- ${m.id} [${m.status}] ${m.from}${m.date ? ` ${m.date}` : ""}: ${m.text.replace(/\s+/g, " ").slice(0, 160)}${m.reasons.length ? ` — ${m.reasons.join(" ")}` : ""}`);
  }
  return L.join("\n");
}

const PURPOSE: Record<string, string> = {
  reading: "reading messages",
  venue: "venue",
  schedule: "schedule",
  food: "food",
  judging: "judging",
  budget: "budget",
};

/** One-page summary: the plan in five areas + one line per AI call + total. */
export function formatSummary(plan: Plan, state: ProjectState): string {
  const L: string[] = [];
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const lpad = (s: string | number, n: number) => String(s).padStart(n);
  const h = plan.headcount;
  const rule = "=".repeat(64);
  L.push(rule);
  L.push("HACKATHON PLAN — SUMMARY");
  L.push(`Plan version ${plan.version} · ${plan.valid ? "VALID (all six checks pass)" : "NOT VALID"} · ${new Date(plan.createdAt).toLocaleString()}`);
  L.push(rule);

  L.push("", "1. VENUE");
  if (plan.venue.chosen) {
    L.push(`   Hall:   ${plan.venue.chosen.label}`);
    L.push(`   Seats:  ${plan.venue.chosen.capacity} (needed: ${h.total} = ${h.students} students + ${h.judges} judges + ${h.staff} staff${h.extra.map((e) => ` + ${e.num} ${e.label}`).join("")})`);
    L.push(`   Cost:   ${rs(plan.venue.chosen.price)}`);
    if (plan.venue.requirements.length > 1) L.push(`   Meets:  ${plan.venue.requirements.slice(1).join(", ")}`);
  } else L.push("   No venue fits.");

  L.push("", `2. SCHEDULE (${plan.schedule.start}–${plan.schedule.end}, ${plan.schedule.durationMin} min)`);
  for (const i of plan.schedule.items) L.push(`   ${i.start}–${i.end}  ${i.label} (${i.minutes} min)`);

  L.push("", "3. FOOD");
  if (plan.food.option) {
    L.push(`   Box type:  ${plan.food.option.label} (${rs(plan.food.option.price)} per head)`);
    L.push(`   Quantity:  ${plan.food.ordered}`);
    for (const s of plan.food.specials) L.push(`   Includes:  ${s.count} ${s.label} @ ${rs(s.price)}`);
    for (const f of plan.food.fees) L.push(`   Plus:      ${f.label} ${f.amount === 0 ? "free" : rs(f.amount)}`);
    L.push(`   Cost:      ${rs(plan.food.cost)}`);
  } else L.push("   No meal option.");

  const j = plan.judging;
  L.push("", "4. JUDGING");
  L.push(`   Judges:  ${j.used} (${j.confirmed ?? "?"} confirmed, ${j.reserves ?? 0} reserve) for ${j.teams} teams`);
  L.push(`   Cost:    ${j.used} × ${rs(j.honorarium)} = ${j.used !== null && j.honorarium !== null ? rs(j.used * j.honorarium) : "?"}`);

  L.push("", "5. BUDGET");
  for (const l of plan.budget.lines) L.push(`   ${pad(l.label, 40)}${lpad(rs(l.amount), 14)}`);
  L.push(`   ${"-".repeat(54)}`);
  L.push(`   ${pad("TOTAL", 40)}${lpad(rs(plan.budget.total), 14)}`);
  const fits = plan.budget.cap !== null && plan.budget.total <= plan.budget.cap;
  L.push(`   Against ${rs(plan.budget.cap)}: ${fits ? `FITS (${rs(plan.budget.remaining)} left)` : `OVER by ${rs(-(plan.budget.remaining ?? 0))}`}`);

  L.push("", "TRACE (one line per AI call)");
  L.push(`   ${pad("#", 4)}${pad("Model", 26)}${pad("For", 18)}${lpad("Tokens", 8)}`);
  let total = 0;
  let calls = 0;
  for (const r of state.runs)
    for (const c of r.calls) {
      calls++;
      total += c.usage.totalTokens ?? 0;
      L.push(`   ${pad(c.n, 4)}${pad(c.model, 26)}${pad(PURPOSE[c.area] ?? c.area, 18)}${lpad(c.usage.totalTokens ?? "n/a", 8)}${c.ok ? "" : "  (failed attempt)"}`);
    }
  L.push(`   ${"-".repeat(56)}`);
  L.push(`   TOTAL: ${calls} call${calls === 1 ? "" : "s"}, ${total.toLocaleString("en-US")} tokens (as reported by the API)`);
  L.push(rule);
  return L.join("\n") + "\n";
}
