// Generates samples/formats/* from a source text pack, so every supported format can be tested
// through the same ingestion pipeline. Also writes negative cases (scanned PDF, image, legacy .doc).
//   npx tsx scripts/make-format-fixtures.ts [source.txt]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const src = process.argv[2] ?? "samples/sample-pack.txt";
const OUT = "samples/formats";
mkdirSync(OUT, { recursive: true });

// Parse "Message N / From: / Date: / text" blocks into records (only for building fixtures).
const blocks = readFileSync(src, "utf8").replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/);
const recs = blocks.map((b) => {
  const lines = b.split("\n");
  const from = lines.find((l) => l.startsWith("From:"))?.slice(5).trim() ?? "";
  const date = lines.find((l) => l.startsWith("Date:"))?.slice(5).trim() ?? "";
  const text = lines.filter((l) => !/^(Message \d+|From:|Date:)/.test(l)).join(" ").trim();
  return { from, date, text };
});

// TXT is the source itself; MD
writeFileSync(join(OUT, "pack.md"), `# Message pack\n\n${recs.map((r, i) => `## ${i + 1}. ${r.from} — ${r.date}\n\n> ${r.text}\n`).join("\n")}`);
// JSON
writeFileSync(join(OUT, "pack.json"), JSON.stringify({ messages: recs }, null, 2));
// CSV
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
writeFileSync(join(OUT, "pack.csv"), `from,date,message\n${recs.map((r) => [r.from, r.date, r.text].map(q).join(",")).join("\n")}\n`);

async function xlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Messages");
  ws.addRow(["From", "Date", "Message"]);
  for (const r of recs) ws.addRow([r.from, r.date, r.text]);
  writeFileSync(join(OUT, "pack.xlsx"), Buffer.from(await wb.xlsx.writeBuffer()));
}

async function docx() {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paras = recs.flatMap((r) => [`${r.from} (${r.date})`, r.text, ""]);
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras
      .map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`)
      .join("")}</w:body></w:document>`,
  );
  writeFileSync(join(OUT, "pack.docx"), await zip.generateAsync({ type: "nodebuffer" }));
}

function pdf(lines: string[], file: string, withText = true) {
  const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, "'").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const wrap = (s: string) => {
    const out: string[] = [];
    let cur = "";
    for (const w of s.split(" ")) {
      if ((cur + " " + w).length > 95) {
        out.push(cur);
        cur = w;
      } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) out.push(cur);
    return out;
  };
  const content = withText
    ? `BT /F1 9 Tf 36 770 Td 12 TL ${lines.flatMap((l) => (l ? wrap(l) : [" "])).map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`
    : "0.5 g 36 400 540 360 re f"; // just a grey box: an image-like page with no text layer
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(join(OUT, file), out, "latin1");
}

async function main() {
await xlsx();
await docx();
pdf(recs.flatMap((r) => [`${r.from} (${r.date})`, r.text, ""]), "pack.pdf");
pdf([], "scanned.pdf", false);
// negative cases
writeFileSync(join(OUT, "photo.png"), Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360000002000154a24f5d0000000049454e44ae426082", "hex"));
writeFileSync(join(OUT, "legacy.doc"), Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(504)]));
console.log(`Wrote ${OUT}: pack.md pack.json pack.csv pack.xlsx pack.docx pack.pdf scanned.pdf photo.png legacy.doc (${recs.length} messages)`);
}
main();
