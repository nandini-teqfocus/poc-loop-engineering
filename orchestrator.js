import 'dotenv/config';
import express from 'express';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { getJiraIssue, addJiraComment, transitionJiraIssue, extractTextFromAdf, getJiraTicketUrl } from './src/jira.js';
import { initSlack, postSlackMessage, askSlackQuestion, notifyPhase, notifyStageChange, registerTicketThread, getTicketThread, getPrUrlForTicket } from './src/slack.js';
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
    let currentPhase = { number: 1, name: 'Ticket Ingestion & Initialization' };

    // Phase 1: Ingestion & Initialization
    try {
      // 1. Fetch ticket details from JIRA
      console.log(`[ORCHESTRATOR] Fetching details from JIRA for ${ticketKey}...`);
      const issue = await getJiraIssue(ticketKey);
      const summary = issue.fields?.summary || 'No summary';
      const description = extractTextFromAdf(issue.fields?.description) || 'No description provided';

      console.log(`[ORCHESTRATOR] Ticket Title: ${summary}`);
      const currentStatus = issue.fields?.status?.name?.toLowerCase();
      console.log(`[ORCHESTRATOR] Current Status: ${issue.fields?.status?.name}`);

      // 2. Announce in Slack & register thread
      const jiraUrl = getJiraTicketUrl(ticketKey);
      if (CHANNEL_ID) {
        const existingTs = getTicketThread(ticketKey);
        if (!existingTs) {
          threadTs = await postSlackMessage(
            CHANNEL_ID,
            `🚀 *Loop Engineering Triggered*: Starting delivery for *${ticketKey}*\n*Summary:* ${summary}`,
            null,
            { jiraUrl }
          );
          registerTicketThread(ticketKey, threadTs);
        } else {
          threadTs = existingTs;
          await postSlackMessage(
            CHANNEL_ID,
            `🚀 *Loop Engineering Triggered*: Starting delivery for *${ticketKey}*\n*Summary:* ${summary}`,
            threadTs,
            { jiraUrl }
          );
        }
      }

      // Ensure ticket is in 'In Progress' state before proceeding
      if (currentStatus === 'to do' || currentStatus === 'todo') {
        console.log(`[ORCHESTRATOR] Transitioning JIRA ${ticketKey} to 'In Progress'...`);
        await transitionJiraIssue(ticketKey, ['In Progress']);
        await notifyStageChange(CHANNEL_ID, {
          ticketKey,
          fromStage: issue.fields?.status?.name || 'To Do',
          toStage: 'In Progress',
          summary: `Ticket picked up by autonomous delivery loop.`,
          jiraUrl,
          threadTs
        });
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

      await notifyPhase(CHANNEL_ID, threadTs, {
        phaseNumber: 1,
        phaseName: 'Ticket Ingestion & Initialization',
        status: 'Completed',
        summary: `Fetched JIRA issue details for *${ticketKey}*, transitioned status to *In Progress*, initialized ticket workspace directory on main branch.`,
        nextPhase: 'Phase 2: Planning & Requirement Analysis (Agent 1)',
        jiraUrl
      });

      // Phase 2: Planning & Analysis (Agent 1)
      currentPhase = { number: 2, name: 'Planning & Requirement Analysis (Agent 1)' };
      console.log(`\n[ORCHESTRATOR] Spawning Agent 1 (Planner)...`);

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

      const planPath = path.join(ticketDir, 'plan.md');
      const planCreated = fs.existsSync(planPath);

      await notifyPhase(CHANNEL_ID, threadTs, {
        phaseNumber: 2,
        phaseName: 'Planning & Requirement Analysis (Agent 1)',
        status: planCreated ? 'Completed' : 'Failed',
        summary: planCreated
          ? `Analyzed project memory and requirements. Formulated comprehensive implementation plan at \`agent-context/tickets/${ticketKey}/plan.md\`.`
          : `Agent 1 completed without generating \`agent-context/tickets/${ticketKey}/plan.md\`.`,
        nextPhase: 'Phase 3: Branch Setup & Environment Preparation',
        jiraUrl
      });

      if (!planCreated) {
        throw new Error(`Execution halted: plan.md was not generated by Agent 1.`);
      }

      // Phase 3: Branch Setup & Environment Preparation
      currentPhase = { number: 3, name: 'Branch Setup & Environment Preparation' };
      const branchName = `portal/${ticketKey}`;
      console.log(`[ORCHESTRATOR] Switching to branch ${branchName}...`);
      try {
        execSync(`git checkout -B ${branchName}`, { stdio: 'inherit' });
      } catch (e) {
        console.error(`[ORCHESTRATOR] Error creating branch:`, e.message);
        throw new Error(`Failed to create or switch to branch ${branchName}: ${e.message}`);
      }

      await notifyPhase(CHANNEL_ID, threadTs, {
        phaseNumber: 3,
        phaseName: 'Branch Setup & Environment Preparation',
        status: 'Completed',
        summary: `Created and checked out isolated ticket feature branch \`${branchName}\`.`,
        nextPhase: 'Phase 4: Implementation & Salesforce Deployment (Agent 2)',
        jiraUrl
      });

      // Phase 4: Implementation & Salesforce Deployment (Agent 2)
      currentPhase = { number: 4, name: 'Implementation & Salesforce Deployment (Agent 2)' };
      console.log(`\n[ORCHESTRATOR] Spawning Agent 2 (Builder)...`);
      const agent2Prompt = buildAgent2Prompt({ ticketKey, summary });
      const agent2Result = await runAgent(agent2Prompt, false);

      if (agent2Result.code !== 0) {
        throw new Error(`Agent 2 process exited with non-zero error code: ${agent2Result.code}`);
      }

      // Extract PR URL
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

      await notifyPhase(CHANNEL_ID, threadTs, {
        phaseNumber: 4,
        phaseName: 'Implementation & Salesforce Deployment (Agent 2)',
        status: 'Completed',
        summary: `Metadata created/updated, deployed successfully to \`time-sheet\` org, living memory (\`MEMORY.md\` & \`CHANGELOG.md\`) updated, changes committed and PR created (${prUrl || 'branch ' + branchName}).`,
        nextPhase: 'Phase 5: JIRA & Finalization',
        jiraUrl,
        githubUrl: prUrl
      });

      // Phase 5: JIRA & Finalization
      currentPhase = { number: 5, name: 'JIRA & Finalization' };
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
        await notifyStageChange(CHANNEL_ID, {
          ticketKey,
          fromStage: 'In Progress',
          toStage: 'In Review',
          summary: `Autonomous delivery loop completed. Work submitted for code review via PR: ${prUrl || branchName}`,
          jiraUrl,
          githubUrl: prUrl,
          threadTs
        });
      } catch (e) {
        console.error('[ORCHESTRATOR] Failed to transition JIRA ticket:', e.message);
      }

      await notifyPhase(CHANNEL_ID, threadTs, {
        phaseNumber: 5,
        phaseName: 'JIRA & Finalization',
        status: 'Completed',
        summary: `Posted completion comment with PR reference to JIRA ${ticketKey} and transitioned issue status to *In Review*.`,
        nextPhase: null,
        jiraUrl,
        githubUrl: prUrl
      });

      // Final summary message to Slack with both JIRA and GitHub PR buttons
      if (CHANNEL_ID && threadTs) {
        await postSlackMessage(
          CHANNEL_ID,
          `🎉 *Delivery Complete for ${ticketKey}!*
• *Status:* Deployed to \`time-sheet\` org & moved to *In Review*
• *Pull Request:* ${prUrl || 'PR created on branch ' + branchName}
• *Memory Updated:* \`agent-context/MEMORY.md\` & \`CHANGELOG.md\` updated.`,
          threadTs,
          { jiraUrl, githubUrl: prUrl }
        );
      }

      console.log(`\n[ORCHESTRATOR] Ticket ${ticketKey} successfully delivered end-to-end!\n`);

    } catch (phaseErr) {
      // Send clear failure update for the specific failed phase
      const jiraUrl = getJiraTicketUrl(ticketKey);
      if (CHANNEL_ID && threadTs) {
        await notifyPhase(CHANNEL_ID, threadTs, {
          phaseNumber: currentPhase.number,
          phaseName: currentPhase.name,
          status: 'Failed',
          summary: `Phase failed with error: ${phaseErr.message}`,
          nextPhase: null,
          jiraUrl
        });
      }
      throw phaseErr;
    }

  } catch (err) {
    console.error(`[ORCHESTRATOR ERROR] Execution failed for ${ticketKey}:`, err);
    const jiraUrl = getJiraTicketUrl(ticketKey);
    if (CHANNEL_ID && threadTs) {
      await postSlackMessage(
        CHANNEL_ID,
        `❌ *Error during delivery for ${ticketKey}:* ${err.message}`,
        threadTs,
        { jiraUrl }
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

  const issueKey = body.issue?.key;
  if (!issueKey) return;

  const summary = body.issue?.fields?.summary || '';
  const jiraUrl = getJiraTicketUrl(issueKey);
  const githubUrl = getPrUrlForTicket(issueKey);

  // Check if changelog contains a status/stage change
  const statusItem = body.changelog?.items?.find(
    (item) => item.field === 'status'
  );

  if (statusItem) {
    const fromStage = statusItem.fromString || 'Initial';
    const toStage = statusItem.toString || body.issue?.fields?.status?.name || 'Unknown';
    console.log(`[WEBHOOK] Stage change detected for ${issueKey}: "${fromStage}" ➔ "${toStage}"`);

    await notifyStageChange(CHANNEL_ID, {
      ticketKey: issueKey,
      fromStage,
      toStage,
      summary: summary ? `Ticket: *${summary}*` : null,
      jiraUrl,
      githubUrl
    });

    if (toStage.toLowerCase() === 'in progress') {
      console.log(`[WEBHOOK] Issue ${issueKey} transitioned to 'In Progress'. Triggering autonomous delivery loop...`);
      executeLoopForTicket(issueKey);
    } else {
      console.log(`[WEBHOOK] Stage '${toStage}' updated in Slack. Autonomous loop not required.`);
    }
  } else {
    // If no changelog item, check if overall issue is "In Progress"
    const currentStatus = body.issue?.fields?.status?.name?.toLowerCase();
    if (currentStatus === 'in progress') {
      console.log(`[WEBHOOK] Issue ${issueKey} status is 'In Progress'. Triggering autonomous delivery loop...`);
      executeLoopForTicket(issueKey);
    } else {
      console.log(`[WEBHOOK] Event for ${issueKey} received without status transition.`);
    }
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
