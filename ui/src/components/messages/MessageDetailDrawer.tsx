import { Icon } from "@/components/ui/Icon";
import { StatusPill } from "@/components/dashboard/StatusPill";
import type { MessageRecord } from "@/types/dashboard";

export function MessageDetailDrawer({ message, onClose }: { message: MessageRecord; onClose: () => void }) {
  return <div className="overlay drawer-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="message-detail-title">
      <div className="drawer-header"><div><div className="section-kicker">Message detail</div><h2 id="message-detail-title">{message.sender}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div>
      <div className="drawer-meta"><span>{message.channel}</span><span>{message.date}</span><StatusPill status={message.status} /></div>
      <div className="drawer-message">{message.text}</div>
      <div className="drawer-section"><span className="detail-label">Related plan areas</span><div className="tag-list">{message.relatedAreas.map((area) => <span key={area} className="area-tag">{area}</span>)}</div></div>
      <div className="drawer-section reason-section"><span className="detail-label">Decision note</span><p>{message.rationale}</p></div>
    </aside>
  </div>;
}
