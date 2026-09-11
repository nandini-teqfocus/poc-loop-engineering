import 'dotenv/config';
import { App } from '@slack/bolt';

let slackApp = null;
let activeResolvers = new Map(); // threadTs -> resolve function

export async function initSlack() {
  if (slackApp) return slackApp;

  slackApp = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true
  });

  // Listen for thread replies
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

  await slackApp.start();
  console.log('[SLACK] Socket Mode client connected and listening.');
  return slackApp;
}

export async function postSlackMessage(channel, text, threadTs = null) {
  const app = await initSlack();
  const res = await app.client.chat.postMessage({
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {})
  });
  return res.ts;
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
