import 'dotenv/config';
import { initSlack, postSlackMessage, executeSlackAiReview, registerTicketThread } from '../src/slack.js';

console.log('======================================================');
console.log('🚀 Live Slack Verification: Gemini AI Code Review');
console.log('======================================================\n');

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
if (!CHANNEL_ID) {
  console.error('❌ SLACK_CHANNEL_ID is missing from .env');
  process.exit(1);
}

async function runLiveVerification() {
  console.log('[STEP 1] Initializing Slack Bolt Client...');
  await initSlack();

  const prNumber = 6;
  const ticketKey = 'SCRUM-10';
  const githubUrl = `https://github.com/nandini-teqfocus/poc-loop-engineering/pull/${prNumber}`;
  const jiraUrl = `https://snandini548.atlassian.net/browse/${ticketKey}`;

  // 1. Post a PR Announcement card with the [ 🤖 Run AI Review ] button
  console.log(`[STEP 2] Posting PR Announcement card to Slack channel ${CHANNEL_ID}...`);
  const initialText = `📢 *Pull Request Ready for Review: #${prNumber}*\n` +
    `• *Ticket:* \`${ticketKey}\` — Create 2 fields in Account object\n` +
    `• *Branch:* \`portal/${ticketKey}\`\n` +
    `• *Changes:* Added \`Service_Tier__c\` (Picklist) & \`Onboarding_Date__c\` (Date)\n\n` +
    `Click *[ 🤖 Run AI Review ]* below or reply with \`review PR ${prNumber}\` to trigger an instant Gemini review!`;

  const threadTs = await postSlackMessage(CHANNEL_ID, initialText, null, {
    jiraUrl,
    githubUrl,
    enableAiReviewButton: true
  });

  console.log(`✅ [SLACK] Parent message posted! Thread TS: ${threadTs}`);
  registerTicketThread(ticketKey, threadTs);

  // 2. Simulate User clicking the button or replying in the thread
  console.log(`\n[STEP 3] Simulating interactive trigger for PR #${prNumber} in thread...`);
  await executeSlackAiReview({
    channel: CHANNEL_ID,
    threadTs,
    prNumber,
    ticketKey,
    user: 'Nandini'
  });

  console.log('\n======================================================');
  console.log('🎉 LIVE SLACK VERIFICATION COMPLETED SUCCESSFULLY!');
  console.log(`Check your Slack channel (${CHANNEL_ID}) to view the live AI Code Review card!`);
  console.log('======================================================\n');
}

runLiveVerification().then(() => {
  // Gracefully exit after giving network a brief moment to settle
  setTimeout(() => process.exit(0), 2000);
}).catch((err) => {
  console.error('❌ Live Slack verification failed:', err);
  process.exit(1);
});
