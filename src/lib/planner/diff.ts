import type { Plan, PlanChange } from "../types";
import { rs } from "./time";

export function diffPlans(a: Plan | null, b: Plan): PlanChange[] {
  if (!a) return [{ area: "plan", field: "plan", from: "—", to: `v${b.version} created` }];
  const out: PlanChange[] = [];
  const cmp = (area: PlanChange["area"], field: string, x: unknown, y: unknown) => {
    const fx = x === null || x === undefined ? "—" : String(x);
    const fy = y === null || y === undefined ? "—" : String(y);
    if (fx !== fy) out.push({ area, field, from: fx, to: fy });
  };
  cmp("venue", "venue", a.venue.chosen && `${a.venue.chosen.label} (${a.venue.chosen.capacity} seats, ${rs(a.venue.chosen.price)})`, b.venue.chosen && `${b.venue.chosen.label} (${b.venue.chosen.capacity} seats, ${rs(b.venue.chosen.price)})`);
  cmp("venue", "headcount", a.headcount.total, b.headcount.total);
  cmp("food", "meal option", a.food.option && `${a.food.option.label} @ ${rs(a.food.option.price)}`, b.food.option && `${b.food.option.label} @ ${rs(b.food.option.price)}`);
  cmp("food", "meals ordered", a.food.ordered, b.food.ordered);
  cmp("food", "food cost", rs(a.food.cost), rs(b.food.cost));
  cmp("judging", "judges used", a.judging.used, b.judging.used);
  cmp("judging", "judges confirmed", a.judging.confirmed, b.judging.confirmed);
  cmp("judging", "judging block (min)", a.judging.blockMinutes, b.judging.blockMinutes);
  const sched = (p: Plan) => p.schedule.items.map((i) => `${i.start} ${i.label} (${i.minutes})`).join("; ");
  cmp("schedule", "timeline", sched(a), sched(b));
  cmp("budget", "cap", rs(a.budget.cap), rs(b.budget.cap));
  const la = new Map(a.budget.lines.map((l) => [l.label, l.amount]));
  const lb = new Map(b.budget.lines.map((l) => [l.label, l.amount]));
  for (const k of new Set([...la.keys(), ...lb.keys()])) cmp("budget", k, la.has(k) ? rs(la.get(k)) : null, lb.has(k) ? rs(lb.get(k)) : null);
  cmp("budget", "total spend", rs(a.budget.total), rs(b.budget.total));
  cmp("budget", "remaining", rs(a.budget.remaining), rs(b.budget.remaining));
  cmp("plan", "valid", a.valid ? "yes" : "no", b.valid ? "yes" : "no");
  return out;
}
