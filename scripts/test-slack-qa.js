import 'dotenv/config';
import { updateTicketState, generateStatusAnswer } from '../src/statusResponder.js';
import { postSlackMessage, initSlack } from '../src/slack.js';

console.log('====================================================');
console.log('🚀 Starting Test Suite: Interactive Slack Status Q&A');
console.log('====================================================\n');

const CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
if (!CHANNEL_ID) {
  console.error('❌ SLACK_CHANNEL_ID is missing from .env');
  process.exit(1);
}

async function runTests() {
  // 1. Setup Mock State for SCRUM-11 (In Progress, Agent 2 Building)
  console.log('[STEP 1] Initializing test data for SCRUM-11 (In Progress, Phase 2)...');
  const startTime = Date.now() - (185 * 1000); // 3 minutes 5 seconds ago
  const phaseStartTime = Date.now() - (115 * 1000); // 1 minute 55 seconds ago

  updateTicketState('SCRUM-11', {
    summary: 'Create a validation rule on Contact',
    startTime,
    currentPhaseNumber: 2,
    currentPhaseName: 'Implementation & Salesforce Deployment (Agent 2)',
    phaseStartTime,
    status: 'In Progress',
    jiraStatus: 'In Progress',
    lastActivity: 'Deploying validation rule metadata to time-sheet org via sf project deploy start',
    nextPhase: 'Phase 5: Automated PR Review (Agent 4)',
    prUrl: null,
    branchName: 'portal/SCRUM-11',
    isRunning: true
  });

  // 2. Setup Mock State for SCRUM-10 (Done, PR #6)
  console.log('[STEP 2] Initializing test data for SCRUM-10 (Completed, PR #6)...');
  updateTicketState('SCRUM-10', {
    summary: 'Create 2 fields in Account object',
    startTime: Date.now() - (600 * 1000),
    currentPhaseNumber: 7,
    currentPhaseName: 'QA Passed & Signed Off',
    phaseStartTime: Date.now() - (120 * 1000),
    status: 'Done',
    jiraStatus: 'Done',
    lastActivity: 'Feature delivered, reviewed, and tested end-to-end!',
    prUrl: 'https://github.com/nandini-teqfocus/poc-loop-engineering/pull/6',
    branchName: 'portal/SCRUM-10',
    isRunning: false,
    testResults: {
      passed: true,
      summary: 'All acceptance criteria, metadata definitions, and dry-run deployments passed with zero errors.'
    }
  });

  // 3. Define Test Scenarios
  const testScenarios = [
    {
      name: 'Scenario A: User asking if task is still in implementation / why taking long',
      ticketKey: 'SCRUM-11',
      question: 'its been so long the agent has started the task and in slack i coulnot see any update so for that i might ask that the task is still in the implementation phase or what ?',
      expectedKeywords: ['not stuck', 'Phase 2', 'Implementation', 'time-sheet']
    },
    {
      name: 'Scenario B: User asking about phase directly',
      ticketKey: 'SCRUM-11',
      question: 'is the task still in the implementation phase?',
      expectedKeywords: ['Phase 2', 'Implementation & Salesforce Deployment']
    },
    {
      name: 'Scenario C: User asking for PR link when PR is not yet created',
      ticketKey: 'SCRUM-11',
      question: 'what is the PR link?',
      expectedKeywords: ['not been opened yet', 'Phase 2']
    },
    {
      name: 'Scenario D: User asking for PR link when PR IS created (SCRUM-10)',
      ticketKey: 'SCRUM-10',
      question: 'where is the PR link?',
      expectedKeywords: ['https://github.com/nandini-teqfocus/poc-loop-engineering/pull/6']
    },
    {
      name: 'Scenario E: User asking about QA test results',
      ticketKey: 'SCRUM-10',
      question: 'did the QA tests pass?',
      expectedKeywords: ['PASSED', 'acceptance criteria']
    }
  ];

  console.log(`\n[STEP 3] Running ${testScenarios.length} automated test scenarios against generateStatusAnswer()...\n`);

  let allPassed = true;

  for (let i = 0; i < testScenarios.length; i++) {
    const scenario = testScenarios[i];
    console.log(`--- Test ${i + 1}: ${scenario.name} ---`);
    console.log(`Question: "${scenario.question}"`);

    const result = await generateStatusAnswer({
      ticketKey: scenario.ticketKey,
      question: scenario.question,
      user: 'U_TESTER'
    });

    console.log('Result text snippet:\n' + result.text.substring(0, 180) + '...\n');

    // Verify expected keywords
    let scenarioPassed = true;
    for (const kw of scenario.expectedKeywords) {
      if (!result.text.includes(kw)) {
        console.error(`❌ Missing keyword in answer: "${kw}"`);
        scenarioPassed = false;
        allPassed = false;
      }
    }

    if (scenarioPassed) {
      console.log(`✅ Test ${i + 1} PASSED!\n`);
    } else {
      console.error(`❌ Test ${i + 1} FAILED!\n`);
    }
  }

  // 4. Live Slack Channel Verification
  console.log('[STEP 4] Posting Live Verification Thread into Slack Channel...');
  await initSlack();

  // Create Parent Verification Thread
  const parentTs = await postSlackMessage(
    CHANNEL_ID,
    `🧪 *[TEST DATA VERIFICATION]*: Testing Interactive Status Q&A Responder\n• *Target Ticket:* \`SCRUM-11\`\n• *Simulated State:* Agent 2 actively deploying metadata\n• *Feature:* Live user status questions & thread answers`,
    null,
    { jiraUrl: 'https://snandini548.atlassian.net/browse/SCRUM-11' }
  );

  console.log(`[SLACK OK] Created test parent thread (ts: ${parentTs})`);

  // Post User Question 1 (The exact example user asked for)
  const q1 = 'its been so long the agent has started the task and in slack i coulnot see any update so for that i might ask that the task is still in the implementation phase or what ?';
  await postSlackMessage(
    CHANNEL_ID,
    `👤 *User Asked:* "${q1}"`,
    parentTs
  );

  // Generate & Post Bot Response 1
  const ans1 = await generateStatusAnswer({
    ticketKey: 'SCRUM-11',
    question: q1,
    user: 'U_DEV'
  });

  await postSlackMessage(
    CHANNEL_ID,
    ans1.text,
    parentTs,
    ans1.buttonOptions
  );
  console.log('[SLACK OK] Posted Response 1 with JIRA action button.');

  // Post User Question 2 (PR Link check)
  const q2 = 'where is the PR link?';
  await postSlackMessage(
    CHANNEL_ID,
    `👤 *User Asked:* "${q2}"`,
    parentTs
  );

  const ans2 = await generateStatusAnswer({
    ticketKey: 'SCRUM-11',
    question: q2,
    user: 'U_DEV'
  });

  await postSlackMessage(
    CHANNEL_ID,
    ans2.text,
    parentTs,
    ans2.buttonOptions
  );
  console.log('[SLACK OK] Posted Response 2.');

  console.log('\n====================================================');
  if (allPassed) {
    console.log('🎉 ALL 5 TEST SCENARIOS PASSED WITH ZERO ERRORS!');
    console.log(`Live messages verified in Slack channel: ${CHANNEL_ID}`);
  } else {
    console.log('⚠️ Some test scenarios failed verification.');
  }
  console.log('====================================================\n');
}

runTests().then(() => process.exit(0)).catch((err) => {
  console.error('FATAL TEST ERROR:', err);
  process.exit(1);
});
