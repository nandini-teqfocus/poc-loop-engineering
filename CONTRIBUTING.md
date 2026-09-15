# Contributing to POC Loop Engineering

Thank you for contributing to **POC Loop Engineering**! This project delivers an autonomous, closed-loop software engineering lifecycle for Salesforce development using multi-agent orchestration.

Please review these guidelines to ensure consistency, quality, and seamless operation across the agent loop.

---

## 1. Important Project Guidelines

### GitHub Account Rule
> [!IMPORTANT]
> When working in this repository and the `time-sheet` Salesforce org (`nandini.singh.c2d90108260b@agentforce.com`):
> - **MANDATORY**: Always commit and interact using the **`nandini-teqfocus`** GitHub account.
> - Verify your local git identity before creating branches or commits:
>   ```bash
>   git config user.name "nandini-teqfocus"
>   git config user.email "nandini.singh@teqfocus.com"
>   ```

---

## 2. Branching & Git Workflow

- **Base Branch**: All production-ready work merges into `main`.
- **Feature Branches**: Branch names must strictly follow the format:
  ```
  portal/<JIRA-TICKET-KEY>
  ```
  *Examples:* `portal/SCRUM-10`, `portal/SCRUM-11`

### Commit Message Conventions
Commits must follow the Conventional Commits specification and include the JIRA ticket key:
- `feat(SCRUM-10): create custom fields on Account object`
- `fix(SCRUM-11): correct validation rule formula syntax`
- `docs(SCRUM-9): add QA test report and living memory updates`
- `test(SCRUM-12): add record update flow verification script`
- `refactor(core): streamline slack notification payloads`

---

## 3. Salesforce Metadata & Development Standards

1. **Source Format**: All metadata must be in standard SFDX source format inside `force-app/main/default/`.
2. **Naming Conventions**:
   - Custom Field Labels: PascalCase or title case (e.g., `Service Tier`, `Onboarding Date`).
   - Custom Field API Names: Descriptive PascalCase with `__c` suffix (e.g., `Service_Tier__c`, `Onboarding_Date__c`).
   - Validation Rules: Descriptive PascalCase with clear error messages attached to the relevant field.
3. **Deployment Verification**:
   - Always run a dry-run or target org validation before opening a PR:
     ```bash
     sf project deploy start --target-org time-sheet --dry-run
     ```
   - Successful deployment to the `time-sheet` org is mandatory for PR review and QA sign-off.

---

## 4. Multi-Agent Protocol & Living Memory

Every ticket processed by human developers or autonomous agents must adhere to the **Persistent Living Memory Protocol**:
- **`agent-context/tickets/<TICKET-KEY>/plan.md`**: Must outline the architecture, touch points, schema changes, and acceptance criteria.
- **`agent-context/MEMORY.md`**: Must be updated to reflect newly deployed schema, objects, validation rules, or automation with business context.
- **`agent-context/CHANGELOG.md`**: Append-only ledger recording the ticket key, date, summary, touched files, and PR link.

---

## 5. Testing & Local Development

Before submitting changes, test connection integrity and orchestrator routes:

```bash
# 1. Install dependencies
npm install

# 2. Verify Slack & JIRA connections
npm run test:connections

# 3. Start local orchestrator server
npm start

# 4. Dry-run ticket loop via CLI
node orchestrator.js --ticket <TICKET-KEY>
```

---

## 6. Pull Request & Review Process

1. Open pull requests against `main` using GitHub CLI or web:
   ```bash
   gh pr create --title "feat(SCRUM-10): Create 2 fields in Account object" --body "..."
   ```
2. The **PR Review Agent (Agent 4)** will automatically audit the PR against JIRA acceptance criteria and post review comments.
3. Once approved, **Agent 3 (QA Tester)** executes org validation.
4. When merged to `main`, the associated JIRA ticket automatically moves to **Done**.
