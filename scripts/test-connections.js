import 'dotenv/config';
import { App } from '@slack/bolt';

console.log('--- Verifying Connections ---');

// 1. Check environment variables
const requiredEnv = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_CHANNEL_ID',
  'JIRA_BASE_URL',
  'JIRA_USER_EMAIL',
  'JIRA_API_TOKEN'
];

let missing = false;
for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    console.warn(`[MISSING] Environment variable: ${envVar}`);
  } else {
    console.log(`[OK] Found ${envVar}`);
  }
}


// 2. Test JIRA API connection
async function testJira() {
  try {
    const rawUrl = process.env.JIRA_BASE_URL.trim();
    const parsedUrl = new URL(rawUrl);
    const baseUrl = parsedUrl.origin;
    const authHeader = Buffer.from(
      `${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_TOKEN}`
    ).toString('base64');

    console.log(`[JIRA DEBUG] Querying: ${baseUrl}/rest/api/3/myself`);
    const res = await fetch(`${baseUrl}/rest/api/3/myself`, {
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Accept': 'application/json'
      }
    });
    console.log(`[JIRA DEBUG] Response status: ${res.status}`);
    const text = await res.text();
    if (res.ok) {
      const data = JSON.parse(text);
      console.log(`[JIRA OK] Connected as: ${data.displayName} (${data.emailAddress})`);

      // Check projects
      const projRes = await fetch(`${baseUrl}/rest/api/3/project`, {
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Accept': 'application/json'
        }
      });
      if (projRes.ok) {
        const projData = await projRes.json();
        console.log(`\nFound ${projData.length} JIRA Projects:`);
        for (const p of projData) {
          console.log(` - [${p.key}] ${p.name} (id: ${p.id})`);
        }
      } else {
        console.log(`[JIRA project query status]: ${projRes.status}`);
      }

    } else {

      console.error(`[JIRA ERROR] Status ${res.status}: ${text.substring(0, 200)}...`);
    }

  } catch (err) {
    console.error(`[JIRA EXCEPTION] ${err.message}`);
  }
}

// 3. Test Slack connection
async function testSlack() {
  try {
    const app = new App({
      token: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      socketMode: true
    });

    const authRes = await app.client.auth.test();
    console.log(`[SLACK OK] Connected as bot: @${authRes.user} in team ${authRes.team}`);

    if (process.env.SLACK_CHANNEL_ID) {
      const postRes = await app.client.chat.postMessage({
        channel: process.env.SLACK_CHANNEL_ID,
        text: '🚀 *POC Loop Engineering*: Slack integration verified and ready!'
      });
      console.log(`[SLACK OK] Successfully sent test message to channel ${process.env.SLACK_CHANNEL_ID} (ts: ${postRes.ts})`);
    } else {
      console.warn('[SLACK WARN] SLACK_CHANNEL_ID is not defined.');
    }
  } catch (err) {
    console.error(`[SLACK ERROR] ${err.message}`);
  }
}


await testJira();
await testSlack();
process.exit(0);
