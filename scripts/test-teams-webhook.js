import 'dotenv/config';
import {
  isTeamsConfigured,
  getTeamsChannelEmail,
  postTeamsMessage,
  notifyTeamsPhase,
  notifyTeamsStageChange
} from '../src/teams.js';

async function main() {
  console.log('=== Testing Microsoft Teams Integration ===\n');

  const configured = isTeamsConfigured();
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  const channelEmail = getTeamsChannelEmail();

  console.log(`1. Detection Status:`);
  console.log(`   • Webhook Configured: ${Boolean(webhookUrl && webhookUrl.startsWith('http'))}`);
  console.log(`   • Channel Email: ${channelEmail || 'Not configured'}`);
  console.log(`   • Overall isTeamsConfigured: ${configured}\n`);

  if (!configured) {
    console.log('[INFO] Neither TEAMS_WEBHOOK_URL nor an active email transport (SMTP / Resend) is configured.');
    console.log('       To deliver to Teams via Channel Email, configure your email credentials in .env:');
    console.log('         TEAMS_CHANNEL_EMAIL="Agent Dev - TESTING <33ae4fb8.teqfocus.com@in.teams.ms>"');
    console.log('         SMTP_HOST=smtp.gmail.com');
    console.log('         SMTP_PORT=465');
    console.log('         SMTP_USER=snandini548@gmail.com');
    console.log('         SMTP_PASS=your_app_password');
    console.log('       Or using Resend:');
    console.log('         RESEND_API_KEY=re_...\n');
    console.log('[INFO] Verifying dry-run execution without throwing exceptions...');

    const res1 = await postTeamsMessage('Test message');
    const res2 = await notifyTeamsPhase({
      phaseNumber: 1,
      phaseName: 'Test Phase',
      status: 'Completed',
      summary: 'Dry run verification passed.'
    });
    const res3 = await notifyTeamsStageChange({
      ticketKey: 'SCRUM-13',
      fromStage: 'To Do',
      toStage: 'In Progress',
      summary: 'Dry run verification passed.'
    });

    if (res1 === false && res2 === false && res3 === false) {
      console.log('✅ Graceful degradation verified: all methods returned false safely without throwing.');
    } else {
      console.warn('⚠️ Unexpected return values during unconfigured run.');
    }

    console.log('\n=== Microsoft Teams Integration Test Completed (Unconfigured Mode) ===');
    return;
  }

  console.log('[INFO] Teams notification channel is configured. Sending live test notifications...');

  try {
    console.log('\n1. Sending test card message...');
    const resMessage = await postTeamsMessage(
      `Autonomous Multi-Agent Loop is active and operational.
• Status: Healthy & Ready
• Target Org: time-sheet (nandini.singh.c2d90108260b@agentforce.com)
• GitHub Account: nandini-teqfocus
• Active Integrations: Slack (Socket Mode) + Microsoft Teams Channel`,
      {
        title: 'Microsoft Teams Integration Live Verification',
        jiraUrl: 'https://snandini548.atlassian.net/browse/SCRUM-13',
        githubUrl: 'https://github.com/nandini-teqfocus/poc-loop-engineering'
      }
    );
    console.log(`   Result: ${resMessage ? 'SUCCESS' : 'FAILED'}`);

    console.log('\n2. Sending test phase notification...');
    const resPhase = await notifyTeamsPhase({
      phaseNumber: 1,
      phaseName: 'Ticket Ingestion & Requirement Analysis',
      status: 'Completed',
      summary: `• JIRA Ticket: SCRUM-13 - Timesheet Automation Trigger & Validation
• Scope & Objective: Validate user hours before submission against business policy
• Acceptance Criteria: Ensure weekly hours <= 40 unless overtime approved; reject negative values
• Components Identified: TimesheetTrigger.trigger, TimesheetValidator.cls, TimesheetValidatorTest.cls
• Target Org Context: time-sheet (Verified active and scratch connection established)`,
      nextPhase: 'Phase 2: Architecture & Technical Design (Agent 1)',
      jiraUrl: 'https://snandini548.atlassian.net/browse/SCRUM-13',
      githubUrl: 'https://github.com/nandini-teqfocus/poc-loop-engineering'
    });
    console.log(`   Result: ${resPhase ? 'SUCCESS' : 'FAILED'}`);

    console.log('\n3. Sending test stage transition notification...');
    const resStage = await notifyTeamsStageChange({
      ticketKey: 'SCRUM-13',
      fromStage: 'In Progress',
      toStage: 'In Review',
      summary: `• Transition Reason: Apex implementation & test suite completed with 96% code coverage
• Pull Request: #7 opened against main branch in nandini-teqfocus/poc-loop-engineering
• Static Analysis: PMD 0 violations, Apex Security scanner passed clean
• Next Action: Awaiting Lead Review and Human-in-the-Loop Slack / Teams sign-off`,
      jiraUrl: 'https://snandini548.atlassian.net/browse/SCRUM-13',
      githubUrl: 'https://github.com/nandini-teqfocus/poc-loop-engineering/pull/7'
    });
    console.log(`   Result: ${resStage ? 'SUCCESS' : 'FAILED'}`);

    console.log('\n=== Microsoft Teams Integration Test Completed (Live Mode) ===');
  } catch (err) {
    console.error('❌ Error testing Teams integration:', err);
    process.exit(1);
  }
}

main();
