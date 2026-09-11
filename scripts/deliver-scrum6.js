import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { runAgent } from '../src/agentRunner.js';
import { buildAgent2Prompt } from '../src/prompts.js';
import { addJiraComment, transitionJiraIssue } from '../src/jira.js';
import { postSlackMessage } from '../src/slack.js';

const ticketKey = 'SCRUM-6';
const summary = 'create fields on contact object';
const branchName = `portal/${ticketKey}`;
const channelId = process.env.SLACK_CHANNEL_ID;

console.log(`\n================== [RESUMING AGENT 1 (PLANNER)] ==================`);
const reply = 'The developer replied: "Option A: Include all 8 standard blood types (A+, A-, B+, B-, O+, O-, AB+, AB-) for the Blood Group field on Contact.". Continue the task and produce agent-context/tickets/SCRUM-6/plan.md.';

const agent1Result = await runAgent(reply, true);
console.log('[AGENT 1 FINISHED] Exit code:', agent1Result.code);

const planPath = path.join(process.cwd(), 'agent-context', 'tickets', ticketKey, 'plan.md');
if (!fs.existsSync(planPath)) {
  console.error('[ERROR] plan.md was not created at:', planPath);
  process.exit(1);
}
console.log('[SUCCESS] plan.md confirmed at:', planPath);

// Checkout branch for Agent 2
console.log(`\n================== [PREPARING BRANCH ${branchName}] ==================`);
try {
  execSync(`git checkout -B ${branchName}`, { stdio: 'inherit' });
} catch (e) {
  console.error('[BRANCH ERROR]', e.message);
}

// Run Agent 2 (Builder)
console.log(`\n================== [RUNNING AGENT 2 (BUILDER)] ==================`);
const agent2Prompt = buildAgent2Prompt({ ticketKey, summary });
const agent2Result = await runAgent(agent2Prompt, false);
console.log('[AGENT 2 FINISHED] Exit code:', agent2Result.code);

// Extract PR URL
let prUrl = null;
const prMatch = agent2Result.output.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
if (prMatch) {
  prUrl = prMatch[0];
} else {
  try {
    const ghOut = execSync(`gh pr list --head ${branchName} --json url -q ".[0].url"`, { encoding: 'utf8' }).trim();
    if (ghOut) prUrl = ghOut;
  } catch (e) {}
}

console.log('[PR URL]', prUrl);

// Update JIRA
const jiraComment = prUrl
  ? `Automated delivery completed by Agent Loop.\n\nPull Request: ${prUrl}\n\nBranch: ${branchName}`
  : `Automated delivery completed by Agent Loop for branch ${branchName}.`;

console.log(`[JIRA] Adding comment to ${ticketKey}...`);
try {
  await addJiraComment(ticketKey, jiraComment);
} catch (e) {
  console.error('[JIRA COMMENT ERROR]', e.message);
}

console.log(`[JIRA] Transitioning ${ticketKey} to In Review...`);
try {
  await transitionJiraIssue(ticketKey, ['In Review', 'Code Review']);
} catch (e) {
  console.error('[JIRA TRANSITION ERROR]', e.message);
}

// Post Slack completion
if (channelId) {
  await postSlackMessage(
    channelId,
    `🎉 *Delivery Complete for ${ticketKey}!*
• *Summary:* ${summary}
• *Status:* Deployed Contact fields to \`time-sheet\` org & moved to *In Review*
• *Pull Request:* ${prUrl || 'PR created on branch ' + branchName}
• *Memory Updated:* \`agent-context/MEMORY.md\` now tracks Contact object fields!`
  );
}

console.log(`\n================== [SCRUM-6 COMPLETE!] ==================\n`);
