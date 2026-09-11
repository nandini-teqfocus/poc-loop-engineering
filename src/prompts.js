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
