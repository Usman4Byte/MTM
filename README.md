# MTM Hackathon Planner

Reads a pack of English and Roman Urdu messages (emails, WhatsApp texts, notices), extracts the facts, and keeps **one valid plan** for a 4-hour hackathon covering **venue, schedule, food, judging and budget**. New messages update the existing plan. Wrong or conflicting messages are rejected with a reason. Every model call is printed with its model name, area tag, input, output and API-reported tokens.

- **Web app**: Next.js App Router + TypeScript. Server-side API routes call Gemini with a server-only key. Projects are stored in the **browser's local storage**.
- **CLI**: `npm run plan -- <file>` runs the same pipeline from the terminal (state in `.mtm/state.json`).

The problem statement is in [`Problem Statement/`](Problem%20Statement/).

---

## Quick start (local)

```bash
npm install
cp .env.example .env.local     # then put your key in GEMINI_API_KEY
npm run dev                    # http://localhost:3000
```

### The one command (judging day)

```bash
npm run plan -- path/to/unseen-pack.txt      # first call on an empty state = full run
npm run plan -- path/to/update-1.txt         # every later call = update (same command)
npm run plan -- path/to/update-2.txt
npm run plan -- path/to/update-3.txt
```

- The command takes any supported file (TXT, CSV, MD, JSON, PDF, DOCX, XLSX) or a folder of them. The type is detected from the file's bytes. You can also pipe text: `echo "message" | npm run plan`.
- There are no per-message flags or hints. Whether a run is full or an update depends only on whether a plan already exists.
- `npm run plan:reset` clears the state before a new pack.
- Each run prints the full trace and the plan, and writes `runs/plan.md`, `runs/plan.json`, `runs/trace.txt` (all runs, with the grand total) and `runs/trace.json`. Upload `plan.md` and `trace.txt` on the form.

In the web app, the first submit on an empty project is a full run and later submits are updates. Use **Plan .md / Trace .txt** to download them.

## Gemini configuration

| Variable | Meaning |
|---|---|
| `GEMINI_API_KEY` | Required. Server-side only (never `NEXT_PUBLIC_`). |
| `GEMINI_MODEL` | Primary model. Default `gemini-3.5-flash-lite`. |
| `GEMINI_MODELS` | Fallback chain, comma-separated. Default `gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemma-4-26b-a4b-it`. An overload, rate limit or timeout moves to the next model. Every attempt counts toward the 5-call limit and is traced with the model that answered. |
| `GEMINI_THINKING_BUDGET` | Defaults to `0` on 2.5-flash models (no hidden thinking tokens). |
| `MTM_JUDGE_POLICY` | `minimum` (default) or `all_confirmed`. See *Judges vs meals*. |
| `MTM_DEFAULT_START` | Start time used only when no message gives one (default `10:00`). |

**Why these models** (benchmarked on the sample pack, same prompt, 2 runs each, 18 Nov 2026):

| Model | Free limits (RPM / RPD) | Full run | Tokens | Checks |
|---|---|---|---|---|
| gemini-3.5-flash-lite | 15 / 500 | 3.3–5.2 s | 2,510–3,249 | 6/6 |
| gemini-3.1-flash-lite | 15 / 500 | 7.2–10.2 s | 3,142 | 6/6 |
| gemma-4-26b-a4b-it | 30 / 14,400 | returned 503 (overloaded) during testing | — | — |

Flash and Pro models are limited to 20 requests per day on this key, which is too few for testing plus judging. `gemini-2.5-flash-lite` is retired for new keys. Gemma has the highest daily limit, so it is the last fallback. Its 16K tokens/minute cap still fits one run of about 3K tokens.

**No embedding model.** Files are converted to text with deterministic parsers (PDF text layer, DOCX, XLSX, CSV, JSON). Embeddings turn text into vectors for *search*. They don't read files, and a pack of about 10 messages has nothing to search. Adding them would add model calls and tokens (hurting the token score) and add a part we could not justify to the judges.

**Bonus (small-model list):** the 10-point bonus needs *every* call to use a model on the organizers' small-model list. **We do not assume any Gemini model qualifies.** Get the approved list from the help desk and set `GEMINI_MODEL` to a model on it. The trace prints the model name the API reports for each call (`modelVersion`), so you can check it.

## Storage

The user asked that the app keep its data in **browser local storage**:

- The browser holds every project (messages, facts, plan versions, traces) in `localStorage` (key `mtm-planner:v1`).
- `POST /api/run` is **stateless**. The browser sends the project state plus the new files or text. The server parses them, calls Gemini and returns the new state. Nothing is written to the serverless filesystem, so this works on Vercel as is.
- **Export / Import project** (JSON) moves a project between browsers or backs it up. The CLI's `.mtm/state.json` can be imported too.
- Limits: local storage is about 5 MB per site, and clearing site data deletes projects. If a save fails, the UI shows a warning. Export to keep a copy.

## Testing

```bash
npm test          # 20 offline tests: every file format + planner/validator rules (no API key needed)
npm run typecheck
npm run build
```

`samples/` holds the sample pack (`sample-pack.txt`), the practice updates and our own unseen-style tests (`unseen/pack-b.csv`, `updates/*`). It also holds every format generated from the pack (`formats/`, rebuilt by `npx tsx scripts/make-format-fixtures.ts`). See [TESTING.md](TESTING.md) for what was run and the results.

## Deploy to Vercel

1. Import the GitHub repo in Vercel (framework: Next.js, detected automatically).
2. Settings → Environment Variables: add `GEMINI_API_KEY` and `GEMINI_MODEL` (Production + Preview).
3. Deploy. `vercel.json` gives `/api/run` up to 120 s (a full run must finish in 2 min; updates stop themselves at 60 s).
4. Request bodies are capped at 4.5 MB on Vercel, so larger files must go through the CLI.

No database is needed (see Storage).

## How it works (for every team member)

```
files / pasted text
   │  ingest (code): detect type from bytes → parse → one numbered text
   ▼
reading call (model, tag "reading")  — always exactly 1 per submit
   │  splits messages by line range, extracts typed facts, flags authority problems
   ▼
router (code): constraints no fact kind can express → 1 area call per affected area
   ▼
facts store (code): source message on every fact; same item + newer date ⇒ older one superseded
   ▼
planner (code): headcount, judges, venue, meals, schedule, budget — all arithmetic
   ▼
validator (code): the six checks
   ▼
conflict resolver (code): if a new fact breaks a check, reject it, keep the valid plan, log why
```

| Part | What it does | What breaks without it |
|---|---|---|
| **Ingestion** (`src/lib/ingest`) | Detects the file type from its bytes and turns every format into the same numbered text. Reports scanned, unsupported or unreadable files. | Each format would need its own logic, and bad files would be skipped silently. |
| **Reading call** (`src/lib/agent/prompts.ts`) | The only place language is understood: splitting messages, Roman Urdu, "already ordered" vs "can we get", who has authority. | Facts would have to be typed in by hand, which the rules forbid. |
| **Typed fact kinds** (`src/lib/types.ts`) | A fixed list of what the model may say ("food_option", "committed", …). Every fact links to its source message. | The model's free text could not be checked, and we could not show where a number came from. |
| **Supersession** (`src/lib/facts.ts`) | Same item from a newer message wins (Rs 1,000 → Rs 1,200). The old fact is kept as *superseded*. | Outdated prices would be used. |
| **Planner** (`src/lib/planner/index.ts`) | All maths: teams, judges needed, headcount, cheapest hall that fits, best meal within budget, timeline. | The model would do arithmetic: more tokens and more mistakes. |
| **Validator** (`src/lib/planner/validate.ts`) | Recomputes the six checks from scratch. | We could not prove the plan is valid or catch a bad message. |
| **Conflict resolver** (`src/lib/agent/pipeline.ts`) | If a new fact makes a check fail, rejects that fact, rebuilds and records the reason. | A wrong message (e.g. 100 boxes for 177 people) would end up in the plan. |
| **Area calls** | Only for constraints none of the fact kinds can express. They turn the constraint into standard facts using that area's context. | Unseen kinds of constraint would be ignored. |
| **Trace** (`src/lib/report.ts`, Gemini client) | Numbered calls, real model name, area tag, input/output, API tokens, totals, decisions. | It is a disqualification risk, and we could not explain any decision. |
| **Call budget** (`CallBudget`) | Caps an update at 5 calls (retries included) and 60 s. | We could break the update limits. |

## Update routing rules (write the prediction slip from these)

1. **Every** submit makes exactly **1 `reading`** call.
2. Changes to prices, counts, budget, halls, breaks, judges, corrections, irrelevant chatter and wrong messages are handled **in code**: **no other call**.
3. An **area call** (`venue` / `schedule` / `food` / `judging` / `budget`) happens **only** when a message has a constraint that the standard fact kinds cannot express. One call per such area (e.g. "lunch in 3 sittings of 20 min" → `schedule`).
4. A failed call is retried once if the limit allows. Retries count toward the 5. If the limit or time runs out, the plan stays as it was and the trace says why.

So for a typical update the prediction is **"reading only"**. The web app has a prediction box that is checked against the areas that actually made calls.

How to tell which facts are standard: see `FACT_KINDS` in `src/lib/types.ts`. If a message's constraint fits one of those lines, the model emits it during reading and no area call happens.

## Judges vs meals (the 20 vs 177 ambiguity)

The sample says **20 judges confirmed** and the practice message says the event has **177 people to feed**. 150 students + 20 judges + 10 staff = **180**, not 177. 177 works out only if **17 judges** are counted: 50 teams ÷ 3 teams per judge = 16.7, rounded up to 17.

**Our assumption (default `MTM_JUDGE_POLICY=minimum`):** the plan engages the minimum number of judges the coverage rule needs (17). They are paid and fed. The other confirmed judges (3) are listed as **unpaid reserves**, which also covers the judge who may be late. This reproduces the brief's 177. Set `MTM_JUDGE_POLICY=all_confirmed` to pay and feed every confirmed judge (180 people). The plan always prints this assumption.

## Other planning decisions (policy, not facts)

- **Venue:** the cheapest hall that seats everyone and meets every stated requirement.
- **Food:** the most expensive meal option that keeps the total within budget. Falls back to cheaper options automatically, unless a message tells us which option to use.
- **Requests** nobody with authority approved (e.g. a DJ) are **not** added. They are listed with "would fit / would not fit".
- **Schedule template:** opening 10 min, lunch 30 min, closing 15 min, at least 60 min of build time. Judging runs as one parallel block at the end (teams per judge × minutes per team). Breaks with a stated time are fixed there.
- **Start time:** 10:00 unless a message states one, or a stated "end by" time works it out.

## Safety

- Uploaded content is wrapped as `<data>` and the system prompt says it is never an instruction. On top of that, code checks every fact, so an "override" message cannot make a failing plan pass.
- The API key stays on the server. `.env*` files are gitignored.

## Known limitations

See [TESTING.md](TESTING.md#limitations).
