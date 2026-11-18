// Text cleanup shared by the server pipeline and the browser preview (pure code, no Node imports).
//
// It works the way a person reads a copied table: first find the column names (e.g. "# From Date Message"),
// then rebuild each row into those named fields. It handles pipe tables, tab-separated copies,
// wide-space columns, PDF copies whose cells break across lines (quoted or numbered rows), and plain prose.
// It fixes LAYOUT only and never changes the words. Text that fits no row is kept as its own block.

export interface CleanResult {
  text: string;
  changed: boolean;
  /** messages rebuilt from a table layout (0 = plain cleanup only) */
  records: number;
  note: string;
  /** detected column names, if any */
  columns: string[];
  preview: { from: string; date: string; text: string }[];
}

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
const DATE_RE = `\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})[a-z]*\\.?(?:,?\\s+\\d{4})?|(?:${MONTHS})[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.-]\\d{1,2}(?:[/.-]\\d{2,4})?`;
const DATE_AT_END = new RegExp(`(${DATE_RE})\\s*$`, "i");
const DATE_ANY = new RegExp(`(?:^|\\s)(${DATE_RE})(?=\\s|$)`, "i");

const ROLE = {
  num: /^(#|no\.?|sr\.?|s\.?\s?no\.?|id|serial|number)$/i,
  from: /^(from|sender|sent by|name|who|source|by|author|contact)$/i,
  date: /^(date|when|day|time|sent|received|on)$/i,
  text: /^(message|messages|text|content|body|details|note|notes|msg|description|update)$/i,
  channel: /^(channel|via|medium|type|platform)$/i,
};

/** Normalize invisible and odd whitespace characters (no visible character is changed). */
export function normalizeChars(t: string): string {
  return t
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[   ]/g, " ")
    .replace(/[​-‍⁠]/g, "")
    .replace(/[ \t]+$/gm, "");
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

/** A header row: 2–8 short label words, no figures, no sentence punctuation. */
function headerColumns(line: string): string[] | null {
  const t = line.trim();
  if (!t || t.length > 90 || /[.?!"“”]$/.test(t)) return null;
  let cells: string[];
  let loose = false;
  if (t.includes("|")) cells = t.split("|");
  else if (t.includes("\t")) cells = t.split("\t");
  else if (/\S\s{2,}\S/.test(t)) cells = t.split(/\s{2,}/);
  else {
    cells = t.split(/\s+/);
    loose = true;
  }
  cells = cells.map((c) => c.trim()).filter(Boolean);
  if (cells.length < 2 || cells.length > 8) return null;
  if (cells.some((c) => c.length > 22 || /\d/.test(c.replace(/^#$/, "")))) return null;
  const known = cells.filter((c) => Object.values(ROLE).some((r) => r.test(c))).length;
  // space-separated words could be a title ("# Message pack"): then every word must be a column name
  if (loose) return known === cells.length ? cells : null;
  return known >= Math.min(2, cells.length) ? cells : null;
}

function roleOf(name: string): keyof typeof ROLE | null {
  for (const [k, r] of Object.entries(ROLE)) if (r.test(name.trim())) return k as keyof typeof ROLE;
  return null;
}

/** Labels to use when writing a rebuilt row, taken from the detected header when there is one. */
function labelsFrom(columns: string[]): { from: string; date: string; text: string } {
  const pick = (role: keyof typeof ROLE, fallback: string) => columns.find((c) => roleOf(c) === role) ?? fallback;
  return { from: pick("from", "From"), date: pick("date", "Date"), text: pick("text", "Message") };
}

function splitPrefix(prefix: string): { from: string; date: string } {
  let p = prefix
    .replace(/\bmessage\s*#?\s*\d+\b/gi, " ")
    .replace(/^\s*#?\s*\d{1,3}[.)]?\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  let date = "";
  const labelled = /date\s*:\s*(.+)$/i.exec(p);
  if (labelled) {
    date = labelled[1].trim();
    p = p.slice(0, labelled.index).trim();
  } else {
    const m = DATE_AT_END.exec(p);
    if (m) {
      date = m[1].trim();
      p = p.slice(0, m.index).trim();
    }
  }
  const from = p.replace(/^from\s*:\s*/i, "").replace(/[,;:|-]\s*$/, "").trim();
  return { from, date };
}

type Rec = { from: string; date: string; text: string };

function writeRecords(recs: Rec[], columns: string[], leftovers: { at: number; text: string }[] = []): string {
  const L = labelsFrom(columns);
  const blocks: string[] = recs.map(
    (r, i) => `Message ${i + 1}\n${r.from ? `${L.from}: ${r.from}\n` : ""}${r.date ? `${L.date}: ${r.date}\n` : ""}${L.text}: ${r.text}`,
  );
  for (const l of leftovers.sort((a, b) => b.at - a.at)) blocks.splice(l.at, 0, `Other text: ${l.text}`);
  return blocks.join("\n\n");
}

/** Rows split into cells (pipe, tab or wide-space tables). */
function cellTable(lines: string[]): { rows: string[][]; kind: string } | null {
  const share = (f: (l: string) => boolean) => lines.filter(f).length / lines.length;
  if (lines.length >= 2 && share((l) => (l.match(/\|/g) ?? []).length >= 2) >= 0.6) {
    const rows = lines
      .filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l))
      .map((l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()));
    return { rows, kind: "pipe table" };
  }
  if (lines.length >= 2 && share((l) => l.includes("\t")) >= 0.6) return { rows: parseDelimited(lines.join("\n"), "\t"), kind: "tab-separated table" };
  const wide = lines.map((l) => l.trim().split(/\s{2,}/));
  if (lines.length >= 2 && share((l) => /\S\s{2,}\S/.test(l.trim())) >= 0.8) {
    const n = wide[0].length;
    if (n >= 2 && wide.filter((c) => c.length === n).length / wide.length >= 0.8) return { rows: wide, kind: "column-aligned table" };
  }
  return null;
}

function rowsToRecords(rows: string[][], columns: string[]): Rec[] {
  const roles = columns.map(roleOf);
  return rows.map((r) => {
    const get = (role: keyof typeof ROLE) => {
      const i = roles.indexOf(role);
      return i >= 0 ? (r[i] ?? "").trim() : "";
    };
    let text = get("text");
    if (!text) text = r.filter((_, i) => roles[i] === null).join(" | ").trim() || r.join(" | ");
    const channel = get("channel");
    const from = [get("from"), channel].filter(Boolean).join(", ");
    return { from, date: get("date"), text: text.replace(/^[“"]|[”"]$/g, "").trim() };
  });
}

/** Clean pasted or extracted text, rebuilding table rows into named fields when the text is a copied table. */
export function cleanText(raw: string): CleanResult {
  const base = normalizeChars(raw);
  let lines = base.split("\n").filter((l) => l.trim());
  const plain = (): CleanResult => {
    const text = base.replace(/\n{3,}/g, "\n\n").trim();
    const changed = text !== raw.trim();
    return { text, changed, records: 0, note: changed ? "Cleaned spacing and invisible characters." : "", columns: [], preview: [] };
  };
  if (!lines.length) return plain();

  // 1) Column names: the first line that reads like a header ("# From Date Message", "Sender | Date | Text")
  let columns: string[] = [];
  const hi = lines.slice(0, 3).findIndex((l) => headerColumns(l));
  if (hi >= 0) {
    columns = headerColumns(lines[hi])!;
    lines = lines.slice(hi + 1);
  }
  const named = (n: number, kind: string) =>
    `Found ${columns.length ? `columns ${columns.join(" · ")} and ` : ""}${n} row(s) in a ${kind}; rebuilt each row as one message (layout only, words unchanged).`;

  // 2) Cell tables: pipe, tab, wide-space
  const table = cellTable(columns.length ? lines : lines);
  if (table && table.rows.length) {
    let rows = table.rows;
    if (!columns.length && headerColumns(rows[0].join("  "))) {
      columns = rows[0];
      rows = rows.slice(1);
    }
    if (!columns.length) columns = rows[0].map((_, i) => (i === rows[0].length - 1 ? "Message" : `Column ${i + 1}`));
    const recs = rowsToRecords(rows, columns);
    return { text: writeRecords(recs, columns), changed: true, records: recs.length, note: named(recs.length, table.kind), columns, preview: recs };
  }

  // 3) Copied rows with quoted messages: "<#> <sender> <date> “message”", cells broken across lines
  const flat = lines.join("\n").replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  const quoted: (Rec & { start: number; end: number })[] = [];
  for (const m of flat.matchAll(/(?:^|\s)([^“”"]{0,160}?)\s*[“"]([^“”"]{3,}?)[”"]/g)) {
    const { from, date } = splitPrefix(m[1]);
    quoted.push({ from, date, text: m[2].trim(), start: m.index!, end: m.index! + m[0].length });
  }
  const coverage = quoted.reduce((s, r) => s + r.text.length + r.from.length + r.date.length, 0) / Math.max(1, flat.length);
  if (quoted.length >= 2 && quoted.every((r) => r.from) && coverage >= 0.7) {
    const leftovers: { at: number; text: string }[] = [];
    let cursor = 0;
    quoted.forEach((r, i) => {
      const gap = flat.slice(cursor, r.start).trim();
      if (gap.length > 3) leftovers.push({ at: i, text: gap });
      cursor = r.end;
    });
    const tail = flat.slice(cursor).trim();
    if (tail.length > 3) leftovers.push({ at: quoted.length, text: tail });
    return {
      text: writeRecords(quoted, columns, leftovers),
      changed: true,
      records: quoted.length,
      note: named(quoted.length, "copied table (quoted messages)"),
      columns,
      preview: quoted.map(({ from, date, text }) => ({ from, date, text })),
    };
  }

  // 4) Numbered rows without quotes: "1 Sender, email 9 Nov message text…" with continuation lines
  const starts = lines.map((l, i) => (/^\s*\d{1,3}[.)]?\s+\S/.test(l) ? i : -1)).filter((i) => i >= 0);
  const sequential = starts.length >= 2 && starts.every((s, k) => Number(/\d+/.exec(lines[s])![0]) === Number(/\d+/.exec(lines[starts[0]])![0]) + k);
  if (sequential && (columns.length || starts[0] === 0)) {
    const recs: Rec[] = [];
    const leftovers: { at: number; text: string }[] = [];
    if (starts[0] > 0) leftovers.push({ at: 0, text: lines.slice(0, starts[0]).join(" ") });
    starts.forEach((s, k) => {
      const chunk = lines
        .slice(s, starts[k + 1] ?? lines.length)
        .join(" ")
        .replace(/^\s*\d{1,3}[.)]?\s+/, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      const d = DATE_ANY.exec(chunk);
      if (d && d.index < 120) {
        const before = chunk.slice(0, d.index).trim().replace(/[,;:|-]\s*$/, "");
        const after = chunk.slice(d.index + d[0].length).trim();
        recs.push({ from: before, date: d[1].trim(), text: after.replace(/^[“"]|[”"]$/g, "") });
      } else recs.push({ from: "", date: "", text: chunk });
    });
    if (recs.length >= 2) {
      return { text: writeRecords(recs, columns, leftovers), changed: true, records: recs.length, note: named(recs.length, "copied table (numbered rows)"), columns, preview: recs };
    }
  }

  // 5) Plain prose: whitespace only (a header-like first line, if any, is kept as written)
  return plain();
}
