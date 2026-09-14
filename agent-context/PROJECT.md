# Project Context: Experience Cloud Portal

## 1. Overview
This repository contains the source code, metadata, and agent delivery infrastructure for the Experience Cloud Portal project. 

The project delivers features incrementally across multiple JIRA tickets through an autonomous delivery loop:
1. **Agent 1 (Planner):** Produces a technical `plan.md` based on ticket requirements and current project memory.
2. **Agent 2 (Builder):** Implements metadata/code, verifies via deployment, commits changes, opens a GitHub PR, and updates living memory.
3. **Agent 4 (PR Reviewer):** Reviews GitHub PR code changes against JIRA acceptance criteria. Leaves review comments or approves PR. Only approved PRs proceed.
4. **Agent 3 (Tester):** Validates acceptance criteria and org deployment in `In Review`. Cycles bugs back to `In Progress` for Builder resolution until all tests pass, then transitions ticket to `Done`.

---

## 2. Environment & Org Details
- **Target Salesforce Org Alias:** `time-sheet`
- **Target Org Username:** `nandini.singh.c2d90108260b@agentforce.com`
- **Salesforce Source Format:** Standard SFDX source format under `force-app/main/default/`
- **Source API Version:** `62.0`
- **GitHub Repository:** `https://github.com/nandini-teqfocus/poc-loop-engineering`
- **GitHub Account:** `nandini-teqfocus` (mandatory for all operations in this project)

---

## 3. Architecture & Standards

### Metadata & Object Standards
- Custom fields on standard or custom objects must use descriptive, PascalCase or camelCase label names with standard `__c` API names.
- All field labels, descriptions, and help texts must be clear and user-facing.
- Custom field XML files live in `force-app/main/default/objects/<Object_Name>/fields/<Field_Name>__c.field-meta.xml`.
- Validation rules live in `force-app/main/default/objects/<Object_Name>/validationRules/<Rule_Name>.validationRule-meta.xml`.

### Deployment Standards
- Metadata deployments must be executed using the Salesforce CLI:
  ```bash
  sf project deploy start --target-org time-sheet
  ```
- All deployments must pass validation in the target org before committing.

### Git & Branching Standards
- Main branch: `main`
- Feature / Ticket branches: `portal/<TICKET-KEY>` (e.g., `portal/PORTAL-101`)
- PRs must target `main` and be opened via GitHub CLI (`gh pr create`).
