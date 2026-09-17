import 'dotenv/config';
import { initSlack, postSlackMessage, registerTicketThread } from '../src/slack.js';

console.log('======================================================');
console.log('🚀 Test Suite: Interactive [ 🛠️ Apply AI Fixes ] Trigger');
console.log('======================================================\n');

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
if (!CHANNEL_ID) {
  console.error('❌ SLACK_CHANNEL_ID is missing from .env');
  process.exit(1);
}

async function runTest() {
  console.log('[STEP 1] Initializing Slack Bolt Client...');
  await initSlack();

  const prNumber = 7;
  const ticketKey = 'SCRUM-13';
  const githubUrl = `https://github.com/nandini-teqfocus/poc-loop-engineering/pull/${prNumber}`;
  const jiraUrl = `https://snandini548.atlassian.net/browse/${ticketKey}`;

  // 1. Post simulated Review Card with [ 🛠️ Apply AI Fixes ] button
  console.log(`[STEP 2] Posting Review Card with [ 🛠️ Apply AI Fixes ] button to Slack channel ${CHANNEL_ID}...`);
  const reviewCardText = `⚠️ *Gemini AI Code Review: PR #${prNumber} — CHANGES REQUESTED*\n` +
    `• *Code Quality Score:* \`5 / 10\`\n` +
    `• *Title:* SCRUM-13: Create a custom field on Opportunity\n` +
    `• *Summary:* Field definition created, but missing explicit length specification or field description.\n\n` +
    `🔍 *Issues & Recommendations (1):*\n` +
    `• ⚠️ \`force-app/main/default/objects/Opportunity/fields/External_Contract_Id__c.field-meta.xml:5\` [STANDARDS] — Ensure description matches external billing specification.\n\n` +
    `Click *[ 🛠️ Apply AI Fixes ]* below or reply with \`apply fixes\` to have Agent 2 automatically fix, redeploy to \`time-sheet\` org, and push!`;

  const threadTs = await postSlackMessage(CHANNEL_ID, reviewCardText, null, {
    jiraUrl,
    githubUrl,
    prNumber,
    ticketKey,
    enableAiReviewButton: false,
    enableApplyFixesButton: true
  });

  console.log(`✅ [SLACK] Review card posted with [ 🛠️ Apply AI Fixes ] button! Thread TS: ${threadTs}`);
  registerTicketThread(ticketKey, threadTs);

  console.log('\n======================================================');
  console.log('🎉 INTERACTIVE AUTO-FIX BUTTON VERIFIED SUCCESSFULLY!');
  console.log(`Check your Slack channel (${CHANNEL_ID}) to see the [ 🛠️ Apply AI Fixes ] red action button!`);
  console.log('======================================================\n');
}

runTest().then(() => {
  setTimeout(() => process.exit(0), 2000);
}).catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
