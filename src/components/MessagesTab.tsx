"use client";

// Messages tab in the ui/ design: message cards + detail drawer, wired to real messages, facts and reasons.

import { useState } from "react";
import { humanizeFact } from "@/lib/humanize";
import type { Message, ProjectState } from "@/lib/types";
import { Icon } from "./ui/Icon";

const STATUS_CLASS: Record<string, string> = {
  accepted: "status-accepted",
  rejected: "status-rejected",
  partial: "status-rejected",
  superseded: "status-pending",
  irrelevant: "status-irrelevant",
  pending: "status-pending",
};
const STATUS_LABEL: Record<string, string> = {
  accepted: "Accepted",
  rejected: "Rejected",
  partial: "Partly rejected",
  superseded: "Out of date",
  irrelevant: "Irrelevant",
  pending: "Pending",
};

function Pill({ status }: { status: string }) {
  return <span className={`status-pill ${STATUS_CLASS[status] ?? "status-pending"}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function MessagesTab({ project }: { project: ProjectState }) {
  const [filter, setFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Message | null>(null);
  const groups = ["all", "accepted", "rejected", "partial", "superseded", "irrelevant"];
  const list = project.messages.filter((m) => filter === "all" || m.status === filter);
  const areasOf = (m: Message) => [...new Set(project.facts.filter((f) => f.msgId === m.id && f.kind !== "note").map((f) => f.area))];

  return (
    <div className="tab-content">
      <div className="section-heading-row messages-heading">
        <div>
          <div className="section-kicker">Incoming context</div>
          <h2>Message pack</h2>
          <p className="heading-description">Every message stays visible with its decision, so changes and rejections are easy to explain.</p>
        </div>
        <div className="message-count">
          <strong>{project.messages.length}</strong>
          <span>messages</span>
        </div>
      </div>
      <div className="tag-list" style={{ marginBottom: 16 }}>
        {groups.map((g) => (
          <button
            key={g}
            className="area-tag"
            style={{ border: 0, cursor: "pointer", background: filter === g ? "var(--green)" : undefined, color: filter === g ? "#fff" : undefined }}
            onClick={() => setFilter(g)}
          >
            {g === "all" ? "All" : STATUS_LABEL[g]} ({g === "all" ? project.messages.length : project.messages.filter((m) => m.status === g).length})
          </button>
        ))}
      </div>
      {!project.messages.length && <p className="muted-label">No messages yet. Load the message pack to start.</p>}
      <div className="message-list">
        {list.map((m) => (
          <button className="message-card panel" key={m.id} onClick={() => setSelected(m)} style={m.status === "rejected" || m.status === "partial" ? { borderColor: "#f3c9c3" } : undefined}>
            <div className="message-card-top">
              <span className="sender-avatar">{m.from.slice(0, 1).toUpperCase()}</span>
              <div className="sender-copy">
                <strong>{m.from}</strong>
                <span>
                  {m.id} · {m.date ?? "no date"} · {m.relevance} · {m.source.name}
                </span>
              </div>
              <Pill status={m.status} />
              <Icon name="arrow" size={17} />
            </div>
            <p>{m.text.length > 280 ? `${m.text.slice(0, 280)}…` : m.text}</p>
            {m.reasons.length > 0 && (
              <p style={{ margin: "-6px 0 12px", color: m.status === "rejected" || m.status === "partial" ? "var(--red)" : "var(--muted)", fontSize: 11 }}>{m.reasons[0]}</p>
            )}
            <div className="message-card-bottom">
              <span>
                <Icon name="mail" size={14} /> {areasOf(m).join(" · ") || "no plan areas"}
              </span>
              <span className="read-more">
                View details <Icon name="arrow" size={14} />
              </span>
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <div className="overlay drawer-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setSelected(null)}>
          <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="message-detail-title">
            <div className="drawer-header">
              <div>
                <div className="section-kicker">Message {selected.id}</div>
                <h2 id="message-detail-title">{selected.from}</h2>
              </div>
              <button className="icon-button" onClick={() => setSelected(null)} aria-label="Close">
                <Icon name="close" />
              </button>
            </div>
            <div className="drawer-meta">
              <span>{selected.date ?? "no date"}</span>
              <span>{selected.relevance}</span>
              <Pill status={selected.status} />
            </div>
            <div className="drawer-message" style={{ whiteSpace: "pre-wrap" }}>
              {selected.text}
            </div>
            <div className="drawer-section">
              <span className="detail-label">Source</span>
              <p className="muted-label">
                {selected.source.name} ({selected.source.detectedType}) · lines {selected.source.lines[0]}–{selected.source.lines[1]} · run {selected.runId}
              </p>
            </div>
            <div className="drawer-section">
              <span className="detail-label">Related plan areas</span>
              <div className="tag-list">
                {areasOf(selected).map((a) => (
                  <span key={a} className="area-tag">
                    {a}
                  </span>
                ))}
                {!areasOf(selected).length && <span className="muted-label">none</span>}
              </div>
            </div>
            <div className="drawer-section">
              <span className="detail-label">Facts taken from this message</span>
              <div style={{ display: "grid", gap: 6 }}>
                {project.facts
                  .filter((f) => f.msgId === selected.id)
                  .map((f) => (
                    <div key={f.id} style={{ fontSize: 12, padding: "8px 10px", borderRadius: 10, background: f.status === "active" ? "#eef8df" : f.status === "rejected" ? "var(--red-bg)" : "var(--amber-bg)" }}>
                      <b>{humanizeFact(f)}</b> <span className="font-mono" style={{ color: "var(--muted)", fontSize: 10 }}>{f.id}</span> ·{" "}
                      <b style={{ color: f.status === "active" ? "var(--green-dark)" : f.status === "rejected" ? "var(--red)" : "var(--amber)" }}>
                        {f.status === "active" ? "used in plan" : f.status === "superseded" ? "out of date" : "rejected"}
                      </b>
                      {f.reason && <div style={{ color: "var(--muted)", marginTop: 3 }}>{f.reason}</div>}
                    </div>
                  ))}
                {!project.facts.some((f) => f.msgId === selected.id) && <span className="muted-label">No facts (irrelevant or information only).</span>}
              </div>
            </div>
            <div className="drawer-section reason-section">
              <span className="detail-label">Decision note</span>
              {selected.reasons.length ? (
                selected.reasons.map((r, i) => <p key={i} style={{ marginBottom: 6 }}>{r}</p>)
              ) : (
                <p>Accepted: all its facts are used in the current plan.</p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
