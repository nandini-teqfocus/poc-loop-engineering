import 'dotenv/config';
import fs from 'fs';
import { reviewPullRequestDiff } from '../src/aiCodeReviewer.js';
import {
  getPullRequestDetails,
  getPullRequestDiff,
  submitReviewSummary,
  postInlineComments
} from '../src/githubPrClient.js';
import { postSlackMessage, initSlack, getTicketThread } from '../src/slack.js';
import { isGitHubActionActive } from '../src/switchManager.js';

console.log('======================================================');
console.log('🤖 Gemini AI Code Review Agent (Google Gen AI SDK)');
console.log('======================================================\n');

// 1. Check Configurable Switch
const switchVal = process.env.ENABLE_PR_REVIEW_AGENT;
const isEnabled = switchVal !== undefined
  ? String(switchVal).trim().toLowerCase() !== 'false'
  : isGitHubActionActive();

if (!isEnabled) {
  console.log('⚡ AI Code Review Agent is currently DISABLED via switch:');
  console.log('   ENABLE_PR_REVIEW_AGENT = false');
  console.log('Skipping execution cleanly.\n');

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### ⚡ AI Code Review Agent: Skipped\n\nThe review agent is disabled via the \`ENABLE_PR_REVIEW_AGENT\` configuration switch.\n`
      );
    } catch (e) {}
  }
  process.exit(0);
}

// 2. Validate GEMINI_API_KEY
if (!process.env.GEMINI_API_KEY) {
  console.error('❌ Error: GEMINI_API_KEY environment variable is missing.');
  console.error('Please configure GEMINI_API_KEY in .env or GitHub Secrets.');
  process.exit(1);
}

async function main() {
  // Parse command line arguments or GitHub Actions environment
  let prNumber = null;
  const prArgIdx = process.argv.indexOf('--pr');
  if (prArgIdx !== -1 && process.argv[prArgIdx + 1]) {
    prNumber = process.argv[prArgIdx + 1];
  }

  // GitHub Actions event detection
  if (!prNumber && process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    try {
      const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      prNumber = event.pull_request?.number || event.number;
    } catch (e) {}
  }

  // Fallback: detect open PR from current git branch
  if (!prNumber) {
    try {
      const { execSync } = await import('child_process');
      const ghOut = execSync('gh pr view --json number -q ".number"', { encoding: 'utf8' }).trim();
      if (ghOut) prNumber = ghOut;
    } catch (e) {}
  }

  if (!prNumber) {
    console.error('❌ Error: Could not determine PR number. Pass --pr <PR_NUMBER> or run within a PR branch.');
    process.exit(1);
  }

  console.log(`[AI REVIEW] Inspecting GitHub PR #${prNumber}...`);
  const prDetails = getPullRequestDetails(prNumber);
  console.log(`[AI REVIEW] Title: "${prDetails.title}"`);
  console.log(`[AI REVIEW] Branch: ${prDetails.headBranch}`);
  console.log(`[AI REVIEW] Total files changed: ${prDetails.allFiles.length}`);
  console.log(`[AI REVIEW] Reviewable source files: ${prDetails.reviewableFiles.length}\n`);

  if (prDetails.reviewableFiles.length === 0) {
    console.log('ℹ️  No reviewable source code files changed in this PR (only docs/lockfiles/assets).');
    console.log('Skipping AI review cleanly.');
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `### ℹ️ AI Code Review: Skipped\nNo reviewable source files found in PR #${prNumber}.\n`
        );
      } catch (e) {}
    }
    process.exit(0);
  }

  // Fetch filtered diff
  console.log('[AI REVIEW] Fetching filtered unified diff...');
  const diff = getPullRequestDiff(prNumber);

  if (!diff || diff.trim().length === 0) {
    console.log('ℹ️  Diff is empty after filtering non-code files. Skipping review.');
    process.exit(0);
  }

  console.log(`[AI REVIEW] Filtered diff size: ${diff.length} characters.`);
  console.log('[AI REVIEW] Invoking Gemini AI model for code analysis...');

  const startTime = Date.now();
  const reviewResult = await reviewPullRequestDiff({
    diff,
    changedFiles: prDetails.reviewableFiles,
    prTitle: prDetails.title,
    branchName: prDetails.headBranch
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n======================================================`);
  console.log(`[AI REVIEW COMPLETE] in ${elapsed}s`);
  console.log(`Verdict:      ${reviewResult.verdict}`);
  console.log(`Score:        ${reviewResult.overallScore} / 10`);
  console.log(`Blockers:     ${reviewResult.inlineComments.filter(c => c.severity === 'BLOCKER').length}`);
  console.log(`Warnings:     ${reviewResult.inlineComments.filter(c => c.severity === 'WARNING').length}`);
  console.log(`Suggestions:  ${reviewResult.inlineComments.filter(c => c.severity === 'SUGGESTION').length}`);
  console.log(`======================================================\n`);

  // Submit PR Review Summary
  console.log(`[AI REVIEW] Posting review summary to PR #${prNumber}...`);
  const reviewMarkdown = submitReviewSummary(prNumber, reviewResult, prDetails);

  // Attempt inline comments if headSha available
  if (reviewResult.inlineComments && reviewResult.inlineComments.length > 0 && prDetails.headSha) {
    console.log(`[AI REVIEW] Posting ${reviewResult.inlineComments.length} inline review comment(s)...`);
    postInlineComments(prNumber, reviewResult.inlineComments, prDetails.headSha);
  }

  // Write GitHub Actions Step Summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${reviewMarkdown}\n`);
    } catch (e) {}
  }

  // Optional: Post review card to Slack if configured
  const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
  if (CHANNEL_ID && process.env.SLACK_BOT_TOKEN) {
    try {
      await initSlack();
      const verdictIcon = reviewResult.verdict === 'APPROVED' ? '✅' : '⚠️';
      const slackText = `${verdictIcon} *Gemini AI Code Review on PR #${prNumber}*
• *Title:* ${prDetails.title}
• *Verdict:* *${reviewResult.verdict}* (Score: \`${reviewResult.overallScore}/10\`)
• *Summary:* ${reviewResult.summary}
• *PR Link:* ${prDetails.url}`;

      await postSlackMessage(CHANNEL_ID, slackText, null, {
        githubUrl: prDetails.url
      });
      console.log('[AI REVIEW] Posted update card to Slack.');
    } catch (e) {
      console.warn('[AI REVIEW] Note: Could not post to Slack:', e.message);
    }
  }

  if (reviewResult.verdict === 'CHANGES_REQUESTED') {
    console.log('\n⚠️  Review verdict is CHANGES_REQUESTED.');
    process.exit(1);
  }

  console.log('\n✅ AI Code Review completed successfully.');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ FATAL AI CODE REVIEW ERROR:', err.message);
  process.exit(1);
});
