"use client";

// Plan tab in the ui/ design: summary, six checks, five area cards, schedule timeline, budget, judging, assumptions.
// All values come from the real plan; nothing here is hardcoded.

import { rs } from "@/lib/planner/time";
import { formatPlan } from "@/lib/report";
import type { CheckResult, Fact, Plan, ProjectState, Run } from "@/lib/types";
import { runVerdict } from "@/lib/verdict";
import { download } from "./RunViews";
import { Icon } from "./ui/Icon";

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={`status-pill ${ok ? "status-valid" : "status-conflict"}`}>{children}</span>;
}

export function Src({ ids, project }: { ids: string[]; project: ProjectState }) {
  if (!ids.length) return null;
  const facts = ids.map((id) => project.facts.find((f) => f.id === id)).filter(Boolean) as Fact[];
  const msgs = [...new Set(facts.map((f) => f.msgId))];
  if (!msgs.length) return null;
  const title = facts
    .map((f) => {
      const m = project.messages.find((x) => x.id === f.msgId);
      return `${f.id} ← ${f.msgId} (${m?.from ?? "?"}): ${m?.text.slice(0, 120) ?? ""}`;
    })
    .join("\n");
  return (
    <span className="src-tag" title={title}>
      {msgs.join(",")}
    </span>
  );
}

interface AreaView {
  key: "venue" | "schedule" | "food" | "judging" | "budget";
  eyebrow: string;
  title: React.ReactNode;
  summary: string;
  metrics: { label: string; value: string }[];
  details: React.ReactNode[];
  check?: CheckResult;
}

export function PlanTab({
  plan,
  project,
  versions,
  onVersion,
  latestVersion,
  lastRun,
}: {
  plan: Plan;
  project: ProjectState;
  versions: number[];
  onVersion: (v: number | null) => void;
  latestVersion: number;
  lastRun?: Run;
}) {
  const h = plan.headcount;
  const j = plan.judging;
  const check = (id: CheckResult["id"]) => plan.checks.find((c) => c.id === id);
  const passed = plan.checks.filter((c) => c.pass).length;
  const headline = lastRun ? runVerdict(lastRun, project).headline : "";
  const max = Math.max(plan.budget.cap ?? 0, plan.budget.total, 1);

  const areas: AreaView[] = [
    {
      key: "venue",
      eyebrow: "Venue",
      title: plan.venue.chosen ? (
        <>
          {cap(plan.venue.chosen.label)}
          <Src ids={[plan.venue.chosen.factId]} project={project} />
        </>
      ) : (
        "No venue fits"
      ),
      summary: `Cheapest hall that seats ${h.total ?? "?"} people${plan.venue.requirements.length > 1 ? ` and has ${plan.venue.requirements.slice(1).join(", ")}` : ""}.`,
      metrics: [
        { label: "Seats", value: plan.venue.chosen ? `${plan.venue.chosen.capacity} (need ${h.total ?? "?"})` : "—" },
        { label: "Cost", value: rs(plan.venue.chosen?.price) },
      ],
      details: [
        `${h.students} students + ${h.judges} judges + ${h.staff} staff${h.extra.map((e) => ` + ${e.num} ${e.label}`).join("")}`,
        ...(plan.venue.chosen?.features.length ? [`Has ${plan.venue.chosen.features.join(", ")}`] : []),
        ...plan.venue.rejectedOptions.map((r) => `Not ${r.label}: ${r.why}`),
      ],
      check: check("venue"),
    },
    {
      key: "schedule",
      eyebrow: "Schedule",
      title: `${plan.schedule.start ?? "?"} – ${plan.schedule.end ?? "?"}`,
      summary: `${plan.schedule.items.length} sessions filling ${plan.schedule.durationMin ?? "?"} minutes; see the timeline below.`,
      metrics: [
        { label: "Build time", value: `${plan.schedule.items.filter((i) => i.kind === "build").reduce((a, i) => a + i.minutes, 0)} min` },
        { label: "Judging", value: j.blockMinutes ? `${j.blockMinutes} min` : "—" },
      ],
      details: [
        ...plan.schedule.items.filter((i) => i.kind === "break" || i.kind === "block").map((i) => `${i.label}: ${i.minutes} min at ${i.start}`),
        ...plan.schedule.notes,
      ],
      check: check("schedule"),
    },
    {
      key: "food",
      eyebrow: "Food",
      title: plan.food.option ? (
        <>
          {plan.food.ordered} × {plan.food.option.label}
          <Src ids={[plan.food.option.factId]} project={project} />
        </>
      ) : (
        "No meal option"
      ),
      summary: "Everyone on site is fed. Best meal option that keeps the budget.",
      metrics: [
        { label: "Per head", value: rs(plan.food.option?.price) },
        { label: "Food total", value: rs(plan.food.cost) },
      ],
      details: [
        `Meals needed: ${plan.food.meals ?? "?"}`,
        ...plan.food.specials.map((s) => `Includes ${s.count} ${s.label} @ ${rs(s.price)}`),
        ...plan.food.fees.map((f) => `Fee: ${f.label} ${rs(f.amount)}`),
        ...(plan.food.alternatives.length ? [`Other options: ${plan.food.alternatives.join(", ")}`] : []),
      ],
      check: check("figures"),
    },
    {
      key: "judging",
      eyebrow: "Judging",
      title: `${j.used ?? "?"} judges · ${j.teams ?? "?"} teams`,
      summary: `${j.minutesPerTeam ?? "?"} min per team, at most ${j.maxTeamsPerJudge ?? "?"} teams per judge, all judges in parallel.`,
      metrics: [
        { label: "Confirmed / needed", value: `${j.confirmed ?? "?"} / ${j.required ?? "?"}` },
        { label: "Honoraria", value: j.used !== null && j.honorarium !== null ? rs(j.used * j.honorarium) : "—" },
      ],
      details: [`${j.reserves ?? 0} reserve judge(s), unpaid unless used`, `Judging block ${j.blockMinutes ?? "?"} min`],
      check: check("judges"),
    },
    {
      key: "budget",
      eyebrow: "Budget",
      title: `${rs(plan.budget.total)} of ${rs(plan.budget.cap)}`,
      summary: "Every cost line recomputed in code from the source messages.",
      metrics: [
        { label: "Remaining", value: rs(plan.budget.remaining) },
        { label: "Lines", value: String(plan.budget.lines.length) },
      ],
      details: plan.budget.requests.map((r) => `Not included: ${r.label} ${rs(r.amount)} (${r.wouldFit ? "would fit if approved" : "would not fit"})`),
      check: check("budget"),
    },
  ];

  return (
    <div className="tab-content plan-content">
      <section className="plan-summary panel">
        <div className="summary-main">
          <div className="section-kicker">
            <span className="kicker-dot" /> Plan version {plan.version}
            {plan.version !== latestVersion && " (older version)"}
          </div>
          <div className="summary-title-row">
            <h2>{plan.valid ? "Valid plan" : "Plan is not valid"}</h2>
            <Pill ok={plan.valid}>{plan.valid ? "Valid" : "Conflict"}</Pill>
          </div>
          <p>{plan.version === latestVersion && headline ? headline : `Version ${plan.version} created ${new Date(plan.createdAt).toLocaleString()}.`}</p>
        </div>
        <div className="summary-meta">
          <span>View version</span>
          <select
            value={plan.version}
            onChange={(e) => onVersion(Number(e.target.value) === latestVersion ? null : Number(e.target.value))}
            className="message-input"
            style={{ minHeight: 0, padding: "6px 8px", margin: "5px 0 10px" }}
            aria-label="Plan version"
          >
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
                {v === latestVersion ? " (latest)" : ""}
              </option>
            ))}
          </select>
          <span className="summary-meta-note">
            <Icon name="check" size={14} /> {passed}/6 checks pass
          </span>
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <button className="button button-secondary" style={{ padding: "6px 9px" }} onClick={() => download(`plan-v${plan.version}.md`, formatPlan(plan, project))}>
              <Icon name="download" size={13} /> .md
            </button>
            <button className="button button-secondary" style={{ padding: "6px 9px" }} onClick={() => download(`plan-v${plan.version}.json`, JSON.stringify(plan, null, 2), "application/json")}>
              <Icon name="download" size={13} /> .json
            </button>
          </div>
        </div>
      </section>

      {plan.conflicts.length > 0 && (
        <section className="warning-panel" aria-label="Conflicts" style={{ color: "var(--red)", background: "var(--red-bg)", borderColor: "#f3c9c3" }}>
          <div className="warning-icon" style={{ background: "#f3c9c3", color: "var(--red)" }}>!</div>
          <div>
            <strong>Conflicts: no plan can satisfy every fact</strong>
            <p>{plan.conflicts.join(" ")}</p>
          </div>
        </section>
      )}

      <div className="section-heading-row">
        <div>
          <div className="section-kicker">Validation</div>
          <h2>The six checks</h2>
        </div>
        <span className="muted-label">Click a check for its working</span>
      </div>
      <section className="check-grid" aria-label="Checks">
        {plan.checks.map((c) => (
          <details key={c.id} className="check-card panel" style={!c.pass ? { borderColor: "var(--red)" } : undefined}>
            <summary className="card-topline">
              <span className="area-eyebrow" style={{ color: "var(--ink)", fontSize: 12, textTransform: "none", letterSpacing: 0 }}>
                {c.name}
              </span>
              <Pill ok={c.pass}>{c.pass ? "Pass" : "Fail"}</Pill>
            </summary>
            <ul className="detail-list" style={{ marginTop: 12 }}>
              {c.details.map((d, i) => (
                <li key={i} style={{ alignItems: "flex-start" }}>
                  <Icon name={c.pass ? "check" : "alert"} size={13} />
                  {d}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </section>

      <div className="section-heading-row">
        <div>
          <div className="section-kicker">Planning overview</div>
          <h2>Five areas, one plan</h2>
        </div>
        <span className="muted-label">Source message tags show where each number came from</span>
      </div>
      <section className="area-grid" aria-label="Planning areas">
        {areas.map((a) => (
          <article className="area-card panel" key={a.key}>
            <div className="card-topline">
              <span className={`area-marker marker-${a.key}`} /> <span className="area-eyebrow">{a.eyebrow}</span>
              {a.check && <Pill ok={a.check.pass}>{a.check.pass ? "Valid" : "Conflict"}</Pill>}
            </div>
            <h3>{a.title}</h3>
            <p className="area-summary">{a.summary}</p>
            <div className="area-metrics">
              {a.metrics.map((m) => (
                <div key={m.label}>
                  <span>{m.label}</span>
                  <strong>{m.value}</strong>
                </div>
              ))}
            </div>
            <ul className="detail-list">
              {a.details.map((d, i) => (
                <li key={i} style={{ alignItems: "flex-start" }}>
                  <Icon name="check" size={14} />
                  {d}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className="timeline-section">
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">Event flow</div>
            <h2>Schedule timeline</h2>
          </div>
          <span className="muted-label">
            {plan.schedule.start}–{plan.schedule.end} · {plan.schedule.durationMin} min
          </span>
        </div>
        <div className="timeline panel">
          {plan.schedule.items.map((item, index) => (
            <div className={`timeline-item ${item.kind === "judging" || item.kind === "break" ? "timeline-accent" : ""}`} key={index}>
              <div className="timeline-time">{item.start}</div>
              <div className="timeline-line">
                <span className="timeline-dot" />
                {index < plan.schedule.items.length - 1 && <span className="timeline-connector" />}
              </div>
              <div className="timeline-copy">
                <h3>
                  {item.label}
                  <Src ids={item.factIds} project={project} />
                </h3>
                <p>
                  {item.start}–{item.end} · {item.minutes} min
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="timeline-section">
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">Money</div>
            <h2>Budget breakdown</h2>
          </div>
          <span className="muted-label" style={{ color: (plan.budget.remaining ?? 0) < 0 ? "var(--red)" : "var(--green-dark)", fontWeight: 700 }}>
            {rs(plan.budget.remaining)} left
          </span>
        </div>
        <div className="panel" style={{ padding: "20px 22px" }}>
          <div style={{ height: 9, borderRadius: 9, background: "var(--soft)", overflow: "hidden", marginBottom: 16 }}>
            <div style={{ height: "100%", width: `${Math.min(100, (plan.budget.total / max) * 100)}%`, background: plan.budget.total > (plan.budget.cap ?? Infinity) ? "var(--red)" : "var(--green)", borderRadius: 9 }} />
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em" }}>
                  <th style={{ padding: "6px 8px 8px 0" }}>Item</th>
                  <th style={{ padding: "6px 8px 8px 0" }}>Area</th>
                  <th style={{ padding: "6px 8px 8px 0" }}>Working</th>
                  <th style={{ padding: "6px 0 8px", textAlign: "right" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {plan.budget.lines.map((l, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ padding: "8px 8px 8px 0" }}>
                      {l.label}
                      <Src ids={l.factIds} project={project} />
                    </td>
                    <td style={{ padding: "8px 8px 8px 0", color: "var(--muted)" }}>{l.area}</td>
                    <td className="num font-mono" style={{ padding: "8px 8px 8px 0", color: "var(--muted)" }}>
                      {l.formula}
                    </td>
                    <td className="num font-mono" style={{ padding: "8px 0", textAlign: "right" }}>
                      {rs(l.amount)}
                    </td>
                  </tr>
                ))}
                <tr style={{ borderTop: "2px solid var(--line)", fontWeight: 800 }}>
                  <td colSpan={3} style={{ padding: "10px 0" }}>
                    Total (cap {rs(plan.budget.cap)})
                  </td>
                  <td className="num font-mono" style={{ textAlign: "right" }}>
                    {rs(plan.budget.total)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {plan.budget.requests.length > 0 && (
            <p className="muted-label" style={{ marginTop: 12 }}>
              Not included (requests nobody with authority approved):{" "}
              {plan.budget.requests.map((r) => (
                <span key={r.factId}>
                  {r.label} {rs(r.amount)} — {r.wouldFit ? "would fit if approved" : "would not fit"}
                  <Src ids={[r.factId]} project={project} />{" "}
                </span>
              ))}
            </p>
          )}
        </div>
      </section>

      <section className="timeline-section">
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">Judging</div>
            <h2>Judge assignments</h2>
          </div>
          <span className="muted-label">
            {j.used ?? "?"} judges · {j.reserves ?? 0} reserve · {rs(j.honorarium)} each
          </span>
        </div>
        <div className="panel tag-list" style={{ padding: "18px 20px" }}>
          {j.assignments.map((a) => (
            <span key={a.judge} className="area-tag">
              <b>{a.judge}</b> · teams {a.teams.join(", ")}
            </span>
          ))}
        </div>
      </section>

      {plan.assumptions.length > 0 && (
        <section className="warning-panel" aria-label="Assumptions">
          <div className="warning-icon">i</div>
          <div>
            <strong>Assumptions & decisions</strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 16, fontSize: 12, lineHeight: 1.6 }}>
              {plan.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
