import { Icon } from "@/components/ui/Icon";
import { StatusPill } from "@/components/dashboard/StatusPill";
import type { MessageRecord } from "@/types/dashboard";

interface MessagesTabProps {
  messages: MessageRecord[];
  onSelect: (message: MessageRecord) => void;
}

export function MessagesTab({ messages, onSelect }: MessagesTabProps) {
  return <div className="tab-content">
    <div className="section-heading-row messages-heading"><div><div className="section-kicker">Incoming context</div><h2>Message pack</h2><p className="heading-description">Every message is kept visible so changes and rejected facts are easy to explain.</p></div><div className="message-count"><strong>{messages.length}</strong><span>messages</span></div></div>
    <div className="message-list">
      {messages.map((message) => <button className="message-card panel" key={message.id} onClick={() => onSelect(message)}>
        <div className="message-card-top"><span className="sender-avatar">{message.sender.slice(0, 1)}</span><div className="sender-copy"><strong>{message.sender}</strong><span>{message.channel} · {message.date}</span></div><StatusPill status={message.status} /><Icon name="arrow" size={17} /></div>
        <p>{message.text}</p>
        <div className="message-card-bottom"><span><Icon name="mail" size={14} /> {message.relatedAreas.join(" · ")}</span><span className="read-more">View details <Icon name="arrow" size={14} /></span></div>
      </button>)}
    </div>
  </div>;
}
