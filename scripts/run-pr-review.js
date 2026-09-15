import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { isPrReviewAgentEnabled, submitPrReview, auditPullRequest } from '../src/prReviewer.js';
import { getJiraIssue, getJiraTicketUrl, extractTextFromAdf } from '../src/jira.js';
import { postSlackMessage, notifyPhase, getTicketThread, initSlack } from '../src/slack.js';

console.log('======================================================');
console.log('🤖 GitHub Actions / Standalone PR Review Agent');
console.log('======================================================\n');

// 1. Check Configurable Switch: ENABLE_PR_REVIEW_AGENT
if (!isPrReviewAgentEnabled()) {
  console.log('⚡ PR Review Agent is currently DISABLED via configuration switch:');
  console.log('   ENABLE_PR_REVIEW_AGENT = false');
  console.log('Skipping PR review execution cleanly.\n');

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### ⚡ PR Review Agent: Skipped\n\nThe PR Review Agent is currently **disabled** via the \`ENABLE_PR_REVIEW_AGENT\` configuration switch.\n`
      );
    } catch (e) {}
  }
  process.exit(0);
}

async function main() {
  // Parse command line arguments or GitHub Actions environment
  let prNumber = null;
  let ticketKey = null;

  const prArgIdx = process.argv.indexOf('--pr');
  if (prArgIdx !== -1 && process.argv[prArgIdx + 1]) {
    prNumber = process.argv[prArgIdx + 1];
  }

  const ticketArgIdx = process.argv.indexOf('--ticket');
  if (ticketArgIdx !== -1 && process.argv[ticketArgIdx + 1]) {
    ticketKey = process.argv[ticketArgIdx + 1].toUpperCase();
  }

  // If in GitHub Actions, read event payload
  if (!prNumber && process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    try {
      const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      prNumber = event.pull_request?.number || event.number;
      if (!ticketKey && event.pull_request) {
        const headRef = event.pull_request.head?.ref || '';
        const title = event.pull_request.title || '';
        const match = headRef.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i) || title.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
        if (match) ticketKey = match[1].toUpperCase();
      }
    } catch (e) {}
  }

  // Fallback: detect open PR from current git branch
  if (!prNumber) {
    try {
      const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
      const ghOut = execSync(`gh pr view ${branch} --json number,headRefName,title,url -q ".number"`, { encoding: 'utf8' }).trim();
      if (ghOut) prNumber = ghOut;
    } catch (e) {}
  }

  if (!prNumber) {
    console.error('❌ Error: Could not determine PR number. Pass --pr <PR_NUMBER> or run in a PR branch.');
    process.exit(1);
  }

  // Resolve PR details via GitHub CLI
  console.log(`[PR REVIEW] Inspecting GitHub PR #${prNumber}...`);
  let prData = { url: '', headRefName: '', title: '', body: '' };
  try {
    const rawPr = execSync(`gh pr view ${prNumber} --json url,headRefName,title,body`, { encoding: 'utf8' });
    prData = JSON.parse(rawPr);
  } catch (e) {
    console.warn('[PR REVIEW] Could not fetch PR JSON details, continuing with available data...');
  }

  const prUrl = prData.url || `https://github.com/nandini-teqfocus/poc-loop-engineering/pull/${prNumber}`;
  const branchName = prData.headRefName || '';

  // Resolve ticket key if not provided
  if (!ticketKey) {
    const candidates = [branchName, prData.title, prData.body];
    for (const text of candidates) {
      if (!text) continue;
      const match = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
      if (match) {
        ticketKey = match[1].toUpperCase();
        break;
      }
    }
  }

  if (!ticketKey) {
    console.warn('⚠️ Warning: Could not detect JIRA ticket key from PR branch or title. Using fallback.');
    ticketKey = 'UNKNOWN';
  }

  console.log(`[PR REVIEW] Linked Ticket: ${ticketKey}`);
  console.log(`[PR REVIEW] PR URL: ${prUrl}`);
  console.log(`[PR REVIEW] Branch: ${branchName || 'N/A'}\n`);

  // Fetch JIRA ticket details if available
  let summary = prData.title || `Delivery for ${ticketKey}`;
  let description = prData.body || '';

  if (ticketKey !== 'UNKNOWN') {
    try {
      const issue = await getJiraIssue(ticketKey);
      summary = issue.fields?.summary || summary;
      description = extractTextFromAdf(issue.fields?.description) || description;
      console.log(`[PR REVIEW] Fetched JIRA requirements: "${summary}"`);
    } catch (e) {
      console.warn(`[PR REVIEW] Note: Could not fetch from JIRA (${e.message}). Proceeding with PR data.`);
    }
  }

  // Audit the Pull Request
  console.log('\n[PR REVIEW] Running code and metadata audit...');
  const outcome = await auditPullRequest({
    ticketKey,
    summary,
    description,
    prNumber,
    prUrl,
    branchName
  });

  console.log(`\n======================================================`);
  console.log(`[PR REVIEW VERDICT]: ${outcome.approved ? 'APPROVED ✅' : 'CHANGES REQUESTED ⚠️'}`);
  console.log(`Summary: ${outcome.summary}`);
  console.log(`======================================================\n`);

  // Submit GitHub PR Review
  if (outcome.approved) {
    console.log(`[PR REVIEW] Submitting APPROVAL on PR #${prNumber}...`);
    submitPrReview(prNumber, {
      action: 'APPROVE',
      body: `All acceptance criteria and technical requirements for **${ticketKey}** verified successfully.\n\n### Review Summary\n${outcome.summary}`
    });
  } else {
    console.log(`[PR REVIEW] Submitting CHANGES REQUESTED on PR #${prNumber}...`);
    submitPrReview(prNumber, {
      action: 'REQUEST_CHANGES',
      body: `The PR Review Agent reviewed this PR against JIRA ticket **${ticketKey}**.\n\n### Required Fixes:\n${outcome.reviewComments}\n\nPlease address the items above and push an update to this branch.`
    });
  }

  // Post to Slack if configured
  const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
  if (CHANNEL_ID && process.env.SLACK_BOT_TOKEN) {
    try {
      await initSlack();
      const threadTs = getTicketThread(ticketKey);
      const jiraUrl = getJiraTicketUrl(ticketKey);

      await postSlackMessage(
        CHANNEL_ID,
        outcome.approved
          ? `✅ *GitHub Actions: PR #${prNumber} Approved!*
• *Ticket:* *${ticketKey}*
• *Review Status:* Approved
• *Summary:* ${outcome.summary}
• *Pull Request:* ${prUrl}`
          : `⚠️ *GitHub Actions: PR #${prNumber} Changes Requested*
• *Ticket:* *${ticketKey}*
• *Review Status:* Changes Requested
• *Required Fixes:*
${outcome.reviewComments}
• *Pull Request:* ${prUrl}`,
        threadTs,
        { jiraUrl, githubUrl: prUrl }
      );
      console.log('[PR REVIEW] Posted review card to Slack.');
    } catch (e) {
      console.warn('[PR REVIEW] Could not post to Slack:', e.message);
    }
  }

  // Write GitHub Actions Step Summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## 🤖 PR Review Agent Report: ${outcome.approved ? 'Approved ✅' : 'Changes Requested ⚠️'}\n\n` +
        `**Ticket:** ${ticketKey}\n\n` +
        `**PR:** [#${prNumber}](${prUrl})\n\n` +
        `### Review Summary\n${outcome.summary}\n\n` +
        (outcome.approved ? '' : `### Required Fixes\n\`\`\`\n${outcome.reviewComments}\n\`\`\`\n`)
      );
    } catch (e) {}
  }

  if (!outcome.approved) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL PR REVIEW ERROR:', err);
  process.exit(1);
});
