"use client";

// Main dashboard. Visual design adopted from the ui/ prototype; every feature is wired to the real pipeline.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { newProject } from "@/lib/project";
import { cleanText } from "@/lib/ingest/clean";
import { formatPlan, formatTrace } from "@/lib/report";
import { AREAS, type Area, type CallTag, type ProjectState, type Run } from "@/lib/types";
import { runVerdict } from "@/lib/verdict";
import { MessagesTab } from "./MessagesTab";
import { PlanTab } from "./PlanTab";
import { HistoryView, RunCard, TraceView, download } from "./RunViews";
import { Icon } from "./ui/Icon";

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
  models: string[];
  hasKey: boolean;
  thinkingBudget: number | null;
  judgePolicy: string;
  defaultStart: string;
  limits: { full: { maxCalls: number; maxMs: number }; update: { maxCalls: number; maxMs: number } };
}

const ACCEPT = ".txt,.csv,.tsv,.md,.markdown,.json,.pdf,.docx,.xlsx,text/plain,text/csv,text/markdown,application/json,application/pdf";
type Tab = "plan" | "trace" | "messages" | "history" | "setup";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
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
  const [prediction, setPrediction] = useState<Area[]>([]);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const [showIngest, setShowIngest] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // live preview of exactly what the pipeline will read from the pasted text (same cleanup code as the server)
  const cleaned = useMemo(() => (text.trim() ? cleanText(text) : null), [text]);
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
      const run: Run = { ...data.run, prediction: mode === "update" ? (prediction as CallTag[]) : undefined, inputs: [...files.map((f) => f.name), ...(text.trim() ? ["pasted text"] : [])] };
      const next: ProjectState = { ...data.state, runs: [...project.runs, run] };
      setProject(next);
      setFiles([]);
      setText("");
      setViewVersion(null);
      setPrediction([]);
      if (run.aborted) setError(`Run stopped: ${run.aborted}`);
      else {
        setShowIngest(false);
        setNotice(runVerdict(run, next).headline);
      }
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
    setNotice("New empty project created. The next submit is a full run.");
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
  const resetSystem = () => {
    const n = Object.keys(store?.projects ?? {}).length;
    if (!window.confirm(`Reset the system?\n\nThis permanently deletes all ${n} project(s), messages, plan versions and traces saved in this browser. It cannot be undone. Export anything you want to keep first.`)) return;
    try {
      window.localStorage.removeItem(STORE_KEY);
    } catch {
      /* storage may be blocked; the in-memory state is still replaced below */
    }
    const p = newProject("Hackathon plan");
    setStore({ activeId: p.id, projects: { [p.id]: p } });
    setViewVersion(null);
    setFiles([]);
    setText("");
    setPrediction([]);
    setError(null);
    setTab("plan");
    setNotice("System reset: all browser data deleted. Load a message pack to start fresh.");
  };

  const importProj = async (f: File | undefined) => {
    if (!f) return;
    try {
      const p = JSON.parse(await f.text()) as ProjectState;
      if (!p.id || !Array.isArray(p.messages) || !Array.isArray(p.plans)) throw new Error("not a project file");
      setStore((s) => (s ? { activeId: p.id, projects: { ...s.projects, [p.id]: p } } : s));
      setNotice(`Imported "${p.name}".`);
    } catch (e) {
      setNotice(`Import failed: ${(e as Error).message}`);
    }
  };

  const totals = useMemo(() => {
    const runs = project?.runs ?? [];
    return { calls: runs.reduce((s, r) => s + r.calls.length, 0), tokens: runs.reduce((s, r) => s + r.totals.totalTokens, 0) };
  }, [project]);

  if (!store || !project) return <main className="app-shell"><div className="page-container muted-label">Loading…</div></main>;

  const counts = project.messages.reduce<Record<string, number>>((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {});
  const lastRun = project.runs[project.runs.length - 1];
  const planState = !latest ? "not-run" : latest.valid ? "valid" : "error";

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "plan", label: "Plan" },
    { id: "trace", label: "Trace", count: totals.calls },
    { id: "messages", label: "Messages", count: project.messages.length },
    { id: "history", label: "Run history", count: project.runs.length },
    { id: "setup", label: "Setup & rules" },
  ];

  const exportItems: [string, () => void, boolean][] = [
    ["Plan (.md)", () => latest && download(`plan-v${latest.version}.md`, formatPlan(latest, project)), !!latest],
    ["Plan (.json)", () => latest && download(`plan-v${latest.version}.json`, JSON.stringify(latest, null, 2), "application/json"), !!latest],
    ["Trace (.txt)", () => download("trace.txt", formatTrace(project)), project.runs.length > 0],
    ["Trace (.json)", () => download("trace.json", JSON.stringify(project.runs, null, 2), "application/json"), project.runs.length > 0],
    ["Whole project (.json)", () => download(`${project.name.replace(/\W+/g, "-")}-project.json`, JSON.stringify(project, null, 2), "application/json"), true],
  ];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Icon name="spark" size={19} />
          </div>
          <div>
            <strong>Mind to Machine</strong>
            <span>Hackathon planner</span>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="run-status">
            <span className={cx("live-dot", busy && "is-running")} style={cfg && !cfg.hasKey ? { background: "var(--red)" } : undefined} />
            {busy ? `Running… ${elapsed.toFixed(1)} s` : cfg ? (cfg.hasKey ? `Ready · ${cfg.models[0]}` : "GEMINI_API_KEY missing on server") : "Checking server…"}
          </div>
          <div style={{ position: "relative" }}>
            <button className="button button-secondary export-button" onClick={() => setShowExport((x) => !x)} aria-expanded={showExport}>
              <Icon name="download" size={16} /> <span>Export</span>
            </button>
            {showExport && (
              <div className="export-menu panel" role="menu" onMouseLeave={() => setShowExport(false)}>
                {exportItems.map(([label, fn, enabled]) => (
                  <button key={label} role="menuitem" disabled={!enabled} onClick={() => (fn(), setShowExport(false))}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="button button-primary" onClick={() => (setError(null), setShowIngest(true))} disabled={busy}>
            <Icon name={mode === "full" ? "upload" : "plus"} size={16} /> {mode === "full" ? "Load message pack" : "Add message"}
          </button>
        </div>
      </header>

      <div className="page-container">
        <section className="welcome-row">
          <div>
            <div className="section-kicker">
              <span className="kicker-dot" /> {project.name}
            </div>
            <h1>Hackathon planning workspace</h1>
            <p>Reads English & Roman Urdu messages, keeps one valid plan, and traces every model call.</p>
          </div>
          <div className="overall-status">
            <span className="status-label">Overall plan</span>
            <div>
              <span className={`plan-dot dot-${planState}`} />
              <strong>{!latest ? "Not run" : `v${latest.version} · ${latest.valid ? "Valid" : "Not valid"}`}</strong>
            </div>
          </div>
        </section>

        <section className="stat-grid">
          <Stat label="Checks" value={latest ? `${latest.checks.filter((c) => c.pass).length}/6` : "—"} sub={latest ? (latest.valid ? "all six pass" : "see failing checks") : "no plan yet"} />
          <Stat label="Messages" value={String(project.messages.length)} sub={`${counts.accepted ?? 0} accepted · ${(counts.rejected ?? 0) + (counts.partial ?? 0)} rejected · ${counts.superseded ?? 0} out of date`} />
          <Stat label="Model calls" value={String(totals.calls)} sub={lastRun ? `last run: ${lastRun.calls.length} (${lastRun.areasCalled.join(", ") || "none"})` : "—"} />
          <Stat label="Tokens (API-reported)" value={totals.tokens.toLocaleString()} sub={lastRun ? `last run ${lastRun.totals.totalTokens.toLocaleString()} · ${(lastRun.ms / 1000).toFixed(1)} s` : "—"} />
        </section>

        {saveWarn && (
          <section className="warning-panel" style={{ marginBottom: 20 }}>
            <div className="warning-icon">!</div>
            <div>
              <strong>Storage</strong>
              <p>{saveWarn}</p>
            </div>
          </section>
        )}

        <nav className="tab-nav" aria-label="Dashboard sections">
          {tabs.map((t) => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count !== undefined && <span className="tab-count">{t.count}</span>}
            </button>
          ))}
        </nav>

        <div className={cx("workspace-grid", !lastRun && "no-aside")}>
        {lastRun && (
          <aside className="run-aside" aria-label="Latest run">
            <RunCard run={lastRun} project={project} title="Latest run" compact />
          </aside>
        )}
        <div className="workspace-main">
        {tab === "plan" &&
          (shown ? (
            <PlanTab plan={shown} project={project} versions={project.plans.map((p) => p.version)} onVersion={(v) => setViewVersion(v)} latestVersion={latest!.version} lastRun={lastRun} />
          ) : (
            <EmptyState mode={mode} onOpen={() => setShowIngest(true)} />
          ))}
        {tab === "trace" && <TraceView project={project} />}
        {tab === "messages" && <MessagesTab project={project} />}
        {tab === "history" && <HistoryView project={project} />}
        {tab === "setup" && (
          <SetupTab
            cfg={cfg}
            store={store}
            project={project}
            onSelect={(id) => (setStore({ ...store, activeId: id }), setViewVersion(null))}
            onNew={newProj}
            onImport={() => importInput.current?.click()}
            onExport={() => download(`${project.name.replace(/\W+/g, "-")}-project.json`, JSON.stringify(project, null, 2), "application/json")}
            onDelete={deleteProj}
            onReset={resetSystem}
          />
        )}
        </div>
        </div>
        <input ref={importInput} type="file" accept="application/json,.json" className="hidden" onChange={(e) => (importProj(e.target.files?.[0]), (e.target.value = ""))} />
      </div>

      {notice && (
        <button className="toast" onClick={() => setNotice(null)}>
          <span className="toast-check">
            <Icon name="check" size={14} />
          </span>
          {notice}
          <Icon name="close" size={14} />
        </button>
      )}

      {showIngest && (
        <div className="overlay" role="presentation" onMouseDown={(e) => !busy && e.target === e.currentTarget && setShowIngest(false)}>
          <section className="modal modal-wide panel" role="dialog" aria-modal="true" aria-labelledby="ingest-title">
            <div className="modal-header">
              <div>
                <div className="section-kicker">{mode === "full" ? "Full run" : "Update"}</div>
                <h2 id="ingest-title">{mode === "full" ? "Load the message pack" : "Add a new message"}</h2>
              </div>
              <button className="icon-button" onClick={() => setShowIngest(false)} aria-label="Close" disabled={busy}>
                <Icon name="close" />
              </button>
            </div>
            <p className="modal-description">
              {mode === "full"
                ? `This project is empty, so the next submit reads the whole pack and builds the first plan (limit ${cfg?.limits.full.maxMs ? cfg.limits.full.maxMs / 1000 : 120} s).`
                : `A plan exists, so this submit updates it: max ${cfg?.limits.update.maxCalls ?? 5} model calls including retries, ${cfg?.limits.update.maxMs ? cfg.limits.update.maxMs / 1000 : 60} s. A wrong message is rejected and the valid plan is kept.`}
            </p>
            <div
              className={cx("dropzone", drag && "is-drag")}
              onDragOver={(e) => (e.preventDefault(), setDrag(true))}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => (e.preventDefault(), setDrag(false), addFiles(e.dataTransfer.files))}
              onClick={() => fileInput.current?.click()}
            >
              <div style={{ display: "flex", justifyContent: "center", color: "var(--green)", marginBottom: 6 }}>
                <Icon name="upload" size={22} />
              </div>
              <strong style={{ fontSize: 13 }}>Drop files or click to choose</strong>
              <div className="muted-label" style={{ marginTop: 4 }}>
                TXT · CSV · MD · JSON · PDF · DOCX · XLSX — type is detected automatically
              </div>
              <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />
            </div>
            {files.length > 0 && (
              <div className="tag-list" style={{ marginTop: 10 }}>
                {files.map((f, i) => (
                  <span key={i} className="area-tag" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Icon name="file" size={13} /> {f.name} ({(f.size / 1024).toFixed(1)} KB)
                    <button className="text-button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                      <Icon name="close" size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <label className="form-label" htmlFor="paste" style={{ marginTop: 16 }}>
              …or paste message text
            </label>
            <textarea id="paste" className="message-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste one or more messages exactly as received" />
            {cleaned && cleaned.changed && (
              <div className="panel" style={{ padding: 14, marginTop: 10, boxShadow: "none", background: "#fbfdf8" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
                  <span className="detail-label" style={{ margin: 0 }}>
                    {cleaned.records ? `${cleaned.records} message${cleaned.records === 1 ? "" : "s"} detected` : "Cleaned for reading"}
                  </span>
                  <button className="button button-secondary" style={{ padding: "6px 10px" }} onClick={() => setText(cleaned.text)}>
                    <Icon name="check" size={13} /> Replace with cleaned text
                  </button>
                </div>
                <p className="muted-label" style={{ margin: "6px 0 8px", lineHeight: 1.5 }}>
                  {cleaned.note} This is what the system reads, even if you don&apos;t replace it.
                </p>
                {cleaned.preview.length > 0 ? (
                  <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, fontSize: 12, maxHeight: 220, overflowY: "auto" }}>
                    {cleaned.preview.map((p, i) => (
                      <li key={i}>
                        <b>{p.from}</b>
                        {p.date && <span style={{ color: "var(--muted)" }}> · {p.date}</span>}
                        <div style={{ color: "var(--muted)" }}>{p.text}</div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <pre className="font-mono" style={{ margin: 0, fontSize: 11, maxHeight: 160, overflowY: "auto", color: "var(--muted)" }}>
                    {cleaned.text}
                  </pre>
                )}
              </div>
            )}
            {mode === "update" && (
              <div className="panel" style={{ padding: 14, marginTop: 14, boxShadow: "none" }}>
                <span className="detail-label">Your prediction (write it before submitting)</span>
                <p className="muted-label" style={{ margin: "2px 0 10px", lineHeight: 1.5 }}>
                  Every submit always makes <b>1 reading call</b>, so there is nothing to predict for reading. Tick the planning areas you expect to make <i>extra</i> model calls. Leave all unticked for &quot;reading only&quot;.
                </p>
                <div className="tag-list">
                  {AREAS.map((t) => (
                    <label key={t} className="area-tag" style={{ cursor: "pointer", background: prediction.includes(t) ? "var(--green)" : undefined, color: prediction.includes(t) ? "#fff" : undefined }}>
                      <input type="checkbox" className="sr-only" checked={prediction.includes(t)} onChange={(e) => setPrediction(e.target.checked ? [...prediction, t] : prediction.filter((x) => x !== t))} />
                      {prediction.includes(t) ? "✓ " : ""}
                      {t}
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 12, marginTop: 10 }}>
                  Prediction: <b>reading{prediction.length ? ` + ${prediction.join(", ")}` : " only"}</b>
                </div>
              </div>
            )}
            {error && (
              <section className="warning-panel" style={{ marginTop: 14, color: "var(--red)", background: "var(--red-bg)", borderColor: "#f3c9c3" }}>
                <div className="warning-icon" style={{ background: "#f3c9c3", color: "var(--red)" }}>!</div>
                <div>
                  <strong>Could not finish</strong>
                  <p>{error}</p>
                </div>
              </section>
            )}
            <div className="modal-actions">
              <button className="button button-secondary" onClick={() => setShowIngest(false)} disabled={busy}>
                Cancel
              </button>
              <button className="button button-primary" onClick={submit} disabled={busy || (!files.length && !text.trim())}>
                <Icon name="play" size={15} /> {busy ? `Working… ${elapsed.toFixed(1)} s` : mode === "full" ? "Run full plan" : "Apply update"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="stat-card panel">
      <span>{label}</span>
      <strong className="num">{value}</strong>
      <small title={sub}>{sub}</small>
    </div>
  );
}

function EmptyState({ mode, onOpen }: { mode: string; onOpen: () => void }) {
  return (
    <section className="plan-summary panel">
      <div className="summary-main">
        <div className="section-kicker">
          <span className="kicker-dot" /> No plan yet
        </div>
        <div className="summary-title-row">
          <h2>Start with the message pack</h2>
        </div>
        <p>Load the pack (a file or pasted text). The first submit is a full run. Every later submit updates the same plan.</p>
      </div>
      <div className="summary-meta">
        <button className="button button-primary" onClick={onOpen}>
          <Icon name="upload" size={16} /> {mode === "full" ? "Load message pack" : "Add message"}
        </button>
      </div>
    </section>
  );
}

function SetupTab({
  cfg,
  store,
  project,
  onSelect,
  onNew,
  onImport,
  onExport,
  onDelete,
  onReset,
}: {
  cfg: ServerConfig | null;
  store: Store;
  project: ProjectState;
  onSelect: (id: string) => void;
  onNew: () => void;
  onImport: () => void;
  onExport: () => void;
  onDelete: () => void;
  onReset: () => void;
}) {
  return (
    <div className="tab-content plan-content">
      <section className="panel" style={{ padding: 22 }}>
        <div className="section-kicker">Predict before you submit</div>
        <h2 style={{ margin: "8px 0 12px", fontSize: 20 }}>Model-call routing rules</h2>
        <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8, fontSize: 13, lineHeight: 1.55 }}>
          <li>
            Every submit makes exactly <b>1 reading</b> call. It reads only the new content: splits it into messages, extracts facts, and flags authority problems.
          </li>
          <li>
            Prices, headcounts, budgets, rooms, breaks, judges, corrections and wrong messages are handled in <b>code</b>, with <b>no extra call</b>.
          </li>
          <li>
            An area call (venue / schedule / food / judging / budget) happens <b>only</b> when a message has a constraint that none of the standard fact kinds can express. One call per such area.
          </li>
          <li>Retries count toward the limit of 5 per update. If the limit is reached, the plan stays as it was.</li>
        </ol>
      </section>

      <section className="panel" style={{ padding: 22 }}>
        <div className="section-kicker">Server</div>
        <h2 style={{ margin: "8px 0 12px", fontSize: 20 }}>Model configuration</h2>
        <div className="area-metrics" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", margin: 0 }}>
          <div>
            <span>Model chain</span>
            <strong className="font-mono">{cfg?.models?.join(" → ") ?? "…"}</strong>
          </div>
          <div>
            <span>API key</span>
            <strong style={{ color: cfg?.hasKey ? "var(--green-dark)" : "var(--red)" }}>{cfg ? (cfg.hasKey ? "Set on server" : "Missing") : "…"}</strong>
          </div>
          <div>
            <span>Judge policy</span>
            <strong>{cfg?.judgePolicy ?? "…"}</strong>
          </div>
          <div>
            <span>Update limits</span>
            <strong>{cfg ? `${cfg.limits.update.maxCalls} calls · ${cfg.limits.update.maxMs / 1000} s` : "…"}</strong>
          </div>
        </div>
      </section>

      <section className="panel" style={{ padding: 22 }}>
        <div className="section-kicker">Saved in this browser</div>
        <h2 style={{ margin: "8px 0 12px", fontSize: 20 }}>Projects</h2>
        <select value={store.activeId} onChange={(e) => onSelect(e.target.value)} className="message-input" style={{ minHeight: 0 }} aria-label="Choose project">
          {Object.values(store.projects).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {p.messages.length} msgs, {p.plans.length} versions
            </option>
          ))}
        </select>
        <div className="modal-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          <button className="button button-secondary" onClick={onNew}>
            <Icon name="plus" size={15} /> New empty project
          </button>
          <button className="button button-secondary" onClick={onExport}>
            <Icon name="download" size={15} /> Export project
          </button>
          <button className="button button-secondary" onClick={onImport}>
            <Icon name="upload" size={15} /> Import project
          </button>
          <button className="button button-secondary" style={{ color: "var(--red)" }} onClick={onDelete}>
            <Icon name="close" size={15} /> Delete project
          </button>
        </div>
        <p className="muted-label" style={{ marginTop: 12, lineHeight: 1.5 }}>
          Projects live in this browser&apos;s local storage; the server keeps nothing. Use Export to move or back up a project. CLI state files (.mtm/state.json) can be imported. Current: <b>{project.name}</b>.
        </p>
      </section>

      <section className="panel danger-zone" style={{ padding: 22 }}>
        <div className="section-kicker" style={{ color: "var(--red)" }}>Fresh start</div>
        <h2 style={{ margin: "8px 0 8px", fontSize: 20 }}>Reset system</h2>
        <p className="muted-label" style={{ margin: "0 0 14px", lineHeight: 1.5 }}>
          Deletes <b>every</b> project, message, plan version and trace saved in this browser ({Object.keys(store.projects).length} project
          {Object.keys(store.projects).length === 1 ? "" : "s"}) and starts one empty project. The server and your API keys are not affected. Export anything you want to keep first.
        </p>
        <button className="button button-secondary" style={{ color: "var(--red)", borderColor: "#f3c9c3" }} onClick={onReset}>
          <Icon name="alert" size={15} /> Reset system (delete all browser data)
        </button>
      </section>
    </div>
  );
}
