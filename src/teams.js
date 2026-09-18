import 'dotenv/config';
import nodemailer from 'nodemailer';

/**
 * Microsoft Teams Integration Service
 * 
 * Supports:
 * 1. Teams Channel Webhook (Adaptive Cards 1.4 via Power Automate / Workflows / Connectors)
 * 2. Teams Channel Email (Clean, native HTML cards delivered to channel email, e.g. <hash>@in.teams.ms)
 */

/**
 * Extracts and sanitizes the Teams channel email address from environment
 * @returns {string|null}
 */
export function getTeamsChannelEmail() {
  const raw = process.env.TEAMS_CHANNEL_EMAIL;
  if (!raw || !raw.trim()) return null;
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1].trim() : raw.trim();
}

/**
 * Checks if Teams integration is configured (either via Webhook or Email)
 * @returns {boolean}
 */
export function isTeamsConfigured() {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (webhookUrl && webhookUrl.trim().startsWith('http')) return true;

  const channelEmail = getTeamsChannelEmail();
  const hasSmtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  const hasResend = Boolean(process.env.RESEND_API_KEY);

  return Boolean(channelEmail && (hasSmtp || hasResend));
}

/**
 * Creates a reusable nodemailer transporter for SMTP delivery
 */
function getEmailTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function formatInlineCode(text) {
  if (!text) return '';
  return text
    .replace(/`([^`]+)`/g, '<code style="background-color: #EDEBE9; border: 1px solid #D2D0CE; padding: 1px 5px; border-radius: 4px; font-family: Consolas, Monaco, monospace; font-size: 12px; color: #822727;">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="color: #201F1E;">$1</strong>')
    .replace(/\*([^*]+)\*/g, '<strong style="color: #201F1E;">$1</strong>');
}

function formatRichSummary(summary, badgeColor) {
  if (!summary) return '';

  const rawLines = summary.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const elements = [];

  for (const line of rawLines) {
    if (line.startsWith('•') || line.startsWith('-') || line.startsWith('*')) {
      const clean = line.replace(/^[•*-]\s*/, '');
      const colonIdx = clean.indexOf(':');
      if (colonIdx > -1 && colonIdx < 35) {
        const key = clean.substring(0, colonIdx).trim();
        const val = clean.substring(colonIdx + 1).trim();
        elements.push(`
          <div style="margin: 5px 0 5px 4px; display: flex; align-items: flex-start;">
            <span style="color: ${badgeColor}; font-size: 14px; margin-right: 8px; line-height: 1.4;">▪</span>
            <div style="color: #242424; line-height: 1.55;">
              <strong style="color: #201F1E;">${formatInlineCode(key)}:</strong> ${formatInlineCode(val)}
            </div>
          </div>
        `);
      } else {
        elements.push(`
          <div style="margin: 5px 0 5px 4px; display: flex; align-items: flex-start;">
            <span style="color: ${badgeColor}; font-size: 14px; margin-right: 8px; line-height: 1.4;">▪</span>
            <div style="color: #242424; line-height: 1.55;">${formatInlineCode(clean)}</div>
          </div>
        `);
      }
    } else if (line.startsWith('>')) {
      const quoteText = line.replace(/^>\s*/, '');
      elements.push(`
        <div style="background-color: #EDEBE9; border-left: 3px solid #605E5C; padding: 6px 12px; margin: 8px 0; border-radius: 0 4px 4px 0; font-family: Consolas, monospace; font-size: 12px; color: #323130;">
          ${formatInlineCode(quoteText)}
        </div>
      `);
    } else {
      const colonIdx = line.indexOf(':');
      if (colonIdx > -1 && colonIdx < 30) {
        const key = line.substring(0, colonIdx).trim();
        const val = line.substring(colonIdx + 1).trim();
        elements.push(`
          <div style="margin: 6px 0; color: #242424; line-height: 1.55;">
            <strong style="color: #201F1E;">${formatInlineCode(key)}:</strong> ${formatInlineCode(val)}
          </div>
        `);
      } else {
        elements.push(`
          <div style="margin: 6px 0; color: #323130; line-height: 1.55;">
            ${formatInlineCode(line)}
          </div>
        `);
      }
    }
  }

  return `
    <div style="background-color: #F8F9FA; border-left: 4px solid ${badgeColor}; border-radius: 0 6px 6px 0; padding: 14px 16px; margin: 12px 0 14px 0; box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
      <div style="font-size: 11.5px; font-weight: 700; color: #484644; text-transform: uppercase; letter-spacing: 0.7px; margin-bottom: 8px; display: flex; align-items: center;">
        <span style="margin-right: 6px; font-size: 13px;">📋</span>
        <span>Detailed Context & Execution Summary</span>
      </div>
      <div style="font-size: 13.5px;">
        ${elements.join('')}
      </div>
      <div style="margin-top: 12px; padding-top: 10px; border-top: 1px dashed #D2D0CE; font-size: 11.5px; color: #605E5C; display: flex; align-items: center; justify-content: space-between;">
        <span>☁️ <strong>Target Org:</strong> <code style="background: #EDEBE9; padding: 1px 5px; border-radius: 3px; font-family: Consolas, monospace; font-size: 11px;">time-sheet</code></span>
        <span>⚡ <strong>Pipeline:</strong> Autonomous Multi-Agent Loop</span>
      </div>
    </div>
  `;
}

/**
 * Builds the clean, original styled HTML card for email delivery to Teams
 */
function buildHtmlCard({
  title,
  badgeText = null,
  badgeColor = '#5B5FC7',
  facts = [],
  summary = '',
  jiraUrl = null,
  githubUrl = null
}) {
  const factsRows = facts.map(f => `
    <tr>
      <td style="padding: 4px 12px 4px 0; font-weight: 600; color: #424242; white-space: nowrap; vertical-align: top;">${f.title}</td>
      <td style="padding: 4px 0; color: #212121;">${f.value}</td>
    </tr>
  `).join('');

  let buttonsHtml = '';
  if (jiraUrl || githubUrl) {
    buttonsHtml = `
      <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid #E0E0E0;">
        ${jiraUrl ? `<a href="${jiraUrl}" target="_blank" style="display: inline-block; padding: 8px 14px; margin-right: 8px; background-color: #0052CC; color: #FFFFFF; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 13px;">🎯 JIRA Ticket</a>` : ''}
        ${githubUrl ? `<a href="${githubUrl}" target="_blank" style="display: inline-block; padding: 8px 14px; background-color: #24292F; color: #FFFFFF; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 13px;">🐙 GitHub PR</a>` : ''}
      </div>
    `;
  }

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; border: 1px solid #E0E0E0; border-radius: 8px; overflow: hidden; background-color: #FFFFFF; margin: 10px 0;">
      <div style="background-color: ${badgeColor}; padding: 12px 16px; color: #FFFFFF;">
        <div style="font-size: 16px; font-weight: 700;">${title}</div>
        ${badgeText ? `<div style="font-size: 12px; opacity: 0.9; margin-top: 2px;">${badgeText}</div>` : ''}
      </div>
      <div style="padding: 16px;">
        ${facts.length > 0 ? `<table style="width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 14px;">${factsRows}</table>` : ''}
        ${formatRichSummary(summary, badgeColor)}
        ${buttonsHtml}
      </div>
      <div style="background-color: #F5F5F5; padding: 8px 16px; font-size: 11px; color: #757575; border-top: 1px solid #EAEAEA;">
        Automated notification from Autonomous Loop Engineering Pipeline
      </div>
    </div>
  `;
}

/**
 * Sends an email notification to the Teams Channel email address
 */
export async function sendTeamsEmail({ subject, html, text = '' }) {
  const channelEmail = getTeamsChannelEmail();
  if (!channelEmail) return false;

  // 1. Try SMTP via Nodemailer if configured
  const transporter = getEmailTransporter();
  if (transporter) {
    try {
      const info = await transporter.sendMail({
        from: `"Loop Engineering" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
        to: channelEmail,
        subject,
        html,
        text: text || subject
      });
      console.log(`[TEAMS EMAIL] Notification delivered to channel email (${channelEmail}) via SMTP. Message ID: ${info.messageId}`);
      return true;
    } catch (e) {
      console.warn(`[TEAMS EMAIL ERROR] SMTP send failed: ${e.message}`);
    }
  }

  // 2. Fallback to Resend API if configured
  if (process.env.RESEND_API_KEY) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'Loop Engineering <onboarding@resend.dev>',
          to: [channelEmail],
          subject,
          html,
          text: text || subject
        })
      });

      if (response.ok) {
        console.log(`[TEAMS EMAIL] Notification delivered to channel email (${channelEmail}) via Resend API.`);
        return true;
      }
      const err = await response.text();
      console.warn(`[TEAMS EMAIL WARN] Resend API error: ${err}`);
    } catch (e) {
      console.warn(`[TEAMS EMAIL ERROR] Resend dispatch failed: ${e.message}`);
    }
  }

  return false;
}

/**
 * Dispatches an HTTP POST payload to the configured Teams Webhook URL.
 */
export async function sendTeamsPayload(payload) {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl || !webhookUrl.trim().startsWith('http')) {
    return false;
  }

  try {
    const response = await fetch(webhookUrl.trim(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn(`[TEAMS WARN] Webhook responded with status ${response.status}: ${errText.substring(0, 200)}`);
      return false;
    }

    console.log('[TEAMS] Notification successfully delivered to Microsoft Teams channel via webhook.');
    return true;
  } catch (err) {
    console.warn(`[TEAMS ERROR] Failed to send webhook payload: ${err.message}`);
    return false;
  }
}

/**
 * Builds standard Adaptive Card action buttons (OpenUrl) for JIRA and GitHub PR
 */
function buildAdaptiveActions({ jiraUrl, githubUrl } = {}) {
  const actions = [];
  if (jiraUrl) {
    actions.push({
      type: 'Action.OpenUrl',
      title: '🎯 JIRA Ticket',
      url: jiraUrl
    });
  }
  if (githubUrl) {
    actions.push({
      type: 'Action.OpenUrl',
      title: '🐙 GitHub PR',
      url: githubUrl
    });
  }
  return actions;
}

/**
 * Wraps Adaptive Card body elements and actions into a Teams-compatible message envelope
 */
function wrapInAdaptiveCard(bodyElements, actions = []) {
  const card = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: bodyElements
  };

  if (actions && actions.length > 0) {
    card.actions = actions;
  }

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: card
      }
    ]
  };
}

/**
 * Posts a generic formatted message or card to Microsoft Teams (Webhook or Email)
 */
export async function postTeamsMessage(text, options = {}) {
  const title = options.title || 'Pipeline Notification';
  let handled = false;

  // 1. Webhook dispatch
  if (process.env.TEAMS_WEBHOOK_URL) {
    const body = [
      ...(options.title ? [{ type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: options.title, wrap: true }] : []),
      { type: 'TextBlock', text: text.replace(/\*(.*?)\*/g, '**$1**'), wrap: true }
    ];
    const actions = buildAdaptiveActions(options);
    const ok = await sendTeamsPayload(wrapInAdaptiveCard(body, actions));
    if (ok) handled = true;
  }

  // 2. Email dispatch
  if (getTeamsChannelEmail()) {
    const html = buildHtmlCard({
      title,
      summary: text,
      jiraUrl: options.jiraUrl,
      githubUrl: options.githubUrl
    });
    const ok = await sendTeamsEmail({
      subject: `[POC Loop] ${title}`,
      html,
      text
    });
    if (ok) handled = true;
  }

  return handled;
}

/**
 * Sends a structured phase lifecycle notification to Microsoft Teams
 */
export async function notifyTeamsPhase({
  phaseNumber,
  phaseName,
  status,
  summary,
  nextPhase = null,
  jiraUrl = null,
  githubUrl = null
}) {
  let statusBadge = status;
  let statusColor = '#5B5FC7';
  let adaptiveColor = 'Default';

  if (status === 'Started') {
    statusBadge = '⏳ Started';
    statusColor = '#0078D4';
    adaptiveColor = 'Accent';
  } else if (status === 'Completed') {
    statusBadge = '✅ Completed';
    statusColor = '#107C41';
    adaptiveColor = 'Good';
  } else if (status === 'Failed') {
    statusBadge = '❌ Failed';
    statusColor = '#D83B01';
    adaptiveColor = 'Attention';
  }

  const title = `Phase ${phaseNumber}: ${phaseName}`;
  const facts = [
    { title: 'Phase:', value: `${phaseNumber} — ${phaseName}` },
    { title: 'Status:', value: statusBadge }
  ];
  if (nextPhase) {
    facts.push({ title: 'Next Phase:', value: nextPhase });
  }

  let handled = false;

  // 1. Webhook
  if (process.env.TEAMS_WEBHOOK_URL) {
    const body = [
      {
        type: 'Container',
        style: adaptiveColor === 'Good' ? 'good' : (adaptiveColor === 'Attention' ? 'attention' : 'emphasis'),
        items: [{ type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: `📍 ${title}`, wrap: true }]
      },
      { type: 'FactSet', facts },
      { type: 'TextBlock', text: `**Summary:**\n${summary}`, wrap: true }
    ];
    const actions = buildAdaptiveActions({ jiraUrl, githubUrl });
    const ok = await sendTeamsPayload(wrapInAdaptiveCard(body, actions));
    if (ok) handled = true;
  }

  // 2. Email
  if (getTeamsChannelEmail()) {
    const html = buildHtmlCard({
      title: `📍 ${title}`,
      badgeText: `Status: ${statusBadge}`,
      badgeColor: statusColor,
      facts,
      summary,
      jiraUrl,
      githubUrl
    });
    const ok = await sendTeamsEmail({
      subject: `[POC Loop] Phase ${phaseNumber}: ${phaseName} - ${statusBadge}`,
      html,
      text: `${title} | Status: ${statusBadge}\n${summary}`
    });
    if (ok) handled = true;
  }

  return handled;
}

/**
 * Sends a structured JIRA stage update notification to Microsoft Teams
 */
export async function notifyTeamsStageChange({
  ticketKey,
  fromStage,
  toStage,
  summary = null,
  jiraUrl = null,
  githubUrl = null
}) {
  let badge = '🔄';
  let statusColor = '#5B5FC7';
  let adaptiveStyle = 'emphasis';
  const lowerTo = (toStage || '').toLowerCase();

  if (lowerTo.includes('progress')) {
    badge = '⚙️';
    statusColor = '#0078D4';
    adaptiveStyle = 'accent';
  } else if (lowerTo.includes('review')) {
    badge = '👀';
    statusColor = '#F7630C';
    adaptiveStyle = 'warning';
  } else if (lowerTo.includes('done') || lowerTo.includes('closed') || lowerTo.includes('resolved')) {
    badge = '🎉';
    statusColor = '#107C41';
    adaptiveStyle = 'good';
  }

  const title = `${badge} JIRA Stage Updated: ${ticketKey}`;
  const facts = [
    { title: 'Ticket:', value: ticketKey || 'N/A' },
    { title: 'Transition:', value: `${fromStage || 'Initial'} ➔ ${toStage}` },
    { title: 'Current Status:', value: toStage || 'Unknown' }
  ];

  let handled = false;

  // 1. Webhook
  if (process.env.TEAMS_WEBHOOK_URL) {
    const body = [
      {
        type: 'Container',
        style: adaptiveStyle,
        items: [{ type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: title, wrap: true }]
      },
      { type: 'FactSet', facts },
      ...(summary ? [{ type: 'TextBlock', text: `**Context:** ${summary}`, wrap: true }] : [])
    ];
    const actions = buildAdaptiveActions({ jiraUrl, githubUrl });
    const ok = await sendTeamsPayload(wrapInAdaptiveCard(body, actions));
    if (ok) handled = true;
  }

  // 2. Email
  if (getTeamsChannelEmail()) {
    const html = buildHtmlCard({
      title,
      badgeText: `Status: ${toStage}`,
      badgeColor: statusColor,
      facts,
      summary,
      jiraUrl,
      githubUrl
    });
    const ok = await sendTeamsEmail({
      subject: `[JIRA] ${ticketKey}: ${fromStage || 'Initial'} ➔ ${toStage}`,
      html,
      text: `${ticketKey}: ${fromStage || 'Initial'} ➔ ${toStage}\n${summary || ''}`
    });
    if (ok) handled = true;
  }

  return handled;
}
