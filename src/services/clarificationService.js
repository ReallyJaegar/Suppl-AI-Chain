// src/services/clarificationService.js
// Sends targeted clarification emails to customers when orders have exceptions.
// Supports Gmail (via API) and SMTP fallback.

import { logger } from '../utils/logger.js';

export const clarificationService = {

  // Send via Gmail API (used when poller processes a Gmail message)
  async sendGmail(gmailClient, { to, subject, body, threadId }) {
    const raw = buildRawEmail({ to, subject, body });
    try {
      await gmailClient.users.messages.send({
        userId: 'me',
        requestBody: {
          raw,
          ...(threadId && { threadId }),
        },
      });
      logger.info('Clarification email sent via Gmail', { to, subject });
    } catch (err) {
      logger.error('Failed to send clarification via Gmail', { error: err.message });
      throw err;
    }
  },

  // Send via Microsoft Graph (used when poller processes an Outlook message)
  async sendOutlook(accessToken, { to, subject, body, replyToMessageId }) {
    const endpoint = replyToMessageId
      ? `https://graph.microsoft.com/v1.0/me/messages/${replyToMessageId}/reply`
      : 'https://graph.microsoft.com/v1.0/me/sendMail';

    const payload = replyToMessageId
      ? { comment: body }
      : {
          message: {
            subject,
            body: { contentType: 'Text', content: body },
            toRecipients: [{ emailAddress: { address: to } }],
          },
        };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.text();
      logger.error('Failed to send clarification via Outlook', { error: err });
      throw new Error(err);
    }

    logger.info('Clarification email sent via Outlook', { to, subject });
  },
};

// ─── Helpers ──────────────────────────────────────────────

function buildRawEmail({ to, subject, body }) {
  const email = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  return Buffer.from(email).toString('base64url');
}
