// The six scored checks. Each one recomputes from facts + plan instead of trusting planner totals.

import { normLabel } from "../facts";
import { AREAS, type CheckResult, type Fact, type Plan } from "../types";
import type { PlannerPolicy } from "./index";
import { parseClock, rs } from "./time";

export function validatePlan(plan: Plan, active: Fact[], policy: PlannerPolicy): CheckResult[] {
  const one = (k: Fact["kind"]) => active.find((f) => f.kind === k);
  const num = (k: Fact["kind"]) => (typeof one(k)?.num === "number" ? (one(k)!.num as number) : null);
  const many = (k: Fact["kind"]) => active.filter((f) => f.kind === k);

  // 1. correct figures
  const fig: string[] = [];
  let figOk = true;
  const students = num("students");
  const teamSize = num("team_size");
  const teamsStated = num("teams");
  if (students === null) {
    figOk = false;
    fig.push("Missing: number of students.");
  }
  if (students !== null && teamSize) {
    const t = students / teamSize;
    if (!Number.isInteger(t)) {
      figOk = false;
      fig.push(`${students} students do not split into teams of ${teamSize} (${t.toFixed(2)} teams).`);
    } else fig.push(`Teams: ${students} ÷ ${teamSize} = ${t}.`);
    if (teamsStated !== null && teamsStated !== t) {
      figOk = false;
      fig.push(`Stated ${teamsStated} teams but ${students} ÷ ${teamSize} = ${t}.`);
    }
  }
  const h = plan.headcount;
  if (h.total !== null) {
    const sum = (h.students ?? 0) + (h.judges ?? 0) + (h.staff ?? 0) + h.extra.reduce((s, e) => s + e.num, 0);
    if (sum !== h.total) {
      figOk = false;
      fig.push(`Headcount mismatch: parts sum to ${sum}, plan says ${h.total}.`);
    } else
      fig.push(
        `People to seat and feed: ${h.students} students + ${h.judges} judges + ${h.staff} staff${h.extra.map((e) => ` + ${e.num} ${e.label}`).join("")} = ${h.total}.`,
      );
    const ordered = plan.food.ordered;
    if (ordered !== null && ordered < h.total) {
      figOk = false;
      fig.push(`Meals ordered (${ordered}) are fewer than people to feed (${h.total}).`);
    } else if (ordered !== null) fig.push(`Meals: ${ordered} for ${h.total} people.`);
  } else {
    figOk = false;
    fig.push("Headcount cannot be computed (missing students or judges).");
  }
  const lineSum = plan.budget.lines.reduce((s, l) => s + l.amount, 0);
  if (lineSum !== plan.budget.total) {
    figOk = false;
    fig.push(`Budget lines sum to ${rs(lineSum)} but total says ${rs(plan.budget.total)}.`);
  }
  const hon = num("honorarium");
  const jl = plan.budget.lines.find((l) => l.area === "judging");
  if (hon !== null && h.judges !== null && jl && jl.amount !== hon * h.judges) {
    figOk = false;
    fig.push(`Honoraria should be ${h.judges} × ${rs(hon)} = ${rs(hon * h.judges)}.`);
  }
  if (plan.food.option && plan.food.ordered !== null) {
    const spCount = plan.food.specials.reduce((s, x) => s + x.count, 0);
    const expect =
      Math.max(0, plan.food.ordered - spCount) * plan.food.option.price +
      plan.food.specials.reduce((s, x) => s + x.count * x.price, 0) +
      plan.food.fees.reduce((s, x) => s + x.amount, 0);
    if (plan.food.cost !== expect) {
      figOk = false;
      fig.push(`Food cost should be ${rs(expect)}.`);
    }
  }

  // 2. budget
  const bud: string[] = [];
  const cap = num("budget_total");
  let budOk = cap !== null && plan.budget.total <= cap;
  if (cap === null) bud.push("Missing: budget cap.");
  else bud.push(`Spend ${rs(plan.budget.total)} of ${rs(cap)} → ${plan.budget.total <= cap ? `${rs(cap - plan.budget.total)} left` : `${rs(plan.budget.total - cap)} OVER`}.`);
  for (const c of many("committed")) {
    if (!plan.budget.lines.some((l) => l.factIds.includes(c.id))) {
      budOk = false;
      bud.push(`Committed spend "${c.label}" missing from the budget.`);
    }
  }
  if (plan.budget.requests.length) bud.push(`Not included (unapproved requests): ${plan.budget.requests.map((r) => `${r.label} ${rs(r.amount)}`).join(", ")}.`);

  // 3. venue fits
  const ven: string[] = [];
  const v = plan.venue.chosen;
  let venOk = !!v && h.total !== null;
  if (!v) ven.push("No venue chosen.");
  else if (h.total !== null) {
    const need = Math.max(h.total, num("venue_min_capacity") ?? 0);
    if (v.capacity < need) {
      venOk = false;
      ven.push(`${v.label} seats ${v.capacity} < ${need} needed.`);
    } else ven.push(`${v.label} seats ${v.capacity} ≥ ${need} needed.`);
    for (const r of many("venue_require")) {
      const need2 = normLabel(r.text ?? r.label);
      const has = [...v.features, v.label].some((f) => {
        const x = normLabel(f);
        return x === need2 || x.includes(need2) || need2.includes(x);
      });
      if (!has) {
        venOk = false;
        ven.push(`Requirement "${r.text ?? r.label}" not met.`);
      } else ven.push(`Has ${r.text ?? r.label}.`);
    }
    if (many("venue_exclude").some((e) => normLabel(e.label) === normLabel(v.label))) {
      venOk = false;
      ven.push(`${v.label} is excluded by a message.`);
    }
  }

  // 4. schedule valid
  const sch: string[] = [];
  let schOk = true;
  const items = plan.schedule.items;
  const dur = num("duration_min");
  if (dur === null) {
    schOk = false;
    sch.push("Missing: event duration.");
  }
  const start = parseClock(plan.schedule.start);
  if (items.length && start !== null && dur !== null) {
    let cur = start;
    for (const it of items) {
      const s = parseClock(it.start)!;
      if (s !== cur % 1440) {
        schOk = false;
        sch.push(`Gap or overlap before "${it.label}" at ${it.start}.`);
      }
      cur = s + it.minutes;
    }
    const sum = items.reduce((a, i) => a + i.minutes, 0);
    if (sum !== dur) {
      schOk = false;
      sch.push(`Sessions add up to ${sum} min, event is ${dur} min.`);
    } else sch.push(`${items.length} sessions fill exactly ${dur} min (${plan.schedule.start}–${plan.schedule.end}).`);
    for (const b of [...many("break"), ...many("block")]) {
      const it = items.find((i) => i.factIds.includes(b.id));
      if (!it) {
        schOk = false;
        sch.push(`Required "${b.label}" (${b.num} min) is missing.`);
        continue;
      }
      if (it.minutes < (b.num ?? 0)) {
        schOk = false;
        sch.push(`"${b.label}" is ${it.minutes} min, needs ${b.num}.`);
      }
      const at = parseClock(b.text);
      if (at !== null && parseClock(it.start) !== at) {
        schOk = false;
        sch.push(`"${b.label}" must start at ${b.text}, scheduled ${it.start}.`);
      } else sch.push(`"${b.label}" ${it.minutes} min at ${it.start}.`);
    }
    const build = items.filter((i) => i.kind === "build").reduce((a, i) => a + i.minutes, 0);
    if (build < policy.minBuildMin) {
      schOk = false;
      sch.push(`Only ${build} min of build time (minimum ${policy.minBuildMin}).`);
    }
    const jud = items.find((i) => i.kind === "judging");
    if (plan.judging.blockMinutes) {
      if (!jud || jud.minutes < plan.judging.blockMinutes) {
        schOk = false;
        sch.push(`Judging needs ${plan.judging.blockMinutes} min in the schedule.`);
      } else sch.push(`Judging block ${jud.minutes} min (${jud.start}–${jud.end}).`);
      const late = num("judge_late_min");
      if (late !== null && jud && parseClock(jud.start)! - start < late) {
        schOk = false;
        sch.push(`Judging starts before judges who are ${late} min late can arrive.`);
      } else if (late !== null) sch.push(`Judging starts ${parseClock(jud!.start)! - start} min after opening, so a ${late}-min-late judge is covered.`);
    }
    const endBy = parseClock(one("end_by")?.text);
    if (endBy !== null && start + dur > endBy) {
      schOk = false;
      sch.push(`Event ends after the required ${one("end_by")!.text}.`);
    }
  } else if (dur !== null) {
    schOk = false;
    sch.push("No schedule could be built.");
  }
  for (const n of plan.schedule.notes) {
    schOk = false;
    sch.push(n);
  }

  // 5. enough judges
  const jd: string[] = [];
  const j = plan.judging;
  let jOk = j.used !== null && j.used > 0 && j.teams !== null;
  if (!jOk) jd.push("Missing judges or teams.");
  else {
    if (j.required !== null && j.used! < j.required) {
      jOk = false;
      jd.push(`${j.used} judges used, ${j.required} needed.`);
    }
    if (j.confirmed !== null && j.used! > j.confirmed) {
      jOk = false;
      jd.push(`Plan uses ${j.used} judges but only ${j.confirmed} confirmed.`);
    }
    const covered = j.assignments.flatMap((a) => a.teams);
    if (covered.length !== j.teams || new Set(covered).size !== j.teams) {
      jOk = false;
      jd.push(`Assignments cover ${new Set(covered).size} of ${j.teams} teams.`);
    }
    if (j.maxTeamsPerJudge !== null && j.assignments.some((a) => a.teams.length > j.maxTeamsPerJudge!)) {
      jOk = false;
      jd.push(`A judge has more than ${j.maxTeamsPerJudge} teams.`);
    }
    if (jOk)
      jd.push(
        `${j.used} judges cover all ${j.teams} teams (max ${Math.max(...j.assignments.map((a) => a.teams.length))} each${j.maxTeamsPerJudge ? `, limit ${j.maxTeamsPerJudge}` : ""}); ${j.confirmed ?? "?"} confirmed, ${j.reserves ?? 0} reserve.`,
      );
  }

  // 6. all areas covered
  const cov: string[] = [];
  const present: Record<string, boolean> = {
    venue: !!plan.venue.chosen,
    schedule: plan.schedule.items.length > 0,
    food: !!plan.food.option && (plan.food.meals ?? 0) > 0,
    judging: plan.judging.assignments.length > 0,
    budget: plan.budget.cap !== null && plan.budget.lines.length > 0,
  };
  for (const a of AREAS) cov.push(`${a}: ${present[a] ? "covered" : "MISSING"}`);
  const covOk = AREAS.every((a) => present[a]);

  return [
    { id: "figures", name: "Correct figures", pass: figOk, details: fig },
    { id: "budget", name: "Within budget", pass: budOk, details: bud },
    { id: "venue", name: "Venue fits", pass: venOk, details: ven },
    { id: "schedule", name: "Schedule valid", pass: schOk, details: sch },
    { id: "judges", name: "Enough judges", pass: jOk, details: jd },
    { id: "coverage", name: "All five areas covered", pass: covOk, details: cov },
  ];
}
