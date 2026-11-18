// Shared types for the whole pipeline (server, CLI and browser all use these).

export const AREAS = ["venue", "schedule", "food", "judging", "budget"] as const;
export type Area = (typeof AREAS)[number];
/** The six tags allowed on a model call, exactly as the brief lists them. */
export const CALL_TAGS = ["reading", ...AREAS] as const;
export type CallTag = (typeof CALL_TAGS)[number];

/** Every fact the planner understands. The model may only emit these kinds. */
export const FACT_KINDS = {
  // event basics
  students: { area: "venue", doc: "number of students (num)" },
  team_size: { area: "judging", doc: "students per team (num)" },
  teams: { area: "judging", doc: "number of teams if stated (num)" },
  staff: { area: "food", doc: "staff on duty who must be seated and fed (num)" },
  extra_people: { area: "food", doc: "other people to seat and feed, e.g. volunteers/guests (label, num)" },
  duration_min: { area: "schedule", doc: "event length in minutes (num)" },
  start_time: { area: "schedule", doc: "event start, 24h HH:MM (text)" },
  end_by: { area: "schedule", doc: "event must end by, 24h HH:MM (text)" },
  // budget
  budget_total: { area: "budget", doc: "total budget cap in Rs (num)" },
  committed: { area: "budget", doc: "money already spent/ordered from the budget (label, num)" },
  cost: { area: "budget", doc: "a required cost that must be paid from the budget (label, num)" },
  request: { area: "budget", doc: "optional ask that nobody with authority approved (label, num)" },
  // venue
  venue_option: { area: "venue", doc: "a bookable space (label=name, num=seats, price=Rs, features)" },
  venue_require: { area: "venue", doc: "an organiser DEMANDS the venue have this feature (text). A hall merely having a feature goes in venue_option features" },
  venue_exclude: { area: "venue", doc: "this venue cannot be used (label=name, text=why)" },
  venue_min_capacity: { area: "venue", doc: "venue must seat at least this many (num)" },
  // food
  food_option: { area: "food", doc: "a meal option (label=name, price=Rs per head)" },
  food_fee: { area: "food", doc: "extra catering charge such as delivery (label, num=Rs)" },
  food_order_qty: { area: "food", doc: "a stated number of meals/boxes ordered (num)" },
  food_special: { area: "food", doc: "special meals inside the headcount, e.g. vegetarian (label, num=count, price optional)" },
  food_use: { area: "food", doc: "an instruction to serve a specific option (label=option name)" },
  // judging
  judges_confirmed: { area: "judging", doc: "judges available/confirmed (num)" },
  honorarium: { area: "judging", doc: "payment per judge in Rs (num)" },
  minutes_per_team: { area: "judging", doc: "judging minutes needed per team (num)" },
  max_teams_per_judge: { area: "judging", doc: "most teams one judge may cover (num)" },
  judges_min: { area: "judging", doc: "at least this many judges must be used (num)" },
  judge_late_min: { area: "schedule", doc: "judges may arrive this many minutes late (num)" },
  // schedule
  break: { area: "schedule", doc: "a required break (label, num=minutes, text=fixed HH:MM if stated)" },
  block: { area: "schedule", doc: "another required session (label, num=minutes, text=fixed HH:MM if stated)" },
  lunch_min: { area: "schedule", doc: "total minutes the meal service needs, e.g. 3 sittings x 20 min = 60 (num)" },
  // anything with no plan effect
  note: { area: "schedule", doc: "information with no effect on the plan (text)" },
} as const satisfies Record<string, { area: Area; doc: string }>;
export type FactKind = keyof typeof FACT_KINDS;

export type FactStatus = "active" | "superseded" | "rejected";

export interface Fact {
  id: string; // F1, F2, ...
  msgId: string; // source message
  kind: FactKind;
  area: Area;
  /** identity used for supersession: same key = same thing, newest wins */
  key: string;
  label?: string;
  num?: number;
  price?: number;
  features?: string[];
  text?: string;
  status: FactStatus;
  reason?: string; // why superseded / rejected
  supersededBy?: string;
  /** which model call (tag) produced this fact */
  origin: CallTag;
  runId: number;
}

export type MessageStatus = "accepted" | "superseded" | "rejected" | "partial" | "irrelevant" | "pending";

export interface SourceInfo {
  /** original file name, or "pasted text" */
  name: string;
  detectedType: string; // txt, csv, md, json, pdf, docx, xlsx
  sizeBytes: number;
  /** line range inside the normalized document */
  lines: [number, number];
}

export interface Message {
  id: string; // M1, M2, ...
  runId: number;
  seq: number; // arrival order across the project
  from: string;
  date: string | null; // ISO date if written in the message
  relevance: "relevant" | "irrelevant" | "request" | "info";
  text: string; // original content, exactly as given
  source: SourceInfo;
  status: MessageStatus;
  reasons: string[];
}

export interface ModelCall {
  n: number; // numbered across the whole project
  runId: number;
  model: string; // model name reported by the API (falls back to requested name)
  requestedModel: string;
  area: CallTag;
  attempt: number;
  input: string;
  output: string;
  usage: {
    promptTokens: number | null;
    outputTokens: number | null;
    thoughtsTokens: number | null;
    totalTokens: number | null;
  };
  ms: number;
  ok: boolean;
  error?: string;
}

export interface TraceEvent {
  kind: "info" | "accept" | "supersede" | "reject" | "conflict" | "route" | "file" | "error";
  text: string;
  msgId?: string;
  factId?: string;
}

export interface CheckResult {
  id: "figures" | "budget" | "venue" | "schedule" | "judges" | "coverage";
  name: string;
  pass: boolean;
  details: string[];
}

export interface BudgetLine {
  area: Area;
  label: string;
  amount: number;
  formula: string;
  factIds: string[];
}

export interface ScheduleItem {
  start: string; // HH:MM
  end: string;
  minutes: number;
  label: string;
  kind: "opening" | "build" | "meal" | "break" | "block" | "judging" | "closing";
  factIds: string[];
}

export interface Plan {
  version: number;
  runId: number;
  createdAt: string;
  feasible: boolean;
  headcount: {
    students: number | null;
    judges: number | null;
    staff: number | null;
    extra: { label: string; num: number }[];
    total: number | null;
  };
  venue: {
    chosen: { label: string; capacity: number; price: number; features: string[]; factId: string } | null;
    rejectedOptions: { label: string; why: string }[];
    requirements: string[];
  };
  food: {
    option: { label: string; price: number; factId: string } | null;
    meals: number | null;
    ordered: number | null;
    specials: { label: string; count: number; price: number }[];
    fees: { label: string; amount: number }[];
    cost: number | null;
    alternatives: string[];
  };
  judging: {
    teams: number | null;
    confirmed: number | null;
    required: number | null;
    used: number | null;
    reserves: number | null;
    minutesPerTeam: number | null;
    maxTeamsPerJudge: number | null;
    honorarium: number | null;
    assignments: { judge: string; teams: number[] }[];
    blockMinutes: number | null;
  };
  schedule: { start: string | null; end: string | null; durationMin: number | null; items: ScheduleItem[]; notes: string[] };
  budget: {
    cap: number | null;
    lines: BudgetLine[];
    total: number;
    remaining: number | null;
    requests: { label: string; amount: number; wouldFit: boolean; factId: string }[];
  };
  assumptions: string[];
  conflicts: string[];
  checks: CheckResult[];
  valid: boolean;
}

export interface PlanChange {
  area: Area | "plan";
  field: string;
  from: string;
  to: string;
}

export interface Run {
  id: number;
  mode: "full" | "update";
  startedAt: string;
  ms: number;
  calls: ModelCall[];
  events: TraceEvent[];
  planVersion: number | null; // plan version in effect after this run
  planChanged: boolean;
  changes: PlanChange[];
  areasCalled: CallTag[];
  totals: { promptTokens: number; outputTokens: number; thoughtsTokens: number; totalTokens: number };
  limits: { maxCalls: number | null; maxMs: number };
  aborted?: string;
  /** areas the team predicted would make model calls (written before submitting) */
  prediction?: CallTag[];
  inputs?: string[];
}

export interface ProjectState {
  id: string;
  name: string;
  createdAt: string;
  messages: Message[];
  facts: Fact[];
  plans: Plan[];
  runs: Run[];
  counters: { msg: number; fact: number; call: number; run: number };
}

/** A normalized input document: every file type becomes this before reading. */
export interface NormalizedDoc {
  name: string;
  detectedType: string;
  sizeBytes: number;
  text: string;
  /** set when the layout was cleaned (broken table lines, invisible characters); words are never changed */
  cleanNote?: string;
}

export interface IngestIssue {
  name: string;
  detectedType: string;
  problem: "unsupported" | "unreadable" | "needs_ocr" | "empty" | "too_large";
  detail: string;
}
