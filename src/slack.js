import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { App } from '@slack/bolt';
import { generateStatusAnswer, getActiveTicketKey } from './statusResponder.js';
import { getSwitchState, toggleSwitch, setSwitchState, isGitHubActionActive } from './switchManager.js';
import { getJiraTicketUrl } from './jira.js';
import { reviewPullRequestDiff } from './aiCodeReviewer.js';
import { getPullRequestDetails, getPullRequestDiff, submitReviewSummary } from './githubPrClient.js';
import { runAgent } from './agentRunner.js';
import { buildAgent2PrReviewFixPrompt } from './prompts.js';

let slackApp = null;
let activeResolvers = new Map(); // threadTs -> resolve function

// In-memory mapping: ticketKey -> parent threadTs
const ticketThreads = new Map();
// In-memory reverse mapping: threadTs -> ticketKey
const threadToTickets = new Map();

// In-memory set to prevent duplicate stage transitions
const sentStageTransitions = new Set();

/**
 * Associates a JIRA ticket key with its active Slack thread timestamp
 * @param {string} ticketKey
 * @param {string} threadTs
 */
export function registerTicketThread(ticketKey, threadTs) {
  if (ticketKey && threadTs) {
    const key = ticketKey.toUpperCase();
    ticketThreads.set(key, threadTs);
    threadToTickets.set(threadTs, key);
  }
}

/**
 * Retrieves the JIRA ticket key associated with a given Slack thread timestamp
 * @param {string} threadTs
 * @returns {string|null}
 */
export function getTicketForThread(threadTs) {
  if (!threadTs) return null;
  if (threadToTickets.has(threadTs)) return threadToTickets.get(threadTs);
  for (const [key, ts] of ticketThreads.entries()) {
    if (ts === threadTs) return key;
  }
  return null;
}

/**
 * Retrieves the Slack thread timestamp for a given JIRA ticket key
 * @param {string} ticketKey
 * @returns {string|null}
 */
export function getTicketThread(ticketKey) {
  if (!ticketKey) return null;
  return ticketThreads.get(ticketKey.toUpperCase()) || null;
}

/**
 * Attempts to locate the GitHub PR URL for a ticket from CHANGELOG.md
 * @param {string} ticketKey
 * @returns {string|null}
 */
export function getPrUrlForTicket(ticketKey) {
  if (!ticketKey) return null;
  const key = ticketKey.toUpperCase();

  // 1. Try finding in CHANGELOG.md
  try {
    const changelogPath = path.join(process.cwd(), 'agent-context', 'CHANGELOG.md');
    if (fs.existsSync(changelogPath)) {
      const content = fs.readFileSync(changelogPath, 'utf8');
      const regex = new RegExp(`- \\*\\*Ticket\\*\\*:\\s*${key}[\\s\\S]*?https:\\/\\/github\\.com\\/[^\\s)]+\\/pull\\/\\d+`, 'i');
      const match = content.match(regex);
      if (match) {
        const prMatch = match[0].match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
        if (prMatch) return prMatch[0];
      }
    }
  } catch (e) {}

  // 2. Try querying GitHub CLI for open or merged PRs matching the ticket key
  try {
    const ghOut = execSync(`gh pr list --state all --search "${key}" --json url -q ".[0].url"`, { encoding: 'utf8' }).trim();
    if (ghOut && ghOut.startsWith('http')) {
      return ghOut;
    }
  } catch (e) {}

  return null;
}

// Track recent transitions per ticket for debouncing duplicate webhooks
const lastTransitionsByTicket = new Map();

/**
 * Sends a dynamic notification to Slack whenever a JIRA ticket changes status/stage
 * @param {string} channel Slack Channel ID
 * @param {Object} options
 * @param {string} options.ticketKey E.g. SCRUM-8
 * @param {string} options.fromStage Previous status/stage name
 * @param {string} options.toStage New status/stage name
 * @param {string} [options.summary] Brief update/context
 * @param {string} [options.jiraUrl] Direct JIRA issue URL
 * @param {string} [options.githubUrl] GitHub PR URL
 * @param {string} [options.threadTs] Optional explicit threadTs override
 * @param {boolean} [options.allowDuplicate=false] Bypass debouncing
 */
export async function notifyStageChange(channel, {
  ticketKey,
  fromStage,
  toStage,
  summary = null,
  jiraUrl = null,
  githubUrl = null,
  threadTs = null,
  allowDuplicate = false
}) {
  if (!channel) return null;

  const normalizedKey = ticketKey?.toUpperCase();
  const effectiveThreadTs = threadTs || (normalizedKey ? ticketThreads.get(normalizedKey) : null);

  // Deduplication key per ticket transition
  const dedupeKey = `${normalizedKey}_${(fromStage || 'none').toLowerCase()}_to_${(toStage || '').toLowerCase()}`;
  const last = lastTransitionsByTicket.get(normalizedKey);
  const now = Date.now();

  // Suppress only if the exact same transition was sent within the last 15 seconds (webhook debounce)
  if (!allowDuplicate && last && last.dedupeKey === dedupeKey && (now - last.timestamp < 15000)) {
    console.log(`[SLACK] Duplicate stage transition suppressed for: ${dedupeKey} (debounced)`);
    return null;
  }
  lastTransitionsByTicket.set(normalizedKey, { dedupeKey, timestamp: now });

  let statusBadge = '🔄';
  const lowerTo = toStage.toLowerCase();
  if (lowerTo.includes('progress')) statusBadge = '⚙️';
  else if (lowerTo.includes('review')) statusBadge = '👀';
  else if (lowerTo.includes('done') || lowerTo.includes('closed') || lowerTo.includes('resolved')) statusBadge = '🎉';
  else if (lowerTo.includes('todo') || lowerTo.includes('to do')) statusBadge = '📝';

  let text = `${statusBadge} *JIRA Stage Updated*: *${ticketKey}*\n`;
  text += `• *Transition:* \`${fromStage || 'Initial'}\` ➔ \`${toStage}\`\n`;
  text += `• *Current Status:* *${toStage}*\n`;

  if (summary) {
    text += `• *Context:* ${summary}\n`;
  } else {
    text += `• *Context:* Ticket transitioned to *${toStage}* in JIRA.\n`;
  }

  const effectiveGithubUrl = githubUrl || (normalizedKey ? getPrUrlForTicket(normalizedKey) : null);
  const buttonOptions = {};
  if (jiraUrl) buttonOptions.jiraUrl = jiraUrl;
  if (effectiveGithubUrl) buttonOptions.githubUrl = effectiveGithubUrl;

  const resTs = await postSlackMessage(channel, text.trim(), effectiveThreadTs, buttonOptions);

  // If this was a top-level message and no thread was mapped yet, register it
  if (!effectiveThreadTs && resTs && normalizedKey) {
    ticketThreads.set(normalizedKey, resTs);
  }

  return resTs;
}

/**
 * Executes a Gemini AI code review triggered directly from Slack (button or thread query)
 */
export async function executeSlackAiReview({ channel, threadTs, prNumber = null, ticketKey = null, user = null }) {
  let targetPrNumber = prNumber;

  if (!targetPrNumber) {
    const effectiveTicket = ticketKey || getTicketForThread(threadTs) || getActiveTicketKey();
    if (effectiveTicket) {
      const prUrl = getPrUrlForTicket(effectiveTicket);
      const match = prUrl?.match(/\/pull\/(\d+)/);
      if (match) targetPrNumber = match[1];
    }
  }

  if (!targetPrNumber) {
    await postSlackMessage(
      channel,
      `⚠️ *Could not detect Pull Request number.* Please specify a PR number, e.g. \`review PR 6\`.`,
      threadTs
    );
    return;
  }

  const userMention = user ? (user.startsWith('U') || user.startsWith('W') ? `<@${user}>` : `*${user}*`) : 'team member';
  await postSlackMessage(
    channel,
    `🤖 *Gemini AI Code Review Triggered* for PR #${targetPrNumber} by ${userMention}!\n_Analyzing changed files & diff with Gemini 3.6 Flash..._`,
    threadTs
  );

  try {
    const prDetails = getPullRequestDetails(targetPrNumber);
    const diff = getPullRequestDiff(targetPrNumber);

    if (!diff || diff.trim().length === 0) {
      await postSlackMessage(
        channel,
        `ℹ️ *PR #${targetPrNumber}* has no reviewable source code changes (only docs, lockfiles, or assets). Review skipped.`,
        threadTs,
        { githubUrl: prDetails.url }
      );
      return;
    }

    const reviewResult = await reviewPullRequestDiff({
      diff,
      changedFiles: prDetails.reviewableFiles,
      prTitle: prDetails.title,
      branchName: prDetails.headBranch
    });

    // Also submit review summary to GitHub PR
    try {
      submitReviewSummary(targetPrNumber, reviewResult, prDetails);
    } catch (ghErr) {
      console.warn('[SLACK AI REVIEW] GitHub review submit note:', ghErr.message);
    }

    const verdictIcon = reviewResult.verdict === 'APPROVED' ? '✅' : '⚠️';
    const verdictBadge = reviewResult.verdict === 'APPROVED' ? 'APPROVED' : 'CHANGES REQUESTED';

    let cardText = `${verdictIcon} *Gemini AI Code Review: PR #${targetPrNumber} — ${verdictBadge}*\n`;
    cardText += `• *Code Quality Score:* \`${reviewResult.overallScore} / 10\`\n`;
    cardText += `• *Title:* ${prDetails.title}\n`;
    cardText += `• *Summary:* ${reviewResult.summary}\n`;

    if (reviewResult.securityAdvisories && reviewResult.securityAdvisories.length > 0) {
      cardText += `\n🛡️ *Security Advisories (${reviewResult.securityAdvisories.length}):*\n`;
      for (const s of reviewResult.securityAdvisories) {
        cardText += `> 🛑 *[${s.severity}] ${s.title}*: ${s.description}\n`;
      }
    }

    if (reviewResult.highlights && reviewResult.highlights.length > 0) {
      cardText += `\n✨ *Key Highlights:*\n`;
      for (const h of reviewResult.highlights.slice(0, 3)) {
        cardText += `• ${h}\n`;
      }
    }

    if (reviewResult.inlineComments && reviewResult.inlineComments.length > 0) {
      cardText += `\n🔍 *Issues & Recommendations (${reviewResult.inlineComments.length}):*\n`;
      for (const c of reviewResult.inlineComments.slice(0, 4)) {
        const icon = c.severity === 'BLOCKER' ? '🛑' : (c.severity === 'WARNING' ? '⚠️' : '💡');
        cardText += `• ${icon} \`${c.filePath}:${c.line}\` [${c.category}] — ${c.comment}\n`;
      }
    }

    const effectiveTicket = ticketKey || getTicketForThread(threadTs);
    const jiraUrl = effectiveTicket ? getJiraTicketUrl(effectiveTicket) : null;
    const hasFixableIssues = reviewResult.verdict !== 'APPROVED' || (reviewResult.inlineComments && reviewResult.inlineComments.length > 0);

    await postSlackMessage(
      channel,
      cardText.trim(),
      threadTs,
      {
        jiraUrl,
        githubUrl: prDetails.url,
        prNumber: targetPrNumber,
        ticketKey: effectiveTicket,
        enableAiReviewButton: false,
        enableApplyFixesButton: hasFixableIssues
      }
    );
    console.log(`[SLACK] Completed AI Code Review for PR #${targetPrNumber} and posted card to thread ${threadTs}`);
  } catch (err) {
    console.error('[SLACK AI REVIEW ERROR]', err);
    await postSlackMessage(
      channel,
      `❌ *AI Code Review failed for PR #${targetPrNumber}:* ${err.message}`,
      threadTs
    );
  }
}

/**
 * Executes automated fixes suggested by Gemini AI review (triggered via button or thread command)
 */
export async function executeApplyFixes({ channel, threadTs, prNumber = null, ticketKey = null, user = null }) {
  let targetPrNumber = prNumber;

  if (!targetPrNumber) {
    const effectiveTicket = ticketKey || getTicketForThread(threadTs) || getActiveTicketKey();
    if (effectiveTicket) {
      const prUrl = getPrUrlForTicket(effectiveTicket);
      const match = prUrl?.match(/\/pull\/(\d+)/);
      if (match) targetPrNumber = match[1];
    }
  }

  if (!targetPrNumber) {
    await postSlackMessage(
      channel,
      `⚠️ *Could not detect Pull Request number.* Please specify a PR number, e.g. \`apply fixes for PR 7\`.`,
      threadTs
    );
    return;
  }

  const userMention = user ? (user.startsWith('U') || user.startsWith('W') ? `<@${user}>` : `*${user}*`) : 'team member';
  await postSlackMessage(
    channel,
    `🛠️ *AI Auto-Fix Triggered* for PR #${targetPrNumber} by ${userMention}!\n_Spawning Agent 2 (Builder) to apply Gemini suggestions, deploy to \`time-sheet\` org, and push updates..._`,
    threadTs
  );

  try {
    const prDetails = getPullRequestDetails(targetPrNumber);
    const effectiveTicket = ticketKey || getTicketForThread(threadTs) || (prDetails.title?.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i)?.[1] || 'SCRUM-TASK');
    const branchName = prDetails.headBranch || `portal/${effectiveTicket}`;

    // 1. Gather review comments/suggested fixes
    let reviewComments = '';
    const reportPath = path.join(process.cwd(), 'agent-context', 'tickets', effectiveTicket, 'pr-review.md');
    if (fs.existsSync(reportPath)) {
      reviewComments = fs.readFileSync(reportPath, 'utf8');
    }

    if (!reviewComments) {
      const diff = getPullRequestDiff(targetPrNumber);
      const review = await reviewPullRequestDiff({
        diff,
        changedFiles: prDetails.reviewableFiles,
        prTitle: prDetails.title,
        branchName
      });
      const commentsList = (review.inlineComments || []).map(c => `- [${c.severity} | ${c.category}] ${c.filePath}:${c.line} — ${c.comment}${c.suggestedFix ? ` (Fix: ${c.suggestedFix})` : ''}`).join('\n');
      const securityList = (review.securityAdvisories || []).map(s => `- [SECURITY ${s.severity}] ${s.title}: ${s.description}`).join('\n');
      reviewComments = [securityList, commentsList].filter(Boolean).join('\n') || review.summary;
    }

    // 2. Checkout the branch locally
    try {
      execSync(`git checkout ${branchName}`, { stdio: 'inherit' });
      execSync(`git pull origin ${branchName}`, { stdio: 'inherit' });
    } catch (e) {
      console.warn(`[AUTO-FIX] Git checkout note: ${e.message}`);
    }

    // 3. Build fix prompt and run Agent 2
    const fixPrompt = buildAgent2PrReviewFixPrompt({
      ticketKey: effectiveTicket,
      summary: prDetails.title,
      branchName,
      prNumber: targetPrNumber,
      reviewComments,
      iteration: 1
    });

    console.log(`[AUTO-FIX] Invoking Agent 2 for PR #${targetPrNumber}...`);
    const fixResult = await runAgent(fixPrompt, false);
    if (fixResult.code !== 0) {
      throw new Error(`Agent 2 fix process exited with code ${fixResult.code}`);
    }

    const jiraUrl = getJiraTicketUrl(effectiveTicket);
    await postSlackMessage(
      channel,
      `✅ *AI Fixes Applied & Pushed to PR #${targetPrNumber}!*
• Builder addressed review comments and redeployed to \`time-sheet\` org.
• Changes committed & pushed to GitHub branch \`${branchName}\`.
_Triggering Gemini AI re-review to verify changes..._`,
      threadTs,
      { jiraUrl, githubUrl: prDetails.url, enableAiReviewButton: false }
    );

    // 4. Trigger automated re-review to verify the fixes
    await executeSlackAiReview({
      channel,
      threadTs,
      prNumber: targetPrNumber,
      ticketKey: effectiveTicket,
      user: 'AI Auto-Fix'
    });

  } catch (err) {
    console.error('[AUTO-FIX ERROR]', err);
    await postSlackMessage(
      channel,
      `❌ *AI Auto-Fix failed for PR #${targetPrNumber}:* ${err.message}`,
      threadTs
    );
  }
}

export async function initSlack() {
  if (slackApp) return slackApp;

  slackApp = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true
  });

  // Interactive Button Handler: Toggle PR Review Mode
  slackApp.action('toggle_pr_switch', async ({ ack, body, client }) => {
    await ack();
    const userLabel = body.user?.username || body.user?.name || 'Slack user';
    const newState = toggleSwitch(`Slack user ${userLabel}`);
    console.log(`[SLACK] User ${userLabel} clicked toggle switch. New mode: ${newState.mode}`);

    const blocks = buildSlackSwitchBlocks(newState);
    const text = newState.githubActionsActive
      ? '🚀 PR Review Switch: GitHub Actions is now ACTIVE'
      : '💻 PR Review Switch: Local Agent is now ACTIVE';

    try {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text,
        blocks
      });
    } catch (err) {
      console.error('[SLACK] Failed to update switch message:', err.message);
    }
  });

  // Interactive Button Handler: Trigger Gemini AI Code Review
  slackApp.action('trigger_ai_review', async ({ ack, body }) => {
    await ack();
    const prNumber = body.actions?.[0]?.value;
    const channel = body.channel?.id;
    const threadTs = body.message?.thread_ts || body.message?.ts;
    const user = body.user?.id || body.user?.username;
    console.log(`[SLACK] User clicked 'Run AI Review' for PR #${prNumber} in thread ${threadTs}`);
    await executeSlackAiReview({ channel, threadTs, prNumber, user });
  });

  // Interactive Button Handler: Apply AI Fixes
  slackApp.action('trigger_apply_fixes', async ({ ack, body }) => {
    await ack();
    let prNumber = null;
    let ticketKey = null;
    try {
      const parsed = JSON.parse(body.actions?.[0]?.value || '{}');
      prNumber = parsed.prNumber;
      ticketKey = parsed.ticketKey;
    } catch (e) {
      prNumber = body.actions?.[0]?.value;
    }
    const channel = body.channel?.id;
    const threadTs = body.message?.thread_ts || body.message?.ts;
    const user = body.user?.id || body.user?.username;
    console.log(`[SLACK] User clicked 'Apply AI Fixes' for PR #${prNumber} in thread ${threadTs}`);
    await executeApplyFixes({ channel, threadTs, prNumber, ticketKey, user });
  });

  // Deduplicate processed messages to prevent duplicate replies across message & app_mention events
  const handledMessages = new Set();

  async function handleIncomingThreadQuestion({ channel, threadTs, text, user }) {
    if (!text || typeof text !== 'string') return;

    // 1. Check if waiting for developer clarification on an active HITL question
    const resolver = activeResolvers.get(threadTs);
    if (resolver) {
      console.log(`[SLACK] Received clarification reply in thread ${threadTs}: "${text}"`);
      activeResolvers.delete(threadTs);
      resolver(text);
      return;
    }

    // 2. Check if user is asking to toggle/switch the PR Review Agent
    if (text.match(/\b(toggle|switch|agent switch|pr switch|agent mode|pr mode)\b/i)) {
      console.log(`[SLACK] Received switch command in thread ${threadTs}: "${text}"`);
      await postSlackSwitchControl(channel, threadTs);
      return;
    }

    // 3. Check if user is asking for an AI code review
    const reviewCmdMatch = text.match(/\b(review\s+pr\s*#?(\d+)|ai\s+review|gemini\s+review|run\s+ai\s+review|run\s+code\s+review|review\s+code|code\s+review)\b/i);
    if (reviewCmdMatch) {
      const explicitPr = text.match(/\bpr\s*#?(\d+)\b/i)?.[1] || reviewCmdMatch[2];
      console.log(`[SLACK] Received AI review command in thread ${threadTs}: "${text}" (PR: ${explicitPr || 'auto'})`);
      await executeSlackAiReview({
        channel,
        threadTs,
        prNumber: explicitPr,
        ticketKey: getTicketForThread(threadTs),
        user
      });
      return;
    }

    // 4. Check if user is asking to apply AI fixes
    const fixCmdMatch = text.match(/\b(apply\s+fixes|fix\s+issues|apply\s+ai\s+fixes|auto\s*fix|fix\s+code|resolve\s+comments)\b/i);
    if (fixCmdMatch) {
      const explicitPr = text.match(/\bpr\s*#?(\d+)\b/i)?.[1];
      console.log(`[SLACK] Received apply fixes command in thread ${threadTs}: "${text}" (PR: ${explicitPr || 'auto'})`);
      await executeApplyFixes({
        channel,
        threadTs,
        prNumber: explicitPr,
        ticketKey: getTicketForThread(threadTs),
        user
      });
      return;
    }

    // 4. Otherwise, this is a developer asking a question about progress or status in the thread!
    console.log(`[SLACK] Received user question in thread ${threadTs} from ${user || 'user'}: "${text}"`);

    let ticketKey = getTicketForThread(threadTs);
    if (!ticketKey) {
      const match = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
      if (match) ticketKey = match[1].toUpperCase();
    }
    if (!ticketKey) {
      ticketKey = getActiveTicketKey();
    }

    try {
      const answer = await generateStatusAnswer({
        ticketKey,
        question: text,
        user
      });

      await postSlackMessage(channel, answer.text, threadTs, answer.buttonOptions);
      console.log(`[SLACK] Sent status answer to thread ${threadTs} for ticket ${ticketKey || 'N/A'}`);
    } catch (err) {
      console.error(`[SLACK ERROR] Failed to generate status answer:`, err);
      await postSlackMessage(
        channel,
        `⚠️ Sorry, I encountered an issue retrieving the live status: ${err.message}`,
        threadTs
      );
    }
  }

  // Listen for thread replies or switch commands via message events
  slackApp.message(async ({ message }) => {
    if (message.bot_id || message.subtype) return;

    const msgId = message.client_msg_id || message.ts;
    if (handledMessages.has(msgId)) return;
    handledMessages.add(msgId);
    if (handledMessages.size > 1000) {
      const first = handledMessages.values().next().value;
      handledMessages.delete(first);
    }

    // Check top-level message in channel for switch command
    if (!message.thread_ts && message.text && message.text.match(/\b(switch|toggle|agent switch|pr switch|agent mode)\b/i)) {
      console.log(`[SLACK] Received top-level switch command: "${message.text}"`);
      await postSlackSwitchControl(message.channel);
      return;
    }

    if (message.thread_ts) {
      await handleIncomingThreadQuestion({
        channel: message.channel,
        threadTs: message.thread_ts,
        text: message.text,
        user: message.user
      });
    }
  });

  // Listen for app_mention events (works even without channels:history)
  slackApp.event('app_mention', async ({ event }) => {
    const threadTs = event.thread_ts || event.ts;
    const msgId = event.client_msg_id || event.ts;
    if (handledMessages.has(msgId)) return;
    handledMessages.add(msgId);
    if (handledMessages.size > 1000) {
      const first = handledMessages.values().next().value;
      handledMessages.delete(first);
    }

    console.log(`[SLACK] Received app_mention in thread ${threadTs}: "${event.text}"`);
    await handleIncomingThreadQuestion({
      channel: event.channel,
      threadTs,
      text: event.text,
      user: event.user
    });
  });

  await slackApp.start();
  console.log('[SLACK] Socket Mode client connected and listening.');
  return slackApp;
}

/**
 * Builds the Slack Block Kit card containing the interactive toggle button.
 * @param {Object} state 
 * @returns {Array} Slack blocks
 */
export function buildSlackSwitchBlocks(state) {
  const isGHA = state.githubActionsActive;
  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🎛️ PR Review Execution Switch',
        emoji: true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: isGHA
          ? '• *Active Engine:* 🚀 *GitHub Actions (Active)*\n• *GitHub Workflow (`pr-review.yml`):* `ENABLED`\n• *Local Agent 4:* Standby (Token usage saved in cloud CI/CD)\n• *Behavior:* When PR is opened/updated, GitHub Actions executes review.'
          : '• *Active Engine:* 💻 *Local Agent (Active)*\n• *GitHub Workflow (`pr-review.yml`):* `DISABLED`\n• *Local Agent 4:* **ACTIVE**\n• *Behavior:* Agent 4 will actively audit PRs locally during ticket runs.'
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: isGHA ? '💻 Switch to Local Agent' : '🚀 Switch to GitHub Actions',
            emoji: true
          },
          style: isGHA ? 'danger' : 'primary',
          action_id: 'toggle_pr_switch',
          value: isGHA ? 'disable_gha' : 'enable_gha'
        }
      ]
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Current Mode: *${isGHA ? 'GitHub Actions' : 'Local Agent'}* | Last updated: \`${state.lastUpdated}\` via *${state.updatedBy}*`
        }
      ]
    }
  ];
}

/**
 * Posts the interactive switch control card with button to a Slack channel or thread.
 * @param {string} channel 
 * @param {string|null} [threadTs=null] 
 * @returns {Promise<string>}
 */
export async function postSlackSwitchControl(channel, threadTs = null) {
  const app = await initSlack();
  const state = getSwitchState();
  const blocks = buildSlackSwitchBlocks(state);
  const text = state.githubActionsActive
    ? '🚀 PR Review Switch: GitHub Actions is ACTIVE'
    : '💻 PR Review Switch: Local Agent is ACTIVE';

  const res = await app.client.chat.postMessage({
    channel,
    text,
    blocks,
    ...(threadTs ? { thread_ts: threadTs } : {})
  });
  return res.ts;
}

/**
 * Posts a message to Slack, supporting optional Block Kit interactive action buttons (JIRA, GitHub)
 * @param {string} channel Slack Channel ID
 * @param {string} text Message text / fallback
 * @param {string|null} [threadTs=null] Thread Timestamp
 * @param {Object} [buttonOptions={}]
 * @param {string} [buttonOptions.jiraUrl] JIRA ticket URL
 * @param {string} [buttonOptions.githubUrl] GitHub PR URL
 */
export async function postSlackMessage(channel, text, threadTs = null, buttonOptions = {}) {
  const app = await initSlack();

  const payload = {
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {})
  };

  const buttons = [];
  if (buttonOptions?.jiraUrl) {
    buttons.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: '🎯 JIRA Ticket',
        emoji: true
      },
      url: buttonOptions.jiraUrl,
      action_id: 'btn_open_jira'
    });
  }

  if (buttonOptions?.githubUrl) {
    buttons.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: '🐙 GitHub PR',
        emoji: true
      },
      style: 'primary',
      url: buttonOptions.githubUrl,
      action_id: 'btn_open_github'
    });

    if (buttonOptions?.enableAiReviewButton !== false) {
      const prNumMatch = buttonOptions.githubUrl.match(/\/pull\/(\d+)/);
      const prNum = prNumMatch ? prNumMatch[1] : '';
      if (prNum) {
        buttons.push({
          type: 'button',
          text: {
            type: 'plain_text',
            text: '🤖 Run AI Review',
            emoji: true
          },
          action_id: 'trigger_ai_review',
          value: prNum
        });
      }
    }

    if (buttonOptions?.enableApplyFixesButton) {
      const prNumMatch = buttonOptions.githubUrl.match(/\/pull\/(\d+)/);
      const prNum = prNumMatch ? prNumMatch[1] : (buttonOptions.prNumber || '');
      if (prNum) {
        buttons.push({
          type: 'button',
          text: {
            type: 'plain_text',
            text: '🛠️ Apply AI Fixes',
            emoji: true
          },
          style: 'danger',
          action_id: 'trigger_apply_fixes',
          value: JSON.stringify({ prNumber: prNum, ticketKey: buttonOptions.ticketKey || '' })
        });
      }
    }
  }

  if (buttons.length > 0) {
    payload.blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text
        }
      },
      {
        type: 'actions',
        elements: buttons
      }
    ];
  }

  const res = await app.client.chat.postMessage(payload);
  return res.ts;
}

// In-memory set to prevent duplicate notifications on retries or repeated events
const sentPhaseNotifications = new Set();

/**
 * Sends a structured phase update to Slack within the designated thread
 * @param {string} channel Slack Channel ID
 * @param {string} threadTs Parent Thread Timestamp
 * @param {Object} options
 * @param {number|string} options.phaseNumber Phase identifier/number
 * @param {string} options.phaseName Name of the phase
 * @param {'Started'|'Completed'|'Failed'} options.status Phase execution status
 * @param {string} options.summary Brief summary of work done or current status
 * @param {string|null} [options.nextPhase] Name of the upcoming phase
 * @param {string} [options.jiraUrl] JIRA ticket URL for button
 * @param {string} [options.githubUrl] GitHub PR URL for button
 * @param {boolean} [options.allowDuplicate=false] Whether to allow resending the exact same notification
 */
export async function notifyPhase(channel, threadTs, {
  phaseNumber,
  phaseName,
  status,
  summary,
  nextPhase = null,
  jiraUrl = null,
  githubUrl = null,
  allowDuplicate = false
}) {
  if (!channel || !threadTs) return null;

  // Deduplication key per thread, phase, and status
  const dedupeKey = `${threadTs}_${phaseNumber}_${phaseName}_${status}`;
  if (!allowDuplicate && sentPhaseNotifications.has(dedupeKey)) {
    console.log(`[SLACK] Duplicate notification suppressed for: ${dedupeKey}`);
    return null;
  }
  sentPhaseNotifications.add(dedupeKey);

  // Determine icon and status badge
  let statusBadge = status;
  if (status === 'Started') statusBadge = '⏳ *Started*';
  else if (status === 'Completed') statusBadge = '✅ *Completed*';
  else if (status === 'Failed') statusBadge = '❌ *Failed*';

  let msg = `📍 *Phase ${phaseNumber}: ${phaseName}*\n• *Status:* ${statusBadge}\n• *Summary:* ${summary}`;
  if (nextPhase) {
    msg += `\n• *Next Phase:* ${nextPhase}`;
  }

  const buttonOptions = {};
  if (jiraUrl) buttonOptions.jiraUrl = jiraUrl;
  if (githubUrl) buttonOptions.githubUrl = githubUrl;

  return await postSlackMessage(channel, msg, threadTs, buttonOptions);
}

export async function askSlackQuestion(channel, threadTs, question, timeoutMinutes = 15) {
  const app = await initSlack();

  const formattedQuestion = `❓ *Clarification Required from Developer:*\n>${question.replace(/\n/g, '\n>')}\n\n_Please reply directly in this thread. Agent execution will resume automatically._`;

  await postSlackMessage(channel, formattedQuestion, threadTs);
  console.log(`[SLACK] Posted question to thread ${threadTs}. Waiting for reply...`);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      activeResolvers.delete(threadTs);
      reject(new Error(`Timeout of ${timeoutMinutes} minutes waiting for Slack reply in thread ${threadTs}`));
    }, timeoutMinutes * 60 * 1000);

    activeResolvers.set(threadTs, (replyText) => {
      clearTimeout(timer);
      resolve(replyText);
    });
  });
}
