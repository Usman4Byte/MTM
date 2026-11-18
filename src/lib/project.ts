// Browser-safe helpers (no server imports).
import type { ProjectState } from "./types";

export function newProject(name = "Hackathon plan"): ProjectState {
  return {
    id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    createdAt: new Date().toISOString(),
    messages: [],
    facts: [],
    plans: [],
    runs: [],
    counters: { msg: 0, fact: 0, call: 0, run: 0 },
  };
}
