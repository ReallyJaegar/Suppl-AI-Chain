// src/services/skuMapper.js
// Maps customer product descriptions to internal SKU codes.
//
// Strategy (in order of preference):
//   1. Exact match in product master (case-insensitive)
//   2. Fuzzy match using token overlap scoring
//   3. AI-assisted match via Claude (last resort, costs tokens)
//
// In production, replace the in-memory catalog with a DB query.
// The catalog format is intentionally simple so ops teams can edit it.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// ─── Product master catalog ───────────────────────────────
// Format: { sku, name, aliases[], unitPrice, unit }
// Load this from your DB or a CSV file in production.

const PRODUCT_CATALOG = [
  { sku: 'CFF-5LB-DR',  name: 'Dark Roast Coffee 5lb',          aliases: ['dark roast 5lb', 'dark roast 5 lb', 'dark roast 5 pound', 'dark coffee 5lb'],               unitPrice: 18.50, unit: 'bag' },
  { sku: 'CFF-2LB-MR',  name: 'Medium Roast Coffee 2lb',        aliases: ['medium roast 2lb', 'medium roast 2 lb', 'regular ground coffee 2lb', 'med roast 2lb'],       unitPrice: 9.25,  unit: 'bag' },
  { sku: 'CFF-5LB-MR',  name: 'Medium Roast Coffee 5lb',        aliases: ['medium roast 5lb', 'regular ground coffee 5lb', 'regular ground 5lb', 'medium roast 5 lb'], unitPrice: 17.50, unit: 'bag' },
  { sku: 'CFF-ESP-1LB', name: 'Espresso Blend 1lb',             aliases: ['espresso 1lb', 'espresso blend 1lb', 'decaf espresso 1lb', 'espresso 1 lb'],                 unitPrice: 13.00, unit: 'bag' },
  { sku: 'CFF-5LB-DC',  name: 'Decaf Coffee 5lb',               aliases: ['decaf 5lb', 'decaf coffee 5lb', 'decaf 5 lb', 'decaffeinated 5lb'],                          unitPrice: 19.00, unit: 'bag' },
  { sku: 'CFF-CBR-32',  name: 'Cold Brew Concentrate 32oz',     aliases: ['cold brew 32oz', 'cold brew concentrate 32oz', 'cold brew 32 oz'],                            unitPrice: 7.75,  unit: 'bottle' },
  { sku: 'POD-MR-24',   name: 'Single Serve Pods Medium Roast 24ct', aliases: ['single serve pods 24ct', 'single serve 24ct', 'pods medium 24', 'pods 24ct', 'single serve pods medium roast'], unitPrice: 11.75, unit: 'box' },
  { sku: 'POD-ESP-24',  name: 'Espresso Pods 24ct',             aliases: ['espresso pods 24ct', 'espresso pods 24', 'pods espresso 24ct'],                               unitPrice: 12.50, unit: 'box' },
  { sku: 'OAT-32OZ',    name: 'Oat Milk 32oz',                  aliases: ['oat milk 32oz', 'oat milk 32 oz', 'oat milk'],                                                unitPrice: 4.50,  unit: 'carton' },
  { sku: 'OAT-CASE',    name: 'Oat Milk Case (12x32oz)',        aliases: ['oat milk case', 'case oat milk', 'oat milk 12 pack'],                                         unitPrice: 48.00, unit: 'case' },
];

// Build lookup index at startup
const exactIndex = new Map();
for (const product of PRODUCT_CATALOG) {
  exactIndex.set(product.sku.toLowerCase(), product);
  exactIndex.set(product.name.toLowerCase(), product);
  for (const alias of product.aliases) {
    exactIndex.set(alias.toLowerCase(), product);
  }
}

// ─── Token overlap fuzzy scorer ───────────────────────────
function tokenScore(query, candidate) {
  const qTokens = new Set(query.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  const cTokens = new Set(candidate.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  let matches = 0;
  for (const t of qTokens) { if (cTokens.has(t)) matches++; }
  return matches / Math.max(qTokens.size, cTokens.size);
}

// ─── AI fallback matcher ──────────────────────────────────
const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

async function aiMatch(description) {
  const catalogSummary = PRODUCT_CATALOG
    .map(p => `${p.sku}: ${p.name}`)
    .join('\n');

  try {
    const res = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `You are a product SKU matcher. Given a customer's product description, return the best matching SKU from the catalog, or null if no good match.

Catalog:
${catalogSummary}

Customer description: "${description}"

Respond with ONLY the SKU code (e.g. "CFF-5LB-DR") or the word "null". Nothing else.`,
      }],
    });

    const match = res.content[0].text.trim();
    if (match === 'null' || !match) return null;

    const product = exactIndex.get(match.toLowerCase());
    if (product) {
      logger.info('AI SKU match', { description, sku: match });
      return product;
    }
    return null;
  } catch (err) {
    logger.error('AI SKU matching failed', { error: err.message });
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────

export const skuMapper = {
  async lookup(description) {
    if (!description) return null;
    const query = description.trim().toLowerCase();

    // 1. Exact match
    if (exactIndex.has(query)) {
      return exactIndex.get(query);
    }

    // 2. Partial exact match (description contains a known alias)
    for (const [key, product] of exactIndex) {
      if (query.includes(key) || key.includes(query)) {
        return product;
      }
    }

    // 3. Fuzzy token overlap
    let best = null;
    let bestScore = 0;
    const allCandidates = [
      ...PRODUCT_CATALOG.map(p => ({ product: p, text: p.name })),
      ...PRODUCT_CATALOG.flatMap(p => p.aliases.map(a => ({ product: p, text: a }))),
    ];
    for (const { product, text } of allCandidates) {
      const score = tokenScore(query, text);
      if (score > bestScore) { bestScore = score; best = product; }
    }
    if (bestScore >= 0.6) {
      logger.info('Fuzzy SKU match', { description, sku: best.sku, score: bestScore });
      return best;
    }

    // 4. AI fallback
    const aiResult = await aiMatch(description);
    return aiResult;
  },

  // Get full product details by SKU (used by ERP connectors)
  getBySku(sku) {
    return exactIndex.get(sku.toLowerCase()) ?? null;
  },

  // List entire catalog (useful for admin UI)
  getCatalog() {
    return PRODUCT_CATALOG;
  },

  // Add or update a product at runtime (without restart)
  upsert(product) {
    PRODUCT_CATALOG.push(product);
    exactIndex.set(product.sku.toLowerCase(), product);
    exactIndex.set(product.name.toLowerCase(), product);
    for (const alias of (product.aliases ?? [])) {
      exactIndex.set(alias.toLowerCase(), product);
    }
  },
};
