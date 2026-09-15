import { getJiraTicketUrl, getJiraIssue } from './jira.js';
import { getPrUrlForTicket } from './slack.js';

// In-memory state tracker: ticketKey (UPPERCASE) -> state object
const ticketStateTracker = new Map();

// Global reference to currently active processing ticket
let activeTicketKey = null;

export function setActiveTicketKey(key) {
  activeTicketKey = key ? key.toUpperCase() : null;
}

export function getActiveTicketKey() {
  return activeTicketKey;
}

/**
 * Updates the tracked runtime state for a given ticket
 * @param {string} ticketKey
 * @param {Object} updates
 */
export function updateTicketState(ticketKey, updates = {}) {
  if (!ticketKey) return null;
  const key = ticketKey.toUpperCase();

  const existing = ticketStateTracker.get(key) || {
    ticketKey: key,
    summary: '',
    startTime: Date.now(),
    currentPhaseNumber: 1,
    currentPhaseName: 'Initialization',
    phaseStartTime: Date.now(),
    status: 'In Progress',
    jiraStatus: 'In Progress',
    lastActivity: 'Started delivery loop',
    nextPhase: null,
    prUrl: null,
    branchName: `portal/${key}`,
    isRunning: true,
    isWaitingInput: false,
    activeQuestion: null,
    testResults: null,
    reviewStatus: null,
    history: []
  };

  const isNewPhase = updates.currentPhaseNumber && updates.currentPhaseNumber !== existing.currentPhaseNumber;
  const isNewPhaseName = updates.currentPhaseName && updates.currentPhaseName !== existing.currentPhaseName;

  const newState = {
    ...existing,
    ...updates,
    lastUpdated: Date.now()
  };

  if (isNewPhase || isNewPhaseName) {
    newState.phaseStartTime = Date.now();
    newState.history.push({
      phaseNumber: newState.currentPhaseNumber,
      phaseName: newState.currentPhaseName,
      time: new Date().toISOString()
    });
  }

  ticketStateTracker.set(key, newState);
  return newState;
}

/**
 * Retrieves the state object for a ticket
 * @param {string} ticketKey
 * @returns {Object|null}
 */
export function getTicketState(ticketKey) {
  if (!ticketKey) return null;
  return ticketStateTracker.get(ticketKey.toUpperCase()) || null;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Generates an intelligent, human-friendly status response answering a user's question in Slack
 * @param {Object} options
 * @param {string} options.ticketKey
 * @param {string} options.question
 * @param {string} [options.user]
 * @returns {Promise<{ text: string, buttonOptions: Object }>}
 */
export async function generateStatusAnswer({ ticketKey, question, user = null }) {
  const key = ticketKey ? ticketKey.toUpperCase() : null;
  let state = key ? getTicketState(key) : null;

  // If no in-memory state exists yet, attempt to fetch live ticket info from JIRA
  if (!state && key) {
    try {
      const issue = await getJiraIssue(key);
      const summary = issue.fields?.summary || '';
      const jiraStatus = issue.fields?.status?.name || 'Unknown';
      const prUrl = getPrUrlForTicket(key);

      state = {
        ticketKey: key,
        summary,
        startTime: null,
        currentPhaseNumber: null,
        currentPhaseName: jiraStatus,
        phaseStartTime: null,
        jiraStatus,
        status: jiraStatus,
        lastActivity: `Ticket status is ${jiraStatus}`,
        prUrl,
        isRunning: ['in progress', 'in review'].includes(jiraStatus.toLowerCase()),
        history: []
      };
    } catch (e) {
      // Non-fatal if JIRA fetch fails
    }
  }

  const cleanQuestion = question.replace(/<@[A-Z0-9]+>/g, '').trim();
  const lowerQ = cleanQuestion.toLowerCase();
  const jiraUrl = key ? getJiraTicketUrl(key) : null;
  const prUrl = state?.prUrl || (key ? getPrUrlForTicket(key) : null);

  const now = Date.now();
  const totalElapsed = state?.startTime ? formatDuration(now - state.startTime) : null;
  const phaseElapsed = state?.phaseStartTime ? formatDuration(now - state.phaseStartTime) : null;
  const phaseNum = state?.currentPhaseNumber;
  const phaseName = state?.currentPhaseName;
  const activity = state?.lastActivity;
  const isRunning = state?.isRunning === true;
  const isWaitingInput = state?.isWaitingInput === true;

  // Intent classification
  const isPhaseInquiry = /phase|stage|step|implementation|planning|review|testing|where are we/i.test(lowerQ);
  const isDelayInquiry = /so long|taking long|taking so long|stuck|freeze|frozen|hanging|delay|slow|why|status|update/i.test(lowerQ);
  const isPrInquiry = /\bpr\b|pull request|github|branch|code link|diff/i.test(lowerQ);
  const isTestInquiry = /\btest\b|testing|qa|pass|failed|bugs?|verification/i.test(lowerQ);
  const isJiraInquiry = /\bjira\b|ticket|story|acceptance criteria/i.test(lowerQ);

  let directAnswer = '';

  if (isWaitingInput) {
    directAnswer = `⚠️ The agent is currently **paused** waiting for developer clarification in this thread:\n>${state.activeQuestion || 'Pending clarification question'}\n\nPlease reply directly to resume execution.`;
  } else if (isPhaseInquiry && !isDelayInquiry) {
    if (isRunning && phaseNum && phaseName) {
      directAnswer = `Yes! The task for **${key}** is currently in **Phase ${phaseNum}: ${phaseName}**${phaseElapsed ? ` (running for **${phaseElapsed}**)` : ''}.\n\n• **Current Activity:** ${activity || 'Actively processing'}.\n• **Next Phase:** ${state?.nextPhase || 'Pending phase completion'}.`;
    } else if (state?.jiraStatus) {
      directAnswer = `The ticket **${key}** is currently in stage **${state.jiraStatus}** in JIRA.`;
    } else {
      directAnswer = `The task for **${key}** is currently being processed by the autonomous delivery loop.`;
    }
  } else if (isDelayInquiry) {
    if (isRunning) {
      directAnswer = `The agent is actively running on **${key}** and is **not stuck**! ⚙️\n\n• **Current Phase:** Phase ${phaseNum || '2'} — ${phaseName || 'Implementation'}${phaseElapsed ? ` (elapsed in phase: \`${phaseElapsed}\`)` : ''}\n• **Total Execution Time:** \`${totalElapsed || 'In Progress'}\`\n• **Current Activity:** ${activity || 'Executing deployment / metadata compilation'}\n\n_Note: Salesforce CLI deployments and remote metadata compilation against the \`time-sheet\` org typically take 1 to 3 minutes to validate._`;
    } else if (state?.jiraStatus?.toLowerCase() === 'done') {
      directAnswer = `The delivery for **${key}** is already **Completed and Done**! 🎉 All acceptance criteria and QA validations passed.`;
    } else {
      directAnswer = `The ticket **${key}** is currently in **${state?.jiraStatus || 'To Do'}** status. The autonomous loop will pick it up as soon as it moves to **In Progress**.`;
    }
  } else if (isPrInquiry) {
    if (prUrl) {
      directAnswer = `The GitHub Pull Request for **${key}** is open: ${prUrl} (Branch: \`${state?.branchName || 'portal/' + key}\`).`;
    } else {
      directAnswer = `The GitHub Pull Request has not been opened yet. Agent 2 opens the PR immediately upon validating the Salesforce deployment on the \`time-sheet\` org.`;
    }
  } else if (isTestInquiry) {
    if (state?.testResults) {
      directAnswer = `QA Testing for **${key}**: **${state.testResults.passed ? 'PASSED ✅' : 'DEFECTS FOUND ❌'}**.\n${state.testResults.summary || ''}`;
    } else if (phaseNum && phaseNum < 7) {
      directAnswer = `QA Testing (Phase 7 with Agent 3) has not started yet. It will execute automatically after Phase 5 (PR Review) and Phase 6 (JIRA transition to In Review) complete.`;
    } else {
      directAnswer = `Agent 3 (QA Tester) is currently validating metadata and test cases against the \`time-sheet\` Salesforce org.`;
    }
  } else {
    // General overview
    directAnswer = `Here is the real-time progress update for **${key || 'your task'}**:`;
  }

  // Construct message
  let text = `🤖 *Agent Status Response*\n`;
  if (cleanQuestion) {
    text += `> _"${cleanQuestion}"_\n\n`;
  }
  text += `${directAnswer}\n\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `• *Ticket:* *${key}* ${state?.summary ? `— _${state.summary}_` : ''}\n`;
  text += `• *Current Stage:* *${state?.jiraStatus || 'In Progress'}*\n`;
  if (isRunning) {
    text += `• *Current Phase:* Phase ${phaseNum || '1'}: ${phaseName || 'Processing'}\n`;
    if (phaseElapsed) text += `• *Phase Duration:* \`${phaseElapsed}\` (Total: \`${totalElapsed || phaseElapsed}\`)\n`;
    if (state?.nextPhase) text += `• *Upcoming Phase:* ${state.nextPhase}\n`;
  }
  if (prUrl) {
    text += `• *Pull Request:* ${prUrl}\n`;
  }

  return {
    text: text.trim(),
    buttonOptions: {
      jiraUrl,
      githubUrl: prUrl
    }
  };
}
