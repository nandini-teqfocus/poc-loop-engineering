# Agent Standing Rules of Engagement

These instructions govern the behavior of all autonomous agents running within this project. Adherence is mandatory.

---

## 1. Agent 1: Planner Protocol

### Step 1: Ingest Context
Before inspecting or processing the assigned ticket, Agent 1 **must** read:
1. `agent-context/PROJECT.md`
2. `agent-context/INSTRUCTIONS.md`
3. `agent-context/MEMORY.md`

### Step 2: Formulate the Plan
Agent 1 reads the assigned JIRA ticket (via JIRA MCP or orchestrator input). It must write the execution plan to:
`agent-context/tickets/<TICKET-KEY>/plan.md`

#### Required `plan.md` Structure:
```markdown
# Plan: <TICKET-KEY> - <Title>

## 1. Context & Dependencies
- Which existing fields/components in MEMORY.md does this build upon?
- Any pre-conditions or dependencies?

## 2. Technical Specification
- Exact metadata files to create/modify (file paths, API names, data types, picklist values).
- Validation rule formulas, error conditions, and error messages.

## 3. Deployment & Verification Steps
- Salesforce CLI command(s) to deploy and test.
- Verification checks to confirm correct installation in the target org.

## 4. Persistent Memory Updates Required
- Exact text snippet to add/update in `agent-context/MEMORY.md`.
- Exact entry to append to `agent-context/CHANGELOG.md`.
```

### Step 3: Human Clarification Protocol (`NEEDS_INPUT`)
If the ticket requirements are ambiguous, contradictory, or missing critical specifications (e.g. unspecified picklist values, ambiguous validation rules), Agent 1 **must not guess**.
- Output the question on the very last line in the exact format:
  ```
  NEEDS_INPUT: <Specific question for the developer>
  ```
- Exit immediately. The orchestrator will post this question to the Slack thread and resume Agent 1 via `agy --continue` once the developer responds.

---

## 2. Agent 2: Builder Protocol

### Step 1: Read Plan
Agent 2 receives and reads `agent-context/tickets/<TICKET-KEY>/plan.md`.

### Step 2: Implement Code & Metadata
- Generate the required Salesforce metadata files under `force-app/main/default/`.
- Verify files conform to standards defined in `PROJECT.md`.

### Step 3: Deploy & Verify
- Deploy metadata to the target org using:
  ```bash
  sf project deploy start --target-org time-sheet
  ```
- If the deployment fails, diagnose the compilation or validation error, fix the metadata, and retry until successful.

### Step 4: Update Persistent Project Memory (MANDATORY)
In the same working branch, Agent 2 **must**:
1. Update `agent-context/MEMORY.md`: Update or add the relevant section describing the new fields, validation rules, or components and the business reason for each.
2. Append a new record to `agent-context/CHANGELOG.md` with date, ticket key, summary, artifacts touched, and PR link.

### Step 5: Commit & Open Pull Request
- Ensure working on branch `portal/<TICKET-KEY>`.
- Commit all changes together (code/metadata + `agent-context/MEMORY.md` + `agent-context/CHANGELOG.md` + `agent-context/tickets/<TICKET-KEY>/`):
  ```bash
  git add .
  git commit -m "feat(<TICKET-KEY>): <short summary>"
  git push origin portal/<TICKET-KEY>
  gh pr create --title "<TICKET-KEY>: <short summary>" --body "<summary>" --base main
  ```
- Emit the final PR URL upon completion.

---

## 3. Agent 3: Tester Protocol (QA & Acceptance Testing)

### Step 1: Trigger Condition
When a JIRA ticket reaches **In Review**, Agent 3 is invoked to validate the implementation.

### Step 2: Verification Checklist
1. **Metadata & Org Validation:**
   - Execute dry-run deployment to target org:
     ```bash
     sf project deploy start --dry-run --target-org time-sheet
     ```
   - Verify zero errors, missing dependencies, or syntax issues.
2. **Acceptance Criteria Verification:**
   - Read `agent-context/tickets/<TICKET-KEY>/plan.md`.
   - Inspect files under `force-app/main/default/` to verify every field label, API name (`__c`), data type, picklist value, and validation rule matches specifications.
   - Confirm living memory updates (`agent-context/MEMORY.md` and `CHANGELOG.md`).

### Step 3: Test Execution Report
Agent 3 writes an audit report to:
`agent-context/tickets/<TICKET-KEY>/test-report.md`
With verdict `TEST_RESULT: PASS` or `TEST_RESULT: FAIL` (with a dedicated `### Bug & Failure Details` section).

### Step 4: Test Loop Resolution
- **If Passed:**
  - JIRA ticket transitions: **`In Review` ➔ `Done`**.
  - JIRA comment and Slack notification posted with test passing confirmation.
- **If Bug/Failure Found:**
  - JIRA ticket transitions: **`In Review` ➔ `In Progress`**.
  - Bug report posted to JIRA and Slack thread.
  - Agent 2 (Builder) runs in Fix Mode to resolve all issues, redeploy to `time-sheet`, and push changes.
  - JIRA ticket transitions back: **`In Progress` ➔ `In Review`**.
  - Agent 3 runs again to re-validate.
  - The loop repeats until all acceptance criteria pass.

---

## 4. GitHub PR Merge Automation

When a Pull Request associated with a ticket is merged into `main`:
1. The GitHub webhook (`/webhook/github`) detects the `pull_request` event where `action === 'closed'` and `merged === true`.
2. The orchestrator identifies the linked JIRA ticket from the branch ref (`portal/<TICKET-KEY>`), PR title, body, or `CHANGELOG.md`.
3. If the ticket is not already `Done`, it automatically transitions the JIRA ticket to **`Done`** and adds a closing comment referencing the merged PR.
4. Posts the stage transition and a celebratory completion card with JIRA & GitHub action buttons into the existing Slack thread.
5. Duplicate merge deliveries are debounced and suppressed using in-memory idempotency tracking.

---

## 5. Agent 4: PR Review Protocol (Code Review & Acceptance Criteria Verification)

### Step 1: Trigger Condition
Invoked immediately after Agent 2 opens the Pull Request (Phase 5). The ticket is blocked from proceeding until the PR review passes.

### Step 2: Verification Checklist
1. **JIRA Requirements & Acceptance Criteria:**
   - Review JIRA ticket and `agent-context/tickets/<TICKET-KEY>/plan.md`.
   - Verify all requested fields, validation rules, flows, and components are present in the PR diff.
2. **Code Standards & Best Practices:**
   - Inspect git diff: `git diff main...portal/<TICKET-KEY>`.
   - Verify API names have `__c` suffix, PascalCase/camelCase conventions, required attributes, and descriptions.
   - Confirm living memory updates (`agent-context/MEMORY.md` and `CHANGELOG.md`).

### Step 3: Review Execution Report
Agent 4 writes a review audit to:
`agent-context/tickets/<TICKET-KEY>/pr-review.md`
With verdict `REVIEW_RESULT: APPROVED` or `REVIEW_RESULT: CHANGES_REQUESTED`.

### Step 4: PR Review Loop Resolution
- **If Changes Requested:**
  - Adds a detailed review comment to the GitHub PR listing all required fixes.
  - Posts review failure update and required fixes to the Slack thread.
  - Spawns Agent 2 (Builder in PR Fix Mode) to address the comments, redeploy, commit, and push to the PR branch.
  - Re-invokes Agent 4 for re-review.
- **If Approved:**
  - Submits official approval on GitHub PR (`gh pr review --approve`).
  - Posts approval confirmation and review audit to Slack thread with JIRA & GitHub action buttons.
  - Only then does the ticket proceed to JIRA Finalization and QA Testing.



