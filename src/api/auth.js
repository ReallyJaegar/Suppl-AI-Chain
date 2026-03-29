// src/api/auth.js
// OAuth flow routes for Gmail and Outlook inbox connectors.
//
// GET /auth/gmail           — Redirect to Google consent screen
// GET /auth/gmail/callback  — Handle OAuth callback, store refresh token
// GET /auth/outlook         — Redirect to Microsoft consent screen
// GET /auth/outlook/callback — Handle OAuth callback

import { Router } from 'express';
import { google } from 'googleapis';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const authRoutes = Router();

// ─── Gmail OAuth ──────────────────────────────────────────

function getGmailOAuth2Client() {
  return new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
    config.gmail.redirectUri,
  );
}

// Step 1: Redirect user to Google consent screen
authRoutes.get('/gmail', (req, res) => {
  if (!config.gmail.clientId) {
    return res.status(501).json({ error: 'Gmail credentials not configured' });
  }
  const oauth2 = getGmailOAuth2Client();
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',          // force refresh_token on every auth
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  });
  res.redirect(url);
});

// Step 2: Google redirects here with ?code=...
// Exchange code for tokens, log the refresh token to store in .env
authRoutes.get('/gmail/callback', asyncHandler(async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    logger.error('Gmail OAuth error', { error });
    return res.status(400).json({ error });
  }

  const oauth2 = getGmailOAuth2Client();
  const { tokens } = await oauth2.getToken(code);

  logger.info('Gmail OAuth success', {
    hasRefreshToken: !!tokens.refresh_token,
    scope: tokens.scope,
  });

  // In production, persist this securely (DB or secrets manager).
  // For MVP: log it and add to .env manually.
  if (tokens.refresh_token) {
    logger.info('>>> Store this refresh token in GMAIL_REFRESH_TOKEN env var', {
      refreshToken: tokens.refresh_token,
    });
  }

  res.json({
    message: 'Gmail connected successfully',
    note: 'Copy GMAIL_REFRESH_TOKEN from server logs into your .env file',
    hasRefreshToken: !!tokens.refresh_token,
  });
}));

// ─── Outlook OAuth ────────────────────────────────────────
// Uses Microsoft Identity Platform (OAuth 2.0 authorization code flow)

authRoutes.get('/outlook', (req, res) => {
  if (!config.outlook.clientId) {
    return res.status(501).json({ error: 'Outlook credentials not configured' });
  }

  const params = new URLSearchParams({
    client_id: config.outlook.clientId,
    response_type: 'code',
    redirect_uri: config.outlook.redirectUri,
    scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send offline_access',
    response_mode: 'query',
  });

  const url = `https://login.microsoftonline.com/${config.outlook.tenantId}/oauth2/v2.0/authorize?${params}`;
  res.redirect(url);
});

authRoutes.get('/outlook/callback', asyncHandler(async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    logger.error('Outlook OAuth error', { error });
    return res.status(400).json({ error });
  }

  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${config.outlook.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.outlook.clientId,
        client_secret: config.outlook.clientSecret,
        code,
        redirect_uri: config.outlook.redirectUri,
        grant_type: 'authorization_code',
      }),
    }
  );

  const tokens = await tokenRes.json();

  if (tokens.error) {
    logger.error('Outlook token exchange failed', tokens);
    return res.status(400).json({ error: tokens.error_description });
  }

  logger.info('Outlook OAuth success', { hasRefreshToken: !!tokens.refresh_token });

  if (tokens.refresh_token) {
    logger.info('>>> Store this in OUTLOOK_REFRESH_TOKEN env var', {
      refreshToken: tokens.refresh_token,
    });
  }

  res.json({
    message: 'Outlook connected successfully',
    hasRefreshToken: !!tokens.refresh_token,
  });
}));

// ─── Status ───────────────────────────────────────────────
authRoutes.get('/status', (req, res) => {
  res.json({
    gmail: !!config.gmail.refreshToken,
    outlook: !!config.outlook.clientId,
  });
});
