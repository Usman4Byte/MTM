"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { StatusPill } from "@/components/dashboard/StatusPill";
import type { TraceEntry } from "@/types/dashboard";

export function TraceTab({ entries }: { entries: TraceEntry[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  return (
    <div className="tab-content">
      <div className="section-heading-row trace-heading"><div><div className="section-kicker">Model activity</div><h2>Run trace</h2><p className="heading-description">A compact record of the decisions behind the current plan.</p></div><div className="trace-count"><span>4</span> model calls</div></div>
      <div className="trace-list">
        {entries.map((entry) => {
          const isOpen = expanded[entry.id];
          return <article className="trace-card panel" key={entry.id}>
            <div className="trace-card-header">
              <div className="call-number">{String(entry.callNumber).padStart(2, "0")}</div>
              <div className="trace-title"><div><strong>{entry.model}</strong><span className="trace-area">{entry.area}</span></div><span className="trace-call-label">Model call {entry.callNumber}</span></div>
              <button className="text-button" onClick={() => setExpanded((current) => ({ ...current, [entry.id]: !isOpen }))} aria-expanded={isOpen}>{isOpen ? "Collapse" : "Expand"}<span className={isOpen ? "rotate-arrow" : ""}><Icon name="arrow" size={15} /></span></button>
            </div>
            <div className="trace-tokens"><span>Input <strong>{entry.inputTokens}</strong> tokens</span><span>Output <strong>{entry.outputTokens}</strong> tokens</span>{entry.reason && <StatusPill status="rejected" />}</div>
            {isOpen && <div className="trace-detail"><div><span className="detail-label">Input</span><p>{entry.input}</p></div><div><span className="detail-label">Output</span><p>{entry.output}</p></div>{entry.reason && <div className="trace-reason"><span className="detail-label">Decision note</span><p>{entry.reason}</p></div>}</div>}
          </article>;
        })}
      </div>
    </div>
  );
}
