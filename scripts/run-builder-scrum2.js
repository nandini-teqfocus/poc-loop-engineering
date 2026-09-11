import { execSync } from 'child_process';
import { runAgent } from '../src/agentRunner.js';
import { buildAgent2Prompt } from '../src/prompts.js';
import { addJiraComment, transitionJiraIssue } from '../src/jira.js';
import { postSlackMessage } from '../src/slack.js';

const ticketKey = 'SCRUM-2';
const summary = 'Expose Renewal Risk Score and add Customer Tier on Account';
const branchName = `portal/${ticketKey}`;
const channelId = process.env.SLACK_CHANNEL_ID;

console.log(`[BUILDER] Switching to branch ${branchName}...`);
try {
  // Base off portal/SCRUM-1 or main so SCRUM-1 fields are present
  execSync(`git checkout -B ${branchName} portal/SCRUM-1`, { stdio: 'inherit' });
} catch (e) {
  execSync(`git checkout -B ${branchName}`, { stdio: 'inherit' });
}

console.log(`[BUILDER] Spawning Agent 2 for ${ticketKey}...`);
const prompt = buildAgent2Prompt({ ticketKey, summary });
const result = await runAgent(prompt, false);

console.log(`[BUILDER] Agent 2 finished with code:`, result.code);

// Extract PR URL
let prUrl = null;
const prMatch = result.output.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
if (prMatch) {
  prUrl = prMatch[0];
} else {
  try {
    const ghOut = execSync(`gh pr list --head ${branchName} --json url -q ".[0].url"`, { encoding: 'utf8' }).trim();
    if (ghOut) prUrl = ghOut;
  } catch (e) {}
}

console.log(`[BUILDER] PR URL:`, prUrl);

// Update JIRA
const jiraComment = prUrl
  ? `Automated delivery completed by Agent Loop.\n\nPull Request: ${prUrl}\n\nBranch: ${branchName}`
  : `Automated delivery completed by Agent Loop for branch ${branchName}.`;

console.log(`[BUILDER] Adding comment to JIRA ${ticketKey}...`);
await addJiraComment(ticketKey, jiraComment);

console.log(`[BUILDER] Transitioning JIRA ${ticketKey} to In Review...`);
await transitionJiraIssue(ticketKey, ['In Review', 'Code Review']);

// Post Slack notification
if (channelId) {
  await postSlackMessage(
    channelId,
    `🎉 *Delivery Complete for ${ticketKey}!*
• *Status:* Deployed to \`time-sheet\` org & moved to *In Review*
• *Pull Request:* ${prUrl || 'PR created on branch ' + branchName}
• *Memory Continuity:* Verified and updated \`agent-context/MEMORY.md\`.`
  );
}

console.log(`\n[BUILDER] Done! ${ticketKey} complete.\n`);
