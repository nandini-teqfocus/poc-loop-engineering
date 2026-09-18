import 'dotenv/config';
import express from 'express';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getJiraIssue, addJiraComment, transitionJiraIssue, extractTextFromAdf, getJiraTicketUrl, searchJiraIssues } from './src/jira.js';
import {
  initSlack,
  postSlackMessage,
  askSlackQuestion,
  notifyPhase as notifySlackPhase,
  notifyStageChange as notifySlackStageChange,
  registerTicketThread,
  getTicketThread,
  getPrUrlForTicket,
  postSlackSwitchControl
} from './src/slack.js';
import {
  isTeamsConfigured,
  postTeamsMessage,
  notifyTeamsPhase,
  notifyTeamsStageChange
} from './src/teams.js';
import { runAgent, parseNeedsInput, parseTestResult, parseReviewResult } from './src/agentRunner.js';
import { buildAgent1Prompt, buildAgent2Prompt, buildAgent3Prompt, buildAgent2FixPrompt, buildAgent4ReviewPrompt, buildAgent2PrReviewFixPrompt } from './src/prompts.js';
import { updateTicketState, setActiveTicketKey } from './src/statusResponder.js';
import { isPrReviewAgentEnabled, submitPrReview, auditPullRequest } from './src/prReviewer.js';
import { getSwitchState, toggleSwitch, setSwitchState, isGitHubActionActive, isLocalAgentActive } from './src/switchManager.js';
import { reviewPullRequestDiff } from './src/aiCodeReviewer.js';
import { getPullRequestDetails, getPullRequestDiff, submitReviewSummary } from './src/githubPrClient.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

// Dual-dispatch notification wrappers: sends to Slack and Microsoft Teams in parallel
async function notifyPhase(channel, threadTs, options) {
  const pSlack = (channel && threadTs) ? notifySlackPhase(channel, threadTs, options) : Promise.resolve(null);
  const pTeams = notifyTeamsPhase(options).catch(err => console.warn('[TEAMS WARN]', err.message));
  return await pSlack;
}

async function notifyStageChange(channel, options) {
  const pSlack = channel ? notifySlackStageChange(channel, options) : Promise.resolve(null);
  const pTeams = notifyTeamsStageChange(options).catch(err => console.warn('[TEAMS WARN]', err.message));
  return await pSlack;
}

let isProcessing = false;
const handledStageTransitions = new Set();

/**
 * Execute the autonomous delivery loop for a given ticket
 */
export async function executeLoopForTicket(ticketKey) {
  if (isProcessing) {
    console.warn(`[ORCHESTRATOR] Already processing a ticket. Skipping request for ${ticketKey}`);
    return;
  }

  isProcessing = true;
  setActiveTicketKey(ticketKey);
  handledStageTransitions.add(`${ticketKey}_in_progress`);
  updateTicketState(ticketKey, {
    summary: 'Initializing ticket...',
    isRunning: true,
    currentPhaseNumber: 1,
    currentPhaseName: 'Ticket Ingestion & Initialization',
    lastActivity: 'Fetching ticket details from JIRA',
    nextPhase: 'Phase 2: Planning & Requirement Analysis (Agent 1)'
  });

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

      updateTicketState(ticketKey, {
        summary,
        jiraStatus: issue.fields?.status?.name || 'In Progress',
        lastActivity: 'Ingested JIRA ticket details'
      });

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
      await postTeamsMessage(
        `🚀 *Loop Engineering Triggered*: Starting delivery for *${ticketKey}*\n*Summary:* ${summary}`,
        { jiraUrl, title: `Loop Engineering Triggered: ${ticketKey}` }
      ).catch(() => {});

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
      updateTicketState(ticketKey, {
        currentPhaseNumber: 2,
        currentPhaseName: 'Planning & Requirement Analysis (Agent 1)',
        lastActivity: 'Agent 1 is analyzing requirements and living memory...',
        nextPhase: 'Phase 3: Branch Setup & Environment Preparation'
      });
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

          updateTicketState(ticketKey, {
            isWaitingInput: true,
            activeQuestion: question,
            lastActivity: 'Waiting for developer clarification in Slack'
          });

          const answer = await askSlackQuestion(CHANNEL_ID, threadTs, question);
          console.log(`[ORCHESTRATOR] Developer responded: "${answer}"`);
          await postSlackMessage(CHANNEL_ID, `👍 Received your answer. Resuming Agent 1...`, threadTs);

          updateTicketState(ticketKey, {
            isWaitingInput: false,
            activeQuestion: null,
            lastActivity: 'Developer answered clarification; resuming planning'
          });

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
      updateTicketState(ticketKey, {
        currentPhaseNumber: 3,
        currentPhaseName: 'Branch Setup & Environment Preparation',
        branchName,
        lastActivity: `Setting up feature branch ${branchName}`,
        nextPhase: 'Phase 4: Implementation & Salesforce Deployment (Agent 2)'
      });

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
      updateTicketState(ticketKey, {
        currentPhaseNumber: 4,
        currentPhaseName: 'Implementation & Salesforce Deployment (Agent 2)',
        lastActivity: 'Agent 2 is creating metadata XML and deploying to time-sheet org',
        nextPhase: 'Phase 5: Automated PR Review (Agent 4)'
      });

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
      updateTicketState(ticketKey, {
        prUrl,
        lastActivity: `Pull Request opened: ${prUrl || 'branch ' + branchName}`,
        nextPhase: 'Phase 5: Automated PR Review (Agent 4)'
      });

      await notifyPhase(CHANNEL_ID, threadTs, {
        phaseNumber: 4,
        phaseName: 'Implementation & Salesforce Deployment (Agent 2)',
        status: 'Completed',
        summary: `Metadata created/updated, deployed successfully to \`time-sheet\` org, living memory (\`MEMORY.md\` & \`CHANGELOG.md\`) updated, changes committed and PR created (${prUrl || 'branch ' + branchName}).`,
        nextPhase: 'Phase 5: Automated PR Review (Agent 4)',
        jiraUrl,
        githubUrl: prUrl
      });

      // Phase 5: Automated PR Review (Switch Mode: GitHub Actions vs Local Agent)
      currentPhase = { number: 5, name: 'Automated PR Review' };
      if (isGitHubActionActive()) {
        console.log(`[ORCHESTRATOR] 🚀 GitHub Actions Mode is ACTIVE for ${ticketKey}. PR review is executed in GitHub Actions CI/CD (Local tokens saved).`);
        updateTicketState(ticketKey, {
          currentPhaseNumber: 5,
          currentPhaseName: 'Automated PR Review (GitHub Actions Active)',
          lastActivity: 'PR Review workflow is active in GitHub Actions CI/CD',
          nextPhase: 'Phase 6: JIRA Finalization'
        });
        if (CHANNEL_ID && threadTs) {
          await notifyPhase(CHANNEL_ID, threadTs, {
            phaseNumber: 5,
            phaseName: 'Automated PR Review (GitHub Actions)',
            status: 'Running in GitHub Actions',
            summary: `*GitHub Actions Mode is ACTIVE.* The PR Review Agent runs directly in GitHub Actions CI/CD on PR events to optimize token usage. Local Agent 4 is on standby.`,
            nextPhase: 'Phase 6: JIRA Finalization',
            jiraUrl,
            githubUrl: prUrl
          });
        }
      } else {
        console.log(`[ORCHESTRATOR] 💻 Local Agent Mode is ACTIVE (GitHub Action is disabled). Spawning Agent 4 locally for ${ticketKey}.`);
        updateTicketState(ticketKey, {
          currentPhaseNumber: 5,
          currentPhaseName: 'Automated PR Review (Agent 4 - Local)',
          lastActivity: 'Agent 4 is reviewing PR diff locally against acceptance criteria',
          nextPhase: 'Phase 6: JIRA Finalization'
        });
        await runPrReviewWorkflow({
          ticketKey,
          summary,
          description,
          prUrl,
          branchName,
          threadTs
        });
      }

      // Phase 6: JIRA Finalization & Transition to In Review
      currentPhase = { number: 6, name: 'JIRA Finalization' };
      updateTicketState(ticketKey, {
        currentPhaseNumber: 6,
        currentPhaseName: 'JIRA Finalization',
        jiraStatus: 'In Review',
        lastActivity: 'Transitioning JIRA ticket to In Review',
        nextPhase: 'Phase 7: QA Validation & Acceptance Testing (Agent 3)'
      });
      const jiraComment = prUrl
        ? `Automated delivery completed and PR approved by Review Agent.\n\nPull Request: ${prUrl}\n\nBranch: ${branchName}`
        : `Automated delivery completed for branch ${branchName}.`;

      console.log(`[ORCHESTRATOR] Posting comment to JIRA ${ticketKey}...`);
      try {
        await addJiraComment(ticketKey, jiraComment);
      } catch (e) {
        console.error('[ORCHESTRATOR] Failed to add JIRA comment:', e.message);
      }

      console.log(`[ORCHESTRATOR] Transitioning JIRA ${ticketKey} to In Review...`);
      try {
        await transitionJiraIssue(ticketKey, ['In Review', 'Code Review']);
        await notifyStageChange(CHANNEL_ID, {
          ticketKey,
          fromStage: 'In Progress',
          toStage: 'In Review',
          summary: `PR reviewed and approved. Work submitted for QA validation via PR: ${prUrl || branchName}`,
          jiraUrl,
          githubUrl: prUrl,
          threadTs
        });
      } catch (e) {
        console.error('[ORCHESTRATOR] Failed to transition JIRA ticket:', e.message);
      }

      await notifyPhase(CHANNEL_ID, threadTs, {
        phaseNumber: 6,
        phaseName: 'JIRA Finalization',
        status: 'Completed',
        summary: `PR approved. Transitioned issue status to *In Review* for QA testing.`,
        nextPhase: 'Phase 7: QA Validation & Acceptance Testing (Agent 3)',
        jiraUrl,
        githubUrl: prUrl
      });

      // Phase 7: QA Validation & Acceptance Testing (Agent 3)
      currentPhase = { number: 7, name: 'QA Validation & Acceptance Testing (Agent 3)' };
      updateTicketState(ticketKey, {
        currentPhaseNumber: 7,
        currentPhaseName: 'QA Validation & Acceptance Testing (Agent 3)',
        lastActivity: 'Agent 3 is verifying schema and acceptance criteria in target org',
        nextPhase: 'Done'
      });
      await runTesterWorkflow({
        ticketKey,
        summary,
        branchName,
        prUrl,
        threadTs
      });

      updateTicketState(ticketKey, {
        currentPhaseNumber: 7,
        currentPhaseName: 'QA Testing Passed',
        lastActivity: 'Feature delivered, reviewed, and tested end-to-end!',
        jiraStatus: 'Done',
        isRunning: false
      });

      console.log(`\n[ORCHESTRATOR] Ticket ${ticketKey} successfully delivered, reviewed, and tested end-to-end!\n`);

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
    await postTeamsMessage(
      `❌ *Error during delivery for ${ticketKey}:* ${err.message}`,
      { jiraUrl, title: `Delivery Error: ${ticketKey}` }
    ).catch(() => {});
  } finally {
    isProcessing = false;
    setActiveTicketKey(null);
  }
}

// Export PR review utilities from src/prReviewer.js
export { submitPrReview, isPrReviewAgentEnabled, auditPullRequest };

/**
 * Executes the PR Review Workflow (Agent 4):
 * - Checks if PR Review Agent is enabled via switch (ENABLE_PR_REVIEW_AGENT)
 * - Fetches linked JIRA ticket requirements & acceptance criteria
 * - Reviews GitHub PR diff and code changes
 * - If missing items found:
 *   - Adds comment on GitHub PR explaining what needs to be fixed
 *   - Sends review failure update to Slack thread
 *   - Spawns Agent 2 (Builder in Fix Mode) to fix the issues, commit & push to PR
 *   - Re-reviews until passes
 * - If everything covered:
 *   - Approves the PR on GitHub
 *   - Sends review approval update to Slack thread
 * - Only allows the ticket to proceed once the PR review passes!
 */
export async function runPrReviewWorkflow({ ticketKey, summary, description, prUrl, branchName, threadTs }) {
  const jiraUrl = getJiraTicketUrl(ticketKey);
  const effectivePrUrl = prUrl || getPrUrlForTicket(ticketKey);
  const effectiveBranch = branchName || `portal/${ticketKey}`;

  // Configurable Switch Check
  if (!isPrReviewAgentEnabled()) {
    console.log(`[ORCHESTRATOR] PR Review Agent is disabled via configuration switch (ENABLE_PR_REVIEW_AGENT=false). Skipping review for ${ticketKey}.`);
    if (CHANNEL_ID && threadTs) {
      await postSlackMessage(
        CHANNEL_ID,
        `⚡ *PR Review Skipped for ${ticketKey}:* PR Review Agent is currently disabled (\`ENABLE_PR_REVIEW_AGENT=false\`).`,
        threadTs,
        { jiraUrl, githubUrl: effectivePrUrl }
      );
    }
    return { approved: true, skipped: true };
  }

  // Resolve PR number
  let prNumber = null;
  const prNumMatch = effectivePrUrl?.match(/\/pull\/(\d+)/);
  if (prNumMatch) prNumber = prNumMatch[1];
  if (!prNumber) {
    try {
      const ghOut = execSync(`gh pr view ${effectiveBranch} --json number -q ".number"`, { encoding: 'utf8' }).trim();
      if (ghOut) prNumber = ghOut;
    } catch (e) {}
  }

  console.log(`\n======================================================`);
  console.log(`[ORCHESTRATOR] Starting PR Review Workflow for ${ticketKey}`);
  console.log(`PR: ${effectivePrUrl || effectiveBranch} (PR #${prNumber || 'N/A'})`);
  console.log(`======================================================\n`);

  const MAX_REVIEW_ITERATIONS = 3;
  let iteration = 0;
  let reviewPassed = false;

  while (!reviewPassed && iteration < MAX_REVIEW_ITERATIONS) {
    iteration++;
    console.log(`\n[ORCHESTRATOR] Running PR Review Iteration ${iteration} for ${ticketKey}...`);

    // 1. Notify Slack: PR Review Started
    if (CHANNEL_ID && threadTs) {
      await notifyPhase(CHANNEL_ID, threadTs, {
        phaseNumber: 5,
        phaseName: `PR Review & Code Quality (Iteration ${iteration})`,
        status: 'Started',
        summary: `Agent 4 (PR Reviewer) is inspecting code diff, verifying acceptance criteria against JIRA ${ticketKey}...`,
        nextPhase: null,
        jiraUrl,
        githubUrl: effectivePrUrl,
        allowDuplicate: true
      });
    }

    // 2. Perform Code Review (Gemini 3.6 Flash primary, legacy agent fallback)
    let outcome = null;
    let geminiReview = null;

    if (process.env.GEMINI_API_KEY && prNumber) {
      console.log(`[ORCHESTRATOR] 🤖 Executing Gemini 3.6 Flash Code Review for PR #${prNumber}...`);
      try {
        const prDetails = getPullRequestDetails(prNumber);
        const diff = getPullRequestDiff(prNumber);

        if (!diff || diff.trim().length === 0) {
          console.log(`[ORCHESTRATOR] PR #${prNumber} has no reviewable source code diff. Auto-approving.`);
          outcome = { approved: true, summary: 'No reviewable code changes detected.' };
        } else {
          geminiReview = await reviewPullRequestDiff({
            diff,
            changedFiles: prDetails.reviewableFiles,
            prTitle: prDetails.title || summary,
            branchName: effectiveBranch
          });

          // Write audit report file
          const reviewReportPath = path.join(process.cwd(), 'agent-context', 'tickets', ticketKey, 'pr-review.md');
          const reportDir = path.dirname(reviewReportPath);
          if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

          let reportMd = `# Gemini AI Code Review: ${ticketKey} (Iteration ${iteration})\n\n` +
            `- **PR**: #${prNumber}\n` +
            `- **Verdict**: ${geminiReview.verdict}\n` +
            `- **Overall Score**: ${geminiReview.overallScore} / 10\n` +
            `- **Summary**: ${geminiReview.summary}\n\n`;

          if (geminiReview.highlights?.length > 0) {
            reportMd += `## Highlights\n${geminiReview.highlights.map(h => `- ${h}`).join('\n')}\n\n`;
          }

          if (geminiReview.securityAdvisories?.length > 0) {
            reportMd += `## Security Advisories\n${geminiReview.securityAdvisories.map(s => `- **[${s.severity}] ${s.title}**: ${s.description} (${s.cweOrOwasp || 'N/A'})`).join('\n')}\n\n`;
          }

          if (geminiReview.inlineComments?.length > 0) {
            reportMd += `## Issues & Recommendations\n${geminiReview.inlineComments.map(c => `- **[${c.severity}] \`${c.filePath}:${c.line}\`** [${c.category}]: ${c.comment}${c.suggestedFix ? `\n  - *Suggested Fix:*\n\`\`\`\n${c.suggestedFix}\n\`\`\`` : ''}`).join('\n')}\n\n`;
          }

          reportMd += `\nREVIEW_RESULT: ${geminiReview.verdict}\n`;

          const commentsList = (geminiReview.inlineComments || []).map(c => `- [${c.severity} | ${c.category}] ${c.filePath}:${c.line} — ${c.comment}${c.suggestedFix ? ` (Fix: ${c.suggestedFix})` : ''}`).join('\n');
          const securityList = (geminiReview.securityAdvisories || []).map(s => `- [SECURITY ${s.severity}] ${s.title}: ${s.description}`).join('\n');
          const combinedIssues = [securityList, commentsList].filter(Boolean).join('\n') || geminiReview.summary;

          if (geminiReview.verdict !== 'APPROVED') {
            reportMd += `REVIEW_COMMENTS:\n${combinedIssues}\n`;
          }

          fs.writeFileSync(reviewReportPath, reportMd, 'utf8');

          // Submit review findings directly to GitHub PR
          try {
            submitReviewSummary(prNumber, geminiReview, prDetails);
          } catch (ghErr) {
            console.warn('[ORCHESTRATOR] GitHub review submit note:', ghErr.message);
          }

          outcome = {
            approved: geminiReview.verdict === 'APPROVED',
            summary: geminiReview.summary,
            reviewComments: combinedIssues,
            geminiReview
          };
        }
      } catch (geminiErr) {
        console.warn(`[ORCHESTRATOR] Gemini AI Code Review encountered error: ${geminiErr.message}. Falling back to prompt runner...`);
      }
    }

    if (!outcome) {
      // Fallback: Legacy Agent 4 review prompt
      const reviewPrompt = buildAgent4ReviewPrompt({
        ticketKey,
        summary,
        description,
        prUrl: effectivePrUrl,
        prNumber,
        branchName: effectiveBranch,
        iteration
      });

      const reviewResult = await runAgent(reviewPrompt, false);
      outcome = parseReviewResult(reviewResult.output, ticketKey);
    }

    console.log(`[ORCHESTRATOR] PR Review Iteration ${iteration} verdict: ${outcome.approved ? 'APPROVED' : 'CHANGES_REQUESTED'}`);

    if (outcome.approved) {
      reviewPassed = true;

      // 3. Approve the PR on GitHub if not already submitted via Gemini
      if (prNumber && !outcome.geminiReview) {
        console.log(`[ORCHESTRATOR] Submitting approval on GitHub PR #${prNumber}...`);
        submitPrReview(prNumber, {
          action: 'APPROVE',
          body: `All acceptance criteria and technical requirements for **${ticketKey}** verified successfully.\n\n### Review Summary\n${outcome.summary}`
        });
      }

      // 4. Send review approval to Slack thread
      if (CHANNEL_ID && threadTs) {
        await notifyPhase(CHANNEL_ID, threadTs, {
          phaseNumber: 5,
          phaseName: 'PR Review & Code Quality (Agent 4)',
          status: 'Completed',
          summary: `Pull Request verified and approved. ${outcome.geminiReview ? `Gemini Score: ${outcome.geminiReview.overallScore}/10. ` : ''}Review audit: \`agent-context/tickets/${ticketKey}/pr-review.md\`.`,
          nextPhase: 'Phase 6: JIRA Finalization & QA Testing',
          jiraUrl,
          githubUrl: effectivePrUrl,
          allowDuplicate: true
        });

        const scoreLine = outcome.geminiReview ? `• *Code Quality Score:* \`${outcome.geminiReview.overallScore} / 10\`\n` : '';
        const highlightsLine = outcome.geminiReview?.highlights?.length ? `• *Highlights:*\n${outcome.geminiReview.highlights.slice(0, 2).map(h => `  - ${h}`).join('\n')}\n` : '';

        await postSlackMessage(
          CHANNEL_ID,
          `✅ *GitHub PR #${prNumber || 'Current'} Approved by Review Agent!*
• *Ticket:* *${ticketKey}*
• *Verdict:* Approved
${scoreLine}• *Summary:* ${outcome.summary}
${highlightsLine}• *Next Step:* Proceeding to JIRA Finalization & QA Testing...`,
          threadTs,
          { jiraUrl, githubUrl: effectivePrUrl, enableAiReviewButton: false }
        );
      }

      break;

    } else {
      // Reviewer found missing requirements or bugs!
      console.log(`[ORCHESTRATOR] PR Reviewer requested changes: ${outcome.reviewComments}`);

      // 1. Add clear comment on GitHub PR explaining what needs to be fixed (if not already posted by Gemini)
      if (prNumber && !outcome.geminiReview) {
        console.log(`[ORCHESTRATOR] Adding review comment to GitHub PR #${prNumber}...`);
        submitPrReview(prNumber, {
          action: 'REQUEST_CHANGES',
          body: `The PR Review Agent reviewed this PR against JIRA ticket **${ticketKey}**.\n\n### Required Fixes:\n${outcome.reviewComments}\n\n*Action:* Builder agent is automatically addressing these items.`
        });
      }

      // 2. Send review result to Slack thread
      if (CHANNEL_ID && threadTs) {
        await notifyPhase(CHANNEL_ID, threadTs, {
          phaseNumber: 5,
          phaseName: `PR Review & Code Quality (Iteration ${iteration})`,
          status: 'Failed',
          summary: `PR Review found missing criteria or issues: ${outcome.reviewComments}`,
          nextPhase: null,
          jiraUrl,
          githubUrl: effectivePrUrl,
          allowDuplicate: true
        });

        const scoreLine = outcome.geminiReview ? `• *Code Quality Score:* \`${outcome.geminiReview.overallScore} / 10\`\n` : '';
        await postSlackMessage(
          CHANNEL_ID,
          `🔍 *PR Review Changes Requested for ${ticketKey} (PR #${prNumber || 'Current'})*
${scoreLine}• *Issues to Fix:*
>${outcome.reviewComments.replace(/\n/g, '\n>')}
• *Action:* Spawning Agent 2 (Builder) to resolve review comments and update PR...`,
          threadTs,
          { jiraUrl, githubUrl: effectivePrUrl, enableAiReviewButton: false }
        );
      }

      // 3. Spawn Agent 2 (Builder) to fix the issues and update PR
      console.log(`[ORCHESTRATOR] Spawning Agent 2 (Builder) to address PR review comments...`);
      const fixPrompt = buildAgent2PrReviewFixPrompt({
        ticketKey,
        summary,
        branchName: effectiveBranch,
        prNumber,
        reviewComments: outcome.reviewComments,
        iteration
      });

      const fixResult = await runAgent(fixPrompt, false);
      if (fixResult.code !== 0) {
        throw new Error(`Agent 2 PR fix process exited with code ${fixResult.code}`);
      }

      // 4. Notify Slack of PR update
      if (CHANNEL_ID && threadTs) {
        await postSlackMessage(
          CHANNEL_ID,
          `🔧 *PR Updated with Fixes for ${ticketKey} (Iteration ${iteration})*
• Builder addressed review comments, redeployed to \`time-sheet\` org, and pushed commits to PR #${prNumber}.
• Re-invoking PR Review Agent to verify fixes...`,
          threadTs,
          { jiraUrl, githubUrl: effectivePrUrl }
        );
      }

      // Loop continues to next iteration for re-review!
    }
  }

  // Only allow the ticket to proceed once the PR review passes!
  if (!reviewPassed) {
    throw new Error(`Execution halted: PR review did not pass after ${MAX_REVIEW_ITERATIONS} iterations for ${ticketKey}.`);
  }

  return { success: true, prNumber, effectivePrUrl };
}

/**
 * Standalone PR Review Runner
 */
export async function runPrReviewForTicket(ticketKey) {
  if (isProcessing) {
    console.warn(`[ORCHESTRATOR] Already processing a task. Skipping review trigger for ${ticketKey}`);
    return;
  }

  if (!isPrReviewAgentEnabled()) {
    console.log(`[ORCHESTRATOR] Standalone review requested for ${ticketKey}, but PR Review Agent is disabled via configuration switch (ENABLE_PR_REVIEW_AGENT=false).`);
    const threadTs = getTicketThread(ticketKey);
    if (CHANNEL_ID) {
      await postSlackMessage(
        CHANNEL_ID,
        `⚡ *PR Review Agent is currently disabled* via \`ENABLE_PR_REVIEW_AGENT=false\`. Standalone review for *${ticketKey}* was not executed.`,
        threadTs || null,
        { jiraUrl: getJiraTicketUrl(ticketKey) }
      );
    }
    return;
  }

  isProcessing = true;
  console.log(`\n[ORCHESTRATOR] Standalone PR review trigger for ${ticketKey}`);

  try {
    const issue = await getJiraIssue(ticketKey);
    const summary = issue.fields?.summary || 'No summary';
    const description = extractTextFromAdf(issue.fields?.description) || '';
    const jiraUrl = getJiraTicketUrl(ticketKey);
    const branchName = `portal/${ticketKey}`;
    const prUrl = getPrUrlForTicket(ticketKey);

    let threadTs = getTicketThread(ticketKey);
    if (!threadTs && CHANNEL_ID) {
      threadTs = await postSlackMessage(
        CHANNEL_ID,
        `🔍 *PR Review Triggered*: Inspecting pull request for *${ticketKey}*\n*Summary:* ${summary}`,
        null,
        { jiraUrl, githubUrl: prUrl }
      );
      registerTicketThread(ticketKey, threadTs);
    }

    await postTeamsMessage(
      `🔍 *PR Review Triggered*: Inspecting pull request for *${ticketKey}*\n*Summary:* ${summary}`,
      { jiraUrl, githubUrl: prUrl, title: `PR Review Triggered: ${ticketKey}` }
    ).catch(() => {});

    await runPrReviewWorkflow({
      ticketKey,
      summary,
      description,
      branchName,
      prUrl,
      threadTs
    });
  } catch (err) {
    console.error(`[ORCHESTRATOR ERROR] Standalone PR review failed for ${ticketKey}:`, err);
    if (CHANNEL_ID) {
      const threadTs = getTicketThread(ticketKey);
      await postSlackMessage(
        CHANNEL_ID,
        `❌ *Error during PR Review for ${ticketKey}:* ${err.message}`,
        threadTs,
        { jiraUrl: getJiraTicketUrl(ticketKey) }
      );
    }
    await postTeamsMessage(
      `❌ *Error during PR Review for ${ticketKey}:* ${err.message}`,
      { jiraUrl: getJiraTicketUrl(ticketKey), title: `PR Review Error: ${ticketKey}` }
    ).catch(() => {});
  } finally {
    isProcessing = false;
  }
}

/**
 * Executes the Tester Workflow for a ticket in 'In Review' stage:
 * - Spawns Agent 3 (Tester) to validate against plan.md & Salesforce org
 * - If passes -> transitions ticket from In Review to Done, notifies Slack & JIRA
 * - If fails -> transitions ticket from In Review to In Progress, records bugs in JIRA & Slack,
 *   spawns Agent 2 (Builder in Fix Mode) to fix the bugs and redeploy,
 *   transitions ticket back from In Progress to In Review, and re-tests.
 * - Repeats until all acceptance criteria pass.
 */
export async function runTesterWorkflow({ ticketKey, summary, branchName, prUrl, threadTs }) {
  const jiraUrl = getJiraTicketUrl(ticketKey);
  const effectivePrUrl = prUrl || getPrUrlForTicket(ticketKey);
  const effectiveBranch = branchName || `portal/${ticketKey}`;

  console.log(`\n======================================================`);
  console.log(`[ORCHESTRATOR] Starting QA Tester Workflow for ${ticketKey}`);
  console.log(`======================================================\n`);

  const MAX_TEST_ITERATIONS = 3;
  let iteration = 0;
  let testPassed = false;

  while (!testPassed && iteration < MAX_TEST_ITERATIONS) {
    iteration++;
    console.log(`\n[ORCHESTRATOR] Running QA Test Iteration ${iteration} for ${ticketKey}...`);

    // Notify Slack: Testing Started
    if (CHANNEL_ID && threadTs) {
      await notifyPhase(CHANNEL_ID, threadTs, {
        phaseNumber: 6,
        phaseName: `QA & Acceptance Testing (Iteration ${iteration})`,
        status: 'Started',
        summary: `Agent 3 (Tester) is verifying metadata, dry-run deployment to \`time-sheet\` org, and acceptance criteria in \`plan.md\`...`,
        nextPhase: null,
        jiraUrl,
        githubUrl: effectivePrUrl,
        allowDuplicate: true
      });
    }

    // Spawn Agent 3 (Tester)
    const testerPrompt = buildAgent3Prompt({ ticketKey, summary, iteration });
    const testerResult = await runAgent(testerPrompt, false);

    // Parse Test Result
    const outcome = parseTestResult(testerResult.output, ticketKey);
    console.log(`[ORCHESTRATOR] QA Iteration ${iteration} result for ${ticketKey}: ${outcome.passed ? 'PASSED' : 'FAILED'}`);

    if (outcome.passed) {
      testPassed = true;

      // 1. Move ticket: In Review -> Done
      console.log(`[ORCHESTRATOR] Transitioning JIRA ${ticketKey} to Done...`);
      try {
        await transitionJiraIssue(ticketKey, ['Done', 'Closed', 'Resolved']);
      } catch (e) {
        console.error('[ORCHESTRATOR] Failed to transition JIRA ticket to Done:', e.message);
      }

      // 2. Notify Slack: Stage transition In Review -> Done
      if (CHANNEL_ID && threadTs) {
        await notifyStageChange(CHANNEL_ID, {
          ticketKey,
          fromStage: 'In Review',
          toStage: 'Done',
          summary: `QA & Acceptance Testing passed all criteria on iteration ${iteration}. Ticket marked as Done!`,
          jiraUrl,
          githubUrl: effectivePrUrl,
          threadTs,
          allowDuplicate: true
        });

        // 3. Notify Slack: Phase 6 Completed
        await notifyPhase(CHANNEL_ID, threadTs, {
          phaseNumber: 6,
          phaseName: 'QA & Acceptance Testing',
          status: 'Completed',
          summary: `All criteria verified successfully by Agent 3 (Tester). Audit report saved at \`agent-context/tickets/${ticketKey}/test-report.md\`.`,
          nextPhase: null,
          jiraUrl,
          githubUrl: effectivePrUrl,
          allowDuplicate: true
        });

        // 4. Send final celebratory completion card to Slack
        await postSlackMessage(
          CHANNEL_ID,
          `🏆 *Autonomous Loop & QA Testing Successfully Completed for ${ticketKey}!*
• *Final Stage:* *Done*
• *Verification:* All acceptance criteria in \`plan.md\` verified
• *Target Org:* Deployed & verified in \`time-sheet\`
• *Pull Request:* ${effectivePrUrl || effectiveBranch}`,
          threadTs,
          { jiraUrl, githubUrl: effectivePrUrl }
        );

        await postTeamsMessage(
          `🏆 *Autonomous Loop & QA Testing Successfully Completed for ${ticketKey}!*
• *Final Stage:* *Done*
• *Verification:* All acceptance criteria in \`plan.md\` verified
• *Target Org:* Deployed & verified in \`time-sheet\`
• *Pull Request:* ${effectivePrUrl || effectiveBranch}`,
          { jiraUrl, githubUrl: effectivePrUrl, title: `Autonomous Loop Completed: ${ticketKey}` }
        ).catch(() => {});
      }

      // 5. Add passing comment to JIRA
      try {
        const comment = `✅ QA Acceptance Testing PASSED (Iteration ${iteration})\n\nVerification Summary:\n${outcome.summary}\n\nArtifacts:\n- PR: ${effectivePrUrl || effectiveBranch}\n- Test Report: agent-context/tickets/${ticketKey}/test-report.md\n\nTicket transitioned to Done.`;
        await addJiraComment(ticketKey, comment);
      } catch (e) {
        console.error('[ORCHESTRATOR] Failed to add JIRA completion comment:', e.message);
      }

      break;

    } else {
      // Tester found bugs!
      console.log(`[ORCHESTRATOR] Tester detected bug(s): ${outcome.bugDetails}`);

      // 1. Move ticket: In Review -> In Progress
      console.log(`[ORCHESTRATOR] Transitioning JIRA ${ticketKey} from In Review to In Progress...`);
      try {
        await transitionJiraIssue(ticketKey, ['In Progress']);
      } catch (e) {
        console.error('[ORCHESTRATOR] Failed to transition JIRA ticket to In Progress:', e.message);
      }

      // 2. Notify Slack: Stage transition In Review -> In Progress
      if (CHANNEL_ID && threadTs) {
        await notifyStageChange(CHANNEL_ID, {
          ticketKey,
          fromStage: 'In Review',
          toStage: 'In Progress',
          summary: `QA Tester detected issues during iteration ${iteration}. Transitioning ticket back to In Progress for developer resolution.`,
          jiraUrl,
          githubUrl: effectivePrUrl,
          threadTs,
          allowDuplicate: true
        });

        // 3. Post bug details to Slack thread
        await postSlackMessage(
          CHANNEL_ID,
          `⚠️ *QA Testing Failed (Iteration ${iteration}) for ${ticketKey}*
• *Bug / Failure Details:*
>${outcome.bugDetails.replace(/\n/g, '\n>')}
• *Action Taken:* Ticket transitioned *In Review ➔ In Progress*.
• *Next Step:* Spawning Agent 2 (Builder) in Fix Mode to resolve issues...`,
          threadTs,
          { jiraUrl, githubUrl: effectivePrUrl }
        );
      }

      // 4. Add bug comment to JIRA
      try {
        const bugComment = `❌ QA Acceptance Testing FAILED (Iteration ${iteration})\n\nTester identified the following issues:\n${outcome.bugDetails}\n\nTicket transitioned back to In Progress for developer resolution.`;
        await addJiraComment(ticketKey, bugComment);
      } catch (e) {
        console.error('[ORCHESTRATOR] Failed to add JIRA bug comment:', e.message);
      }

      // 5. Spawn Agent 2 (Builder) in Fix Mode
      console.log(`[ORCHESTRATOR] Spawning Agent 2 (Builder in Fix Mode)...`);
      const fixPrompt = buildAgent2FixPrompt({
        ticketKey,
        summary,
        branchName: effectiveBranch,
        bugDetails: outcome.bugDetails,
        iteration
      });

      const fixResult = await runAgent(fixPrompt, false);
      if (fixResult.code !== 0) {
        throw new Error(`Agent 2 fix process exited with error code ${fixResult.code}`);
      }

      // 6. Move ticket back: In Progress -> In Review
      console.log(`[ORCHESTRATOR] Transitioning JIRA ${ticketKey} from In Progress to In Review...`);
      try {
        await transitionJiraIssue(ticketKey, ['In Review', 'Code Review']);
      } catch (e) {
        console.error('[ORCHESTRATOR] Failed to transition JIRA ticket to In Review:', e.message);
      }

      // 7. Notify Slack: Stage transition In Progress -> In Review
      if (CHANNEL_ID && threadTs) {
        await notifyStageChange(CHANNEL_ID, {
          ticketKey,
          fromStage: 'In Progress',
          toStage: 'In Review',
          summary: `Agent 2 (Builder) resolved reported bugs and redeployed to \`time-sheet\` org. Re-submitting for testing.`,
          jiraUrl,
          githubUrl: effectivePrUrl,
          threadTs,
          allowDuplicate: true
        });

        await postSlackMessage(
          CHANNEL_ID,
          `🔧 *Fix Applied & Re-submitted for ${ticketKey} (Iteration ${iteration})*
• Fixes committed, pushed to branch \`${effectiveBranch}\`, and redeployed to \`time-sheet\` org.
• Ticket transitioned *In Progress ➔ In Review*.
• Re-invoking Agent 3 (Tester) for validation...`,
          threadTs,
          { jiraUrl, githubUrl: effectivePrUrl }
        );
      }

      // Loop continues to next iteration for re-testing!
    }
  }

  if (!testPassed) {
    throw new Error(`QA testing could not pass after ${MAX_TEST_ITERATIONS} iterations for ${ticketKey}.`);
  }
}

/**
 * Standalone Tester runner (invoked directly or via webhook)
 */
export async function runTesterWorkflowForTicket(ticketKey) {
  if (isProcessing) {
    console.warn(`[ORCHESTRATOR] Already processing a task. Skipping tester trigger for ${ticketKey}`);
    return;
  }

  isProcessing = true;
  handledStageTransitions.add(`${ticketKey}_in_review`);
  console.log(`\n[ORCHESTRATOR] Standalone tester trigger for ${ticketKey}`);

  try {
    const issue = await getJiraIssue(ticketKey);
    const summary = issue.fields?.summary || 'No summary';
    const jiraUrl = getJiraTicketUrl(ticketKey);
    const branchName = `portal/${ticketKey}`;
    const prUrl = getPrUrlForTicket(ticketKey);

    let threadTs = getTicketThread(ticketKey);
    if (!threadTs && CHANNEL_ID) {
      threadTs = await postSlackMessage(
        CHANNEL_ID,
        `🔍 *Tester Workflow Triggered*: Validating implementation for *${ticketKey}*\n*Summary:* ${summary}`,
        null,
        { jiraUrl, githubUrl: prUrl }
      );
      registerTicketThread(ticketKey, threadTs);
    }

    await runTesterWorkflow({
      ticketKey,
      summary,
      branchName,
      prUrl,
      threadTs
    });
  } catch (err) {
    console.error(`[ORCHESTRATOR ERROR] Standalone tester workflow failed for ${ticketKey}:`, err);
    if (CHANNEL_ID) {
      const threadTs = getTicketThread(ticketKey);
      await postSlackMessage(
        CHANNEL_ID,
        `❌ *Error during QA Testing for ${ticketKey}:* ${err.message}`,
        threadTs,
        { jiraUrl: getJiraTicketUrl(ticketKey) }
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
    } else if (toStage.toLowerCase() === 'in review') {
      console.log(`[WEBHOOK] Issue ${issueKey} transitioned to 'In Review'. Triggering Tester workflow...`);
      runTesterWorkflowForTicket(issueKey);
    } else {
      console.log(`[WEBHOOK] Stage '${toStage}' updated in Slack. Autonomous loop not required.`);
    }
  } else {
    // If no changelog item, check if overall issue is "In Progress" or "In Review"
    const currentStatus = body.issue?.fields?.status?.name?.toLowerCase();
    if (currentStatus === 'in progress') {
      console.log(`[WEBHOOK] Issue ${issueKey} status is 'In Progress'. Triggering autonomous delivery loop...`);
      executeLoopForTicket(issueKey);
    } else if (currentStatus === 'in review') {
      console.log(`[WEBHOOK] Issue ${issueKey} status is 'In Review'. Triggering Tester workflow...`);
      runTesterWorkflowForTicket(issueKey);
    } else {
      console.log(`[WEBHOOK] Event for ${issueKey} received without status transition.`);
    }
  }
});

/**
 * Identifies the associated JIRA ticket from a GitHub PR payload
 * Checks branch head ref, title, body, and CHANGELOG.md
 */
export function extractTicketFromPrPayload(body) {
  const pr = body.pull_request || body;
  const candidates = [
    pr.head?.ref,
    pr.title,
    pr.body
  ];

  for (const text of candidates) {
    if (!text || typeof text !== 'string') continue;
    const match = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
    if (match) {
      return match[1].toUpperCase();
    }
  }

  // Also check CHANGELOG.md by PR URL or PR number
  const prUrl = pr.html_url || pr.url;
  if (prUrl) {
    try {
      const changelogPath = path.join(process.cwd(), 'agent-context', 'CHANGELOG.md');
      if (fs.existsSync(changelogPath)) {
        const content = fs.readFileSync(changelogPath, 'utf8');
        const lines = content.split('\n');
        let currentTicket = null;
        for (const line of lines) {
          const ticketMatch = line.match(/\*\*Ticket\*\*:\s*([A-Z][A-Z0-9]+-\d+)/i);
          if (ticketMatch) currentTicket = ticketMatch[1].toUpperCase();
          if (currentTicket && line.includes(prUrl)) {
            return currentTicket;
          }
        }
      }
    } catch (e) {}
  }

  return null;
}

// In-memory set to prevent duplicate PR merge processing
const processedPrMerges = new Set();

/**
 * Handles GitHub PR Merge event:
 * - Identifies ticket and checks if already Done
 * - Transitions JIRA ticket to Done
 * - Posts status change to existing Slack thread
 * - Adds comment to JIRA
 * - Prevents duplicate executions
 */
export async function handlePrMerge({ ticketKey, prUrl, prNumber }) {
  if (!ticketKey) return { success: false, error: 'No ticketKey provided' };

  const dedupeKey = `merge_${ticketKey.toUpperCase()}_pr_${prNumber || prUrl || 'latest'}`;
  if (processedPrMerges.has(dedupeKey)) {
    console.log(`[PR MERGE] Merge event for ${ticketKey} (${dedupeKey}) already processed. Skipping duplicate.`);
    return { success: true, duplicate: true };
  }
  processedPrMerges.add(dedupeKey);

  console.log(`\n======================================================`);
  console.log(`[PR MERGE] Processing merged PR for Ticket: ${ticketKey}`);
  console.log(`PR URL: ${prUrl || 'N/A'}`);
  console.log(`======================================================\n`);

  const jiraUrl = getJiraTicketUrl(ticketKey);
  const effectivePrUrl = prUrl || getPrUrlForTicket(ticketKey);
  const threadTs = getTicketThread(ticketKey);

  try {
    // 1. Fetch current JIRA issue state
    const issue = await getJiraIssue(ticketKey);
    const currentStatus = issue.fields?.status?.name || 'In Review';
    const isAlreadyDone = ['done', 'closed', 'resolved'].includes(currentStatus.toLowerCase());

    console.log(`[PR MERGE] Ticket ${ticketKey} current status: ${currentStatus}`);

    // 2. Transition JIRA ticket to Done if not already Done
    if (!isAlreadyDone) {
      console.log(`[PR MERGE] Transitioning JIRA ${ticketKey} to Done...`);
      try {
        await transitionJiraIssue(ticketKey, ['Done', 'Closed', 'Resolved']);
      } catch (e) {
        console.error(`[PR MERGE] Failed to transition ${ticketKey} to Done:`, e.message);
      }

      // Add comment to JIRA
      try {
        await addJiraComment(
          ticketKey,
          `🔀 Pull Request ${effectivePrUrl ? `(${effectivePrUrl}) ` : ''}merged into \`main\`.\n\nJIRA ticket automatically transitioned to *Done*.`
        );
      } catch (e) {
        console.error('[PR MERGE] Failed to add JIRA comment on PR merge:', e.message);
      }
    } else {
      console.log(`[PR MERGE] Ticket ${ticketKey} is already '${currentStatus}'. No JIRA transition needed.`);
    }

    // 3. Post status change & celebratory card to Slack
    if (CHANNEL_ID) {
      if (!isAlreadyDone) {
        await notifyStageChange(CHANNEL_ID, {
          ticketKey,
          fromStage: currentStatus,
          toStage: 'Done',
          summary: `Pull Request merged into \`main\`. Ticket automatically moved to *Done*!`,
          jiraUrl,
          githubUrl: effectivePrUrl,
          threadTs,
          allowDuplicate: true
        });
      }

      await postSlackMessage(
        CHANNEL_ID,
        `🔀 *Pull Request Merged into \`main\`!*
• *Ticket:* *${ticketKey}*
• *Status:* Moved to *Done*
• *Pull Request:* ${effectivePrUrl || 'Merged into main'}
• *Delivery Lifecycle:* Feature successfully delivered and merged into main branch.`,
        threadTs,
        { jiraUrl, githubUrl: effectivePrUrl }
      );

      await postTeamsMessage(
        `🔀 *Pull Request Merged into \`main\`!*\n• *Ticket:* *${ticketKey}*\n• *Status:* Moved to *Done*\n• *Pull Request:* ${effectivePrUrl || 'Merged into main'}`,
        { jiraUrl, githubUrl: effectivePrUrl, title: `PR Merged: ${ticketKey}` }
      ).catch(() => {});
    }

    console.log(`[PR MERGE] Successfully handled PR merge for ${ticketKey}.\n`);
    return { success: true, ticketKey, status: 'Done' };

  } catch (err) {
    console.error(`[PR MERGE ERROR] Failed to handle PR merge for ${ticketKey}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Webhook Route for GitHub
 */
app.post('/webhook/github', async (req, res) => {
  res.status(200).send({ received: true });

  const event = req.headers['x-github-event'];
  const body = req.body;

  if (event === 'ping') {
    console.log('\n[GITHUB WEBHOOK] Received ping event from GitHub.');
    return;
  }

  console.log(`\n[GITHUB WEBHOOK] Received event: '${event}', action: '${body.action}'`);

  // Handle pull_request event
  if (event === 'pull_request' || body.pull_request) {
    const action = body.action;
    const pr = body.pull_request;
    const isMerged = action === 'closed' && (pr?.merged === true || pr?.merged_at != null);

    if (isMerged) {
      const ticketKey = extractTicketFromPrPayload(body);
      const prUrl = pr.html_url || pr.url;
      const prNumber = pr.number;

      console.log(`[GITHUB WEBHOOK] Detected merged PR #${prNumber} (${prUrl}) for ticket: ${ticketKey || 'UNKNOWN'}`);

      if (ticketKey) {
        await handlePrMerge({
          ticketKey,
          prUrl,
          prNumber
        });
      } else {
        console.warn(`[GITHUB WEBHOOK] Could not associate merged PR #${prNumber} with any JIRA ticket.`);
      }
    } else {
      console.log(`[GITHUB WEBHOOK] PR event action '${action}' (merged: ${pr?.merged}). No merge action required.`);
    }
  }
});

/**
 * Manual Trigger Routes (Useful for testing)
 */
app.post('/trigger/:key', (req, res) => {
  const { key } = req.params;
  res.send({ triggered: true, ticket: key });
  executeLoopForTicket(key);
});

app.post('/trigger-tester/:key', (req, res) => {
  const { key } = req.params;
  res.send({ triggered: true, ticket: key, workflow: 'tester' });
  runTesterWorkflowForTicket(key);
});

app.post('/trigger-review/:key', (req, res) => {
  const { key } = req.params;
  res.send({ triggered: true, ticket: key, workflow: 'pr_review' });
  runPrReviewForTicket(key);
});

app.post('/trigger-merge/:key', async (req, res) => {
  const { key } = req.params;
  const prUrl = req.body?.prUrl || getPrUrlForTicket(key);
  const prNumber = req.body?.prNumber || 1;
  res.send({ triggered: true, ticket: key, workflow: 'pr_merged' });
  await handlePrMerge({ ticketKey: key, prUrl, prNumber });
});

/**
 * HTML Template Renderer for Web Dashboard
 */
function renderDashboardHtml(initialState) {
  const isGHA = initialState.githubActionsActive;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>POC Loop Engineering — Agent Switch Control Panel</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: rgba(30, 41, 59, 0.7);
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --success: #10b981;
      --accent: #8b5cf6;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body {
      background: radial-gradient(circle at 50% 0%, #1e1b4b 0%, #0f172a 75%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 20px;
    }
    .container {
      max-width: 760px;
      width: 100%;
    }
    .header {
      text-align: center;
      margin-bottom: 36px;
    }
    .header h1 {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #60a5fa, #a78bfa, #34d399);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 8px;
    }
    .header p {
      color: var(--text-muted);
      font-size: 15px;
    }
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 32px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
      margin-bottom: 24px;
    }
    .switch-section {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      padding: 24px 0;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 18px;
      border-radius: 9999px;
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      transition: all 0.3s ease;
    }
    .badge.gha {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.4);
    }
    .badge.local {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.4);
    }
    .pulse-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 10px currentColor;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    .toggle-btn {
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      color: white;
      border: none;
      padding: 18px 42px;
      font-size: 17px;
      font-weight: 700;
      border-radius: 14px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 12px;
      box-shadow: 0 10px 20px -5px rgba(37, 99, 235, 0.4);
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .toggle-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 15px 25px -5px rgba(37, 99, 235, 0.6);
    }
    .toggle-btn:active {
      transform: translateY(1px);
    }
    .toggle-btn.btn-local {
      background: linear-gradient(135deg, #059669, #0d9488);
      box-shadow: 0 10px 20px -5px rgba(16, 185, 129, 0.4);
    }
    .toggle-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .description-box {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
      font-size: 14px;
      line-height: 1.6;
      color: var(--text-muted);
      width: 100%;
      margin-top: 10px;
    }
    .description-box strong {
      color: var(--text);
    }
    .action-row {
      display: flex;
      gap: 12px;
      margin-top: 20px;
      width: 100%;
    }
    .secondary-btn {
      flex: 1;
      background: rgba(51, 65, 85, 0.6);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 12px 18px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.2s ease;
      text-decoration: none;
    }
    .secondary-btn:hover {
      background: rgba(71, 85, 105, 0.8);
      border-color: #475569;
    }
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-top: 24px;
    }
    .info-card {
      background: rgba(15, 23, 42, 0.4);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
    }
    .info-card h4 {
      font-size: 13px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .info-card p {
      font-size: 13px;
      line-height: 1.5;
      color: #cbd5e1;
    }
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #1e293b;
      border: 1px solid #475569;
      color: #f8fafc;
      padding: 12px 20px;
      border-radius: 10px;
      font-size: 14px;
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5);
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.3s ease;
      pointer-events: none;
    }
    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎛️ Agent Execution Control Panel</h1>
      <p>POC Loop Engineering &bull; Dynamic PR Reviewer Engine Switch</p>
    </div>

    <div class="card">
      <div class="switch-section">
        <div id="badge" class="badge ${isGHA ? 'gha' : 'local'}">
          <span class="pulse-dot"></span>
          <span id="badge-text">${isGHA ? '🚀 GitHub Actions (Active)' : '💻 Local Agent (Active)'}</span>
        </div>

        <button id="toggleBtn" class="toggle-btn ${isGHA ? '' : 'btn-local'}" onclick="handleToggle()">
          <span id="btnIcon">${isGHA ? '💻' : '🚀'}</span>
          <span id="btnText">${isGHA ? 'Switch to Local Agent' : 'Switch to GitHub Actions'}</span>
        </button>

        <div class="description-box" id="descBox">
          ${isGHA
            ? '<strong>GitHub Actions Mode:</strong> The PR Review workflow is <strong>ACTIVE</strong> in GitHub Actions. PR code audits run in GitHub cloud runners on PR events, reducing local token usage.'
            : '<strong>Local Agent Mode:</strong> GitHub Actions workflow is <strong>DISABLED</strong>. Agent 4 runs locally in Phase 5 of the orchestrator to audit the PR diff and enforce acceptance criteria.'}
        </div>

        <div class="action-row">
          <button class="secondary-btn" onclick="postToSlack()">
            💬 Send Switch Button to Slack
          </button>
          <a class="secondary-btn" href="https://github.com/nandini-teqfocus/poc-loop-engineering/actions" target="_blank">
            🐙 GitHub Actions Tab
          </a>
        </div>
      </div>

      <div class="info-grid">
        <div class="info-card">
          <h4>🚀 GitHub Actions Mode</h4>
          <p>Workflow <code>pr-review.yml</code> is enabled. Triggers automatically on PR events. Local orchestrator saves tokens.</p>
        </div>
        <div class="info-card">
          <h4>💻 Local Agent Mode</h4>
          <p>Workflow is disabled via GitHub API. Agent 4 runs locally in Phase 5 to audit code diffs and request fixes.</p>
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.innerText = msg;
      toast.className = 'toast show';
      setTimeout(() => { toast.className = 'toast'; }, 3000);
    }

    async function handleToggle() {
      const btn = document.getElementById('toggleBtn');
      btn.disabled = true;
      btn.style.opacity = '0.5';

      try {
        const res = await fetch('/api/switch/toggle', { method: 'POST' });
        const data = await res.json();
        updateUI(data.githubActionsActive);
        showToast('Switched to ' + (data.githubActionsActive ? 'GitHub Actions Mode 🚀' : 'Local Agent Mode 💻'));
      } catch (e) {
        showToast('Error toggling switch: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    }

    async function postToSlack() {
      try {
        const res = await fetch('/api/switch/post-to-slack', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('✅ Sent interactive switch card to Slack channel!');
        } else {
          showToast('Error: ' + (data.error || 'Failed to post'));
        }
      } catch (e) {
        showToast('Error posting to Slack: ' + e.message);
      }
    }

    function updateUI(isGHA) {
      const badge = document.getElementById('badge');
      const badgeText = document.getElementById('badge-text');
      const btn = document.getElementById('toggleBtn');
      const btnIcon = document.getElementById('btnIcon');
      const btnText = document.getElementById('btnText');
      const descBox = document.getElementById('descBox');

      if (isGHA) {
        badge.className = 'badge gha';
        badgeText.innerText = '🚀 GitHub Actions (Active)';
        btn.className = 'toggle-btn';
        btnIcon.innerText = '💻';
        btnText.innerText = 'Switch to Local Agent';
        descBox.innerHTML = '<strong>GitHub Actions Mode:</strong> The PR Review workflow is <strong>ACTIVE</strong> in GitHub Actions. PR code audits run in GitHub cloud runners on PR events, reducing local token usage.';
      } else {
        badge.className = 'badge local';
        badgeText.innerText = '💻 Local Agent (Active)';
        btn.className = 'toggle-btn btn-local';
        btnIcon.innerText = '🚀';
        btnText.innerText = 'Switch to GitHub Actions';
        descBox.innerHTML = '<strong>Local Agent Mode:</strong> GitHub Actions workflow is <strong>DISABLED</strong>. Agent 4 runs locally in Phase 5 of the orchestrator to audit the PR diff and enforce acceptance criteria.';
      }
    }

    // Auto-sync every 3 seconds
    setInterval(async () => {
      try {
        const res = await fetch('/api/switch');
        const data = await res.json();
        updateUI(data.githubActionsActive);
      } catch (e) {}
    }, 3000);
  </script>
</body>
</html>`;
}

// Web UI & Switch Control API Routes
app.get(['/', '/switch'], (req, res) => {
  const state = getSwitchState();
  res.send(renderDashboardHtml(state));
});

app.get('/api/switch', (req, res) => {
  res.json(getSwitchState());
});

app.post('/api/switch/toggle', async (req, res) => {
  const newState = toggleSwitch('Web Dashboard Button');
  if (CHANNEL_ID) {
    try {
      const modeText = newState.githubActionsActive
        ? '🚀 *GitHub Actions (Active)* — PR reviews executed in CI/CD (local tokens saved).'
        : '💻 *Local Agent (Active)* — GitHub Action disabled; Agent 4 runs locally.';
      await postSlackMessage(CHANNEL_ID, `🎛️ *PR Review Switch Toggled via Web UI:*\n• Active Mode: ${modeText}`);
    } catch (e) {}
  }
  res.json(newState);
});

app.post('/api/switch/set', async (req, res) => {
  const { active } = req.body;
  const newState = setSwitchState(Boolean(active), 'Web API');
  res.json(newState);
});

app.post('/api/switch/post-to-slack', async (req, res) => {
  if (!CHANNEL_ID) {
    return res.status(400).json({ error: 'SLACK_CHANNEL_ID not configured' });
  }
  try {
    const ts = await postSlackSwitchControl(CHANNEL_ID);
    res.json({ success: true, ts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server & Slack Listener
async function start() {
  await initSlack();

  app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Orchestrator server running on http://localhost:${PORT}`);
    console.log(`JIRA Webhook endpoint:   http://localhost:${PORT}/webhook/jira`);
    console.log(`GitHub Webhook endpoint: http://localhost:${PORT}/webhook/github`);
    console.log(`Manual trigger loop:     http://localhost:${PORT}/trigger/<TICKET-KEY>`);
    console.log(`Manual trigger review:   http://localhost:${PORT}/trigger-review/<TICKET-KEY>`);
    console.log(`Manual trigger tester:   http://localhost:${PORT}/trigger-tester/<TICKET-KEY>`);
    console.log(`Manual trigger merge:    http://localhost:${PORT}/trigger-merge/<TICKET-KEY>`);
    console.log(`======================================================\n`);
  });

  // CLI argument support (e.g. node orchestrator.js --ticket SCRUM-1 or --key SCRUM-1)
  const ticketArgIdx = process.argv.indexOf('--ticket') !== -1
    ? process.argv.indexOf('--ticket')
    : process.argv.indexOf('--key');
  if (ticketArgIdx !== -1 && process.argv[ticketArgIdx + 1]) {
    const ticketKey = process.argv[ticketArgIdx + 1];
    executeLoopForTicket(ticketKey);
  }

  const reviewArgIdx = process.argv.indexOf('--review');
  if (reviewArgIdx !== -1 && process.argv[reviewArgIdx + 1]) {
    const ticketKey = process.argv[reviewArgIdx + 1];
    runPrReviewForTicket(ticketKey);
  }

  const testerArgIdx = process.argv.indexOf('--tester');
  if (testerArgIdx !== -1 && process.argv[testerArgIdx + 1]) {
    const ticketKey = process.argv[testerArgIdx + 1];
    runTesterWorkflowForTicket(ticketKey);
  }

  const mergeArgIdx = process.argv.indexOf('--merge');
  if (mergeArgIdx !== -1 && process.argv[mergeArgIdx + 1]) {
    const ticketKey = process.argv[mergeArgIdx + 1];
    handlePrMerge({ ticketKey });
  }

  // Initialize handled tickets at startup to avoid re-triggering pre-existing active issues
  try {
    const existingActive = await searchJiraIssues({
      jql: "project = SCRUM AND (status = 'In Progress' OR status = 'In Review')",
      maxResults: 20
    });
    for (const issue of existingActive) {
      const status = issue.fields?.status?.name?.toLowerCase();
      if (status === 'in progress') handledStageTransitions.add(`${issue.key}_in_progress`);
      if (status === 'in review') handledStageTransitions.add(`${issue.key}_in_review`);
    }
    console.log(`[POLL INITIALIZED] Initialized active ticket cache (${existingActive.length} existing active issues tracked).`);
  } catch (e) {}

  // Resilient Polling Fallback (every 10s: picks up tickets if webhook or tunnel drops)
  setInterval(async () => {
    if (isProcessing) return;
    try {
      // 1. Check for tickets newly moved to 'In Progress'
      const inProgressIssues = await searchJiraIssues({
        jql: "project = SCRUM AND status = 'In Progress' order by updated DESC",
        maxResults: 5
      });
      for (const issue of inProgressIssues) {
        const dedupeKey = `${issue.key}_in_progress`;
        if (!handledStageTransitions.has(dedupeKey) && !isProcessing) {
          console.log(`\n[POLL DETECT] Issue ${issue.key} moved to 'In Progress'. Triggering autonomous delivery loop...`);
          handledStageTransitions.add(dedupeKey);
          executeLoopForTicket(issue.key);
          break;
        }
      }

      if (isProcessing) return;

      // 2. Check for tickets newly moved to 'In Review'
      const inReviewIssues = await searchJiraIssues({
        jql: "project = SCRUM AND status = 'In Review' order by updated DESC",
        maxResults: 5
      });
      for (const issue of inReviewIssues) {
        const dedupeKey = `${issue.key}_in_review`;
        if (!handledStageTransitions.has(dedupeKey) && !isProcessing) {
          console.log(`\n[POLL DETECT] Issue ${issue.key} moved to 'In Review'. Triggering QA Tester workflow...`);
          handledStageTransitions.add(dedupeKey);
          runTesterWorkflowForTicket(issue.key);
          break;
        }
      }
    } catch (e) {
      // Ignore polling errors during transient network blips
    }
  }, 10000);
}

const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  process.argv[1].endsWith('orchestrator.js')
);

if (isMain) {
  start();
}
