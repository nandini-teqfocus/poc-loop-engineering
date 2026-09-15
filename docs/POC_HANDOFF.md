# Loop Engineering Handoff — Agent Loop + Persistent Project Memory

**What this actually is:** not a one-day, one-prompt build. You're standing up a small **agentic delivery pipeline for the whole Experience Cloud portal project** — many tickets, over many days, across many separate Antigravity CLI sessions. The two things that make that work are (1) the JIRA→Slack→GitHub automation loop, and (2) a **persistent, git-tracked memory** so that when Agent 1 starts planning ticket #7, it already knows what tickets #1–6 built, what fields exist, and why — instead of re-deriving it from scratch or contradicting earlier decisions.

Today's realistic goal: get the loop mechanics + memory scaffold working end-to-end on **one** ticket (fields + validation rules on Account), with the memory files structured so ticket #2 (UI + Apex) can be run tomorrow and actually read what ticket #1 did. Don't try to run the whole portal build in one day — prove the pattern on one ticket, then it scales by just... running more tickets through it.

---

## 1. Architecture

```
JIRA (Cloud)
   │  webhook: issue transitioned To Do -> In Progress
   ▼
Cloudflare Tunnel ──▶ Local Orchestrator (Node or Python script)
                                              │
                                              ▼
                          Agent 1 — Planner  (Antigravity CLI + JIRA MCP)
                 reads /agent-context/ (project memory) + the ticket,
                 writes /agent-context/tickets/<KEY>/plan.md
                                              │
                                              ▼
                          Agent 2 — Builder  (Antigravity CLI + sf + gh)
                 implements plan.md, deploys, commits, opens PR,
                 UPDATES /agent-context/MEMORY.md + CHANGELOG.md
                                              │
                              ┌───────────────┴───────────────┐
                              ▼                                ▼
                     Slack (question/clarify —          JIRA (comment + transition
                     agent PAUSES, orchestrator          to Code Review)
                     polls, agent RESUMES with
                     full context on reply — §3a)
```

The key change from a single-ticket POC: **plan.md, the memory, and the changelog all live inside the actual git repo**, not a throwaway `/work/` scratch folder — because they need to survive across days, machines, and developers, and they need to travel with the PR that created them.

---

## 2. Persistent project memory — file structure

All of this lives in the repo, e.g. under `/agent-context/`, committed as part of every ticket's PR:

```
/agent-context/
  PROJECT.md            -- static: what the portal is, architecture, org details,
                            naming conventions, coding standards. Rarely changes.
  INSTRUCTIONS.md        -- static: how agents must behave — plan.md format, when to
                            emit NEEDS_INPUT, deployment steps, PR/commit conventions,
                            branch naming. This is the standing "rules of engagement."
  MEMORY.md              -- LIVING summary of current build state: every object/field/
                            component that exists, grouped by area, with a one-line
                            reason for each. This is what Agent 1 reads FIRST, before
                            it even opens the new ticket.
  CHANGELOG.md            -- append-only ledger, one entry per completed ticket:
                            ticket key, date, summary, artifacts touched, PR link.
                            Never edited retroactively — MEMORY.md is the distilled
                            current state, CHANGELOG.md is the raw history.
  /tickets/
    <TICKET-KEY>/
      plan.md            -- Agent 1's output for this specific ticket
      log.md             -- Agent 2's execution notes, including any Q&A that happened
```

**Why split MEMORY.md from CHANGELOG.md:** MEMORY.md answers "what do we have and why" (Agent 1's question at planning time); CHANGELOG.md answers "what happened, in order" (useful for debugging/audit, but not something you want an agent re-deriving state from every time — it'll get long). Keep MEMORY.md curated and short; let CHANGELOG.md grow.

**Example MEMORY.md entry, so the split is concrete:**
```
## Account object
- Fields added in PORTAL-101 (2026-09-11): Industry_Segment__c (picklist: A/B/C),
  Renewal_Risk_Score__c (number 0-100), Last_Health_Check__c (date),
  Primary_Competitor__c (text 80), Contract_Value__c (currency), Auto_Renew__c (checkbox)
- Validation rule added in PORTAL-101: if Renewal_Risk_Score__c > 80,
  Primary_Competitor__c must not be blank
- Not yet done: no UI exposes these fields yet (planned for PORTAL-102)
```
That last line is exactly what lets ticket #2's Agent 1 know the fields exist and are ready to be surfaced in UI, without re-reading PORTAL-101's full ticket or diffing metadata.

---

## 3. How memory gets read and written (wired into the agents, not optional)

- **Agent 1 (Planner), first action on every ticket, before touching the ticket itself:** read `PROJECT.md`, `INSTRUCTIONS.md`, and `MEMORY.md`. Its plan.md should explicitly note if the ticket depends on or extends something already in MEMORY.md (e.g. "this UI ticket will expose the 6 Account fields added in PORTAL-101").
- **Agent 2 (Builder), last action before finishing — not optional, part of the same PR:** update `MEMORY.md` (add/modify the relevant section) and append one entry to `CHANGELOG.md`. This is a normal file edit committed on the same branch as the code change, so it's reviewed in the same PR and lands atomically with the work it describes.
- If MEMORY.md and the actual deployed org ever disagree (e.g. someone made a manual change), that's a real signal something's wrong — don't have agents silently "fix" MEMORY.md to match; surface it via a `NEEDS_INPUT` instead.

As the project grows, `MEMORY.md` will eventually want splitting by area (`memory/account-object.md`, `memory/portal-ui.md`, etc.) rather than one flat file — not needed for the first few tickets, but plan for it so it's not a rewrite later.

---

## 4. Components & concrete tech choices

| Piece | Recommendation | Notes |
|---|---|---|
| Public endpoint for JIRA webhook | Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`) | JIRA Cloud cannot reach `localhost` directly. Quick tunnel URL changes on restart — re-register the JIRA webhook if that happens. |
| Orchestrator | Single Node.js or Python script, plain sequential control flow | No message queue. Receive webhook → run Agent 1 → wait for it to exit → run Agent 2 → wait for it to exit. |
| Agent invocation | Antigravity CLI (`agy --print "<prompt>"`) run headless, with JIRA/SF/GitHub MCP wired in, and `/agent-context/` in its workspace | Agent 1 prompt = "read /agent-context/, read this ticket via MCP, produce plan.md." Agent 2 prompt = "implement plan.md, deploy, commit, PR, update MEMORY.md + CHANGELOG.md." |
| Agent pause/resume | `agy --continue` (a.k.a. `-c`) to resume the most recent conversation with full memory | See §5. Native to `agy` — not something to build yourselves. |
| JIRA integration | JIRA MCP server for both read (Agent 1) and write (Agent 2 — comment + transition) | Confirm the MCP server supports issue transitions and comments, not just reads. |
| Slack integration | A real Slack app with **Socket Mode** or the Events API — not just an Incoming Webhook | Incoming webhooks can't receive replies; you need two-way. |
| Slack Q&A pattern | Orchestrator (not the agent process) posts the question, polls the thread every ~10s, timeout after N minutes → on timeout, pause the run rather than guessing | Keep dead simple. Not a general conversational bot. |
| Salesforce deploy | `sf` CLI, authenticated to one fixed target org | One fixed org for now, not scratch-org-per-task. |
| GitHub | `gh` CLI, authenticated | New branch per ticket (`portal/<ticket-key>`), commit (including `/agent-context/` changes), `gh pr create`. |

---

## 5. How agent pause/resume actually works

`agy` already does most of this — no custom context-serialization needed:

- Every `agy` conversation is persisted locally, and `agy --continue` (`-c`) reloads **the most recent conversation** with full memory of what was said and done.
- **Known gotcha:** headless (`--print`) invocations don't currently print the conversation ID to stdout/stderr, so a wrapper can't reliably target a specific past session by ID.
- **Workaround:** since the orchestrator runs one `agy` conversation at a time (Agent 1 fully exits before Agent 2 starts, nothing else invokes `agy` concurrently), plain `agy --continue` unambiguously resumes the right session. Don't parallelize agent invocations, or this breaks.

Mechanics:

1. Agent runs via `agy --print "<task prompt>"`.
2. Needs clarification → prints `NEEDS_INPUT: <question>` as the last line, exits.
3. Orchestrator matches that line, posts the question to Slack (@mention, thread tagged with ticket key), marks the ticket `paused`, does not re-invoke yet.
4. Orchestrator polls the Slack thread for a reply.
5. On reply: `agy --continue --print "The developer replied: '<reply>'. Continue the task."`
6. `agy` reloads full prior context (including whatever it already read from `/agent-context/`) and resumes.

If the timeout is hit, stop the run and surface it clearly rather than guessing.

---

## 6. Step-by-step flow

1. Developer moves JIRA ticket **To Do → In Progress**.
2. JIRA webhook fires to the Cloudflare Tunnel URL → hits local orchestrator.
3. Orchestrator creates `/agent-context/tickets/<ticket-key>/` on a new branch and logs the event.
4. Orchestrator invokes **Agent 1 (Planner)**: reads `/agent-context/` + the ticket via JIRA MCP → writes `plan.md` (or pauses on `NEEDS_INPUT`, resumes per §5) → exits.
5. Orchestrator invokes **Agent 2 (Builder)** with `plan.md`: implements, deploys via `sf`, updates `MEMORY.md` + `CHANGELOG.md`, commits (code + memory files together), pushes, opens PR via `gh pr create` → exits.
6. Orchestrator: adds a JIRA comment with the summary + PR link, transitions the ticket to **Code Review**, posts a Slack notification.

---

## 7. Fixed test case for today

> **PORTAL-101:** Create 6 fields on Account: `Industry_Segment__c` (picklist: A/B/C), `Renewal_Risk_Score__c` (number, 0–100), `Last_Health_Check__c` (date), `Primary_Competitor__c` (text, 80), `Contract_Value__c` (currency), `Auto_Renew__c` (checkbox). Add a validation rule: if `Renewal_Risk_Score__c` > 80, `Primary_Competitor__c` must not be blank.

If there's time left after PORTAL-101 completes, run a second, deliberately dependent ticket (e.g. "add these Account fields to the Experience Cloud record page layout") to actually prove the memory read/write loop — not just the automation loop. That's the real test of today's work: does ticket #2's Agent 1 correctly reference what ticket #1 built, sourced from `MEMORY.md` rather than re-reading PORTAL-101 by hand.

---

## 8. Explicitly out of scope for now

- Credential isolation / per-agent scoped tokens
- Scratch-org-per-task
- Branch protection enforcement, network egress allowlisting per container
- Retry logic, idempotent webhook handling, concurrent tickets
- General-purpose Slack bot behavior beyond the one Q&A pattern
- Splitting `MEMORY.md` by area (fine as one file for the first handful of tickets)

These belong to the separate hardened architecture track, and to a later "memory needs restructuring" pass once the file actually gets big — don't build either preemptively.

---

## 9. Suggested task split

- **Engineer A:** Cloudflare Tunnel + JIRA webhook registration + orchestrator skeleton, including creating/populating `/agent-context/` scaffold on first run
- **Engineer B:** Agent 1 (Planner) prompt — must read `/agent-context/` before the ticket, plan.md format, `NEEDS_INPUT` convention
- **Engineer C:** Agent 2 (Builder) prompt — `sf` deploy, `gh` branch/PR flow, and the MEMORY.md/CHANGELOG.md update step as a mandatory last action
- **Engineer D:** Slack Socket Mode app + orchestrator-side ask/poll-for-reply logic + `agy --continue` resume trigger + final notification step

Someone should also hand-write the initial `PROJECT.md` and `INSTRUCTIONS.md` before the first run — these are the two files that won't be generated by the agents themselves, and everything else depends on them being accurate from the start.
