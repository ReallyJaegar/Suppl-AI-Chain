// src/services/inboxPoller.js
// Polls Gmail and/or Outlook inboxes on a schedule.
// New emails are automatically sent through the extraction pipeline.
//
// Gmail:   Uses Gmail API with label filtering
// Outlook: Uses Microsoft Graph API

import cron from 'node-cron';
import { google } from 'googleapis';
import { config } from '../config/index.js';
import { extractionService } from './extractionService.js';
import { orderStore } from './orderStore.js';
import { clarificationService } from './clarificationService.js';
import { logger } from '../utils/logger.js';

// Track processed message IDs to avoid reprocessing
const processedIds = new Set();

// ─── Gmail poller ─────────────────────────────────────────

async function getGmailClient() {
  const oauth2 = new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
    config.gmail.redirectUri,
  );
  oauth2.setCredentials({ refresh_token: config.gmail.refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

async function pollGmail() {
  const credOk = v => !!v && !v.startsWith("your_") && !v.includes("stored_after");
  if (!credOk(config.gmail.clientId) || !credOk(config.gmail.clientSecret) || !credOk(config.gmail.refreshToken)) return;
  try {
    const gmail = await getGmailClient();

    // Search for unread emails in the orders inbox (customize the query)
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread label:orders-inbox',   // adjust label to match your setup
      maxResults: 20,
    });

    const messages = listRes.data.messages ?? [];
    logger.info(`Gmail: found ${messages.length} unread messages`);

    for (const msg of messages) {
      if (processedIds.has(msg.id)) continue;

      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      const headers = full.data.payload.headers;
      const getHeader = name => headers.find(h => h.name.toLowerCase() === name)?.value ?? '';

      const from    = getHeader('from');
      const subject = getHeader('subject');
      const date    = getHeader('date');

      // Extract body text (handles multipart)
      const body = extractGmailBody(full.data.payload);

      if (!body.trim()) {
        logger.warn('Gmail: empty body, skipping', { id: msg.id, subject });
        continue;
      }

      logger.info('Gmail: processing email', { id: msg.id, from, subject });

      const order = await extractionService.parseEmail({ from, subject, date, body });
      order.sourceChannel = 'gmail';
      order.sourceMessageId = msg.id;
      await orderStore.save(order);

      // Auto-send clarification if there are exceptions
      if (!order.touchless && order.suggestedClarificationEmail) {
        await clarificationService.sendGmail(gmail, {
          to: from,
          subject: `Re: ${subject}`,
          body: order.suggestedClarificationEmail,
          threadId: full.data.threadId,
        });
        logger.info('Gmail: clarification sent', { orderId: order.id, to: from });
      }

      // Mark as read
      await gmail.users.messages.modify({
        userId: 'me',
        id: msg.id,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });

      processedIds.add(msg.id);
    }
  } catch (err) {
    logger.error('Gmail poll error', { error: err.message });
  }
}

function extractGmailBody(payload) {
  // Prefer plain text over HTML
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractGmailBody(part);
      if (text) return text;
    }
  }
  return '';
}

// ─── Outlook (Microsoft Graph) poller ────────────────────

let outlookAccessToken = null;
let outlookTokenExpiry = 0;

async function getOutlookToken() {
  if (outlookAccessToken && Date.now() < outlookTokenExpiry - 60_000) {
    return outlookAccessToken;
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${config.outlook.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.outlook.clientId,
        client_secret: config.outlook.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: process.env.OUTLOOK_REFRESH_TOKEN,
        scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send offline_access',
      }),
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(data.error_description);

  outlookAccessToken = data.access_token;
  outlookTokenExpiry = Date.now() + data.expires_in * 1000;
  return outlookAccessToken;
}

async function pollOutlook() {
  if (!config.outlook.clientId || !process.env.OUTLOOK_REFRESH_TOKEN) return;

  try {
    const token = await getOutlookToken();

    const res = await fetch(
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=isRead eq false&$top=20&$select=id,subject,from,receivedDateTime,body',
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const data = await res.json();
    const messages = data.value ?? [];
    logger.info(`Outlook: found ${messages.length} unread messages`);

    for (const msg of messages) {
      if (processedIds.has(msg.id)) continue;

      const from    = msg.from?.emailAddress?.address ?? '';
      const subject = msg.subject ?? '';
      const date    = msg.receivedDateTime;
      const body    = msg.body?.content ?? '';

      // Strip HTML tags for plain text
      const plainBody = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      logger.info('Outlook: processing email', { id: msg.id, from, subject });

      const order = await extractionService.parseEmail({ from, subject, date, body: plainBody });
      order.sourceChannel = 'outlook';
      order.sourceMessageId = msg.id;
      await orderStore.save(order);

      // Mark as read
      await fetch(`https://graph.microsoft.com/v1.0/me/messages/${msg.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead: true }),
      });

      processedIds.add(msg.id);
    }
  } catch (err) {
    logger.error('Outlook poll error', { error: err.message });
  }
}

// ─── Scheduler ────────────────────────────────────────────

export function startInboxPoller() {
  // Poll every 2 minutes
  cron.schedule('*/2 * * * *', async () => {
    logger.info('Inbox poll cycle starting');
    await Promise.allSettled([pollGmail(), pollOutlook()]);
    logger.info('Inbox poll cycle complete');
  });

  // Run immediately on startup
  setTimeout(async () => {
    await Promise.allSettled([pollGmail(), pollOutlook()]);
  }, 2000);
}
