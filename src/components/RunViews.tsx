"use client";

// Readable run views: each run tells its story first (plan kept or changed, and why),
// then shows every model call with its input/output one click away.

import { formatRun, formatTrace } from "@/lib/report";
import type { ModelCall, ProjectState, Run } from "@/lib/types";
import { runVerdict } from "@/lib/verdict";

function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

const TONE: Record<string, string> = {
  accepted: "bg-ok-soft text-ok",
  rejected: "bg-bad-soft text-bad",
  partial: "bg-bad-soft text-bad",
  superseded: "bg-warn-soft text-warn",
  irrelevant: "bg-soft text-muted",
  pending: "bg-soft text-muted",
};

function Pill({ children, tone }: { children: React.ReactNode; tone: string }) {
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", TONE[tone] ?? tone)}>{children}</span>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</div>;
}

export function download(name: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The readable story of one run: result, why (per message), what changed, calls made, prediction check, problems. */
export function RunCard({ run, project, title, children }: { run: Run; project: ProjectState; title?: string; children?: React.ReactNode }) {
  const v = runVerdict(run, project);
  const tone = run.aborted ? "border-bad bg-bad-soft" : run.mode === "update" && v.kept ? "border-warn bg-warn-soft" : "border-ok bg-ok-soft";
  const retries = run.calls.filter((c) => c.attempt > 1).length;
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-4 py-2 text-xs text-muted">
        <b className="text-sm text-ink">
          {title ? `${title} · ` : ""}Run {run.id}
        </b>
        <Pill tone={run.mode === "full" ? "bg-soft text-accent" : "bg-warn-soft text-warn"}>{run.mode === "full" ? "full run" : "update"}</Pill>
        <span>{new Date(run.startedAt).toLocaleTimeString()}</span>
        <span>· {(run.ms / 1000).toFixed(1)} s (limit {run.limits.maxMs / 1000} s)</span>
        <span>
          · {run.calls.length} model call{run.calls.length === 1 ? "" : "s"} (limit {run.limits.maxCalls})
        </span>
        <span>· {run.totals.totalTokens.toLocaleString()} tokens</span>
        {run.inputs?.length ? <span className="truncate">· input: {run.inputs.join(", ")}</span> : null}
      </div>
      <div className="space-y-3 p-4">
        <div className={cx("rounded-lg border p-3", tone)}>
          <Label>Result</Label>
          <div className="text-sm font-semibold text-ink">{v.headline}</div>
        </div>

        {v.outcomes.length > 0 && (
          <div>
            <Label>Why: what happened to each message</Label>
            <ul className="space-y-1.5">
              {v.outcomes.map((o) => (
                <li key={o.id} className="rounded-lg border border-line p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={o.status}>{o.status}</Pill>
                    <span className="font-mono text-xs text-muted">{o.id}</span>
                    <span className="font-medium">{o.from}</span>
                  </div>
                  <div className="mt-1 text-xs italic text-muted">
                    &ldquo;{o.text.replace(/\s+/g, " ").slice(0, 220)}
                    {o.text.length > 220 ? "…" : ""}&rdquo;
                  </div>
                  <div className={cx("mt-1 text-xs", o.status === "rejected" || o.status === "partial" ? "font-medium text-bad" : "text-ink")}>{o.why}</div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <Label>What changed in the plan</Label>
          {v.changes.length ? (
            <ul className="space-y-0.5 text-xs">
              {v.changes.map((c, i) => (
                <li key={i}>• {c}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">{run.mode === "full" ? "First plan created (see the Plan tab)." : "Nothing. The plan is exactly as it was before this run."}</p>
          )}
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-line p-2 text-xs">
            <Label>Model calls made</Label>
            <b>{v.readingCalls} reading</b> (always){" "}
            {v.modelAreas.length ? (
              <>
                + <b>{v.modelAreas.join(", ")}</b>
              </>
            ) : (
              "· no planning-area calls"
            )}
            {retries > 0 && <span className="text-warn"> · {retries} retr{retries === 1 ? "y" : "ies"} counted</span>}
          </div>
          <div className={cx("rounded-lg border p-2 text-xs", v.prediction ? (v.prediction.match ? "border-ok bg-ok-soft" : "border-bad bg-bad-soft") : "border-line")}>
            <Label>Prediction check</Label>
            {v.prediction ? (
              <>
                Predicted: <b>{v.prediction.predicted.length ? `reading + ${v.prediction.predicted.join(", ")}` : "reading only"}</b> · Actual:{" "}
                <b>{v.prediction.actual.length ? `reading + ${v.prediction.actual.join(", ")}` : "reading only"}</b> →{" "}
                <b className={v.prediction.match ? "text-ok" : "text-bad"}>{v.prediction.match ? "✓ MATCH" : "✗ MISMATCH"}</b>
              </>
            ) : (
              <span className="text-muted">{run.mode === "full" ? "Not used for full runs." : "No prediction was recorded for this run."}</span>
            )}
          </div>
        </div>

        {v.problems.length > 0 && (
          <div className="rounded-lg border border-warn bg-warn-soft p-2 text-xs text-warn">
            <b>Problems reported:</b>
            <ul className="mt-0.5 list-disc pl-4">
              {v.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

export function HistoryView({ project }: { project: ProjectState }) {
  const runs = [...project.runs].reverse();
  if (!runs.length) return <div className="card p-10 text-center text-sm text-muted">No runs yet.</div>;
  return (
    <div className="space-y-3">
      {runs.map((r) => (
        <RunCard key={r.id} run={r} project={project} />
      ))}
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  file: "File read",
  route: "Routing",
  info: "Note",
  accept: "Plan check",
  supersede: "Replaced by newer",
  reject: "Rejected",
  conflict: "Conflict",
  error: "Problem",
};
const EVENT_STYLE: Record<string, string> = { reject: "text-bad", conflict: "text-bad", error: "text-warn", supersede: "text-warn", accept: "text-ok", route: "text-accent" };

export function TraceView({ project }: { project: ProjectState }) {
  const runs = [...project.runs].reverse();
  const g = project.runs.reduce(
    (s, r) => ({ c: s.c + r.calls.length, p: s.p + r.totals.promptTokens, o: s.o + r.totals.outputTokens, th: s.th + r.totals.thoughtsTokens, t: s.t + r.totals.totalTokens }),
    { c: 0, p: 0, o: 0, th: 0, t: 0 },
  );
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
        <span className="num">
          <b>All runs:</b> {g.c} model calls · input {g.p.toLocaleString()} · output {g.o.toLocaleString()} · thinking {g.th.toLocaleString()} · <b>total {g.t.toLocaleString()} tokens</b> (as reported by the API)
        </span>
        <div className="flex gap-2 text-xs">
          <button className="rounded-lg border border-line px-2 py-1 hover:border-accent" onClick={() => download("trace.txt", formatTrace(project))}>
            Download trace .txt
          </button>
          <button className="rounded-lg border border-line px-2 py-1 hover:border-accent" onClick={() => download("trace.json", JSON.stringify(project.runs, null, 2), "application/json")}>
            Trace .json
          </button>
        </div>
      </div>
      {!runs.length && <div className="card p-10 text-center text-sm text-muted">No model calls yet.</div>}
      {runs.map((r) => (
        <RunCard key={r.id} run={r} project={project}>
          <div>
            <Label>Every model call in this run (click a call to see its full input and output)</Label>
            <div className="space-y-2">
              {r.calls.map((c) => (
                <CallRow key={c.n} c={c} />
              ))}
              {!r.calls.length && <p className="text-xs text-muted">No model calls (nothing readable was submitted).</p>}
            </div>
          </div>
          <details>
            <summary className="text-xs font-medium text-accent">▸ All system decisions in order ({r.events.length})</summary>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs">
              {r.events.map((e, i) => (
                <li key={i} className={EVENT_STYLE[e.kind] ?? "text-muted"}>
                  <b>{EVENT_LABEL[e.kind] ?? e.kind}:</b> {e.text}
                </li>
              ))}
            </ol>
          </details>
          <div className="num rounded-lg bg-soft p-2 text-right text-xs">
            Run total: input {r.totals.promptTokens.toLocaleString()} · output {r.totals.outputTokens.toLocaleString()} · thinking {r.totals.thoughtsTokens.toLocaleString()} · <b>total {r.totals.totalTokens.toLocaleString()} tokens</b>
          </div>
          <details>
            <summary className="text-xs font-medium text-accent">▸ This run as plain text (same as the downloaded trace)</summary>
            <pre className="mt-1 max-h-96 overflow-auto rounded bg-code p-2 font-mono text-[11px]">{formatRun(r, { full: false, state: project })}</pre>
          </details>
        </RunCard>
      ))}
    </div>
  );
}

function summarizeOutput(c: ModelCall): string[] {
  try {
    const j = JSON.parse(c.output) as {
      messages?: { ref: string; from: string; relevance: string; first: number; last: number }[];
      facts?: { kind: string; label?: string; num?: number; price?: number; text?: string; reject?: string }[];
      custom?: { area: string; text: string }[];
      unsupported?: string;
    };
    const out: string[] = [];
    if (j.messages) out.push(`Found ${j.messages.length} message(s): ${j.messages.map((m) => `${m.from} (${m.relevance})`).join("; ")}`);
    if (j.facts) {
      const ok = j.facts.filter((f) => !f.reject);
      const bad = j.facts.filter((f) => f.reject);
      const show = (f: (typeof ok)[number]) => [f.kind, f.label && `"${f.label}"`, f.num, f.price !== undefined ? `@${f.price}` : "", f.text].filter((x) => x !== undefined && x !== "").join(" ");
      out.push(`Extracted ${ok.length} fact(s): ${ok.map(show).join("; ") || "none"}`);
      if (bad.length) out.push(`Flagged as wrong: ${bad.map((f) => `${show(f)} (${f.reject})`).join("; ")}`);
    }
    if (j.custom?.length) out.push(`Needs an area call: ${j.custom.map((x) => `${x.area}: ${x.text}`).join("; ")}`);
    if (j.unsupported) out.push(`Could not express: ${j.unsupported}`);
    return out;
  } catch {
    return [];
  }
}

function prettyJson(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 1);
  } catch {
    return s;
  }
}

function CallRow({ c }: { c: ModelCall }) {
  const summary = c.ok ? summarizeOutput(c) : [];
  return (
    <details className="rounded-lg border border-line">
      <summary className="p-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <b className="font-mono">▸ Call #{c.n}</b>
          <span className="rounded bg-soft px-1.5 py-0.5 font-semibold text-accent">area: {c.area}</span>
          <span>
            model: <b className="font-mono">{c.model}</b>
          </span>
          {c.attempt > 1 && <span className="text-warn">retry (attempt {c.attempt})</span>}
          <span className="text-muted">{(c.ms / 1000).toFixed(1)} s</span>
          <Pill tone={c.ok ? "accepted" : "rejected"}>{c.ok ? "ok" : "failed"}</Pill>
          <span className="num ml-auto font-mono">
            tokens in {c.usage.promptTokens ?? "n/a"} · out {c.usage.outputTokens ?? "n/a"} · thinking {c.usage.thoughtsTokens ?? "n/a"} · total <b>{c.usage.totalTokens ?? "n/a"}</b>
          </span>
        </div>
        {c.error && <div className="mt-1 text-bad">Error: {c.error}</div>}
        {summary.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-muted">
            {summary.map((x, i) => (
              <li key={i}>→ {x}</li>
            ))}
          </ul>
        )}
      </summary>
      <div className="grid gap-2 border-t border-line p-2 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-semibold text-muted">INPUT sent to the model</div>
          <pre className="max-h-96 overflow-auto rounded bg-code p-2 font-mono text-[11px]">{c.input}</pre>
        </div>
        <div>
          <div className="mb-1 text-[11px] font-semibold text-muted">OUTPUT returned by the model</div>
          <pre className="max-h-96 overflow-auto rounded bg-code p-2 font-mono text-[11px]">{prettyJson(c.output)}</pre>
        </div>
      </div>
    </details>
  );
}
