import { Icon } from "@/components/ui/Icon";
import type { PlanData } from "@/types/dashboard";
import { StatusPill } from "@/components/dashboard/StatusPill";

interface PlanTabProps {
  plan: PlanData;
}

export function PlanTab({ plan }: PlanTabProps) {
  return (
    <div className="tab-content plan-content">
      <section className="plan-summary panel">
        <div className="summary-main">
          <div className="section-kicker"><span className="kicker-dot" /> Current plan</div>
          <div className="summary-title-row">
            <h2>Ready for review</h2>
            <StatusPill status={plan.status} />
          </div>
          <p>{plan.runSummary}</p>
        </div>
        <div className="summary-meta">
          <span>Last run</span>
          <strong>{plan.lastRun}</strong>
          <span className="summary-meta-note"><Icon name="check" size={14} /> 5 areas checked</span>
        </div>
      </section>

      {plan.warnings.length > 0 && (
        <section className="warning-panel" aria-label="Plan warnings">
          <div className="warning-icon">!</div>
          <div><strong>Review needed</strong><p>{plan.warnings.join(" ")}</p></div>
        </section>
      )}

      <div className="section-heading-row">
        <div><div className="section-kicker">Planning overview</div><h2>Five areas, one plan</h2></div>
        <span className="muted-label">Updated from latest run</span>
      </div>

      <section className="area-grid" aria-label="Planning areas">
        {plan.areas.map((area) => (
          <article className="area-card panel" key={area.key}>
            <div className="card-topline"><span className={`area-marker marker-${area.key}`} /> <span className="area-eyebrow">{area.eyebrow}</span><StatusPill status={area.status} /></div>
            <h3>{area.title}</h3>
            <p className="area-summary">{area.summary}</p>
            <div className="area-metrics">
              {area.metrics.map((metric) => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}
            </div>
            <ul className="detail-list">{area.details.map((detail) => <li key={detail}><Icon name="check" size={14} />{detail}</li>)}</ul>
          </article>
        ))}
      </section>

      <section className="timeline-section">
        <div className="section-heading-row"><div><div className="section-kicker">Event flow</div><h2>Schedule timeline</h2></div><span className="muted-label">4-hour format</span></div>
        <div className="timeline panel">
          {plan.schedule.map((item, index) => (
            <div className={`timeline-item ${item.accent ? "timeline-accent" : ""}`} key={item.time}>
              <div className="timeline-time">{item.time}</div>
              <div className="timeline-line"><span className="timeline-dot" />{index < plan.schedule.length - 1 && <span className="timeline-connector" />}</div>
              <div className="timeline-copy"><h3>{item.title}</h3><p>{item.description}</p></div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
