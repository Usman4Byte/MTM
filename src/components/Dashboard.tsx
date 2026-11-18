"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { newProject } from "@/lib/project";
import { rs } from "@/lib/planner/time";
import { formatPlan, formatRun, formatTrace } from "@/lib/report";
import { AREAS, CALL_TAGS, type CallTag, type Fact, type Message, type Plan, type ProjectState, type Run } from "@/lib/types";

// ---------------- local (browser) storage ----------------
const STORE_KEY = "mtm-planner:v1";
interface Store {
  activeId: string;
  projects: Record<string, ProjectState>;
}
function loadStore(): Store | null {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Store) : null;
  } catch {
    return null;
  }
}
function saveStore(s: Store): string | null {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(s));
    return null;
  } catch (e) {
    return `Could not save to browser storage (${(e as Error).message}). Export the project to keep it.`;
  }
}

interface ServerConfig {
  model: string;
  hasKey: boolean;
  thinkingBudget: number | null;
  judgePolicy: string;
  defaultStart: string;
  limits: { full: { maxCalls: number; maxMs: number }; update: { maxCalls: number; maxMs: number } };
}

const ACCEPT = ".txt,.csv,.tsv,.md,.markdown,.json,.pdf,.docx,.xlsx,text/plain,text/csv,text/markdown,application/json,application/pdf";
type Tab = "plan" | "messages" | "changes" | "trace";

function download(name: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

const STATUS_STYLE: Record<string, string> = {
  accepted: "bg-ok-soft text-ok",
  active: "bg-ok-soft text-ok",
  superseded: "bg-warn-soft text-warn",
  rejected: "bg-bad-soft text-bad",
  partial: "bg-bad-soft text-bad",
  irrelevant: "bg-soft text-muted",
  pending: "bg-soft text-muted",
};

function Badge({ children, tone }: { children: React.ReactNode; tone: string }) {
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", STATUS_STYLE[tone] ?? tone)}>{children}</span>;
}

export default function Dashboard() {
  const [store, setStore] = useState<Store | null>(null);
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saveWarn, setSaveWarn] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("plan");
  const [prediction, setPrediction] = useState<CallTag[]>(["reading"]);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const s = loadStore();
    if (s && s.projects[s.activeId]) setStore(s);
    else {
      const p = newProject("Hackathon plan");
      setStore({ activeId: p.id, projects: { [p.id]: p } });
    }
    fetch("/api/config")
      .then((r) => r.json())
      .then(setCfg)
      .catch(() => setCfg(null));
  }, []);

  useEffect(() => {
    if (store) setSaveWarn(saveStore(store));
  }, [store]);

  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed((Date.now() - t0) / 1000), 100);
    return () => clearInterval(id);
  }, [busy]);

  const project = store ? store.projects[store.activeId] : null;
  const setProject = useCallback((p: ProjectState) => setStore((s) => (s ? { ...s, projects: { ...s.projects, [p.id]: p } } : s)), []);
  const latest = project?.plans.length ? project.plans[project.plans.length - 1] : null;
  const shown = project && viewVersion !== null ? project.plans.find((p) => p.version === viewVersion) ?? latest : latest;
  const mode = project && project.messages.length ? "update" : "full";

  const submit = async () => {
    if (!project || busy) return;
    if (!files.length && !text.trim()) {
      setError("Add a file or paste a message first.");
      return;
    }
    setBusy(true);
    setError(null);
    const fd = new FormData();
    const { runs: _runs, ...core } = project;
    void _runs;
    fd.append("state", JSON.stringify({ ...core, runs: [] }));
    for (const f of files) fd.append("files", f, f.name);
    if (text.trim()) fd.append("text", text);
    try {
      const res = await fetch("/api/run", { method: "POST", body: fd });
      const data = (await res.json()) as { state?: ProjectState; run?: Run; error?: string };
      if (!res.ok || !data.state || !data.run) throw new Error(data.error ?? `Server returned ${res.status}`);
      const run: Run = { ...data.run, prediction: mode === "update" ? prediction : undefined, inputs: [...files.map((f) => f.name), ...(text.trim() ? ["pasted text"] : [])] };
      const next: ProjectState = { ...data.state, runs: [...project.runs, run] };
      setProject(next);
      setFiles([]);
      setText("");
      setViewVersion(null);
      setPrediction(["reading"]);
      if (run.aborted) setError(`Run stopped: ${run.aborted}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((cur) => [...cur, ...Array.from(list)]);
  };

  const newProj = () => {
    const p = newProject(`Plan ${Object.keys(store?.projects ?? {}).length + 1}`);
    setStore((s) => (s ? { activeId: p.id, projects: { ...s.projects, [p.id]: p } } : s));
    setViewVersion(null);
    setTab("plan");
  };
  const deleteProj = () => {
    if (!store || !project) return;
    if (!window.confirm(`Delete "${project.name}" from this browser? This cannot be undone (export it first to keep a copy).`)) return;
    const rest = { ...store.projects };
    delete rest[project.id];
    const ids = Object.keys(rest);
    if (!ids.length) {
      const p = newProject("Hackathon plan");
      setStore({ activeId: p.id, projects: { [p.id]: p } });
    } else setStore({ activeId: ids[0], projects: rest });
    setViewVersion(null);
  };
  const importProj = async (f: File | undefined) => {
    if (!f) return;
    try {
      const p = JSON.parse(await f.text()) as ProjectState;
      if (!p.id || !Array.isArray(p.messages) || !Array.isArray(p.plans)) throw new Error("not a project file");
      setStore((s) => (s ? { activeId: p.id, projects: { ...s.projects, [p.id]: p } } : s));
    } catch (e) {
      setError(`Import failed: ${(e as Error).message}`);
    }
  };

  const totals = useMemo(() => {
    const runs = project?.runs ?? [];
    return {
      calls: runs.reduce((s, r) => s + r.calls.length, 0),
      tokens: runs.reduce((s, r) => s + r.totals.totalTokens, 0),
    };
  }, [project]);

  if (!store || !project) return <div className="p-8 text-muted">Loading…</div>;

  const counts = project.messages.reduce<Record<string, number>>((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {});
  const lastRun = project.runs[project.runs.length - 1];

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6">
      {/* header */}
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">MTM Hackathon Planner</h1>
          <p className="text-sm text-muted">Reads English & Roman Urdu messages, keeps one valid plan, and traces every model call.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-line bg-card px-3 py-1">
            Model: <b className="font-mono">{cfg?.model ?? "…"}</b>
          </span>
          <span className={cx("rounded-full px-3 py-1 font-medium", cfg?.hasKey ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad")}>{cfg ? (cfg.hasKey ? "Gemini key set (server)" : "GEMINI_API_KEY missing") : "checking server…"}</span>
          <span className="rounded-full border border-line bg-card px-3 py-1">Saved in this browser</span>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* -------- sidebar -------- */}
        <aside className="space-y-5">
          <section className="card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">{mode === "full" ? "1 · Load message pack" : "Send a new message"}</h2>
              <Badge tone={mode === "full" ? "bg-soft text-accent" : "bg-warn-soft text-warn"}>{mode === "full" ? "full run" : "update"}</Badge>
            </div>
            <p className="mb-3 text-xs text-muted">
              {mode === "full"
                ? `Empty project: the next submit reads the whole pack (limit ${cfg?.limits.full.maxMs ? cfg.limits.full.maxMs / 1000 : 120} s).`
                : `Plan exists: the next submit updates it (max ${cfg?.limits.update.maxCalls ?? 5} model calls incl. retries, ${cfg?.limits.update.maxMs ? cfg.limits.update.maxMs / 1000 : 60} s).`}
            </p>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                addFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInput.current?.click()}
              className={cx("cursor-pointer rounded-xl border-2 border-dashed p-4 text-center text-sm transition", drag ? "border-accent bg-soft" : "border-line hover:border-accent")}
            >
              <div className="font-medium">Drop files or click to choose</div>
              <div className="mt-1 text-xs text-muted">TXT · CSV · MD · JSON · PDF · DOCX · XLSX — type is detected automatically</div>
              <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />
            </div>
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <li key={i} className="flex items-center justify-between rounded-lg bg-soft px-2 py-1 text-xs">
                    <span className="truncate">
                      {f.name} <span className="text-muted">({(f.size / 1024).toFixed(1)} KB)</span>
                    </span>
                    <button className="ml-2 text-muted hover:text-bad" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label className="mt-3 block text-xs font-medium text-muted" htmlFor="paste">
              …or paste message text
            </label>
            <textarea
              id="paste"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              placeholder="Paste one or more messages exactly as received"
              className="mt-1 w-full rounded-lg border border-line bg-bg p-2 font-mono text-xs outline-none focus:border-accent"
            />
            {mode === "update" && (
              <div className="mt-3 rounded-lg border border-line p-2">
                <div className="mb-1 text-xs font-medium">Your prediction: which areas will make model calls?</div>
                <div className="flex flex-wrap gap-1.5">
                  {CALL_TAGS.map((t) => (
                    <label key={t} className={cx("flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs", prediction.includes(t) ? "border-accent bg-soft text-accent" : "border-line text-muted")}>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={prediction.includes(t)}
                        onChange={(e) => setPrediction(e.target.checked ? [...prediction, t] : prediction.filter((x) => x !== t))}
                      />
                      {t}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <button
              onClick={submit}
              disabled={busy || (!files.length && !text.trim())}
              className="mt-3 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? `Working… ${elapsed.toFixed(1)} s` : mode === "full" ? "Run full plan" : "Apply update"}
            </button>
            {error && <div className="mt-2 rounded-lg bg-bad-soft p-2 text-xs text-bad">{error}</div>}
            {saveWarn && <div className="mt-2 rounded-lg bg-warn-soft p-2 text-xs text-warn">{saveWarn}</div>}
          </section>

          <section className="card p-4 text-sm">
            <h2 className="mb-2 font-semibold">Routing rules (predict before you submit)</h2>
            <ol className="list-decimal space-y-1 pl-4 text-xs text-muted">
              <li>
                Every submit makes exactly <b className="text-ink">1 reading</b> call: it splits messages, extracts facts, and flags authority problems.
              </li>
              <li>
                Prices, headcounts, budgets, rooms, breaks, judges, corrections and wrong messages are handled in <b className="text-ink">code</b>, with <b className="text-ink">no extra call</b>.
              </li>
              <li>
                An area call (venue / schedule / food / judging / budget) happens <b className="text-ink">only</b> when a message has a constraint that none of the standard fact kinds can express. One call per such area.
              </li>
              <li>Retries count toward the limit of 5 per update. If the limit is reached, the plan stays as it was.</li>
            </ol>
          </section>

          <section className="card p-4 text-sm">
            <h2 className="mb-2 font-semibold">Project</h2>
            <select
              value={store.activeId}
              onChange={(e) => (setStore({ ...store, activeId: e.target.value }), setViewVersion(null))}
              className="w-full rounded-lg border border-line bg-bg p-2 text-sm"
              aria-label="Choose project"
            >
              {Object.values(store.projects).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.messages.length} msgs, {p.plans.length} versions
                </option>
              ))}
            </select>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <button className="rounded-lg border border-line px-2 py-1.5 hover:border-accent" onClick={newProj}>
                New empty project
              </button>
              <button className="rounded-lg border border-line px-2 py-1.5 hover:border-accent" onClick={() => download(`${project.name.replace(/\W+/g, "-")}-project.json`, JSON.stringify(project, null, 2), "application/json")}>
                Export project
              </button>
              <button className="rounded-lg border border-line px-2 py-1.5 hover:border-accent" onClick={() => importInput.current?.click()}>
                Import project
              </button>
              <button className="rounded-lg border border-line px-2 py-1.5 text-bad hover:border-bad" onClick={deleteProj}>
                Delete project
              </button>
              <input ref={importInput} type="file" accept="application/json,.json" className="hidden" onChange={(e) => (importProj(e.target.files?.[0]), (e.target.value = ""))} />
            </div>
            <p className="mt-2 text-[11px] text-muted">Projects live in this browser&apos;s local storage. The server keeps nothing. Use Export to move a project or to back it up. CLI state files (.mtm/state.json) can be imported too.</p>
          </section>
        </aside>

        {/* -------- main -------- */}
        <main className="min-w-0 space-y-5">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Plan" value={latest ? `v${latest.version}` : "—"} sub={latest ? (latest.valid ? "valid · 6/6 checks" : `${latest.checks.filter((c) => c.pass).length}/6 checks`) : "no plan yet"} tone={latest ? (latest.valid ? "ok" : "bad") : undefined} />
            <Stat label="Messages" value={String(project.messages.length)} sub={`${counts.accepted ?? 0} accepted · ${(counts.rejected ?? 0) + (counts.partial ?? 0)} rejected · ${counts.superseded ?? 0} superseded`} />
            <Stat label="Model calls" value={String(totals.calls)} sub={lastRun ? `last run: ${lastRun.calls.length} (${lastRun.areasCalled.join(", ") || "none"})` : "—"} />
            <Stat label="Tokens (API-reported)" value={totals.tokens.toLocaleString()} sub={lastRun ? `last run ${lastRun.totals.totalTokens.toLocaleString()} · ${(lastRun.ms / 1000).toFixed(1)} s` : "—"} />
          </section>

          <nav className="flex flex-wrap gap-1 rounded-xl border border-line bg-card p-1 text-sm" role="tablist">
            {(
              [
                ["plan", "Plan"],
                ["messages", `Messages (${project.messages.length})`],
                ["changes", "Changes"],
                ["trace", `Trace (${totals.calls} calls)`],
              ] as [Tab, string][]
            ).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx("flex-1 rounded-lg px-3 py-1.5 font-medium transition", tab === k ? "bg-accent text-accent-ink" : "text-muted hover:text-ink")}>
                {l}
              </button>
            ))}
          </nav>

          {tab === "plan" &&
            (shown ? (
              <PlanView plan={shown} project={project} versions={project.plans.map((p) => p.version)} onVersion={(v) => setViewVersion(v)} latestVersion={latest!.version} />
            ) : (
              <Empty text="No plan yet. Load a message pack on the left. The first submit is a full run." />
            ))}
          {tab === "messages" && <MessagesView project={project} />}
          {tab === "changes" && <ChangesView project={project} />}
          {tab === "trace" && <TraceView project={project} />}
        </main>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "ok" | "bad" }) {
  return (
    <div className="card p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={cx("num mt-0.5 text-xl font-bold", tone === "ok" && "text-ok", tone === "bad" && "text-bad")}>{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted" title={sub}>
        {sub}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="card p-10 text-center text-sm text-muted">{text}</div>;
}

function Src({ ids, project }: { ids: string[]; project: ProjectState }) {
  if (!ids.length) return null;
  const facts = ids.map((id) => project.facts.find((f) => f.id === id)).filter(Boolean) as Fact[];
  const msgs = [...new Set(facts.map((f) => f.msgId))];
  const title = facts
    .map((f) => {
      const m = project.messages.find((x) => x.id === f.msgId);
      return `${f.id} ← ${f.msgId} (${m?.from ?? "?"}): ${m?.text.slice(0, 120) ?? ""}`;
    })
    .join("\n");
  return (
    <span className="ml-1 cursor-help rounded bg-soft px-1 font-mono text-[10px] text-muted" title={title}>
      {msgs.join(",")}
    </span>
  );
}

function PlanView({ plan, project, versions, onVersion, latestVersion }: { plan: Plan; project: ProjectState; versions: number[]; onVersion: (v: number | null) => void; latestVersion: number }) {
  const h = plan.headcount;
  const j = plan.judging;
  const max = Math.max(plan.budget.cap ?? 0, plan.budget.total, 1);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={plan.valid ? "accepted" : "rejected"}>{plan.valid ? "valid plan" : "not valid"}</Badge>
          <span className="text-sm text-muted">
            Version {plan.version}
            {plan.version !== latestVersion && " (older version)"} · {new Date(plan.createdAt).toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label htmlFor="ver" className="text-muted">
            View version
          </label>
          <select id="ver" value={plan.version} onChange={(e) => onVersion(Number(e.target.value) === latestVersion ? null : Number(e.target.value))} className="rounded-lg border border-line bg-card p-1">
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
          <button className="rounded-lg border border-line bg-card px-2 py-1 hover:border-accent" onClick={() => download(`plan-v${plan.version}.md`, formatPlan(plan, project))}>
            Plan .md
          </button>
          <button className="rounded-lg border border-line bg-card px-2 py-1 hover:border-accent" onClick={() => download(`plan-v${plan.version}.json`, JSON.stringify(plan, null, 2), "application/json")}>
            Plan .json
          </button>
        </div>
      </div>

      {/* six checks */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {plan.checks.map((c) => (
          <details key={c.id} className={cx("card p-3", !c.pass && "border-bad")}>
            <summary className="flex items-center justify-between gap-2">
              <span className="font-medium">{c.name}</span>
              <Badge tone={c.pass ? "accepted" : "rejected"}>{c.pass ? "pass" : "fail"}</Badge>
            </summary>
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {c.details.map((d, i) => (
                <li key={i}>• {d}</li>
              ))}
            </ul>
          </details>
        ))}
      </section>

      {plan.conflicts.length > 0 && (
        <section className="rounded-xl border border-bad bg-bad-soft p-3 text-sm text-bad">
          <b>Conflicts — no plan can satisfy every fact:</b>
          <ul className="mt-1 list-disc pl-5">
            {plan.conflicts.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        {/* venue */}
        <AreaCard title="Venue">
          {plan.venue.chosen ? (
            <>
              <div className="text-lg font-semibold">
                {plan.venue.chosen.label}
                <Src ids={[plan.venue.chosen.factId]} project={project} />
              </div>
              <div className="text-sm text-muted">
                {plan.venue.chosen.capacity} seats · {rs(plan.venue.chosen.price)}
                {plan.venue.chosen.features.length ? ` · ${plan.venue.chosen.features.join(", ")}` : ""}
              </div>
            </>
          ) : (
            <div className="text-bad">No venue fits.</div>
          )}
          <div className="mt-2 text-xs text-muted">
            Seats needed: <b className="text-ink">{h.total ?? "?"}</b> = {h.students} students + {h.judges} judges + {h.staff} staff
            {h.extra.map((e) => ` + ${e.num} ${e.label}`).join("")}
          </div>
          {plan.venue.rejectedOptions.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-muted">
              {plan.venue.rejectedOptions.map((r) => (
                <li key={r.label}>
                  ✕ {r.label}: {r.why}
                </li>
              ))}
            </ul>
          )}
        </AreaCard>

        {/* food */}
        <AreaCard title="Food">
          {plan.food.option ? (
            <>
              <div className="text-lg font-semibold">
                {plan.food.ordered} × {plan.food.option.label}
                <Src ids={[plan.food.option.factId]} project={project} />
              </div>
              <div className="text-sm text-muted">
                {rs(plan.food.option.price)} per head · total {rs(plan.food.cost)}
              </div>
            </>
          ) : (
            <div className="text-bad">No meal option.</div>
          )}
          <ul className="mt-2 space-y-0.5 text-xs text-muted">
            <li>Meals needed: {plan.food.meals ?? "?"} (everyone on site)</li>
            {plan.food.specials.map((s) => (
              <li key={s.label}>
                Includes {s.count} {s.label} @ {rs(s.price)}
              </li>
            ))}
            {plan.food.fees.map((f) => (
              <li key={f.label}>
                Fee: {f.label} {rs(f.amount)}
              </li>
            ))}
            {plan.food.alternatives.length > 0 && <li>Other options: {plan.food.alternatives.join(", ")}</li>}
          </ul>
        </AreaCard>

        {/* schedule */}
        <AreaCard title={`Schedule · ${plan.schedule.start ?? "?"}–${plan.schedule.end ?? "?"} (${plan.schedule.durationMin ?? "?"} min)`}>
          <ol className="space-y-1">
            {plan.schedule.items.map((it, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span className="num w-[92px] shrink-0 font-mono text-xs text-muted">
                  {it.start}–{it.end}
                </span>
                <span
                  className={cx(
                    "h-2 shrink-0 rounded-full",
                    it.kind === "build" ? "bg-accent" : it.kind === "judging" ? "bg-warn" : it.kind === "break" || it.kind === "meal" ? "bg-ok" : "bg-muted",
                  )}
                  style={{ width: `${Math.max(6, (it.minutes / (plan.schedule.durationMin || 1)) * 120)}px` }}
                />
                <span className="truncate">
                  {it.label} <span className="text-xs text-muted">{it.minutes} min</span>
                  <Src ids={it.factIds} project={project} />
                </span>
              </li>
            ))}
          </ol>
          {plan.schedule.notes.length > 0 && <div className="mt-2 text-xs text-bad">{plan.schedule.notes.join(" ")}</div>}
        </AreaCard>

        {/* judging */}
        <AreaCard title="Judging">
          <div className="text-lg font-semibold">
            {j.used ?? "?"} judges for {j.teams ?? "?"} teams
          </div>
          <div className="text-sm text-muted">
            {j.confirmed ?? "?"} confirmed · {j.required ?? "?"} required · {j.reserves ?? 0} reserve · {j.minutesPerTeam ?? "?"} min/team · max {j.maxTeamsPerJudge ?? "?"} teams each · {rs(j.honorarium)} each
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-4 2xl:grid-cols-6">
            {j.assignments.map((a) => (
              <div key={a.judge} className="rounded-md bg-soft px-1.5 py-1 text-[11px]">
                <b>{a.judge}</b> <span className="text-muted">T{a.teams.join(",")}</span>
              </div>
            ))}
          </div>
        </AreaCard>
      </div>

      {/* budget */}
      <AreaCard title="Budget">
        <div className="mb-3">
          <div className="flex justify-between text-sm">
            <span>
              Spend <b className="num">{rs(plan.budget.total)}</b> of <b className="num">{rs(plan.budget.cap)}</b>
            </span>
            <span className={cx("num font-semibold", (plan.budget.remaining ?? 0) < 0 ? "text-bad" : "text-ok")}>{rs(plan.budget.remaining)} left</span>
          </div>
          <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-soft">
            <div className={cx("h-full rounded-full", plan.budget.total > (plan.budget.cap ?? Infinity) ? "bg-bad" : "bg-accent")} style={{ width: `${Math.min(100, (plan.budget.total / max) * 100)}%` }} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-1 pr-2 font-medium">Item</th>
                <th className="py-1 pr-2 font-medium">Area</th>
                <th className="py-1 pr-2 font-medium">Working</th>
                <th className="py-1 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {plan.budget.lines.map((l, i) => (
                <tr key={i} className="border-b border-line/60">
                  <td className="py-1 pr-2">
                    {l.label}
                    <Src ids={l.factIds} project={project} />
                  </td>
                  <td className="py-1 pr-2 text-xs text-muted">{l.area}</td>
                  <td className="num py-1 pr-2 font-mono text-xs text-muted">{l.formula}</td>
                  <td className="num py-1 text-right font-mono">{rs(l.amount)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-1.5" colSpan={3}>
                  Total
                </td>
                <td className="num py-1.5 text-right font-mono">{rs(plan.budget.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {plan.budget.requests.length > 0 && (
          <div className="mt-3 rounded-lg bg-soft p-2 text-xs">
            <b>Not included (requests nobody with authority approved):</b>
            <ul className="mt-1">
              {plan.budget.requests.map((r) => (
                <li key={r.factId}>
                  {r.label} {rs(r.amount)} — {r.wouldFit ? "would fit if approved" : "would not fit"}
                  <Src ids={[r.factId]} project={project} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </AreaCard>

      {plan.assumptions.length > 0 && (
        <AreaCard title="Assumptions & decisions">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            {plan.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </AreaCard>
      )}
    </div>
  );
}

function AreaCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
}

function MessagesView({ project }: { project: ProjectState }) {
  const [filter, setFilter] = useState<string>("all");
  const groups = ["all", "accepted", "rejected", "partial", "superseded", "irrelevant"];
  const list = project.messages.filter((m) => filter === "all" || m.status === filter);
  if (!project.messages.length) return <Empty text="No messages yet." />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {groups.map((g) => (
          <button key={g} onClick={() => setFilter(g)} className={cx("rounded-full border px-3 py-1 text-xs", filter === g ? "border-accent bg-soft text-accent" : "border-line text-muted")}>
            {g} ({g === "all" ? project.messages.length : project.messages.filter((m) => m.status === g).length})
          </button>
        ))}
      </div>
      {list.map((m) => (
        <MessageCard key={m.id} m={m} project={project} />
      ))}
    </div>
  );
}

function MessageCard({ m, project }: { m: Message; project: ProjectState }) {
  const facts = project.facts.filter((f) => f.msgId === m.id);
  return (
    <article className={cx("card p-3", (m.status === "rejected" || m.status === "partial") && "border-bad")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted">{m.id}</span>
        <Badge tone={m.status}>{m.status}</Badge>
        <span className="font-medium">{m.from}</span>
        {m.date && <span className="text-xs text-muted">{m.date}</span>}
        <span className="text-xs text-muted">· {m.relevance}</span>
        <span className="ml-auto text-[11px] text-muted">
          {m.source.name} ({m.source.detectedType}) · lines {m.source.lines[0]}–{m.source.lines[1]} · run {m.runId}
        </span>
      </div>
      <pre className="mt-2 rounded-lg bg-code p-2 font-mono text-xs">{m.text}</pre>
      {m.reasons.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {m.reasons.map((r, i) => (
            <li key={i} className={r.startsWith("Rejected") || r.startsWith("Constraint not") || r.startsWith("Not enforceable") ? "text-bad" : "text-muted"}>
              {r}
            </li>
          ))}
        </ul>
      )}
      {facts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {facts.map((f) => (
            <span key={f.id} className={cx("rounded-md px-1.5 py-0.5 font-mono text-[11px]", STATUS_STYLE[f.status])} title={f.reason ?? `${f.status} · from ${f.origin} call`}>
              {f.id} {f.kind}
              {f.label ? ` "${f.label}"` : ""}
              {f.num !== undefined ? ` ${f.num}` : ""}
              {f.price !== undefined ? ` @${f.price}` : ""}
              {f.text ? ` ${f.text}` : ""}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function ChangesView({ project }: { project: ProjectState }) {
  const runs = [...project.runs].reverse();
  if (!runs.length) return <Empty text="No runs yet." />;
  return (
    <div className="space-y-3">
      {runs.map((r) => (
        <section key={r.id} className="card p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            <b>Run {r.id}</b>
            <Badge tone={r.mode === "full" ? "bg-soft text-accent" : "bg-warn-soft text-warn"}>{r.mode}</Badge>
            <span className="text-muted">
              {r.planChanged ? `→ plan v${r.planVersion}` : `plan unchanged (v${r.planVersion ?? "—"})`} · calls: {r.areasCalled.join(", ") || "none"}
            </span>
            {r.inputs && <span className="text-xs text-muted">· {r.inputs.join(", ")}</span>}
          </div>
          {r.changes.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="py-1 pr-2 font-medium">Area</th>
                    <th className="py-1 pr-2 font-medium">Field</th>
                    <th className="py-1 pr-2 font-medium">Before</th>
                    <th className="py-1 font-medium">After</th>
                  </tr>
                </thead>
                <tbody>
                  {r.changes.map((c, i) => (
                    <tr key={i} className="border-b border-line/60 align-top">
                      <td className="py-1 pr-2 text-xs text-muted">{c.area}</td>
                      <td className="py-1 pr-2">{c.field}</td>
                      <td className="py-1 pr-2 text-xs text-bad">{c.from}</td>
                      <td className="py-1 text-xs text-ok">{c.to}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted">No change to the plan{r.events.some((e) => e.kind === "reject") ? ". The submitted message was rejected, so the valid plan stayed as it was." : "."}</p>
          )}
          {r.events.filter((e) => e.kind === "reject" || e.kind === "conflict").length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-bad">
              {r.events
                .filter((e) => e.kind === "reject" || e.kind === "conflict")
                .map((e, i) => (
                  <li key={i}>⚠ {e.text}</li>
                ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

const EVENT_STYLE: Record<string, string> = {
  reject: "text-bad",
  conflict: "text-bad",
  error: "text-warn",
  supersede: "text-warn",
  accept: "text-ok",
  route: "text-accent",
};

function TraceView({ project }: { project: ProjectState }) {
  const runs = [...project.runs].reverse();
  const g = project.runs.reduce(
    (s, r) => ({ c: s.c + r.calls.length, p: s.p + r.totals.promptTokens, o: s.o + r.totals.outputTokens, th: s.th + r.totals.thoughtsTokens, t: s.t + r.totals.totalTokens }),
    { c: 0, p: 0, o: 0, th: 0, t: 0 },
  );
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
        <span className="num">
          <b>Grand total:</b> {g.c} calls · input {g.p.toLocaleString()} · output {g.o.toLocaleString()} · thinking {g.th.toLocaleString()} · <b>total {g.t.toLocaleString()} tokens</b>
        </span>
        <div className="flex gap-2 text-xs">
          <button className="rounded-lg border border-line px-2 py-1 hover:border-accent" onClick={() => download("trace.txt", formatTrace(project))}>
            Trace .txt
          </button>
          <button className="rounded-lg border border-line px-2 py-1 hover:border-accent" onClick={() => download("trace.json", JSON.stringify(project.runs, null, 2), "application/json")}>
            Trace .json
          </button>
        </div>
      </div>
      {!runs.length && <Empty text="No model calls yet." />}
      {runs.map((r) => {
        const predOk = r.prediction ? sameSet(r.prediction, r.areasCalled) : null;
        return (
          <section key={r.id} className="card p-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <b>Run {r.id}</b>
              <Badge tone={r.mode === "full" ? "bg-soft text-accent" : "bg-warn-soft text-warn"}>{r.mode}</Badge>
              <span className="text-muted">
                {new Date(r.startedAt).toLocaleTimeString()} · {(r.ms / 1000).toFixed(1)} s / {r.limits.maxMs / 1000} s · {r.calls.length} / {r.limits.maxCalls} calls · {r.totals.totalTokens.toLocaleString()} tokens
              </span>
              {r.aborted && <Badge tone="rejected">stopped</Badge>}
              {predOk !== null && (
                <span className={cx("ml-auto rounded-full px-2 py-0.5 text-xs", predOk ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad")}>
                  prediction {r.prediction!.join(", ")} → actual {r.areasCalled.join(", ") || "none"} {predOk ? "✓" : "✗"}
                </span>
              )}
            </div>
            <ul className="mt-2 space-y-0.5 font-mono text-[11px]">
              {r.events.map((e, i) => (
                <li key={i} className={EVENT_STYLE[e.kind] ?? "text-muted"}>
                  [{e.kind}] {e.text}
                </li>
              ))}
            </ul>
            <div className="mt-3 space-y-2">
              {r.calls.map((c) => (
                <details key={c.n} className="rounded-lg border border-line">
                  <summary className="flex flex-wrap items-center gap-2 p-2 text-xs">
                    <b className="font-mono">#{c.n}</b>
                    <span className="rounded bg-soft px-1.5 py-0.5 font-semibold text-accent">{c.area}</span>
                    <span className="font-mono">{c.model}</span>
                    <span className="text-muted">attempt {c.attempt}</span>
                    <span className="text-muted">{c.ms} ms</span>
                    <span className="num ml-auto font-mono">
                      in {c.usage.promptTokens ?? "n/a"} · out {c.usage.outputTokens ?? "n/a"} · think {c.usage.thoughtsTokens ?? "n/a"} · total <b>{c.usage.totalTokens ?? "n/a"}</b>
                    </span>
                    {!c.ok && <Badge tone="rejected">failed</Badge>}
                  </summary>
                  <div className="grid gap-2 border-t border-line p-2 lg:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[11px] font-semibold text-muted">INPUT</div>
                      <pre className="max-h-96 overflow-auto rounded bg-code p-2 font-mono text-[11px]">{c.input}</pre>
                    </div>
                    <div>
                      <div className="mb-1 text-[11px] font-semibold text-muted">OUTPUT {c.error && <span className="text-bad">— {c.error}</span>}</div>
                      <pre className="max-h-96 overflow-auto rounded bg-code p-2 font-mono text-[11px]">{prettyJson(c.output)}</pre>
                    </div>
                  </div>
                </details>
              ))}
            </div>
            <div className="num mt-2 text-right text-xs text-muted">
              Run total: input {r.totals.promptTokens.toLocaleString()} · output {r.totals.outputTokens.toLocaleString()} · thinking {r.totals.thoughtsTokens.toLocaleString()} · <b className="text-ink">total {r.totals.totalTokens.toLocaleString()}</b>
            </div>
            <details className="mt-2">
              <summary className="text-xs text-accent">Show this run as plain text</summary>
              <pre className="mt-1 max-h-96 overflow-auto rounded bg-code p-2 font-mono text-[11px]">{formatRun(r, { full: false })}</pre>
            </details>
          </section>
        );
      })}
      <p className="text-xs text-muted">Areas checked against the allowed tags: {CALL_TAGS.join(", ")}. Planning areas: {AREAS.join(", ")}.</p>
    </div>
  );
}

function sameSet(a: string[], b: string[]) {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

function prettyJson(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 1);
  } catch {
    return s;
  }
}
