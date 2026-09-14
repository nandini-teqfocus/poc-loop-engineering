/**
 * Prompt builders for Agent 1 (Planner) and Agent 2 (Builder)
 */

export function buildAgent1Prompt({ ticketKey, summary, description }) {
  return `You are Agent 1 (Planner) for the Experience Cloud Portal project.

Your task is to plan the implementation for JIRA ticket ${ticketKey}.

Ticket Summary: ${summary}
Ticket Description:
${description || '(No description provided in JIRA ticket)'}

MANDATORY PROTOCOL:
1. FIRST, read the persistent context files:
   - agent-context/PROJECT.md
   - agent-context/INSTRUCTIONS.md
   - agent-context/MEMORY.md
2. Inspect what already exists in MEMORY.md and ensure this plan builds harmoniously upon it.
3. If ANY critical requirement is ambiguous, unstated, or contradictory, DO NOT GUESS.
   Instead, output your question on the final line in this exact format:
   NEEDS_INPUT: <your specific question here>
   and stop.
4. Otherwise, formulate a detailed technical plan adhering to INSTRUCTIONS.md, and write it to:
   agent-context/tickets/${ticketKey}/plan.md
5. Once plan.md is written, provide a brief summary of the plan and finish.
`;
}

export function buildAgent2Prompt({ ticketKey, summary }) {
  return `You are Agent 2 (Builder) for the Experience Cloud Portal project.

Your task is to execute the approved plan for JIRA ticket ${ticketKey}:
agent-context/tickets/${ticketKey}/plan.md

MANDATORY EXECUTION STEPS:
1. Read agent-context/tickets/${ticketKey}/plan.md.
2. Verify you are on git branch portal/${ticketKey}.
3. Create/update the required Salesforce metadata files under force-app/main/default/.
4. Deploy the metadata to the target org using the Salesforce CLI:
   sf project deploy start --target-org time-sheet
   Ensure deployment succeeds. If there are deployment errors, fix them and redeploy.
5. MANDATORY LIVING MEMORY UPDATE:
   - Update agent-context/MEMORY.md with the new fields, validation rules, or components, including why they were added.
   - Append one new row/entry to agent-context/CHANGELOG.md detailing ${ticketKey}, date, summary, artifacts touched, and PR link.
6. Commit all changes together (code, metadata, plan, MEMORY.md, and CHANGELOG.md):
   git add .
   git commit -m "feat(${ticketKey}): ${summary.replace(/"/g, '')}"
7. Push the branch to GitHub:
   git push -u origin portal/${ticketKey}
8. Open a Pull Request targeting main using GitHub CLI:
   gh pr create --title "${ticketKey}: ${summary.replace(/"/g, '')}" --body "Automated delivery for ${ticketKey}.\n\n### Changes\n- Implemented metadata as specified in \`plan.md\`.\n- Deployed to \`time-sheet\` org.\n- Updated \`MEMORY.md\` and \`CHANGELOG.md\`." --base main
9. Print the final PR URL on the last line.
`;
}

export function buildAgent3Prompt({ ticketKey, summary, iteration = 1 }) {
  return `You are Agent 3 (QA Tester & Acceptance Validator) for the Experience Cloud Portal project.

Your task is to validate and verify the implementation for JIRA ticket ${ticketKey} (QA Test Iteration ${iteration}).

Ticket Summary: ${summary}
Implementation Plan: agent-context/tickets/${ticketKey}/plan.md
Git Branch: portal/${ticketKey}
Target Salesforce Org: time-sheet (nandini.singh.c2d90108260b@agentforce.com)

MANDATORY QA PROTOCOL:
1. Read the following persistent context files:
   - agent-context/PROJECT.md
   - agent-context/INSTRUCTIONS.md
   - agent-context/MEMORY.md
   - agent-context/tickets/${ticketKey}/plan.md
2. Inspect the metadata files created/modified under force-app/main/default/ on branch portal/${ticketKey}.
3. Perform deployment validation against the target org:
   sf project deploy start --dry-run --target-org time-sheet
   Ensure there are zero deployment errors or schema conflicts.
4. Verify every acceptance criterion and technical specification in plan.md:
   - Check that field API names (__c), data types, required attributes, and labels strictly match.
   - Check that validation rule formulas, error messages, and locations are correctly configured.
   - Verify that MEMORY.md and CHANGELOG.md were properly updated.
5. Write a comprehensive test execution report to:
   agent-context/tickets/${ticketKey}/test-report.md
   Include:
   - Title: # QA Test Report: ${ticketKey} (Iteration ${iteration})
   - Summary of verification performed
   - Checklist of Acceptance Criteria (each marked [PASS] or [FAIL])
   - Deployment / Org Validation Result
   - Final Verdict: TEST_RESULT: PASS or TEST_RESULT: FAIL
   - If FAIL, a section "### Bug & Failure Details" explaining precisely what is broken or missing.
6. MANDATORY OUTPUT FORMAT ON FINAL LINES:
   If all tests and acceptance criteria pass:
   TEST_RESULT: PASS
   SUMMARY: <one sentence summary of verification>

   If any test fails or bug is discovered:
   TEST_RESULT: FAIL
   BUG_DETAILS: <concise, actionable description of bug(s) to fix>
`;
}

export function buildAgent2FixPrompt({ ticketKey, summary, branchName, bugDetails, iteration = 1 }) {
  return `You are Agent 2 (Builder) for the Experience Cloud Portal project.

The QA Tester (Agent 3) identified bugs/failures during QA Test Iteration ${iteration} for ticket ${ticketKey}.
Your task is to FIX these issues and re-deploy the updated implementation.

Ticket Summary: ${summary}
Branch: ${branchName || `portal/${ticketKey}`}
Target Salesforce Org: time-sheet

BUG / FAILURE DETAILS REPORTED BY QA TESTER:
${bugDetails}

MANDATORY FIX PROTOCOL:
1. Review the reported bug details and inspect the implementation under force-app/main/default/.
2. Fix the metadata, fields, validation rules, or code to resolve every reported issue.
3. Deploy the updated metadata to the target org:
   sf project deploy start --target-org time-sheet
   Ensure deployment succeeds with 0 errors.
4. Update agent-context/MEMORY.md and agent-context/CHANGELOG.md with details of the fix.
5. Commit all changes to git:
   git add .
   git commit -m "fix(${ticketKey}): resolve tester issues (iteration ${iteration})"
6. Push changes to GitHub:
   git push origin ${branchName || `portal/${ticketKey}`}
7. On the final line of your output, print:
   FIX_COMPLETE: <brief summary of fixes made>
`;
}

