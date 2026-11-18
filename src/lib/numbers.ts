// Grounding check: a money figure the model extracts must actually be written in the source message.
// Catches misreads such as "Rs 800" -> 80000. Handles "1,200", "1.2k", "50k", "6.5 lakh", "2 million", "1.5 crore".

const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, hazar: 1e3, hazaar: 1e3, lakh: 1e5, lac: 1e5, lacs: 1e5, lakhs: 1e5, m: 1e6, million: 1e6, mn: 1e6, crore: 1e7, cr: 1e7 };

/** Every number written in the text, including scaled forms (e.g. "6.5 lakh" -> 650000). */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  const re = /(\d+(?:,\d{2,3})*(?:\.\d+)?)\s*(k|thousand|hazaa?r|lakhs?|lacs?|million|mn|m|crore|cr)?\b/gi;
  for (const m of text.matchAll(re)) {
    const base = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    out.add(base);
    const unit = m[2]?.toLowerCase();
    if (unit && MULT[unit]) out.add(Math.round(base * MULT[unit]));
  }
  return out;
}

/** True when value is written in the text (exactly, or as a scaled form). */
export function isGrounded(value: number, text: string): boolean {
  // zero ("delivery free", "muft") can never inflate a cost, so it needs no written figure
  if (value === 0) return true;
  const nums = numbersIn(text);
  return nums.has(value) || [...nums].some((n) => Math.abs(n - value) < 0.5);
}
