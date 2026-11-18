// Planner/validator unit tests with SYNTHETIC numbers (deliberately not the sample pack's).
import assert from "node:assert/strict";
import { test } from "node:test";
import { factKey, resolveSupersession } from "../src/lib/facts";
import { DEFAULT_POLICY, buildPlan } from "../src/lib/planner";
import { FACT_KINDS, type Fact, type FactKind, type Message } from "../src/lib/types";

let id = 0;
function f(kind: FactKind, p: Partial<Fact> = {}, msgId = "M1"): Fact {
  const x: Fact = { id: `F${++id}`, msgId, kind, area: FACT_KINDS[kind].area, key: "", status: "active", origin: "reading", runId: 1, ...p };
  x.key = factKey(x);
  return x;
}
function base(): Fact[] {
  return [
    f("students", { num: 120 }),
    f("team_size", { num: 4 }),
    f("duration_min", { num: 300 }),
    f("staff", { num: 6 }),
    f("budget_total", { num: 500000 }),
    f("break", { label: "rest", num: 20 }),
    f("venue_option", { label: "small room", num: 100, price: 30000 }),
    f("venue_option", { label: "big hall", num: 180, price: 90000, features: ["projector"] }),
    f("venue_option", { label: "huge hall", num: 400, price: 200000 }),
    f("food_option", { label: "premium", price: 1500 }),
    f("food_option", { label: "simple", price: 700 }),
    f("judges_confirmed", { num: 12 }),
    f("honorarium", { num: 4000 }),
    f("minutes_per_team", { num: 10 }),
    f("max_teams_per_judge", { num: 4 }),
    f("committed", { label: "trophies", num: 60000 }),
  ];
}

test("valid plan: arithmetic, cheapest fitting venue, best food within budget", () => {
  const p = buildPlan(base(), 1, 1, DEFAULT_POLICY);
  assert.equal(p.judging.teams, 30);
  assert.equal(p.judging.required, 8); // ceil(30/4)
  assert.equal(p.judging.used, 8);
  assert.equal(p.headcount.total, 120 + 8 + 6);
  assert.equal(p.venue.chosen?.label, "big hall");
  assert.equal(p.food.option?.label, "premium");
  assert.equal(p.food.cost, 134 * 1500);
  assert.equal(p.budget.total, 90000 + 134 * 1500 + 8 * 4000 + 60000);
  assert.equal(p.schedule.items.reduce((s, i) => s + i.minutes, 0), 300);
  assert.ok(p.valid, JSON.stringify(p.checks.filter((c) => !c.pass)));
});

test("tight budget downgrades food instead of breaking the cap", () => {
  const facts = base().map((x) => (x.kind === "budget_total" ? { ...x, num: 300000 } : x));
  const p = buildPlan(facts, 1, 1, DEFAULT_POLICY);
  assert.equal(p.food.option?.label, "simple");
  assert.ok(p.budget.total <= 300000);
  assert.ok(p.valid);
});

test("impossible budget is reported, not hidden", () => {
  const facts = base().map((x) => (x.kind === "budget_total" ? { ...x, num: 100000 } : x));
  const p = buildPlan(facts, 1, 1, DEFAULT_POLICY);
  assert.equal(p.valid, false);
  assert.ok(p.conflicts.some((c) => c.includes("No combination fits")));
  assert.equal(p.checks.find((c) => c.id === "budget")?.pass, false);
});

test("short meal order fails the figures check", () => {
  const p = buildPlan([...base(), f("food_order_qty", { num: 50 })], 1, 1, DEFAULT_POLICY);
  assert.equal(p.checks.find((c) => c.id === "figures")?.pass, false);
});

test("venue requirement and fixed-time break are honoured", () => {
  const facts = [...base().filter((x) => x.kind !== "break"), f("venue_require", { text: "projector" }), f("break", { label: "prayer", num: 15, text: "12:30" }), f("start_time", { text: "10:00" })];
  const p = buildPlan(facts, 1, 1, DEFAULT_POLICY);
  assert.equal(p.venue.chosen?.label, "big hall");
  const prayer = p.schedule.items.find((i) => i.label === "prayer");
  assert.equal(prayer?.start, "12:30");
  assert.ok(p.valid, JSON.stringify(p.checks.filter((c) => !c.pass)));
});

test("not enough judges fails the judges check", () => {
  const facts = base().map((x) => (x.kind === "judges_confirmed" ? { ...x, num: 5 } : x));
  const p = buildPlan(facts, 1, 1, DEFAULT_POLICY);
  assert.equal(p.checks.find((c) => c.id === "judges")?.pass, false);
});

test("uneven teams fail the figures check", () => {
  const facts = base().map((x) => (x.kind === "students" ? { ...x, num: 121 } : x));
  const p = buildPlan(facts, 1, 1, DEFAULT_POLICY);
  assert.equal(p.checks.find((c) => c.id === "figures")?.pass, false);
});

test("all_confirmed judge policy pays and feeds every confirmed judge", () => {
  const p = buildPlan(base(), 1, 1, { ...DEFAULT_POLICY, judgePolicy: "all_confirmed" });
  assert.equal(p.judging.used, 12);
  assert.equal(p.headcount.total, 120 + 12 + 6);
});

test("newer dated message supersedes older one for the same item", () => {
  const msgs: Message[] = [
    { id: "M1", runId: 1, seq: 1, from: "vendor", date: "2026-01-20", relevance: "relevant", text: "", source: { name: "x", detectedType: "txt", sizeBytes: 0, lines: [1, 1] }, status: "pending", reasons: [] },
    { id: "M2", runId: 1, seq: 2, from: "vendor", date: "2026-01-05", relevance: "relevant", text: "", source: { name: "x", detectedType: "txt", sizeBytes: 0, lines: [2, 2] }, status: "pending", reasons: [] },
  ];
  const a = f("food_option", { label: "Simple", price: 900 }, "M1");
  const b = f("food_option", { label: "simple", price: 700 }, "M2");
  resolveSupersession([a, b], msgs);
  assert.equal(a.status, "active"); // later date wins even though it arrived first
  assert.equal(b.status, "superseded");
});

test("fixed-time break near the end: judging moves before it, buffer absorbs the rest", () => {
  const facts = [...base().filter((x) => x.kind !== "break"), f("start_time", { text: "11:30" }), f("break", { label: "asr", num: 20, text: "15:30" })];
  const p = buildPlan(facts, 1, 1, DEFAULT_POLICY);
  assert.equal(p.schedule.items.find((i) => i.label === "asr")?.start, "15:30");
  assert.ok(p.valid, JSON.stringify(p.checks.filter((c) => !c.pass).map((c) => c.details)));
});

test("a cost correction replaces the committed item with the same name", () => {
  const a = f("committed", { label: "Printing", num: 10000 });
  const b = f("cost", { label: "printing", num: 15000 });
  assert.equal(a.key, b.key);
});
