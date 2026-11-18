"use client";

import { useState } from "react";
import { AddMessageModal } from "@/components/messages/AddMessageModal";
import { MessageDetailDrawer } from "@/components/messages/MessageDetailDrawer";
import { MessagesTab } from "@/components/messages/MessagesTab";
import { PlanTab } from "@/components/plan/PlanTab";
import { TraceTab } from "@/components/trace/TraceTab";
import { Icon } from "@/components/ui/Icon";
import { mockMessages, mockPlan, mockTrace } from "@/data/mockData";
import type { MessageRecord, PlanStatus, RunState } from "@/types/dashboard";

type Tab = "plan" | "trace" | "messages";

const tabs: { id: Tab; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "trace", label: "Trace" },
  { id: "messages", label: "Messages" },
];

export function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("plan");
  const [messages, setMessages] = useState(mockMessages);
  const [selectedMessage, setSelectedMessage] = useState<MessageRecord | null>(null);
  const [showAddMessage, setShowAddMessage] = useState(false);
  const [runState, setRunState] = useState<RunState>("completed");
  const [planStatus, setPlanStatus] = useState<PlanStatus>(mockPlan.status);
  const [notice, setNotice] = useState<string | null>(null);

  const runAnalysis = () => {
    setRunState("running");
    setNotice("Running the mock analysis flow…");
    window.setTimeout(() => {
      setRunState("completed");
      setPlanStatus("valid");
      setNotice("Mock run complete. No backend or model call was made.");
    }, 1200);
  };

  const addMessage = (text: string) => {
    const newMessage: MessageRecord = {
      id: `message-${Date.now()}`,
      sender: "Manual entry",
      date: "Just now",
      channel: "Manual entry",
      text,
      status: "pending review",
      relatedAreas: [],
      rationale: "This message was added locally and is waiting for a future analysis run.",
    };
    setMessages((current) => [newMessage, ...current]);
    setPlanStatus("needs-review");
    setShowAddMessage(false);
    setActiveTab("messages");
    setNotice("Message added to the local mock inbox.");
  };

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand-lockup"><div className="brand-mark"><Icon name="spark" size={19} /></div><div><strong>Mind to Machine</strong><span>Hackathon planner</span></div></div>
      <div className="topbar-actions"><div className="run-status"><span className={`live-dot ${runState === "running" ? "is-running" : ""}`} />{runState === "running" ? "Running mock analysis" : "Ready to review"}</div><button className="button button-secondary" onClick={() => setShowAddMessage(true)}><Icon name="plus" size={16} /> <span>Add message</span></button><button className="button button-secondary export-button" onClick={() => setNotice("Export is a placeholder for this UI-only stage.")}><Icon name="download" size={16} /> <span>Export</span></button><button className="button button-primary" onClick={runAnalysis} disabled={runState === "running"}><Icon name="play" size={15} /> {runState === "running" ? "Running…" : "Run analysis"}</button></div>
    </header>
    <div className="page-container">
      <section className="welcome-row"><div><div className="section-kicker"><span className="kicker-dot" /> Operations view</div><h1>Hackathon planning workspace</h1><p>One clear view of the plan, decisions, and incoming context.</p></div><div className="overall-status"><span className="status-label">Overall plan</span><div><StatusDot status={planStatus} /><strong>{planStatus === "valid" ? "Valid" : planStatus === "needs-review" ? "Needs review" : planStatus === "error" ? "Error" : "Not run"}</strong></div></div></section>
      <nav className="tab-nav" aria-label="Dashboard sections">{tabs.map((tab) => <button className={activeTab === tab.id ? "active" : ""} key={tab.id} onClick={() => setActiveTab(tab.id)}>{tab.label}{tab.id === "messages" && <span className="tab-count">{messages.length}</span>}</button>)}</nav>
      {activeTab === "plan" && <PlanTab plan={{ ...mockPlan, status: planStatus }} />}
      {activeTab === "trace" && <TraceTab entries={mockTrace} />}
      {activeTab === "messages" && <MessagesTab messages={messages} onSelect={setSelectedMessage} />}
    </div>
    {notice && <button className="toast" onClick={() => setNotice(null)}><span className="toast-check"><Icon name="check" size={14} /></span>{notice}<Icon name="close" size={14} /></button>}
    {showAddMessage && <AddMessageModal onClose={() => setShowAddMessage(false)} onSubmit={addMessage} />}
    {selectedMessage && <MessageDetailDrawer message={selectedMessage} onClose={() => setSelectedMessage(null)} />}
  </main>;
}

function StatusDot({ status }: { status: PlanStatus }) {
  return <span className={`plan-dot dot-${status}`} />;
}
