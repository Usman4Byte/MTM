// Shared ingestion pipeline: every input (file or pasted text) becomes a NormalizedDoc.
// File type is detected from the bytes first (magic numbers), then the extension.
// Nothing is skipped silently: every problem becomes an IngestIssue the UI/CLI shows.

import type { IngestIssue, NormalizedDoc } from "../types";

export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface RawInput {
  name: string;
  bytes: Uint8Array;
  mime?: string;
}

export interface IngestResult {
  docs: NormalizedDoc[];
  issues: IngestIssue[];
  warnings: string[];
}

function ext(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return sig.every((b, i) => bytes[i] === b);
}

export type Detected =
  | "pdf"
  | "docx"
  | "xlsx"
  | "zip-other"
  | "ole-legacy"
  | "image"
  | "json"
  | "csv"
  | "tsv"
  | "md"
  | "txt"
  | "binary";

/** Decide the file type from content (and extension only to split text flavours). */
export async function detectType(input: RawInput): Promise<Detected> {
  const b = input.bytes;
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) {
    const JSZip = (await import("jszip")).default;
    try {
      const zip = await JSZip.loadAsync(b);
      if (zip.file("word/document.xml")) return "docx";
      if (zip.file("xl/workbook.xml")) return "xlsx";
    } catch {
      return "binary";
    }
    return "zip-other";
  }
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0])) return "ole-legacy"; // .doc / .xls (old Office)
  if (
    startsWith(b, [0x89, 0x50, 0x4e, 0x47]) ||
    startsWith(b, [0xff, 0xd8, 0xff]) ||
    startsWith(b, [0x47, 0x49, 0x46, 0x38]) ||
    (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && b[8] === 0x57) // RIFF....WEBP
  )
    return "image";
  // Text-like: reject if it does not look like text.
  const sample = b.subarray(0, Math.min(b.length, 8192));
  let nul = 0;
  for (const x of sample) if (x === 0) nul++;
  if (nul > 0) return "binary";
  const text = decodeText(b).trim();
  const e = ext(input.name);
  if (e === "csv" || input.mime === "text/csv") return "csv";
  if (e === "tsv" || input.mime === "text/tab-separated-values") return "tsv";
  if ((text.startsWith("{") || text.startsWith("[")) && isJson(text)) return "json";
  if (e === "md" || e === "markdown" || input.mime === "text/markdown") return "md";
  return "txt";
}

function isJson(t: string): boolean {
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

export function decodeText(bytes: Uint8Array): string {
  let t = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n?/g, "\n");
}

/** Minimal RFC 4180 parser (quoted fields, escaped quotes, newlines in quotes). */
export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Tables become one line per row, "Header: value | Header: value", so each row reads as one record. */
export function tableToLines(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const looksLikeHeader = rows.length > 1 && header.every((h) => h !== "" && h.length < 40 && !/^[\d.,\s]+$/.test(h));
  const body = looksLikeHeader ? rows.slice(1) : rows;
  return body.map((r) =>
    r
      .map((v, i) => {
        const val = v.replace(/\s*\n\s*/g, " / ").trim();
        return looksLikeHeader && header[i] ? `${header[i]}: ${val}` : val;
      })
      .filter((s) => s !== "" && !/:\s*$/.test(s))
      .join(" | "),
  );
}

function jsonToLines(value: unknown): string[] {
  const flat = (v: unknown): string =>
    typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "");
  const recordLine = (o: unknown): string =>
    typeof o === "object" && o !== null && !Array.isArray(o)
      ? Object.entries(o as Record<string, unknown>)
          .map(([k, v]) => `${k}: ${flat(v)}`)
          .join(" | ")
      : flat(o);
  const findArray = (v: unknown): unknown[] | null => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) {
        if (Array.isArray(val) && val.length) return val;
      }
    }
    return null;
  };
  const arr = findArray(value);
  if (arr) return arr.map(recordLine);
  return JSON.stringify(value, null, 2).split("\n");
}

async function parsePdf(bytes: Uint8Array, name: string, issues: IngestIssue[], warnings: string[]): Promise<string | null> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((p) => p.replace(/\r\n?/g, "\n"));
  const chars = pages.reduce((s, p) => s + p.trim().length, 0);
  if (chars < 20 * Math.max(1, totalPages)) {
    issues.push({
      name,
      detectedType: "pdf",
      problem: "needs_ocr",
      detail: `PDF has ${totalPages} page(s) but almost no text layer (${chars} characters). It looks scanned; run OCR and upload the text.`,
    });
    return null;
  }
  pages.forEach((p, i) => {
    if (p.trim().length < 5) warnings.push(`${name}: page ${i + 1} has no text layer (may be a scanned image) and was not read.`);
  });
  return pages.join("\n");
}

async function parseDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  const res = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return res.value.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n");
}

async function parseXlsx(bytes: Uint8Array): Promise<string> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const out: string[] = [];
  wb.eachSheet((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(row.getCell(c).text ?? "");
      rows.push(cells);
    });
    if (rows.length) {
      if (wb.worksheets.length > 1) out.push(`[sheet: ${ws.name}]`);
      out.push(...tableToLines(rows));
    }
  });
  return out.join("\n");
}

export async function ingestOne(input: RawInput): Promise<IngestResult> {
  const issues: IngestIssue[] = [];
  const warnings: string[] = [];
  const size = input.bytes.length;
  if (size > MAX_FILE_BYTES) {
    issues.push({ name: input.name, detectedType: ext(input.name) || "unknown", problem: "too_large", detail: `File is ${size} bytes; the limit is ${MAX_FILE_BYTES}.` });
    return { docs: [], issues, warnings };
  }
  const type = await detectType(input);
  let text: string | null = null;
  try {
    switch (type) {
      case "pdf":
        text = await parsePdf(input.bytes, input.name, issues, warnings);
        break;
      case "docx":
        text = await parseDocx(input.bytes);
        break;
      case "xlsx":
        text = await parseXlsx(input.bytes);
        break;
      case "csv":
        text = tableToLines(parseDelimited(decodeText(input.bytes), ",")).join("\n");
        break;
      case "tsv":
        text = tableToLines(parseDelimited(decodeText(input.bytes), "\t")).join("\n");
        break;
      case "json":
        text = jsonToLines(JSON.parse(decodeText(input.bytes))).join("\n");
        break;
      case "md":
      case "txt":
        text = decodeText(input.bytes);
        break;
      case "image":
        issues.push({ name: input.name, detectedType: "image", problem: "needs_ocr", detail: "This is an image. Text in images needs OCR, which this system does not run. Upload the text instead." });
        break;
      case "ole-legacy":
        issues.push({ name: input.name, detectedType: "doc/xls (legacy)", problem: "unsupported", detail: "Old binary Office format (.doc/.xls). Save it as .docx or .xlsx and upload again." });
        break;
      case "zip-other":
        issues.push({ name: input.name, detectedType: "zip", problem: "unsupported", detail: "ZIP-based file that is neither DOCX nor XLSX (e.g. PPTX, ODT or a zip archive)." });
        break;
      default:
        issues.push({ name: input.name, detectedType: "binary", problem: "unreadable", detail: "File is binary and not a supported format (TXT, CSV, MD, JSON, PDF, DOCX, XLSX)." });
    }
  } catch (err) {
    issues.push({ name: input.name, detectedType: type, problem: "unreadable", detail: `Could not parse: ${(err as Error).message}` });
    text = null;
  }
  if (text !== null) {
    if (text.trim() === "") {
      issues.push({ name: input.name, detectedType: type, problem: "empty", detail: "File contains no readable text." });
    } else {
      return { docs: [{ name: input.name, detectedType: type, sizeBytes: size, text: text.trim() }], issues, warnings };
    }
  }
  return { docs: [], issues, warnings };
}

export async function ingestAll(inputs: RawInput[], pasted?: string): Promise<IngestResult> {
  const all: IngestResult = { docs: [], issues: [], warnings: [] };
  if (pasted && pasted.trim()) {
    const t = pasted.replace(/\r\n?/g, "\n").trim();
    all.docs.push({ name: "pasted text", detectedType: "text", sizeBytes: new TextEncoder().encode(t).length, text: t });
  }
  for (const input of inputs) {
    const r = await ingestOne(input);
    all.docs.push(...r.docs);
    all.issues.push(...r.issues);
    all.warnings.push(...r.warnings);
  }
  return all;
}

/** Number every line across all docs. The reading model points at line ranges; code slices the originals. */
export interface NumberedLine {
  n: number;
  doc: number;
  text: string;
  header: boolean;
}

export function numberLines(docs: NormalizedDoc[]): NumberedLine[] {
  const lines: NumberedLine[] = [];
  let n = 0;
  docs.forEach((d, di) => {
    lines.push({ n: ++n, doc: di, text: `=== ${d.name} (${d.detectedType}) ===`, header: true });
    for (const t of d.text.split("\n")) lines.push({ n: ++n, doc: di, text: t, header: false });
  });
  return lines;
}
