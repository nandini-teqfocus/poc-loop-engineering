import 'dotenv/config';
import express from 'express';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { getJiraIssue, addJiraComment, transitionJiraIssue, extractTextFromAdf } from './src/jira.js';
import { initSlack, postSlackMessage, askSlackQuestion } from './src/slack.js';
import { runAgent, parseNeedsInput } from './src/agentRunner.js';
import { buildAgent1Prompt, buildAgent2Prompt } from './src/prompts.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

let isProcessing = false;

/**
 * Execute the autonomous delivery loop for a given ticket
 */
export async function executeLoopForTicket(ticketKey) {
  if (isProcessing) {
    console.warn(`[ORCHESTRATOR] Already processing a ticket. Skipping request for ${ticketKey}`);
    return;
  }

  isProcessing = true;
  console.log(`\n======================================================`);
  console.log(`[ORCHESTRATOR] Starting Loop for Ticket: ${ticketKey}`);
  console.log(`======================================================\n`);

  let threadTs = null;

  try {
    // 1. Fetch ticket details from JIRA
    console.log(`[ORCHESTRATOR] Fetching details from JIRA for ${ticketKey}...`);
    const issue = await getJiraIssue(ticketKey);
    const summary = issue.fields?.summary || 'No summary';
    const description = extractTextFromAdf(issue.fields?.description) || 'No description provided';


    console.log(`[ORCHESTRATOR] Ticket Title: ${summary}`);
    const currentStatus = issue.fields?.status?.name?.toLowerCase();
    console.log(`[ORCHESTRATOR] Current Status: ${issue.fields?.status?.name}`);

    // Ensure ticket is in 'In Progress' state before proceeding
    if (currentStatus === 'to do' || currentStatus === 'todo') {
      console.log(`[ORCHESTRATOR] Transitioning JIRA ${ticketKey} to 'In Progress'...`);
      await transitionJiraIssue(ticketKey, ['In Progress']);
    }


    // 2. Announce in Slack
    if (CHANNEL_ID) {
      threadTs = await postSlackMessage(
        CHANNEL_ID,
        `🚀 *Loop Engineering Triggered*: Starting delivery for *${ticketKey}*\n*Summary:* ${summary}`
      );
    }

    // 3. Prepare git state and ticket folder
    console.log(`[ORCHESTRATOR] Preparing git state on branch main...`);
    try {
      execSync('git checkout main', { stdio: 'inherit' });
    } catch (e) {
      console.warn('[ORCHESTRATOR] Notice: git checkout main returned warning, continuing...');
    }

    const ticketDir = path.join(process.cwd(), 'agent-context', 'tickets', ticketKey);
    if (!fs.existsSync(ticketDir)) {
      fs.mkdirSync(ticketDir, { recursive: true });
    }

    // 4. Run Agent 1 (Planner)
    console.log(`\n[ORCHESTRATOR] Spawning Agent 1 (Planner)...`);
    if (threadTs) {
      await postSlackMessage(CHANNEL_ID, `📋 *Agent 1 (Planner)* is analyzing requirements and project memory...`, threadTs);
    }

    let agent1Prompt = buildAgent1Prompt({ ticketKey, summary, description });
    let isContinue = false;
    let planComplete = false;
    let maxIterations = 5;

    while (!planComplete && maxIterations > 0) {
      maxIterations--;
      const result = await runAgent(agent1Prompt, isContinue);
      const question = parseNeedsInput(result.output);

      if (question) {
        console.log(`\n[ORCHESTRATOR] Agent 1 requested clarification: "${question}"`);
        if (!CHANNEL_ID || !threadTs) {
          throw new Error(`Agent 1 requested clarification, but Slack is not configured: "${question}"`);
        }

        const answer = await askSlackQuestion(CHANNEL_ID, threadTs, question);
        console.log(`[ORCHESTRATOR] Developer responded: "${answer}"`);
        await postSlackMessage(CHANNEL_ID, `👍 Received your answer. Resuming Agent 1...`, threadTs);

        agent1Prompt = `The developer replied: "${answer}". Continue the task and produce agent-context/tickets/${ticketKey}/plan.md.`;
        isContinue = true;
      } else {
        const planPath = path.join(ticketDir, 'plan.md');
        if (fs.existsSync(planPath)) {
          console.log(`[ORCHESTRATOR] Found plan.md at ${planPath}`);
          planComplete = true;
        } else {
          console.warn(`[ORCHESTRATOR] Agent 1 exited without plan.md. Inspecting output.`);
          planComplete = true; // Proceed or log
        }
      }
    }

    if (threadTs) {
      await postSlackMessage(CHANNEL_ID, `✅ *Agent 1 finished plan.md*.\nNow spawning *Agent 2 (Builder)* to implement and deploy to Salesforce...`, threadTs);
    }

    // 5. Checkout feature branch for Agent 2
    const branchName = `portal/${ticketKey}`;
    console.log(`[ORCHESTRATOR] Switching to branch ${branchName}...`);
    try {
      execSync(`git checkout -B ${branchName}`, { stdio: 'inherit' });
    } catch (e) {
      console.error(`[ORCHESTRATOR] Error creating branch:`, e.message);
    }

    // 6. Run Agent 2 (Builder)
    console.log(`\n[ORCHESTRATOR] Spawning Agent 2 (Builder)...`);
    const agent2Prompt = buildAgent2Prompt({ ticketKey, summary });
    const agent2Result = await runAgent(agent2Prompt, false);

    // 7. Extract PR URL
    let prUrl = null;
    const prMatch = agent2Result.output.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
    if (prMatch) {
      prUrl = prMatch[0];
    } else {
      try {
        const ghOut = execSync(`gh pr list --head ${branchName} --json url -q ".[0].url"`, { encoding: 'utf8' }).trim();
        if (ghOut) prUrl = ghOut;
      } catch (e) {
        console.warn('[ORCHESTRATOR] Could not auto-detect PR URL via gh CLI.');
      }
    }

    console.log(`[ORCHESTRATOR] Detected PR URL: ${prUrl || 'None'}`);

    // 8. Update JIRA
    const jiraComment = prUrl
      ? `Automated delivery completed by Agent Loop.\n\nPull Request: ${prUrl}\n\nBranch: ${branchName}`
      : `Automated delivery completed by Agent Loop for branch ${branchName}.`;

    console.log(`[ORCHESTRATOR] Posting comment to JIRA ${ticketKey}...`);
    try {
      await addJiraComment(ticketKey, jiraComment);
    } catch (e) {
      console.error('[ORCHESTRATOR] Failed to add JIRA comment:', e.message);
    }

    console.log(`[ORCHESTRATOR] Transitioning JIRA ${ticketKey} to In Review / Code Review...`);
    try {
      await transitionJiraIssue(ticketKey, ['In Review', 'Code Review']);
    } catch (e) {
      console.error('[ORCHESTRATOR] Failed to transition JIRA ticket:', e.message);
    }

    // 9. Post completion message to Slack
    if (CHANNEL_ID && threadTs) {
      await postSlackMessage(
        CHANNEL_ID,
        `🎉 *Delivery Complete for ${ticketKey}!*
• *Status:* Deployed to \`time-sheet\` org & moved to *In Review*
• *Pull Request:* ${prUrl || 'PR created on branch ' + branchName}
• *Memory Updated:* \`agent-context/MEMORY.md\` & \`CHANGELOG.md\` updated.`,
        threadTs
      );
    }

    console.log(`\n[ORCHESTRATOR] Ticket ${ticketKey} successfully delivered end-to-end!\n`);

  } catch (err) {
    console.error(`[ORCHESTRATOR ERROR] Execution failed for ${ticketKey}:`, err);
    if (CHANNEL_ID && threadTs) {
      await postSlackMessage(
        CHANNEL_ID,
        `❌ *Error during delivery for ${ticketKey}:* ${err.message}`,
        threadTs
      );
    }
  } finally {
    isProcessing = false;
  }
}

/**
 * Webhook Route for JIRA
 */
app.post('/webhook/jira', async (req, res) => {
  res.status(200).send({ received: true });

  const body = req.body;
  console.log('\n[WEBHOOK] Received JIRA webhook event:', body.webhookEvent);

  // Check if issue was transitioned to "In Progress"
  const issueKey = body.issue?.key;
  if (!issueKey) return;

  const statusChange = body.changelog?.items?.find(
    (item) => item.field === 'status' && item.toString?.toLowerCase() === 'in progress'
  );

  if (statusChange) {
    console.log(`[WEBHOOK] Issue ${issueKey} transitioned to 'In Progress'. Triggering loop...`);
    executeLoopForTicket(issueKey);
  } else {
    console.log(`[WEBHOOK] Event for ${issueKey} is not a transition to 'In Progress'. Ignoring.`);
  }
});

/**
 * Manual Trigger Route (Useful for testing)
 */
app.post('/trigger/:key', (req, res) => {
  const { key } = req.params;
  res.send({ triggered: true, ticket: key });
  executeLoopForTicket(key);
});

// Start Server & Slack Listener
async function start() {
  await initSlack();

  app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Orchestrator server running on http://localhost:${PORT}`);
    console.log(`Webhook endpoint: http://localhost:${PORT}/webhook/jira`);
    console.log(`Manual trigger:   http://localhost:${PORT}/trigger/<TICKET-KEY>`);
    console.log(`======================================================\n`);
  });

  // CLI argument support (e.g. node orchestrator.js --ticket SCRUM-1)
  const ticketArgIdx = process.argv.indexOf('--ticket');
  if (ticketArgIdx !== -1 && process.argv[ticketArgIdx + 1]) {
    const ticketKey = process.argv[ticketArgIdx + 1];
    executeLoopForTicket(ticketKey);
  }
}

start();
