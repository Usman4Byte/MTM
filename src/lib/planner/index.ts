// Deterministic planner. Input: active facts. Output: a Plan (validated separately).
// All arithmetic, choices and allocation happen here in plain code, never in the model.

import { normLabel } from "../facts";
import type { BudgetLine, Fact, FactKind, Plan, ScheduleItem } from "../types";
import { fmtClock, parseClock, rs } from "./time";
import { DEFAULT_PLACE, placeFromEnv, prayerKind, prayerTimes, type PrayerPlace } from "./prayer";
import { validatePlan } from "./validate";

/** Planning policy: defaults the planner uses when the messages are silent. Not facts. */
export interface PlannerPolicy {
  /** "minimum": engage only the judges the coverage rule needs (spares are reserves, unpaid, unfed).
   *  "all_confirmed": engage, pay and feed every confirmed judge. */
  judgePolicy: "minimum" | "all_confirmed";
  defaultStart: string;
  openingMin: number;
  lunchMin: number;
  closingMin: number;
  minBuildMin: number;
  /** YYYY-MM-DD used for prayer times; today when unset */
  eventDate?: string;
  /** when Zuhr is prayed together locally, "HH:MM-HH:MM" (Pakistan mosques: about 13:15-13:45) */
  zuhrJamaat: string;
  place: PrayerPlace;
}

export function policyFromEnv(): PlannerPolicy {
  return {
    judgePolicy: process.env.MTM_JUDGE_POLICY === "all_confirmed" ? "all_confirmed" : "minimum",
    defaultStart: process.env.MTM_DEFAULT_START ?? "10:00",
    openingMin: 10,
    lunchMin: 30,
    closingMin: 15,
    minBuildMin: 60,
    eventDate: process.env.MTM_EVENT_DATE || undefined,
    zuhrJamaat: process.env.MTM_ZUHR_JAMAAT || "13:15-13:45",
    place: placeFromEnv(),
  };
}

export const DEFAULT_POLICY: PlannerPolicy = {
  judgePolicy: "minimum",
  defaultStart: "10:00",
  openingMin: 10,
  lunchMin: 30,
  closingMin: 15,
  minBuildMin: 60,
  place: DEFAULT_PLACE,
  zuhrJamaat: "13:15-13:45",
};

class FactView {
  constructor(private facts: Fact[]) {}
  one(kind: FactKind): Fact | undefined {
    return this.facts.find((f) => f.kind === kind);
  }
  many(kind: FactKind): Fact[] {
    return this.facts.filter((f) => f.kind === kind);
  }
  num(kind: FactKind): number | null {
    const v = this.one(kind)?.num;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
}

function featureMatch(have: string[], need: string): boolean {
  const n = normLabel(need);
  return have.some((h) => {
    const x = normLabel(h);
    return x === n || x.includes(n) || n.includes(x);
  });
}

export function buildPlan(active: Fact[], version: number, runId: number, policy: PlannerPolicy = DEFAULT_POLICY): Plan {
  const v = new FactView(active);
  const assumptions: string[] = [];
  const conflicts: string[] = [];

  // ---------- people ----------
  const students = v.num("students");
  const teamSize = v.num("team_size");
  const teamsStated = v.num("teams");
  const teams = teamsStated ?? (students !== null && teamSize ? students / teamSize : null);
  let staff = v.num("staff");
  if (staff === null) {
    staff = 0;
    assumptions.push("No staff count stated: no staff seats or meals included.");
  }
  const extras = v.many("extra_people").filter((f) => (f.num ?? 0) > 0).map((f) => ({ label: f.label ?? "others", num: f.num as number, id: f.id }));

  // ---------- judging ----------
  const confirmed = v.num("judges_confirmed");
  const maxPer = v.num("max_teams_per_judge");
  const minutesPer = v.num("minutes_per_team");
  const honorarium = v.num("honorarium");
  const judgesMin = v.num("judges_min");
  let required: number | null = null;
  if (teams !== null && maxPer && Number.isInteger(teams)) required = Math.ceil(teams / maxPer);
  if (judgesMin !== null) required = Math.max(required ?? 0, judgesMin);
  let used: number | null;
  if (required === null) {
    used = confirmed;
    if (confirmed !== null) assumptions.push("No limit on teams per judge stated: all confirmed judges are used.");
  } else if (confirmed === null) {
    used = required;
    assumptions.push(`Judge availability not stated: plan assumes ${required} judges can be found.`);
  } else if (confirmed < required) {
    used = confirmed;
    conflicts.push(`Only ${confirmed} judges confirmed but ${required} are needed for ${teams} teams at ${maxPer} teams per judge.`);
  } else {
    used = policy.judgePolicy === "all_confirmed" ? confirmed : required;
    if (policy.judgePolicy === "minimum" && confirmed > required)
      assumptions.push(
        `${confirmed} judges confirmed, ${required} needed (${teams} teams ÷ ${maxPer} per judge, rounded up). Plan engages ${required}; the other ${confirmed - required} are unpaid reserves and are not in the meal count. (Policy MTM_JUDGE_POLICY=minimum; set all_confirmed to pay and feed all ${confirmed}.)`,
      );
  }
  const assignments: { judge: string; teams: number[] }[] = [];
  if (used && teams !== null && Number.isInteger(teams) && teams > 0) {
    const base = Math.floor(teams / used);
    const extra = teams % used;
    let t = 1;
    for (let j = 0; j < used; j++) {
      const k = base + (j < extra ? 1 : 0);
      const ts: number[] = [];
      for (let i = 0; i < k; i++) ts.push(t++);
      assignments.push({ judge: `J${j + 1}`, teams: ts });
    }
  }
  const maxAssigned = assignments.reduce((m, a) => Math.max(m, a.teams.length), 0);
  const blockMinutes = minutesPer !== null && maxAssigned > 0 ? maxAssigned * minutesPer : null;

  // ---------- headcount ----------
  const total =
    students !== null && used !== null ? students + used + (staff ?? 0) + extras.reduce((s, e) => s + e.num, 0) : null;

  // ---------- venue candidates ----------
  const venueOpts = v.many("venue_option").filter((f) => f.label);
  const requires = v.many("venue_require").map((f) => f.text ?? f.label ?? "").filter(Boolean);
  const excluded = new Map(v.many("venue_exclude").map((f) => [normLabel(f.label), f.text ?? "excluded"]));
  const minCap = Math.max(total ?? 0, v.num("venue_min_capacity") ?? 0);
  const rejectedOptions: { label: string; why: string }[] = [];
  const venueCands = venueOpts
    .filter((o) => {
      const why: string[] = [];
      if (o.num === undefined) why.push("capacity unknown");
      else if (o.num < minCap) why.push(`seats ${o.num} < ${minCap} needed`);
      if (o.price === undefined) why.push("price unknown");
      for (const r of requires) if (!featureMatch([...(o.features ?? []), o.label ?? ""], r)) why.push(`no ${r}`);
      const ex = excluded.get(normLabel(o.label));
      if (ex !== undefined) why.push(`excluded: ${ex}`);
      if (why.length) rejectedOptions.push({ label: o.label!, why: why.join("; ") });
      return why.length === 0;
    })
    .sort((a, b) => a.price! - b.price! || a.num! - b.num!);

  // ---------- food ----------
  const foodOpts = v.many("food_option").filter((f) => f.label && f.price !== undefined);
  const use = v.one("food_use");
  const specials = v.many("food_special").filter((f) => (f.num ?? 0) > 0);
  const fees = v.many("food_fee").filter((f) => (f.num ?? 0) > 0);
  const orderQty = v.num("food_order_qty");
  const meals = total;
  const ordered = orderQty ?? meals;
  let foodOrder = [...foodOpts].sort((a, b) => b.price! - a.price!);
  if (use) {
    const pick = foodOpts.find((o) => normLabel(o.label) === normLabel(use.label));
    if (pick) foodOrder = [pick];
    else conflicts.push(`Instruction to serve "${use.label}" but no such meal option has a price.`);
  }
  const specialCount = specials.reduce((s, f) => s + (f.num ?? 0), 0);
  const foodCost = (opt: Fact | undefined): number | null => {
    if (!opt || ordered === null) return null;
    const normal = Math.max(0, ordered - specialCount) * opt.price!;
    const sp = specials.reduce((s, f) => s + (f.num ?? 0) * (f.price ?? opt.price!), 0);
    return normal + sp + fees.reduce((s, f) => s + (f.num ?? 0), 0);
  };

  // ---------- fixed costs ----------
  const cap = v.num("budget_total");
  const judgeCost = used !== null && honorarium !== null ? used * honorarium : 0;
  const committed = v.many("committed").filter((f) => (f.num ?? 0) > 0);
  const costs = v.many("cost").filter((f) => (f.num ?? 0) > 0);
  const fixedCost = judgeCost + committed.reduce((s, f) => s + f.num!, 0) + costs.reduce((s, f) => s + f.num!, 0);

  // ---------- choose venue + food together (best meal option, then cheapest venue, within budget) ----------
  let chosenVenue: Fact | undefined;
  let chosenFood: Fact | undefined;
  const combos: { venue?: Fact; food?: Fact; total: number }[] = [];
  const vList: (Fact | undefined)[] = venueCands.length ? venueCands : [undefined];
  const fList: (Fact | undefined)[] = foodOrder.length ? foodOrder : [undefined];
  for (const f of fList) for (const ve of vList) combos.push({ venue: ve, food: f, total: fixedCost + (ve?.price ?? 0) + (foodCost(f) ?? 0) });
  const fits = combos.find((c) => cap === null || c.total <= cap);
  if (fits) {
    chosenVenue = fits.venue;
    chosenFood = fits.food;
  } else if (combos.length) {
    const cheapest = combos.reduce((a, b) => (b.total < a.total ? b : a));
    chosenVenue = cheapest.venue;
    chosenFood = cheapest.food;
    conflicts.push(
      `No combination fits the budget: the cheapest valid plan costs ${rs(cheapest.total)}, which is ${rs(cheapest.total - (cap ?? 0))} over the cap of ${rs(cap)}.`,
    );
  }
  if (cap === null) assumptions.push("No budget cap stated.");
  if (!venueCands.length && venueOpts.length) conflicts.push(`No venue meets the requirements (needs ${minCap} seats${requires.length ? `, ${requires.join(", ")}` : ""}).`);
  if (foodOrder.length > 1 && chosenFood && chosenFood !== foodOrder[0])
    assumptions.push(`Meal downgraded to "${chosenFood.label}" because "${foodOrder[0].label}" does not fit the budget.`);
  else if (foodOrder.length > 1 && chosenFood) assumptions.push(`Meal option "${chosenFood.label}" chosen: the best-priced option that fits the budget.`);

  // ---------- budget lines ----------
  const lines: BudgetLine[] = [];
  if (chosenVenue) lines.push({ area: "venue", label: `Venue: ${chosenVenue.label}`, amount: chosenVenue.price!, formula: rs(chosenVenue.price), factIds: [chosenVenue.id] });
  if (chosenFood && ordered !== null) {
    const normal = Math.max(0, ordered - specialCount);
    lines.push({ area: "food", label: `Meals: ${chosenFood.label}`, amount: normal * chosenFood.price!, formula: `${normal} × ${rs(chosenFood.price)}`, factIds: [chosenFood.id] });
    for (const s of specials)
      lines.push({ area: "food", label: `Meals: ${s.label}`, amount: s.num! * (s.price ?? chosenFood.price!), formula: `${s.num} × ${rs(s.price ?? chosenFood.price)}`, factIds: [s.id] });
    for (const f of fees) lines.push({ area: "food", label: `Catering: ${f.label}`, amount: f.num!, formula: rs(f.num), factIds: [f.id] });
  }
  if (judgeCost > 0) {
    const ids = [v.one("honorarium")?.id, v.one("judges_confirmed")?.id, v.one("max_teams_per_judge")?.id].filter(Boolean) as string[];
    lines.push({ area: "judging", label: "Judge honoraria", amount: judgeCost, formula: `${used} × ${rs(honorarium)}`, factIds: ids });
  }
  for (const c of committed) lines.push({ area: "budget", label: `Already ordered: ${c.label}`, amount: c.num!, formula: rs(c.num), factIds: [c.id] });
  for (const c of costs) lines.push({ area: "budget", label: `Required: ${c.label}`, amount: c.num!, formula: rs(c.num), factIds: [c.id] });
  const budgetTotal = lines.reduce((s, l) => s + l.amount, 0);
  const remaining = cap !== null ? cap - budgetTotal : null;
  const requests = v
    .many("request")
    .filter((f) => (f.num ?? 0) > 0)
    .map((f) => ({ label: f.label ?? "request", amount: f.num!, wouldFit: remaining !== null && remaining >= f.num!, factId: f.id }));

  // ---------- schedule ----------
  const duration = v.num("duration_min");
  const endBy = parseClock(v.one("end_by")?.text);
  let start = parseClock(v.one("start_time")?.text);
  if (start === null && endBy !== null && duration !== null) {
    start = endBy - duration;
    assumptions.push(`No start time stated: start set to ${fmtClock(start)} so the event ends by ${fmtClock(endBy)}.`);
  }
  if (start === null) {
    start = parseClock(policy.defaultStart) ?? 600;
    assumptions.push(`No start time stated: schedule assumes ${fmtClock(start)} (MTM_DEFAULT_START).`);
  }
  const hasMeal = foodOpts.length > 0;
  let sched = duration !== null ? layoutSchedule(v, start, duration, blockMinutes, hasMeal, policy) : { items: [], notes: ["Event duration not stated."] };
  // A prayer break without a stated time goes at the time people actually pray together (mosque jamaat),
  // e.g. Zuhr 13:15-13:45 in Pakistan, not just "after lunch". Every 15-min start inside that window is
  // tried with lunch before it, after it, or on its own; the layout where the day flows best wins.
  const prayer = v.many("break").find((f) => !parseClock(f.text) && prayerKind(f.label));
  if (prayer && duration !== null) {
    const date = policy.eventDate ? new Date(`${policy.eventDate}T12:00:00Z`) : new Date();
    const pt = prayerTimes(date, policy.place);
    const friday = date.getUTCDay() === 5;
    const kind = prayerKind(prayer.label);
    const end = start + duration;
    const len = prayer.num ?? 15;
    const zuhr = parseRange(policy.zuhrJamaat) ?? [13 * 60 + 15, 13 * 60 + 45];
    const windows: { name: string; from: number; to: number; begins: number }[] = [];
    if (kind !== "asr")
      windows.push(
        friday
          ? { name: "Jumu'ah", from: zuhr[0], to: Math.max(zuhr[1], 14 * 60), begins: pt.dhuhr }
          : { name: "Zuhr", from: zuhr[0], to: zuhr[1], begins: pt.dhuhr },
      );
    if (kind !== "dhuhr") windows.push({ name: "Asr", from: pt.asr + 15, to: pt.asr + 45, begins: pt.asr });
    const lunchLen = v.num("lunch_min") ?? policy.lunchMin;
    let best: { score: number; sched: typeof sched; at: number; w: (typeof windows)[number]; lunch: string } | null = null;
    for (const w of windows) {
      for (let at = Math.ceil(w.from / 15) * 15; at + len <= w.to + (w.to - w.from > 30 ? 15 : 0) && at <= w.to; at += 15) {
        if (at < start + policy.openingMin || at + len > end - policy.closingMin) continue;
        const lunchChoices: [string, number | undefined][] = hasMeal
          ? [
              ["before", at - lunchLen],
              ["after", at + len],
              ["separate", undefined],
            ]
          : [["none", undefined]];
        for (const [lunchPos, lunchAt] of lunchChoices) {
          if (lunchAt !== undefined && (lunchAt < start + policy.openingMin || lunchAt + lunchLen > end - policy.closingMin)) continue;
          const trial = layoutSchedule(v, start, duration, blockMinutes, hasMeal, policy, { fixedAt: { [prayer.id]: at }, lunchAt });
          if (trial.notes.length) continue;
          const items = trial.items;
          const lastBuild = items.map((i) => i.kind).lastIndexOf("build");
          const judgingIdx = items.findIndex((i) => i.kind === "judging");
          const closingLast = items[items.length - 1]?.kind === "closing";
          const buffer = items.filter((i) => i.label.startsWith("Buffer")).reduce((x, i) => x + i.minutes, 0);
          const buildPieces = items.filter((i) => i.kind === "build").length;
          const score =
            (closingLast ? 0 : 1000) +
            (judgingIdx < 0 || judgingIdx > lastBuild ? 0 : 500) + // judging after all building
            buffer * 5 + // no idle time
            (buildPieces - 1) * 8 + // fewer interruptions to building
            (lunchPos === "separate" ? 6 : 0) + // lunch next to prayer is how events run
            (at - w.from) * 0.05;
          if (!best || score < best.score) best = { score, sched: trial, at, w, lunch: lunchPos };
        }
      }
    }
    if (best) {
      sched = best.sched;
      const day = date.toISOString().slice(0, 10);
      assumptions.push(
        `Prayer break ${fmtClock(best.at)}–${fmtClock(best.at + len)}: ${best.w.name} is prayed together (jamaat) at about ${fmtClock(best.w.from)}–${fmtClock(best.w.to)} (${best.w.name === "Asr" ? `Asr begins ${fmtClock(best.w.begins)}, Hanafi` : `prayer time begins ${fmtClock(best.w.begins)}`}) in ${policy.place.name} on ${day}${best.lunch === "before" ? "; lunch just before it" : best.lunch === "after" ? "; lunch right after it" : ""}. Change with MTM_ZUHR_JAMAAT / MTM_EVENT_DATE.`,
      );
    } else {
      assumptions.push(`No congregational prayer time (${windows.map((w) => `${w.name} ${fmtClock(w.from)}–${fmtClock(w.to)}`).join(", ")}) fits inside ${fmtClock(start)}–${fmtClock(end)}; the prayer break is scheduled as a normal break.`);
    }
  }

  const plan: Plan = {
    version,
    runId,
    createdAt: new Date().toISOString(),
    feasible: conflicts.length === 0,
    headcount: { students, judges: used, staff, extra: extras.map(({ label, num }) => ({ label, num })), total },
    venue: {
      chosen: chosenVenue
        ? { label: chosenVenue.label!, capacity: chosenVenue.num!, price: chosenVenue.price!, features: chosenVenue.features ?? [], factId: chosenVenue.id }
        : null,
      rejectedOptions,
      requirements: [`at least ${minCap} seats`, ...requires],
    },
    food: {
      option: chosenFood ? { label: chosenFood.label!, price: chosenFood.price!, factId: chosenFood.id } : null,
      meals,
      ordered,
      specials: specials.map((s) => ({ label: s.label ?? "special", count: s.num!, price: s.price ?? chosenFood?.price ?? 0 })),
      fees: fees.map((f) => ({ label: f.label ?? "fee", amount: f.num! })),
      cost: foodCost(chosenFood),
      alternatives: foodOpts.filter((o) => o !== chosenFood).map((o) => `${o.label} ${rs(o.price)}/head`),
    },
    judging: {
      teams,
      confirmed,
      required,
      used,
      reserves: confirmed !== null && used !== null ? Math.max(0, confirmed - used) : null,
      minutesPerTeam: minutesPer,
      maxTeamsPerJudge: maxPer,
      honorarium,
      assignments,
      blockMinutes,
    },
    schedule: {
      start: fmtClock(start),
      end: duration !== null ? fmtClock(start + duration) : null,
      durationMin: duration,
      items: sched.items,
      notes: sched.notes,
    },
    budget: { cap, lines, total: budgetTotal, remaining, requests },
    assumptions,
    conflicts,
    checks: [],
    valid: false,
  };
  plan.checks = validatePlan(plan, active, policy);
  plan.valid = plan.checks.every((c) => c.pass);
  return plan;
}

function parseRange(r: string | undefined): [number, number] | null {
  const m = /(\d{1,2}[:.]\d{2})\s*[-–]\s*(\d{1,2}[:.]\d{2})/.exec(r ?? "");
  const a = parseClock(m?.[1]);
  const b = parseClock(m?.[2]);
  return a !== null && b !== null && b > a ? [a, b] : null;
}

interface Slot {
  label: string;
  kind: ScheduleItem["kind"];
  minutes: number;
  elastic: boolean;
  factIds: string[];
}

function layoutSchedule(
  v: FactView,
  start: number,
  duration: number,
  judgingMin: number | null,
  hasMeal: boolean,
  policy: PlannerPolicy,
  opts: { fixedAt?: Record<string, number>; lunchAt?: number } = {},
): { items: ScheduleItem[]; notes: string[] } {
  const notes: string[] = [];
  const fixed: { at: number; slot: Slot }[] = [];
  const floatingBreaks: Slot[] = [];
  const floatingBlocks: Slot[] = [];
  for (const f of [...v.many("break"), ...v.many("block")]) {
    const slot: Slot = { label: f.label ?? f.kind, kind: f.kind === "break" ? "break" : "block", minutes: f.num ?? 0, elastic: false, factIds: [f.id] };
    if (slot.minutes <= 0) {
      notes.push(`"${slot.label}" has no duration; not scheduled.`);
      continue;
    }
    const at = opts.fixedAt?.[f.id] ?? parseClock(f.text);
    if (at !== null) fixed.push({ at, slot });
    else (f.kind === "break" ? floatingBreaks : floatingBlocks).push(slot);
  }
  const lunchSlot: Slot = { label: "Lunch", kind: "meal", minutes: v.num("lunch_min") ?? policy.lunchMin, elastic: false, factIds: v.one("lunch_min") ? [v.one("lunch_min")!.id] : [] };
  const lunchFixed = hasMeal && opts.lunchAt !== undefined;
  if (lunchFixed) fixed.push({ at: opts.lunchAt!, slot: lunchSlot });
  fixed.sort((a, b) => a.at - b.at);
  const seq: Slot[] = [
    { label: "Opening & briefing", kind: "opening", minutes: policy.openingMin, elastic: false, factIds: [] },
    { label: "Build (hacking)", kind: "build", minutes: 0, elastic: true, factIds: [] },
    ...(hasMeal && !lunchFixed ? [lunchSlot] : []),
    ...floatingBreaks,
    { label: "Build (hacking)", kind: "build", minutes: 0, elastic: true, factIds: [] },
    ...floatingBlocks,
    ...(judgingMin ? [{ label: "Judging (all judges in parallel)", kind: "judging" as const, minutes: judgingMin, elastic: false, factIds: [] }] : []),
    { label: "Closing & results", kind: "closing", minutes: policy.closingMin, elastic: false, factIds: [] },
  ];
  const fixedSum = seq.filter((s) => !s.elastic).reduce((a, s) => a + s.minutes, 0) + fixed.reduce((a, f) => a + f.slot.minutes, 0);
  const build = duration - fixedSum;
  if (build < 0) notes.push(`Required sessions need ${fixedSum} min but the event is only ${duration} min.`);
  const firstBuild = Math.max(0, Math.round(build / 2 / 5) * 5);
  const elastic = seq.filter((s) => s.elastic);
  elastic[0].minutes = Math.min(firstBuild, Math.max(0, build));
  elastic[1].minutes = Math.max(0, build - elastic[0].minutes);

  // Sweep the timeline. If a fixed session cannot fit before a fixed-time item and there is no later
  // build time to absorb the gap, shrink earlier build time instead and add the minutes back as a buffer.
  const sweep = (slots: Slot[]) => {
    const out: ScheduleItem[] = [];
    const sweepNotes: string[] = [];
    let need = 0;
    const push = (s: Slot, at: number, minutes: number) => {
      const last = out[out.length - 1];
      if (last && last.kind === "build" && s.kind === "build" && parseClock(last.end) === at) {
        last.minutes += minutes;
        last.end = fmtClock(at + minutes);
        return;
      }
      out.push({ start: fmtClock(at), end: fmtClock(at + minutes), minutes, label: s.label, kind: s.kind, factIds: s.factIds });
    };
    let cursor = start;
    const q = [...fixed];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      let rem = s.minutes;
      let guard = 0;
      while (rem > 0 && guard++ < 50) {
        const nf = q[0];
        if (nf && cursor >= nf.at) {
          if (cursor > nf.at) sweepNotes.push(`"${nf.slot.label}" was due at ${fmtClock(nf.at)} but could only start at ${fmtClock(cursor)}.`);
          push(nf.slot, cursor, nf.slot.minutes);
          cursor += nf.slot.minutes;
          q.shift();
          continue;
        }
        const room = nf ? nf.at - cursor : Infinity;
        if (s.elastic) {
          const take = Math.min(rem, room);
          push(s, cursor, take);
          cursor += take;
          rem -= take;
        } else if (rem <= room) {
          push(s, cursor, rem);
          cursor += rem;
          rem = 0;
        } else {
          const donor = slots.slice(i + 1).find((x) => x.elastic && x.minutes > 0);
          const take = donor ? Math.min(room, donor.minutes) : room;
          if (donor) donor.minutes -= take;
          else if (!need) need = rem - room;
          push({ label: "Build (hacking)", kind: "build", minutes: take, elastic: true, factIds: [] }, cursor, take);
          cursor += take;
        }
      }
    }
    while (q.length) {
      const nf = q.shift()!;
      if (cursor > nf.at) sweepNotes.push(`"${nf.slot.label}" was due at ${fmtClock(nf.at)} but could only start at ${fmtClock(cursor)}.`);
      const at = Math.max(cursor, nf.at);
      if (at > cursor) push({ label: "Build (hacking)", kind: "build", minutes: at - cursor, elastic: true, factIds: [] }, cursor, at - cursor);
      push(nf.slot, at, nf.slot.minutes);
      cursor = at + nf.slot.minutes;
    }
    return { out, sweepNotes, cursor, need };
  };
  const clone = () => seq.map((x) => ({ ...x }));
  let res = sweep(clone());
  for (let tries = 0; res.cursor !== start + duration && res.need > 0 && tries < 3; tries++) {
    const slots = clone();
    let left = res.need;
    for (const el of slots.filter((x) => x.elastic).reverse()) {
      const cut = Math.min(left, el.minutes);
      el.minutes -= cut;
      left -= cut;
    }
    if (left > 0) break;
    const closing = slots.findIndex((x) => x.kind === "closing");
    slots.splice(closing < 0 ? slots.length : closing, 0, { label: "Buffer (free time)", kind: "block", minutes: res.need, elastic: false, factIds: [] });
    const next = sweep(slots);
    if (next.cursor === start + duration && next.sweepNotes.length === 0) {
      res = next;
      break;
    }
    if (next.need) res = { ...next, need: res.need + next.need };
    else break;
  }
  notes.push(...res.sweepNotes);
  if (res.cursor !== start + duration) notes.push(`Schedule ends at ${fmtClock(res.cursor)} instead of ${fmtClock(start + duration)}.`);
  return { items: res.out.filter((x) => x.minutes > 0), notes };
}
