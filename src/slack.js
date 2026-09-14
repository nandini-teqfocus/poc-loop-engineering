import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { App } from '@slack/bolt';

let slackApp = null;
let activeResolvers = new Map(); // threadTs -> resolve function

// In-memory mapping: ticketKey -> parent threadTs
const ticketThreads = new Map();

// In-memory set to prevent duplicate stage transitions
const sentStageTransitions = new Set();

/**
 * Associates a JIRA ticket key with its active Slack thread timestamp
 * @param {string} ticketKey
 * @param {string} threadTs
 */
export function registerTicketThread(ticketKey, threadTs) {
  if (ticketKey && threadTs) {
    ticketThreads.set(ticketKey.toUpperCase(), threadTs);
  }
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
  try {
    const changelogPath = path.join(process.cwd(), 'agent-context', 'CHANGELOG.md');
    if (fs.existsSync(changelogPath)) {
      const content = fs.readFileSync(changelogPath, 'utf8');
      const regex = new RegExp(`- \\*\\*Ticket\\*\\*:\\s*${ticketKey}[\\s\\S]*?https:\\/\\/github\\.com\\/[^\\s)]+\\/pull\\/\\d+`, 'i');
      const match = content.match(regex);
      if (match) {
        const prMatch = match[0].match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
        return prMatch ? prMatch[0] : null;
      }
    }
  } catch (e) {}
  return null;
}

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
 */
export async function notifyStageChange(channel, {
  ticketKey,
  fromStage,
  toStage,
  summary = null,
  jiraUrl = null,
  githubUrl = null,
  threadTs = null
}) {
  if (!channel) return null;

  const normalizedKey = ticketKey?.toUpperCase();
  const effectiveThreadTs = threadTs || (normalizedKey ? ticketThreads.get(normalizedKey) : null);

  // Deduplication key per ticket transition
  const dedupeKey = `${normalizedKey}_${fromStage || 'none'}_to_${toStage}`;
  if (sentStageTransitions.has(dedupeKey)) {
    console.log(`[SLACK] Duplicate stage transition suppressed for: ${dedupeKey}`);
    return null;
  }
  sentStageTransitions.add(dedupeKey);

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

  const buttonOptions = {};
  if (jiraUrl) buttonOptions.jiraUrl = jiraUrl;
  if (githubUrl) buttonOptions.githubUrl = githubUrl;

  const resTs = await postSlackMessage(channel, text.trim(), effectiveThreadTs, buttonOptions);

  // If this was a top-level message and no thread was mapped yet, register it
  if (!effectiveThreadTs && resTs && normalizedKey) {
    ticketThreads.set(normalizedKey, resTs);
  }

  return resTs;
}

export async function initSlack() {
  if (slackApp) return slackApp;

  slackApp = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true
  });

  // Listen for thread replies via message events
  slackApp.message(async ({ message }) => {
    // Only care about messages with thread_ts, from non-bots
    if (message.thread_ts && !message.bot_id && !message.subtype) {
      const resolver = activeResolvers.get(message.thread_ts);
      if (resolver) {
        console.log(`[SLACK] Received reply in thread ${message.thread_ts}: "${message.text}"`);
        activeResolvers.delete(message.thread_ts);
        resolver(message.text);
      }
    }
  });

  // Listen for app_mention events (works even without channels:history)
  slackApp.event('app_mention', async ({ event }) => {
    const threadTs = event.thread_ts || event.ts;
    console.log(`[SLACK] Received app_mention in thread ${threadTs}: "${event.text}"`);
    const resolver = activeResolvers.get(threadTs);
    if (resolver) {
      console.log(`[SLACK] Resolving active question with mention text: "${event.text}"`);
      activeResolvers.delete(threadTs);
      resolver(event.text);
    }
  });

  await slackApp.start();
  console.log('[SLACK] Socket Mode client connected and listening.');
  return slackApp;
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
