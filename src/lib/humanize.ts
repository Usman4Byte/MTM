// Plain-English wording for facts, used wherever people (not machines) read them.

import { rs } from "./planner/time";
import type { Fact } from "./types";

const mins = (n?: number) => (n === undefined ? "?" : n % 60 === 0 && n >= 60 ? `${n / 60}-hour` : `${n}-min`);
const at = (t?: string) => (t ? ` at ${t}` : "");

export function humanizeFact(f: Pick<Fact, "kind" | "label" | "num" | "price" | "text" | "features">): string {
  const L = f.label ?? "";
  const n = f.num;
  switch (f.kind) {
    case "students":
      return `${n} students`;
    case "team_size":
      return `teams of ${n}`;
    case "teams":
      return `${n} teams`;
    case "staff":
      return `${n} staff on duty`;
    case "extra_people":
      return `${n} ${L || "extra people"} to seat and feed`;
    case "duration_min":
      return n !== undefined && n % 60 === 0 ? `${n / 60}-hour event` : `${n}-minute event`;
    case "start_time":
      return `starts at ${f.text}`;
    case "end_by":
      return `must end by ${f.text}`;
    case "budget_total":
      return `total budget ${rs(n)}`;
    case "committed":
      return `already spent: ${L} ${rs(n)}`;
    case "cost":
      return `required cost: ${L} ${rs(n)}`;
    case "request":
      return `asked for ${L} ${rs(n)} (not approved)`;
    case "venue_option":
      return `${L}: ${n ?? "?"} seats, ${rs(f.price)}${f.features?.length ? ` (${f.features.join(", ")})` : ""}`;
    case "venue_require":
      return `venue must have ${f.text ?? L}`;
    case "venue_exclude":
      return `${L} cannot be used${f.text ? ` (${f.text})` : ""}`;
    case "venue_min_capacity":
      return `venue must seat at least ${n}`;
    case "food_option":
      return `${L}: ${rs(f.price)} per head`;
    case "food_fee":
      return n === 0 ? `${L || "delivery"} is free` : `${L || "catering fee"} ${rs(n)}`;
    case "food_fee_pct":
      return `${L || "service charge"} ${n}% of the food bill`;
    case "food_order_qty":
      return `order of ${n} meals`;
    case "food_special":
      return `${n} ${L || "special"} meals${f.price !== undefined ? ` at ${rs(f.price)}` : ""}`;
    case "food_use":
      return `serve ${L}`;
    case "judges_confirmed":
      return `${n} judges confirmed`;
    case "honorarium":
      return `${rs(n)} per judge`;
    case "minutes_per_team":
      return `${n} min of judging per team`;
    case "max_teams_per_judge":
      return `max ${n} teams per judge`;
    case "judges_min":
      return `at least ${n} judges`;
    case "judge_late_min":
      return `a judge may be ${n} min late`;
    case "break":
      return `${mins(n)} ${L || "break"}${at(f.text)}`;
    case "block":
      return `${mins(n)} ${L || "session"}${at(f.text)}`;
    case "lunch_min":
      return `lunch needs ${n} min`;
    case "note":
      return f.text ?? L ?? "note";
  }
}

/** Reasons start with machine prefixes; keep the human part. */
export function cleanReason(s?: string): string {
  return (s ?? "invalid")
    .replace(/^Reading check:\s*/i, "")
    .replace(/^Breaks the plan — /, "")
    .replace(/\.\.+/g, ".")
    .replace(/\s*Plan kept valid without it\.?$/, "");
}
