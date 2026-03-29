// src/services/extractionService.js
// The AI brain. Uses Claude to extract structured order data from any format.
// Also handles file-to-text conversion (PDF, XLSX, CSV).

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import { skuMapper } from './skuMapper.js';
import { logger } from '../utils/logger.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// ─── System prompt ────────────────────────────────────────
// This is the core instruction set. Tune this as you learn from real orders.

const SYSTEM_PROMPT = `You are an order intake AI agent for a B2B manufacturer.
Your job is to extract structured purchase order data from incoming messages.
Input may be: a free-text email, CSV/spreadsheet data pasted as text, or extracted PDF text.

Extract ALL fields below. Use null for any field not found.
Return ONLY a raw JSON object — no markdown fences, no preamble, no explanation.

JSON schema:
{
  "poNumber": string | null,
  "customerName": string | null,
  "customerEmail": string | null,
  "shipTo": {
    "name": string | null,
    "address": string | null,
    "city": string | null,
    "state": string | null,
    "zip": string | null,
    "country": string | null
  } | null,
  "requestedDeliveryDate": string | null,
  "paymentTerms": string | null,
  "currency": string,
  "lineItems": [
    {
      "rawDescription": string,
      "mappedSku": string | null,
      "quantity": number | null,
      "unitPrice": number | null,
      "totalPrice": number | null,
      "unit": string | null,
      "notes": string | null,
      "issues": string[]
    }
  ],
  "orderTotal": number | null,
  "exceptions": string[],
  "touchless": boolean,
  "confidence": number,
  "suggestedClarificationEmail": string | null
}

Rules:
- exceptions: list every missing required field, price anomaly, unknown product, or ambiguity
- touchless: true ONLY if ALL of these are present and valid: poNumber, shipTo, requestedDeliveryDate, and all lineItems have quantity + unitPrice
- confidence: 0.0–1.0. Deduct for: missing fields (-0.1 each), ambiguous quantities (-0.05), unclear descriptions (-0.05)
- currency: default "USD" if not specified
- suggestedClarificationEmail: if touchless=false, write a concise professional email asking ONLY for missing info. null if touchless=true.
- requestedDeliveryDate: normalize to ISO 8601 (YYYY-MM-DD) if possible
- lineItems[].issues: item-level problems (e.g. "price below contract rate", "SKU not recognized")
- orderTotal: sum of all lineItems totalPrice if not explicitly stated`;

// ─── Main extraction function ─────────────────────────────

export const extractionService = {

  async parseEmail({ from, subject, date, body }) {
    const userMessage = [
      `From: ${from ?? 'unknown'}`,
      `Subject: ${subject ?? 'no subject'}`,
      `Date: ${date}`,
      '',
      body,
    ].join('\n');

    let rawJson;

    try {
      const response = await client.messages.create({
        model: config.anthropic.model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      rawJson = response.content[0].text.trim();
      // Strip accidental markdown fences
      rawJson = rawJson.replace(/^```json\s*/i, '').replace(/\s*```$/, '');

    } catch (err) {
      logger.error('Claude API error', { error: err.message });
      throw new Error(`AI extraction failed: ${err.message}`);
    }

    let extracted;
    try {
      extracted = JSON.parse(rawJson);
    } catch {
      logger.error('Failed to parse Claude response as JSON', { rawJson });
      throw new Error('AI returned malformed JSON — check logs');
    }

    // ─── Post-processing ──────────────────────────────────
    // 1. Run SKU mapper over all line items
    extracted.lineItems = await Promise.all(
      (extracted.lineItems ?? []).map(async item => {
        if (!item.mappedSku && item.rawDescription) {
          const mapped = await skuMapper.lookup(item.rawDescription);
          if (mapped) {
            item.mappedSku = mapped.sku;
            // Remove any "SKU not recognized" issues now that we have a match
            item.issues = (item.issues ?? []).filter(i => !i.toLowerCase().includes('sku'));
          }
        }
        // Calculate totalPrice if missing
        if (item.totalPrice == null && item.quantity != null && item.unitPrice != null) {
          item.totalPrice = parseFloat((item.quantity * item.unitPrice).toFixed(2));
        }
        return item;
      })
    );

    // 2. Recalculate orderTotal
    if (extracted.orderTotal == null) {
      const total = extracted.lineItems.reduce((sum, i) => sum + (i.totalPrice ?? 0), 0);
      if (total > 0) extracted.orderTotal = parseFloat(total.toFixed(2));
    }

    // 3. Re-evaluate touchless after SKU mapping
    const hasUnresolvedSkus = extracted.lineItems.some(i => !i.mappedSku);
    const hasMissingPrices  = extracted.lineItems.some(i => i.unitPrice == null);
    if (hasUnresolvedSkus || hasMissingPrices) {
      extracted.touchless = false;
    }

    // 4. Attach metadata
    extracted.id            = crypto.randomUUID();
    extracted.sourceEmail   = from;
    extracted.sourceSubject = subject;
    extracted.receivedAt    = date;
    extracted.parsedAt      = new Date().toISOString();
    extracted.status        = extracted.touchless ? 'touchless' : 'exception';

    return extracted;
  },

  // ─── File text extraction ─────────────────────────────
  // Converts uploaded files to plain text before passing to Claude.

  async extractTextFromFile(buffer, mimetype, filename) {
    if (mimetype === 'text/csv' || mimetype === 'text/plain') {
      return buffer.toString('utf-8');
    }

    if (mimetype === 'application/pdf') {
      // Dynamic import — pdf-parse has CJS quirks
      const pdfParse = (await import('pdf-parse')).default;
      const data = await pdfParse(buffer);
      logger.info('PDF extracted', { filename, pages: data.numpages, chars: data.text.length });
      return data.text;
    }

    if (
      mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimetype === 'application/vnd.ms-excel'
    ) {
      const XLSX = (await import('xlsx')).default;
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      // Concatenate all sheets as CSV text
      const sheets = workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        return `=== Sheet: ${name} ===\n${XLSX.utils.sheet_to_csv(sheet)}`;
      });
      return sheets.join('\n\n');
    }

    throw new Error(`Cannot extract text from file type: ${mimetype}`);
  },
};
