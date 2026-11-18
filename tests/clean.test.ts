// Text cleanup for copied tables. Synthetic messages (not the pack's), in the layouts copies really arrive in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanText } from "../src/lib/ingest/clean";

const pdfCopy = `# From Date Message
1 Registrar’s office, email 2 Nov “Approved: a 5-hour event for 120 students in teams of 4. The
budget is Rs 520,000.”
2 Blue Area Convention
Centre, email
1 Nov “Cedar Hall seats 180 at Rs 95,000.”
3 Caterer, WhatsApp 4 Nov “Biryani box Rs 900 per head, veg bhi Rs 900.”`;

test("PDF table copy: finds the column names, then rebuilds each row (words unchanged)", () => {
  const c = cleanText(pdfCopy);
  assert.deepEqual(c.columns, ["#", "From", "Date", "Message"]);
  assert.equal(c.records, 3);
  assert.deepEqual(
    c.preview.map((p) => [p.from, p.date]),
    [
      ["Registrar’s office, email", "2 Nov"],
      ["Blue Area Convention Centre, email", "1 Nov"],
      ["Caterer, WhatsApp", "4 Nov"],
    ],
  );
  assert.equal(c.preview[0].text, "Approved: a 5-hour event for 120 students in teams of 4. The budget is Rs 520,000.");
  assert.ok(c.text.includes("From: Caterer, WhatsApp\nDate: 4 Nov\nMessage: Biryani box Rs 900 per head, veg bhi Rs 900."));
  assert.ok(!c.text.includes(" "));
});

test("PDF table copy without quotes (numbered rows, broken cells)", () => {
  const c = cleanText(`No. Sender Date Text
1 Registrar, email 2 Nov Approved: 120 students,
budget Rs 520,000.
2 Caterer,
WhatsApp 4 Nov Biryani Rs 900 per head.`);
  assert.equal(c.records, 2);
  assert.deepEqual(c.preview[1], { from: "Caterer, WhatsApp", date: "4 Nov", text: "Biryani Rs 900 per head." });
  assert.ok(c.text.includes("Sender: Registrar, email\nDate: 2 Nov\nText: Approved: 120 students, budget Rs 520,000."));
});

test("tab-separated paste (Word/Excel/web) uses its own column names", () => {
  const c = cleanText("Sender\tDate\tMessage\nFinance\t3 Nov\tPaid Rs 45,000 for trophies\nSecurity\t6 Nov\tFee Rs 15,000");
  assert.equal(c.records, 2);
  assert.ok(c.text.includes("Sender: Finance\nDate: 3 Nov\nMessage: Paid Rs 45,000 for trophies"));
});

test("markdown / pipe table", () => {
  const c = cleanText("| From | Channel | Date | Message |\n|---|---|---|---|\n| Finance | email | 3 Nov | Paid Rs 45,000 |\n| Dean | email | 2 Nov | Budget Rs 520,000 |");
  assert.equal(c.records, 2);
  assert.deepEqual(c.preview[0], { from: "Finance, email", date: "3 Nov", text: "Paid Rs 45,000" });
});

test("wide-space aligned columns", () => {
  const c = cleanText("From        Date      Message\nFinance     3 Nov     Paid Rs 45,000\nSecurity    6 Nov     Fee Rs 15,000");
  assert.equal(c.records, 2);
  assert.equal(c.preview[1].text, "Fee Rs 15,000");
});

test("plain prose is left alone apart from spacing", () => {
  const msg = "Finance here. The printing bill came in at Rs 15,000, not Rs 10,000.";
  const c = cleanText(msg);
  assert.equal(c.records, 0);
  assert.equal(c.text, msg);
});

test("text outside any row is kept, never dropped", () => {
  const c = cleanText(`1 Dean, email 9 Nov “Budget Rs 600,000.”\nSome stray note here.\n2 Finance, email 10 Nov “Prizes Rs 90,000.”`);
  assert.equal(c.records, 2);
  assert.ok(c.text.includes("Some stray note here"));
});
