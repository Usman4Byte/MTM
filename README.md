# MTM — Mind to Machine Hackathon Planner

Reads a pack of English and Roman Urdu messages (emails, WhatsApp texts, notices) and keeps **one valid plan** for the hackathon covering **venue, schedule, food, judging and budget**. New messages update the plan. Wrong ones are rejected with a reason. Every model call is traced.

Problem statement: [`Problem Statement/`](Problem%20Statement/) · Test record: [TESTING.md](TESTING.md)

---

## Quick start

```bash
npm install
cp .env.example .env.local      # add your GEMINI_API_KEY
npm run dev                     # http://localhost:3000
```

**Judging-day command** (same command for the pack and every update):

```bash
npm run plan:reset                       # fresh start
npm run plan -- path/to/unseen-pack.txt  # full run
npm run plan -- path/to/update-1.txt     # update (same command)
```

Output goes to `runs/plan.md`, `runs/plan.json`, `runs/trace.txt` and `runs/trace.json`. Upload `plan.md` and `trace.txt` on the form.

---

## Features

### Input
- **Any format, one pipeline:** TXT, CSV, MD, JSON, PDF, DOCX, XLSX or pasted text. The type is detected from the file's bytes, not its name.
- **Smart cleanup:** text copied from PDF or Word tables (broken lines, page markers like "Page 3 of 4", repeated headers) is rebuilt into one message per row. It finds the column names first, then the rows. Layout only; words are never changed.
- **Nothing skipped silently:** scanned PDFs and images are reported as *needs OCR*, old `.doc`/`.xls` as *unsupported*, and text that fits no row is kept.
- **Manual entries:** text typed with no sender counts as an organiser instruction.
- **Content is data:** messages can never override system rules (an injection-style "SYSTEM OVERRIDE" message was tested and ignored).

### Planning (all in code, no model)
- **Venue:** the cheapest hall that seats everyone and meets every requirement (e.g. a generator or projector).
- **Food:** the best meal option within budget, for everyone on site; vegetarian/special meals and fees included.
- **Judging:** judges needed = teams ÷ max teams per judge, rounded up. Teams are assigned to judges, spares are kept as reserves.
- **Schedule:** opening, build, lunch, breaks, judging and closing fill the exact event length. Fixed-time sessions are respected.
- **Realistic prayer:** a prayer break goes at the mosque congregation time (Zuhr ≈ 13:15–13:45, Jumu'ah on Fridays, Asr calculated for the date and place), with lunch next to it.
- **Budget:** every cost line (venue, meals, honoraria, already-spent items, required fees) with its working. Unapproved requests (e.g. a DJ) are listed but not added.

### Keeping the plan correct
- **The six checks:** correct figures, within budget, venue fits, schedule valid, enough judges, all five areas covered.
- **Outdated info:** a newer message about the same item replaces the old one (Rs 1,000 → Rs 1,200). The old fact is kept and marked *out of date*.
- **Wrong messages are rejected with a reason:** no authority (a caterer cutting meals, a student raising the budget), or breaking a check (100 boxes for 177 people). The previous valid plan is kept.
- **Infeasible changes:** e.g. a budget cut below the cheapest possible plan. Rejected, with the exact shortfall explained.
- **Model misreads caught:** every money figure must appear in its source message, so "Rs 800" read as 80,000 is rejected. The model also reads each message on its own and never merges messages that disagree.
- **Source on every number:** each fact links to the message it came from.

### Model use (lean and predictable)
- **One `reading` call per submit.** It reads only the new content.
- **Area calls** happen only for a constraint no standard fact can express (e.g. "lunch in 3 sittings").
- **Limits:** an update makes at most 5 calls (retries included) within 60 s; a full run must finish within 120 s.
- **Fallbacks:** each model is tried on every API key before the next model (3.5 Flash Lite → 3.1 Flash Lite → Gemma).
- **Traced:** each call is numbered with the model name, area tag, input, output and API-reported tokens, plus totals.

### Interface
- **Plan tab:** status, six checks, five area cards, timeline, budget table, judge assignments. **Click any area card for a full breakdown** (decision, working, every option considered, sources).
- **Latest run panel (right):** plain verdict ("Plan stayed on v2 — message rejected because…"), what changed, calls made, and a **prediction check** (✓ match / ✗ mismatch).
- **Trace:** every call with expandable input/output and token counts.
- **Messages:** filter by status; click for full text, facts and reason.
- **Run history:** every run's verdict and changes.
- **Export:** plan (.md/.json), trace (.txt/.json), whole project.
- **Setup & rules:** routing rules, model and key status, projects (new / import / export / delete), and **Reset system** to wipe all browser data.
- **Saved in your browser** (local storage); the server stores nothing.

---

## Predicting model calls (for the slip)

| Message type | Calls |
|---|---|
| Price, count, budget, hall, break, judge, correction, wrong or irrelevant message | **reading only** |
| An unusual rule no standard fact can express | reading + that area (e.g. *food*) |

## How it works

```
input → cleanup (code) → reading call (model) → facts + sources (code)
      → planner (code) → six checks (code) → reject what breaks them (code) → plan + trace
```

| Part | Why it exists |
|---|---|
| Ingestion + cleanup | Turns every format into the same clean text |
| Reading call | The only step that needs language understanding |
| Typed facts | The model can only say things code can check |
| Supersession | Newer information wins, by date |
| Planner | All maths in code: cheaper and exact |
| Validator | Proves the plan is valid |
| Conflict resolver | Keeps the plan valid when a message is wrong |
| Number check | Catches model misreads |
| Trace | Shows every call and decision |

---

## Configuration (`.env.local`)

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY`, `GEMINI_API_KEY_2` | API keys (server only, never committed) |
| `GEMINI_MODEL`, `GEMINI_MODELS` | Primary model and fallback chain |
| `MTM_JUDGE_POLICY` | `minimum` (default) or `all_confirmed` |
| `MTM_DEFAULT_START` | Start time when no message gives one (default 10:00) |
| `MTM_ZUHR_JAMAAT`, `MTM_EVENT_DATE`, `MTM_LAT`/`MTM_LON` | Prayer timing |

**Small-model bonus:** set `GEMINI_MODELS` to models on the organisers' approved list only. Don't assume any model qualifies.

## Assumptions

- **Judges vs meals:** 20 judges are confirmed, but 50 teams ÷ 3 per judge = 17 needed. The plan pays and feeds 17 and keeps 3 as unpaid reserves, giving **177 people** as the brief states. Set `MTM_JUDGE_POLICY=all_confirmed` for 180.
- **Schedule defaults** when messages are silent: opening 10 min, lunch 30 min, closing 15 min, at least 60 min of build time.

## Testing & deployment

```bash
npm test            # 32 offline tests: formats, cleanup, number check, planner rules
npm run build       # production build
```

**Vercel:** import the repo, add the environment variables, deploy. No database is needed.
