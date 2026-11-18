export type PlanStatus = "not-run" | "valid" | "needs-review" | "error";

export type AreaStatus = "valid" | "needs-review" | "conflict" | "pending";

export type AreaKey = "venue" | "schedule" | "food" | "judging" | "budget";

export type MessageStatus =
  | "accepted"
  | "rejected"
  | "outdated"
  | "irrelevant"
  | "pending review";

export type RunState = "idle" | "running" | "completed" | "error";

export interface AreaMetric {
  label: string;
  value: string;
}

export interface AreaResult {
  key: AreaKey;
  title: string;
  eyebrow: string;
  summary: string;
  details: string[];
  metrics: AreaMetric[];
  status: AreaStatus;
}

export interface ScheduleItem {
  time: string;
  title: string;
  description: string;
  accent?: boolean;
}

export interface PlanData {
  status: PlanStatus;
  lastRun: string;
  runSummary: string;
  areas: AreaResult[];
  schedule: ScheduleItem[];
  warnings: string[];
}

export interface MessageRecord {
  id: string;
  sender: string;
  date: string;
  channel: "Email" | "WhatsApp" | "Notice" | "Manual entry";
  text: string;
  status: MessageStatus;
  relatedAreas: AreaKey[];
  rationale: string;
}

export interface TraceEntry {
  id: string;
  callNumber: number;
  model: string;
  area: AreaKey;
  input: string;
  output: string;
  inputTokens: string;
  outputTokens: string;
  reason?: string;
}
