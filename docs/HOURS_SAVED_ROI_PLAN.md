# Plan: Hours-Saved ROI Surfacing

**Status:** Not started. Design + honest accounting. Ready to pick up in a fresh context.

**Related:** `ORCHESTRATION_PLAN.md` introduces the `issue_status_history` table
used by Track 2 below. That plan builds the table; this plan reads from it.

## User's constraint

- Show **hours saved**, not dollars.
- User asked: "How we are calculating the time, is it correct?"

## Honest answer to that question

**Currently it is not measured — it is a plugin-author guess.**

`issues.estimated_minutes` is populated from `plugin.effortEstimate()`, which
reads static tables in each plugin and/or `config/effort-map.json`:

| Scanner    | Source                                | Typical values                     |
|------------|---------------------------------------|------------------------------------|
| Apiiro     | fallback map in `plugin-apiiro/src/index.js` | secret=5, sca_minor=5, sca_major=30, license=20, sast=15 |
| AQA        | `aqa_complexity` field from scanner → easy=5, medium=15, hard=30 | scanner-reported |
| SonarQube  | Parses SonarQube's own `effort` string ("30min", "2h") | scanner-reported |

So AQA and Sonar are **at least** based on the scanner's own remediation
effort estimate (which is itself a heuristic, but an industry-calibrated
one). Apiiro is purely our in-house guess.

**Implication:** any "hours saved" number we show today is a headline number,
not a measurement. That's fine for an executive slide but we shouldn't claim
it as measured savings in an engineering review.

## Two-track ROI

To make the number defensible, split the dashboard into:

### Track 1: Potential savings (headline)
Sum of `estimated_minutes` for all issues in a "fixed" state (status in
`ai_fixed`, `verified`, `merged`, `closed`), grouped by time window.

```
Potential hours saved = SUM(estimated_minutes) / 60
```

Label on dashboard: **"Potential hours saved (estimated)"** — the word
"estimated" is important; it sets expectations.

### Track 2: Measured savings (defensible)
Track actual wall-clock time humans spent reviewing/fixing, and subtract
from the estimate to get actual savings.

We already have the timestamps to do this — just aren't using them:

- `created_at` — when the issue was fetched
- `updated_at` — last transition
- `fix_attempts.attempted_at` — per-attempt timestamps
- Status transitions: `open → in_progress → ai_fixed → verified → merged`

Add two new metrics:

```
time_to_ai_fix = ai_fixed_at - in_progress_at   // "AI did the work in X"
time_to_review = verified_at   - ai_fixed_at    // "Human reviewed in Y"
time_to_merge  = merged_at     - verified_at    // "Ship time"
```

Then:

```
Net time saved per issue
  = estimated_minutes               // what a manual fix would take
  - (time_to_review + time_to_merge) // what the human actually spent
```

Human never did `time_to_ai_fix` manually — that's the AI's contribution.

## Schema change

The transitions aren't all recorded. Add a small status history table:

```sql
CREATE TABLE IF NOT EXISTS issue_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  changed_at TEXT,
  changed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_issue_status_history_issue_id
  ON issue_status_history (issue_id);
```

Then every status-change path (fix.js, approve/reject in dashboard, PR
merge watcher) writes a row. Trivial to add — maybe 15 lines total.

## New endpoint: `GET /api/roi`

Response shape:

```json
{
  "window": "30d",
  "issues_fixed": 142,
  "potential_hours_saved": 47.5,
  "measured_review_hours": 12.3,
  "net_hours_saved": 35.2,
  "breakdown_by_source": {
    "apiiro":    { "potential": 20.0, "measured_review": 5.0, "net": 15.0 },
    "aqa":       { "potential": 22.5, "measured_review": 6.3, "net": 16.2 },
    "sonarqube": { "potential":  5.0, "measured_review": 1.0, "net":  4.0 }
  },
  "note": "Potential is estimated via plugin heuristics and SonarQube's own effort field. Measured is actual human review time from status transitions. Fresh data; calibration improves as more issues merge."
}
```

The `note` field is the "honest answer." Display it verbatim under the
dashboard card so no reader is misled.

## Dashboard card

```
┌───────────────────────────────────────────────┐
│ HOURS SAVED (last 30 days)                    │
│                                               │
│    35.2 net hours saved                       │
│    ─────────────                              │
│    47.5 potential · 12.3 measured review time │
│                                               │
│    i) Estimate vs. measured — hover for note  │
└───────────────────────────────────────────────┘
```

## Honest ranges for the promo case

If you need a single number for the office:

- **Lower bound (defensible):** `net_hours_saved` as computed above.
- **Upper bound (headline):** `potential_hours_saved` — what the issues
  *would* have cost without the tool, if plugin estimates are right.
- The **ratio** of the two is your calibration: if measured review time is
  ~25% of the estimate, you can say "we do ~4x faster than manual." If
  it's 80%, you know the tool isn't saving much and you should say so.

## Implementation order

1. `issue_status_history` table + write-on-transition in fix.js + approve/
   reject handlers. Backfill is fine — it will fill in from now on.
2. `getROI(window)` function in `packages/core/src/metrics.js` that joins
   issues + issue_status_history and computes both tracks.
3. `GET /api/roi` in dashboard/server.js.
4. Frontend card on the existing dashboard (not on Kanban — this goes on
   the main stats page).

## Related question to resolve with the user

Once measured data exists, do we **recalibrate** `estimated_minutes` per
category from the observations? That would make the Apiiro guesses
self-correcting over time. It's a quick `UPDATE effort-map` nightly job.
Answer before building.
