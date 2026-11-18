import type { AreaStatus, MessageStatus, PlanStatus } from "@/types/dashboard";

type Status = AreaStatus | MessageStatus | PlanStatus;

const labels: Record<Status, string> = {
  valid: "Valid",
  "needs-review": "Needs review",
  conflict: "Conflict",
  pending: "Pending",
  accepted: "Accepted",
  rejected: "Rejected",
  outdated: "Outdated",
  irrelevant: "Irrelevant",
  "pending review": "Pending review",
  "not-run": "Not run",
  error: "Error",
};

export function StatusPill({ status }: { status: Status }) {
  return <span className={`status-pill status-${status.replace(" ", "-")}`}>{labels[status]}</span>;
}
