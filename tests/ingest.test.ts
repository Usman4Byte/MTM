// Every supported format goes through ingestOne(); type is detected from the bytes, not from a hint.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ingestAll, ingestOne, numberLines } from "../src/lib/ingest";

const load = (p: string, name = p.split("/").pop()!) => ({ name, bytes: new Uint8Array(readFileSync(p)) });
// phrases present in every fixture (they come from the same source pack)
const must = ["Standard lunch box", "Hall B", "honorarium", "prayer break"];

for (const [file, type] of [
  ["samples/sample-pack.txt", "txt"],
  ["samples/formats/pack.md", "md"],
  ["samples/formats/pack.json", "json"],
  ["samples/formats/pack.csv", "csv"],
  ["samples/formats/pack.xlsx", "xlsx"],
  ["samples/formats/pack.docx", "docx"],
  ["samples/formats/pack.pdf", "pdf"],
] as const) {
  test(`${type}: detected and parsed into the shared text form`, async () => {
    const r = await ingestOne(load(file));
    assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
    assert.equal(r.docs.length, 1);
    assert.equal(r.docs[0].detectedType, type);
    for (const m of must) assert.ok(r.docs[0].text.toLowerCase().includes(m.toLowerCase()), `${type} missing "${m}"`);
  });
}

test("detection ignores misleading extensions (PDF renamed to .txt)", async () => {
  const r = await ingestOne(load("samples/formats/pack.pdf", "renamed.txt"));
  assert.equal(r.docs[0]?.detectedType, "pdf");
});

test("scanned PDF is reported as needing OCR, not skipped", async () => {
  const r = await ingestOne(load("samples/formats/scanned.pdf"));
  assert.equal(r.docs.length, 0);
  assert.equal(r.issues[0]?.problem, "needs_ocr");
});

test("image and legacy Office files are reported", async () => {
  assert.equal((await ingestOne(load("samples/formats/photo.png"))).issues[0]?.problem, "needs_ocr");
  assert.equal((await ingestOne(load("samples/formats/legacy.doc"))).issues[0]?.problem, "unsupported");
});

test("pasted text and files share one numbered document", async () => {
  const r = await ingestAll([load("samples/formats/pack.csv")], "Hello, one pasted message");
  const lines = numberLines(r.docs);
  assert.equal(lines[0].header, true);
  assert.ok(lines.some((l) => l.text.includes("one pasted message")));
  assert.ok(lines.filter((l) => l.header).length === 2);
});
