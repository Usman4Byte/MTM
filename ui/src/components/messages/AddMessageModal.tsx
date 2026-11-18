"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";

interface AddMessageModalProps {
  onClose: () => void;
  onSubmit: (text: string) => void;
}

export function AddMessageModal({ onClose, onSubmit }: AddMessageModalProps) {
  const [text, setText] = useState("");
  const submit = () => { if (text.trim()) onSubmit(text.trim()); };
  return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal panel" role="dialog" aria-modal="true" aria-labelledby="add-message-title">
      <div className="modal-header"><div><div className="section-kicker">Manual entry</div><h2 id="add-message-title">Add a message</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div>
      <p className="modal-description">Add a new message to the local mock inbox. It will remain pending review until a later analysis run.</p>
      <label className="form-label" htmlFor="message-text">Message text</label>
      <textarea id="message-text" className="message-input" value={text} onChange={(event) => setText(event.target.value)} placeholder="Paste or type an incoming message…" autoFocus />
      <div className="modal-actions"><button className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" onClick={submit} disabled={!text.trim()}><Icon name="plus" size={16} /> Add message</button></div>
    </section>
  </div>;
}
