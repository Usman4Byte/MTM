// Deterministic fact bookkeeping: identity keys, supersession (newest wins), provenance.

import type { Fact, FactKind, Message } from "./types";

const LABELED: ReadonlySet<FactKind> = new Set<FactKind>([
  "extra_people",
  "committed",
  "cost",
  "request",
  "venue_option",
  "venue_exclude",
  "food_option",
  "food_fee",
  "food_special",
  "break",
  "block",
]);

export function normLabel(s: string | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function factKey(f: Pick<Fact, "kind" | "label" | "text" | "id">): string {
  if (f.kind === "note") return `note:${f.id}`;
  if (f.kind === "venue_require") return `venue_require:${normLabel(f.text ?? f.label)}`;
  if (LABELED.has(f.kind)) return `${f.kind}:${normLabel(f.label)}`;
  return f.kind;
}

/** Is message a newer than message b? Dates decide when both are dated; otherwise arrival order. */
export function isNewer(a: Message, b: Message): boolean {
  if (a.date && b.date && a.date !== b.date) return a.date > b.date;
  if (a.runId !== b.runId) return a.runId > b.runId;
  return a.seq > b.seq;
}

/**
 * Recompute active/superseded for all non-rejected facts. Rejected facts stay rejected.
 * Returns supersession events (fact superseded by which fact) for the trace.
 */
export function resolveSupersession(facts: Fact[], messages: Message[]): { factId: string; byId: string }[] {
  const msg = new Map(messages.map((m) => [m.id, m]));
  const groups = new Map<string, Fact[]>();
  for (const f of facts) {
    if (f.status === "rejected") continue;
    const g = groups.get(f.key) ?? [];
    g.push(f);
    groups.set(f.key, g);
  }
  const events: { factId: string; byId: string }[] = [];
  for (const g of groups.values()) {
    let newest = g[0];
    for (const f of g.slice(1)) {
      const a = msg.get(f.msgId);
      const b = msg.get(newest.msgId);
      if (a && b && (isNewer(a, b) || (a.id === b.id && Number(f.id.slice(1)) > Number(newest.id.slice(1))))) newest = f;
    }
    for (const f of g) {
      if (f === newest) {
        f.status = "active";
        f.supersededBy = undefined;
        if (f.reason?.startsWith("Superseded")) f.reason = undefined;
      } else {
        const wasActive = f.status === "active";
        const nm = msg.get(newest.msgId);
        f.status = "superseded";
        f.supersededBy = newest.id;
        f.reason = `Superseded by ${newest.id} from ${nm?.from ?? "?"}${nm?.date ? ` (${nm.date})` : ""}: newer information for the same item.`;
        if (wasActive) events.push({ factId: f.id, byId: newest.id });
      }
    }
  }
  return events;
}

export function activeFacts(facts: Fact[]): Fact[] {
  return facts.filter((f) => f.status === "active");
}

/** Message status follows its facts: all rejected -> rejected; all superseded -> superseded; etc. */
export function refreshMessageStatuses(messages: Message[], facts: Fact[]): void {
  for (const m of messages) {
    const fs = facts.filter((f) => f.msgId === m.id && f.kind !== "note");
    const keepReasons = m.reasons.filter((r) => !r.startsWith("Superseded") && !r.startsWith("Rejected") && !r.startsWith("Partly"));
    if (fs.length === 0) {
      m.status = m.relevance === "request" ? "accepted" : "irrelevant";
      m.reasons = keepReasons;
      if (m.relevance !== "request" && !keepReasons.length) m.reasons.push("No planning facts in this message (irrelevant or information only).");
      continue;
    }
    const rej = fs.filter((f) => f.status === "rejected");
    const sup = fs.filter((f) => f.status === "superseded");
    const act = fs.filter((f) => f.status === "active");
    const reasons = [...keepReasons];
    for (const f of rej) reasons.push(`Rejected ${f.id} (${f.kind}${f.label ? ` ${f.label}` : ""}): ${f.reason ?? "invalid"}`);
    for (const f of sup) reasons.push(`Superseded ${f.id} (${f.kind}${f.label ? ` ${f.label}` : ""}): ${f.reason ?? ""}`);
    if (rej.length === fs.length) m.status = "rejected";
    else if (act.length === 0 && sup.length > 0 && rej.length === 0) m.status = "superseded";
    else if (rej.length > 0) m.status = "partial";
    else m.status = "accepted";
    m.reasons = reasons;
  }
}

export function describeFact(f: Fact): string {
  const p: string[] = [f.kind];
  if (f.label) p.push(`"${f.label}"`);
  if (f.num !== undefined) p.push(String(f.num));
  if (f.price !== undefined) p.push(`price ${f.price}`);
  if (f.text) p.push(f.text);
  if (f.features?.length) p.push(`[${f.features.join(", ")}]`);
  return p.join(" ");
}
