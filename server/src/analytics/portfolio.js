/**
 * Portfolio import + analytics.
 *
 * Users upload whatever their broker exports: comma, semicolon or tab
 * separated CSV, sometimes with account metadata above the table, different
 * column names, cash rows and duplicate lots. This module turns that into
 * clean positions and then measures the book against the live engine plan:
 * weights, P/L, concentration, stops, and a specific trim/exit/add call per
 * position.
 *
 * Everything here is pure. Pricing and per-symbol analysis are injected, so
 * the parsing and the maths can be tested without network access.
 */

export const MAX_UPLOAD_BYTES = 256 * 1024;
export const MAX_POSITIONS = 100;
/** Names deep-analysed per review. The rest still get live quotes. */
export const MAX_ANALYSED_POSITIONS = 25;
/** A single name above this share of the book is flagged and trimmed. */
export const MAX_POSITION_WEIGHT = 0.2;
/** Trim back to this weight, leaving headroom under the cap. */
export const TRIM_TARGET_WEIGHT = 0.15;
/** A sector above this share of the book is a concentration risk. */
export const MAX_SECTOR_WEIGHT = 0.4;

const SYMBOL_RE = /^[A-Z0-9^][A-Z0-9.\-^=]{0,14}$/;

const CASH_CODES = new Set([
  'CASH',
  'CASHBALANCE',
  'CASHAVAILABLE',
  'USD',
  'EUR',
  'GBP',
  'GBX',
  'CHF',
  'JPY',
  'CAD',
  'AUD',
  'HKD',
  'SGD',
  'NZD',
  'SEK',
  'NOK',
  'DKK',
]);

const FIAT = new Set(['USD', 'EUR', 'GBP', 'GBX', 'CHF', 'JPY', 'CAD', 'AUD', 'HKD', 'SGD', 'NZD', 'SEK', 'NOK', 'DKK']);

const IGNORED_SYMBOLS = new Set(['TOTAL', 'SUBTOTAL', 'GRANDTOTAL', 'BALANCE', 'ACCOUNT', 'SUMMARY']);

const FIELD_ALIASES = {
  symbol: [
    'symbol',
    'ticker',
    'ticker symbol',
    'security symbol',
    'instrument',
    'instrument code',
    'stock',
    'stock symbol',
    'holding',
    'asset',
    'security',
    'code',
  ],
  quantity: ['quantity', 'qty', 'shares', 'units', 'position', 'position size', 'no of shares', 'number of shares', 'share count'],
  averageCost: [
    'average cost',
    'avg cost',
    'avg price',
    'average price',
    'average cost per share',
    'avg cost per share',
    'cost per share',
    'price paid',
    'purchase price',
    'buy price',
    'unit cost',
    'cost share',
    'cost basis per share',
    'basis per share',
    'trade price',
    'open price',
  ],
  totalCost: [
    'cost basis',
    'total cost',
    'total cost basis',
    'book cost',
    'book value',
    'amount invested',
    'invested amount',
    'invested',
    'total invested',
  ],
  marketValue: ['market value', 'current value', 'position value', 'value', 'market val', 'total value'],
  name: ['name', 'security name', 'company', 'company name', 'description', 'instrument name', 'long name'],
  currency: ['currency', 'ccy', 'currency code', 'trade currency'],
  assetType: ['asset type', 'security type', 'type', 'asset class', 'instrument type'],
  sector: ['sector', 'industry'],
};

const cleanFileName = (name, fallback) =>
  String(name || fallback)
    .split(/[/\\]/)
    .pop()
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .trim()
    .slice(0, 120) || fallback;

const normalizeHeader = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const COLUMN_BLOCKLIST = {
  symbol: ['currency', 'exchange', 'asset type', 'security type'],
  quantity: ['value', 'cost', 'price', 'currency', 'weight'],
  averageCost: ['total', 'basis'],
  totalCost: ['per share', 'avg', 'average'],
  marketValue: ['cost', 'basis'],
};

function findColumn(headers, field) {
  const aliases = FIELD_ALIASES[field];
  for (const alias of aliases) {
    const index = headers.indexOf(alias);
    if (index !== -1) return index;
  }
  // Brokers add words around the same field ("Average cost (USD)",
  // "Quantity held"); accept a contains-match only when it is unambiguous.
  const blocked = COLUMN_BLOCKLIST[field] || [];
  for (const alias of aliases) {
    if (alias.length < 4) continue;
    const index = headers.findIndex(
      (header) =>
        (header === alias || header.includes(alias)) &&
        !blocked.some((word) => header.includes(word)),
    );
    if (index !== -1) return index;
  }
  return -1;
}

/** Number cells from US, UK and continental exports (1,234.56 / 1.234,56). */
export function parseNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let text = String(raw ?? '').trim();
  if (!text) return null;

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text
    .replace(/[^0-9.,+\-]/g, '')
    .replace(/\s+/g, '');
  if (!text || !/\d/.test(text)) return null;
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  }
  const sign = negative ? -1 : 1;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');

  let normalized = text;
  if (lastComma !== -1 && lastDot !== -1) {
    // Whichever separator comes last is the decimal mark.
    normalized =
      lastComma > lastDot
        ? text.replace(/\./g, '').replace(',', '.')
        : text.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // "1,234" / "1,234,567" are thousands; "12,5" is a decimal comma.
    normalized = /^\d{1,3}(,\d{3})+$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.');
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? sign * value : null;
}

function cleanSymbol(raw) {
  let symbol = String(raw ?? '')
    .trim()
    .replace(/^\$/, '')
    .toUpperCase();
  const colon = symbol.lastIndexOf(':');
  if (colon !== -1) symbol = symbol.slice(colon + 1);
  // Trading212 / IBKR suffixes: AAPL_US_EQ, AAPL.US, AAPL_US.
  for (let i = 0; i < 2; i += 1) symbol = symbol.replace(/[_\s](EQ|EQT|US|USD)$/, '');
  symbol = symbol.replace(/\.US$/, '');
  return symbol;
}

/** A salvaged token has to look like a real ticker, not a company name. */
const isPlausibleTicker = (symbol) =>
  Boolean(symbol) &&
  symbol.length <= 8 &&
  /[A-Z]/.test(symbol) &&
  SYMBOL_RE.test(symbol) &&
  !IGNORED_SYMBOLS.has(symbol.replace(/\s+/g, ''));

/**
 * Best-effort ticker from a noisy screenshot cell: "AAPL - Apple Inc.",
 * "NVIDIA Corp. (NVDA)", "NYSE:TSM", "BRK/B", "$AAPL". Used only by the
 * vision path, where the user verifies every row before it is priced — a
 * salvageable line is better than silently dropping the holding.
 */
export function salvageTicker(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';

  const direct = cleanSymbol(text);
  if (isPlausibleTicker(direct)) return direct;

  // Class shares are written BRK/B on some brokers; Yahoo uses BRK-B.
  const slash = cleanSymbol(text.replace(/\//g, '-'));
  if (isPlausibleTicker(slash)) return slash;

  // A ticker in parentheses is the most reliable signal in a name column.
  for (const match of text.matchAll(/\(([A-Za-z0-9.^=-]{1,10})\)/g)) {
    const candidate = cleanSymbol(match[1]);
    if (isPlausibleTicker(candidate)) return candidate;
  }

  // Otherwise prefer an all-caps token (tickers are upper-case on screen).
  // Two characters minimum so the capital in "Total" or "Apple" is not read
  // as a ticker.
  for (const match of text.matchAll(/\b([A-Z]{2,6}(?:\.[A-Z]{1,3})?)\b/g)) {
    const candidate = cleanSymbol(match[1]);
    if (isPlausibleTicker(candidate)) return candidate;
  }

  return '';
}

function isCashSymbol(symbol, assetType) {
  const compactSymbol = symbol.replace(/\s+/g, '');
  if (CASH_CODES.has(compactSymbol)) return true;
  return /cash|currency|money market/i.test(String(assetType || ''));
}

/** RFC4180-ish split that survives quoted commas, semicolons and newlines. */
function splitDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === '\n') line += 1;
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => String(value).trim() !== '')) {
        rows.push({ cells: row, line: rowLine });
      }
      row = [];
      cell = '';
      line += 1;
      rowLine = line;
      continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.some((value) => String(value).trim() !== '')) rows.push({ cells: row, line: rowLine });
  return rows;
}

function detectDelimiter(text) {
  const sample = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 12)
    .join('\n');
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const delimiter of candidates) {
    let count = 0;
    let quoted = false;
    for (const char of sample) {
      if (char === '"') quoted = !quoted;
      else if (!quoted && char === delimiter) count += 1;
    }
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function resolveHeader(cells) {
  const headers = cells.map(normalizeHeader);
  const map = {
    symbol: findColumn(headers, 'symbol'),
    quantity: findColumn(headers, 'quantity'),
    averageCost: findColumn(headers, 'averageCost'),
    totalCost: findColumn(headers, 'totalCost'),
    marketValue: findColumn(headers, 'marketValue'),
    name: findColumn(headers, 'name'),
    currency: findColumn(headers, 'currency'),
    assetType: findColumn(headers, 'assetType'),
    sector: findColumn(headers, 'sector'),
  };
  if (map.symbol === -1 || map.quantity === -1) return null;
  return { headers, map };
}

function warn(warnings, message) {
  if (message && !warnings.includes(message)) warnings.push(message);
}

function mergePositions(positions, warnings) {
  const merged = new Map();
  positions.forEach((position, index) => {
    // A screenshot row whose share count could not be read is kept for the
    // verification step instead of being dropped; it cannot be merged with a
    // priced lot, so it gets its own slot.
    if (!Number.isFinite(position.quantity)) {
      merged.set(`incomplete:${index}`, { ...position, lots: 1, costComplete: position.avgCost !== null });
      return;
    }
    const key = `position:${position.symbol}|${position.currency}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...position, lots: 1, costComplete: position.avgCost !== null });
      return;
    }
    const totalQuantity = existing.quantity + position.quantity;
    const costComplete = existing.costComplete && position.avgCost !== null;
    const weightedCost =
      costComplete && totalQuantity !== 0
        ? (existing.quantity * existing.avgCost + position.quantity * position.avgCost) / totalQuantity
        : null;
    merged.set(key, {
      ...existing,
      name: existing.name || position.name,
      assetType: existing.assetType || position.assetType,
      sector: existing.sector || position.sector,
      quantity: totalQuantity,
      // A partially-known cost basis is worse than none: it would understate
      // P/L on the merged line, so the whole position is marked unpriced.
      avgCost: costComplete ? Number(weightedCost.toFixed(6)) : null,
      costComplete,
      lots: existing.lots + 1,
    });
    warn(warnings, `${existing.symbol} appeared in more than one row and was merged into a single position.`);
  });

  return [...merged.values()]
    .filter((position) => position.quantity !== 0)
    .map(({ lots, costComplete, ...position }) => position);
}

function normalizeRecord(record, warnings, { allowIncomplete = false } = {}) {
  const symbol = cleanSymbol(record.symbol);
  if (!symbol || IGNORED_SYMBOLS.has(symbol.replace(/\s+/g, ''))) return null;
  if (!SYMBOL_RE.test(symbol)) {
    throw new Error(`"${String(record.symbol).slice(0, 24)}" is not a valid ticker`);
  }

  const quantity = parseNumber(record.quantity);
  const assetType = String(record.assetType || '').trim() || null;
  const cashLike = isCashSymbol(symbol, assetType);
  // The screenshot path keeps an identified line even when the share count was
  // blurry, so the user can fill it in on the verification table; a broker
  // file still rejects the row because it has no human in the loop.
  if (!cashLike && quantity === null && !allowIncomplete) throw new Error('missing share quantity');
  if (!cashLike && quantity === 0) throw new Error('zero quantity');

  const currency = String(record.currency || '').trim().toUpperCase() || 'USD';

  if (cashLike) {
    const cashCost = parseNumber(record.averageCost) ?? 0;
    const units = quantity ?? 0;
    // Some exports put the cash balance in the quantity column, others leave
    // it blank and put the balance in the price/value column. Take whichever
    // is present instead of multiplying a balance by a zero cost.
    const value =
      parseNumber(record.marketValue) ??
      parseNumber(record.totalCost) ??
      (units !== 0 ? units * (cashCost > 0 ? cashCost : 1) : cashCost);
    const cashCurrency = FIAT.has(symbol) ? symbol : currency || 'USD';
    return {
      cash: {
        currency: cashCurrency === 'GBX' ? 'GBP' : cashCurrency,
        // A negative balance is a margin debit, not spending money: keeping
        // the sign is what makes the total portfolio value honest.
        value: Number(value) || 0,
        label: symbol === 'CASH' ? String(record.name || 'Cash').trim() || 'Cash' : symbol,
      },
    };
  }

  const avgCostInput = parseNumber(record.averageCost);
  const totalCost = parseNumber(record.totalCost);
  let avgCost = avgCostInput;
  if (avgCost === null && totalCost !== null && quantity !== null && quantity !== 0) {
    avgCost = Math.abs(totalCost / quantity);
  }
  if (avgCost !== null && avgCost <= 0) avgCost = null;

  return {
    position: {
      symbol,
      name: String(record.name || '').replace(/\s+/g, ' ').trim().slice(0, 80) || symbol,
      quantity: quantity === null ? null : Number(quantity.toFixed(6)),
      avgCost: avgCost === null ? null : Number(avgCost.toFixed(6)),
      currency,
      assetType,
      sector: String(record.sector || '').trim() || null,
      marketValueHint: parseNumber(record.marketValue),
    },
  };
}

function readField(record, index) {
  if (index === -1 || index === undefined) return null;
  return record[index];
}

/** Parse CSV/TSV holdings text, including broker preamble and cash rows. */
export function parsePortfolioText(content, { fileName = 'portfolio.csv' } = {}) {
  const text = String(content ?? '').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('The file is empty.');

  const delimiter = detectDelimiter(text);
  const rows = splitDelimited(text, delimiter);
  if (!rows.length) throw new Error('The file has no readable rows.');

  let headerIndex = -1;
  let header = null;
  for (let i = 0; i < Math.min(rows.length, 25); i += 1) {
    const resolved = resolveHeader(rows[i].cells);
    if (resolved) {
      headerIndex = i;
      header = resolved;
      break;
    }
  }
  if (!header) {
    throw new Error('Could not find a holdings table — the file needs a ticker column and a share-quantity column.');
  }

  const warnings = [];
  const ignored = [];
  const positions = [];
  const cash = [];

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const { cells, line } = rows[i];
    const record = {
      symbol: readField(cells, header.map.symbol),
      quantity: readField(cells, header.map.quantity),
      averageCost: readField(cells, header.map.averageCost),
      totalCost: readField(cells, header.map.totalCost),
      marketValue: readField(cells, header.map.marketValue),
      name: readField(cells, header.map.name),
      currency: readField(cells, header.map.currency),
      assetType: readField(cells, header.map.assetType),
      sector: readField(cells, header.map.sector),
    };
    if (!String(record.symbol ?? '').trim()) continue;
    try {
      const parsed = normalizeRecord(record, warnings);
      if (!parsed) continue;
      if (parsed.cash) cash.push(parsed.cash);
      if (parsed.position) positions.push(parsed.position);
    } catch (error) {
      ignored.push({ line, symbol: String(record.symbol).slice(0, 24), reason: error.message });
    }
  }

  if (!positions.length && !cash.length) {
    throw new Error('No holdings found in that file. Expected one row per position with a ticker and share quantity.');
  }

  const merged = mergePositions(positions, warnings);
  if (merged.length > MAX_POSITIONS) {
    warn(warnings, `Only the first ${MAX_POSITIONS} positions were imported (the file contains ${merged.length}).`);
  }

  const missingCost = merged.filter((position) => position.avgCost === null).length;
  if (missingCost) {
    warn(warnings, `${missingCost} position${missingCost === 1 ? '' : 's'} have no cost basis — unrealized P/L is unavailable for them.`);
  }
  if (ignored.length) {
    warn(warnings, `${ignored.length} row${ignored.length === 1 ? '' : 's'} could not be read and were skipped.`);
  }

  return {
    fileName: cleanFileName(fileName, 'portfolio.csv'),
    format: delimiter === '\t' ? 'tsv' : 'csv',
    baseCurrency: 'USD',
    positions: merged.slice(0, MAX_POSITIONS),
    cash: mergeCash(cash),
    warnings,
    ignored,
    parsedRows: positions.length + cash.length,
  };
}

function mergeCash(entries) {
  const totals = new Map();
  for (const entry of entries) {
    const currency = entry.currency || 'USD';
    const existing = totals.get(currency) || { currency, value: 0, label: entry.label };
    existing.value += entry.value;
    totals.set(currency, existing);
  }
  return [...totals.values()].map((entry) => ({ ...entry, value: Number(entry.value.toFixed(2)) }));
}

/** Accept an already-structured holdings array (JSON upload or API caller). */
export function parsePortfolioHoldings(holdings, { fileName = 'portfolio.json', allowIncomplete = false } = {}) {
  if (!Array.isArray(holdings)) throw new Error('holdings must be an array');
  const warnings = [];
  const ignored = [];
  const positions = [];
  const cash = [];

  holdings.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      ignored.push({ line: index + 2, symbol: '', reason: 'not an object' });
      return;
    }
    const record = {
      symbol: item.symbol ?? item.ticker ?? item.tickerSymbol ?? item.stock,
      quantity: item.quantity ?? item.qty ?? item.shares ?? item.shareCount ?? item.sharesHeld ?? item.units,
      averageCost:
        item.avgCost ?? item.averageCost ?? item.avgPrice ?? item.averagePrice ?? item.pricePaid ?? item.unitCost,
      totalCost: item.totalCost ?? item.costBasis,
      marketValue: item.marketValue ?? item.value,
      name: item.name,
      currency: item.currency,
      assetType: item.assetType ?? item.type,
      sector: item.sector,
    };
    try {
      const parsed = normalizeRecord(record, warnings, { allowIncomplete });
      if (!parsed) return;
      if (parsed.cash) cash.push(parsed.cash);
      if (parsed.position) positions.push(parsed.position);
    } catch (error) {
      ignored.push({ line: index + 2, symbol: String(record.symbol ?? '').slice(0, 24), reason: error.message });
    }
  });

  if (!positions.length && !cash.length) throw new Error('No holdings found in that file.');

  const merged = mergePositions(positions, warnings);
  const missingQuantity = merged.filter((position) => !Number.isFinite(position.quantity)).length;
  if (missingQuantity) {
    warn(warnings, `${missingQuantity} position${missingQuantity === 1 ? '' : 's'} have no readable share quantity — fill them in before reviewing.`);
  }
  const missingCost = merged.filter((position) => position.avgCost === null).length;
  if (missingCost) {
    warn(warnings, `${missingCost} position${missingCost === 1 ? '' : 's'} have no cost basis — unrealized P/L is unavailable for them.`);
  }

  return {
    fileName: cleanFileName(fileName, 'portfolio.json'),
    format: 'json',
    baseCurrency: 'USD',
    positions: merged.slice(0, MAX_POSITIONS),
    cash: mergeCash(cash),
    warnings,
    ignored,
    parsedRows: holdings.length,
  };
}

export function parsePortfolioFile({ fileName = 'portfolio.csv', content, holdings, allowIncomplete = false } = {}) {
  if (Array.isArray(holdings)) return parsePortfolioHoldings(holdings, { fileName, allowIncomplete });
  const text = String(content ?? '').trim();
  if (!text) throw new Error('Attach a portfolio file or a holdings list.');
  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('The JSON file could not be parsed.');
    }
    const list = Array.isArray(parsed) ? parsed : parsed.holdings || parsed.positions || parsed.portfolio;
    if (!Array.isArray(list)) throw new Error('JSON must be an array of holdings or { "holdings": [...] }.');
    return parsePortfolioHoldings(list, { fileName });
  }
  return parsePortfolioText(text, { fileName });
}

const round = (value, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

const pctOf = (value, base) =>
  typeof value === 'number' && Number.isFinite(value) && base ? (value / base) * 100 : null;

const FX_TO_USD = { USD: 1 };

/** USD value of one unit of `currency`, or null when no rate is available. */
function usdRate(currency, fx = {}) {
  if (!currency || currency === 'USD') return 1;
  if (currency === 'EUR' && Number.isFinite(fx.eurPerUsd) && fx.eurPerUsd > 0) return 1 / fx.eurPerUsd;
  return FX_TO_USD[currency] ?? null;
}

/**
 * Build the review the API and the agent consume.
 *
 * `quotes` and `analyses` are maps keyed by symbol. Every number is measured
 * from live prices; a missing quote is reported, never filled with the cost
 * basis, so the review cannot silently claim stale data is live.
 */
export function buildPortfolioReview({
  fileName = 'portfolio',
  positions = [],
  cash = [],
  quotes = {},
  analyses = {},
  fx = {},
  warnings = [],
  analysedSymbols = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const cashRows = [];
  for (const entry of cash) {
    const rate = usdRate(entry.currency, fx);
    cashRows.push({
      currency: entry.currency || 'USD',
      label: entry.label || entry.currency || 'Cash',
      value: round(entry.value, 2),
      valueUsd: rate === null ? null : round(entry.value * rate, 2),
      supported: rate !== null,
    });
  }

  const rows = positions.map((position) => {
    const quote = quotes[position.symbol] || null;
    const analysis = analyses[position.symbol] || null;
    const currency = position.currency || quote?.currency || 'USD';
    const rate = usdRate(currency, fx);
    const supported = rate !== null;
    const price = quote?.price ?? null;
    const quantity = position.quantity;
    const short = quantity < 0;

    const marketValueNative = price === null ? null : price * quantity;
    const costBasisNative = position.avgCost === null ? null : position.avgCost * quantity;
    const pnlNative =
      marketValueNative === null || costBasisNative === null ? null : marketValueNative - costBasisNative;
    const pnlPct = pnlNative === null || !costBasisNative ? null : (pnlNative / Math.abs(costBasisNative)) * 100;
    const dayChangeNative = quote?.change === null || quote?.change === undefined ? null : quote.change * quantity;

    const plan = analysis?.plan || null;
    const stopLoss = plan?.stopLoss ?? null;
    const direction = plan?.direction ?? null;
    const targets = (plan?.targets || []).map((target) => ({
      label: target.label,
      price: target.price,
      upsidePct: target.upsidePct,
      probability: target.probability,
    }));
    const stopDistancePct =
      price !== null && stopLoss !== null ? ((price - stopLoss) / price) * 100 : null;
    // A downside plan's stop sits above spot as an upside invalidation; it is
    // not the stop on a long holding. Only judge a stop against a plan on the
    // same side as the position.
    const stopApplies =
      stopLoss !== null && (direction === null || (short ? direction === 'short' : direction === 'long'));
    const stopBreached =
      stopApplies && stopDistancePct !== null && (short ? stopDistancePct >= 0 : stopDistancePct <= 0);
    const nearStop =
      stopApplies && !stopBreached && stopDistancePct !== null && Math.abs(stopDistancePct) <= 3;

    const zone = plan?.buyZone || null;
    const inZone =
      zone && price !== null ? price >= zone.low && price <= zone.high : false;
    const aboveZonePct = zone && price !== null ? ((price - zone.high) / zone.high) * 100 : null;

    const sector =
      analysis?.fundamentals?.sector ||
      position.sector ||
      (quote?.quoteType === 'ETF' ? 'Funds & ETFs' : null) ||
      'Unclassified';

    return {
      symbol: position.symbol,
      name: quote?.name || position.name || position.symbol,
      short,
      instrument: String(quote?.quoteType || position.assetType || 'EQUITY').toUpperCase(),
      quoteType: quote?.quoteType || position.assetType || 'EQUITY',
      sector,
      currency,
      supported,
      quantity,
      avgCost: position.avgCost,
      costBasis: supported && costBasisNative !== null ? round(costBasisNative * rate, 2) : null,
      price,
      marketValue: supported && marketValueNative !== null ? round(marketValueNative * rate, 2) : null,
      rawMarketValue: marketValueNative === null ? null : round(marketValueNative, 2),
      unrealizedPnl: supported && pnlNative !== null ? round(pnlNative * rate, 2) : null,
      unrealizedPnlPct: round(pnlPct, 2),
      dayChangeValue: supported && dayChangeNative !== null ? round(dayChangeNative * rate, 2) : null,
      dayChangePercent: quote?.changePercent ?? null,
      score: analysis?.score?.total ?? null,
      call: analysis?.alert?.action ?? null,
      callLabel: analysis?.alert?.actionLabel ?? null,
      setupLabel: analysis?.alert?.setupLabel ?? null,
      direction,
      stopLoss,
      stopDistancePct: round(stopDistancePct, 2),
      stopBreached,
      nearStop,
      targets,
      buyZone: zone,
      inZone,
      aboveZonePct: round(aboveZonePct, 2),
      analysed: Boolean(analysis),
      flags: [],
    };
  });

  const included = rows.filter((row) => row.supported && row.marketValue !== null);
  const grossInvested = included.reduce((total, row) => total + Math.abs(row.marketValue), 0);
  const netInvested = included.reduce((total, row) => total + row.marketValue, 0);
  const costPriced = included.filter((row) => row.costBasis !== null);
  const costBasis = costPriced.reduce((total, row) => total + row.costBasis, 0);
  const unrealizedPnl = included.reduce((total, row) => total + (row.unrealizedPnl ?? 0), 0);
  const dayChange = included.reduce((total, row) => total + (row.dayChangeValue ?? 0), 0);
  const cashValue = cashRows.reduce((total, row) => total + (row.valueUsd ?? 0), 0);
  const totalValue = grossInvested + cashValue;

  for (const row of rows) {
    row.weightPct = row.marketValue === null ? null : round(pctOf(Math.abs(row.marketValue), totalValue), 2);
    row.netWeightPct = row.marketValue === null ? null : round(pctOf(row.marketValue, totalValue), 2);
  }

  // Position-level recommendation: risk first (stop / explicit sell), then
  // size, then the engine call. Every number is computed from the live book.
  for (const row of rows) {
    const short = row.quantity < 0;
    const tags = row.flags;
    if (!row.supported) {
      tags.push({ code: 'currency', severity: 'medium', label: `${row.currency} value not converted` });
    }
    if (row.marketValue === null) {
      tags.push({ code: 'unpriced', severity: 'high', label: 'No live price' });
    }
    if (row.unrealizedPnlPct !== null && row.unrealizedPnlPct <= -20) {
      tags.push({ code: 'drawdown', severity: 'medium', label: `${row.unrealizedPnlPct.toFixed(1)}% below cost` });
    }
    if (row.stopBreached) {
      tags.push({ code: 'stop-breach', severity: 'high', label: 'Below plan stop' });
    } else if (row.nearStop) {
      tags.push({ code: 'near-stop', severity: 'medium', label: 'Within 3% of stop' });
    }
    if (row.weightPct !== null && row.weightPct > MAX_POSITION_WEIGHT * 100) {
      tags.push({
        code: 'overweight',
        severity: 'high',
        label: `${row.weightPct.toFixed(1)}% of book (cap ${MAX_POSITION_WEIGHT * 100}%)`,
      });
    }

    // A line just over the cap only needs to come back to the cap. A badly
    // oversized line (>30%) is cut further, to the 15% working weight.
    const targetWeight = (row.weightPct ?? 0) > 30 ? TRIM_TARGET_WEIGHT : MAX_POSITION_WEIGHT;
    const trimValue = totalValue * targetWeight;
    const trimTarget =
      row.price && row.marketValue !== null && Math.abs(row.marketValue) > trimValue
        ? Math.max(1, Math.ceil((Math.abs(row.marketValue) - trimValue) / row.price))
        : null;

    let recommendation = 'hold';
    let reason = '';

    const derivative =
      row.marketValue !== null && !['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX'].includes(row.instrument);

    if (row.marketValue === null) {
      recommendation = 'review';
      reason = 'No live price — confirm the ticker and re-upload before acting.';
    } else if (derivative) {
      recommendation = 'review';
      reason = `This line quotes as ${row.instrument}, not a stock or ETF. Equity stops and targets do not apply — size and manage it in its own terms.`;
      tags.push({ code: 'instrument', severity: 'medium', label: row.instrument });
    } else if (row.stopBreached) {
      recommendation = 'exit';
      reason = `Price is through the plan stop at ${row.stopLoss}. The setup is invalidated — cut or fully hedge it.`;
    } else if (row.call === 'sell' && !short) {
      recommendation = 'exit';
      reason = 'Engine call is Sell (trend break). This is a risk exit, not a short recommendation.';
    } else if (short && (row.call === 'buy' || row.call === 'accumulate')) {
      recommendation = 'exit';
      reason = `This is a short position but the engine call is ${row.callLabel} — the trend is against it. Cover rather than adding to a losing short.`;
    } else if (row.call === 'reduce') {
      recommendation = 'trim';
      reason = 'Engine call is Reduce: the 50- and 200-day disagree. Cut the position and re-add only on a fresh setup.';
    } else if (row.weightPct !== null && row.weightPct > MAX_POSITION_WEIGHT * 100) {
      recommendation = 'trim';
      reason = `${row.weightPct.toFixed(1)}% of the book is above the ${MAX_POSITION_WEIGHT * 100}% single-name cap. Trim toward ${(targetWeight * 100).toFixed(0)}% to bring the name back inside the risk limit.`;
    } else if ((row.call === 'buy' || row.call === 'accumulate') && row.aboveZonePct !== null && row.aboveZonePct > 5) {
      recommendation = 'hold';
      reason = `Call is ${row.callLabel}, but price is ${row.aboveZonePct.toFixed(1)}% above the buy zone — wait for a pullback instead of adding up here.`;
    } else if (!short && (row.call === 'buy' || row.call === 'accumulate') && (row.weightPct ?? 100) < 10) {
      recommendation = 'add';
      reason = `Call is ${row.callLabel} and the name is only ${(row.weightPct ?? 0).toFixed(1)}% of the book — there is room to build toward 10%.`;
    } else if (short && row.call === 'sell') {
      // A Sell call on a short position means the downtrend is still working.
      // Telling the holder to "exit" there would cover a winning trade on the
      // same evidence that opened it; only size risk can trim it (above).
      recommendation = 'hold';
      reason = 'Engine call is Sell (trend break) and this position is short — the move is with you. Keep it, trail the stop above, and cover when the trend turns.';
    } else if (row.call === 'hold') {
      recommendation = 'hold';
      reason = 'Call is Hold (extended uptrend). Keep the position, do not add, and trail the stop.';
    } else if (!row.analysed) {
      recommendation = 'review';
      reason = 'No engine plan for this line — verify the instrument or review it in the Analyzer.';
    } else {
      recommendation = 'hold';
      reason = 'Position is inside its plan and within the size cap.';
    }

    row.recommendation = recommendation;
    row.recommendationReason = reason;
    row.trimShares =
      recommendation === 'exit'
        ? Math.abs(row.quantity)
        : recommendation === 'trim'
          ? trimTarget ?? Math.max(1, Math.ceil(Math.abs(row.quantity) / 2))
          : null;
    row.priority = { exit: 1, trim: 2, review: 3, add: 4, hold: 5 }[recommendation];
  }

  rows.sort(
    (a, b) =>
      (a.priority ?? 9) - (b.priority ?? 9) ||
      (b.marketValue ?? 0) - (a.marketValue ?? 0) ||
      a.symbol.localeCompare(b.symbol),
  );

  const investedWeights = included.map((row) => Math.abs(row.marketValue) / (grossInvested || 1));
  const hhi = investedWeights.reduce((total, weight) => total + weight * weight, 0);
  const sortedByWeight = [...rows].filter((row) => row.marketValue !== null).sort((a, b) => (b.weightPct ?? 0) - (a.weightPct ?? 0));
  const top1Pct = sortedByWeight[0]?.weightPct ?? null;
  const top5Pct = sortedByWeight.slice(0, 5).reduce((total, row) => total + (row.weightPct ?? 0), 0);

  const sectors = new Map();
  for (const row of rows) {
    if (row.marketValue === null) continue;
    const entry = sectors.get(row.sector) || { key: row.sector, label: row.sector, value: 0, symbols: [] };
    entry.value += Math.abs(row.marketValue);
    entry.symbols.push(row.symbol);
    sectors.set(row.sector, entry);
  }
  const sectorExposure = [...sectors.values()]
    .map((entry) => ({
      ...entry,
      weightPct: round(pctOf(entry.value, totalValue), 2),
      value: round(entry.value, 2),
    }))
    .sort((a, b) => b.weightPct - a.weightPct);

  const counts = { exit: 0, trim: 0, add: 0, hold: 0, review: 0 };
  for (const row of rows) counts[row.recommendation] += 1;
  const callCounts = { buy: 0, accumulate: 0, hold: 0, reduce: 0, sell: 0, unknown: 0 };
  for (const row of rows) {
    if (!row.analysed) callCounts.unknown += 1;
    else if (row.call in callCounts) callCounts[row.call] += 1;
    else callCounts.unknown += 1;
  }

  const flags = [];
  const stopBreaches = rows.filter((row) => row.stopBreached);
  if (stopBreaches.length) {
    flags.push({
      code: 'stop-breach',
      severity: 'high',
      title: `${stopBreaches.length} position${stopBreaches.length === 1 ? ' is' : 's are'} through the plan stop`,
      detail: `${stopBreaches.map((row) => row.symbol).join(', ')} — the thesis is invalidated on those lines.`,
      symbols: stopBreaches.map((row) => row.symbol),
    });
  }
  // Only long holdings are at risk from a Sell call; a short with the same call
  // is a working trend, not an exit.
  const sells = rows.filter((row) => row.call === 'sell' && !row.short);
  if (sells.length) {
    flags.push({
      code: 'sell-call',
      severity: 'high',
      title: `${sells.length} holding${sells.length === 1 ? ' carries' : 's carry'} a Sell call`,
      detail: `${sells.map((row) => row.symbol).join(', ')} — trend break; plan the exit rather than averaging down.`,
      symbols: sells.map((row) => row.symbol),
    });
  }
  if (top1Pct !== null && top1Pct > MAX_POSITION_WEIGHT * 100) {
    flags.push({
      code: 'concentration',
      severity: 'high',
      title: `${sortedByWeight[0].symbol} is ${top1Pct.toFixed(1)}% of the book`,
      detail: `Single-name risk is above the ${MAX_POSITION_WEIGHT * 100}% cap. A 20% drawdown there costs ${(top1Pct * 0.2).toFixed(1)}% of the portfolio.`,
      symbols: [sortedByWeight[0].symbol],
    });
  }
  const topSector = sectorExposure[0];
  if (topSector && topSector.weightPct > MAX_SECTOR_WEIGHT * 100) {
    flags.push({
      code: 'sector-concentration',
      severity: 'medium',
      title: `${topSector.label} is ${topSector.weightPct.toFixed(0)}% of the book`,
      detail: `A single sector above ${MAX_SECTOR_WEIGHT * 100}% means the book trades one macro factor. Diversify or hedge the exposure.`,
      symbols: topSector.symbols,
    });
  }
  const drawdowns = rows.filter((row) => row.unrealizedPnlPct !== null && row.unrealizedPnlPct <= -20);
  if (drawdowns.length) {
    flags.push({
      code: 'drawdown',
      severity: 'medium',
      title: `${drawdowns.length} position${drawdowns.length === 1 ? '' : 's'} down 20% or more`,
      detail: `${drawdowns.map((row) => `${row.symbol} ${row.unrealizedPnlPct.toFixed(0)}%`).join(', ')} — decide whether the thesis still holds instead of anchoring to cost.`,
      symbols: drawdowns.map((row) => row.symbol),
    });
  }
  const unpriced = rows.filter((row) => row.marketValue === null);
  if (unpriced.length) {
    flags.push({
      code: 'unpriced',
      severity: 'medium',
      title: `${unpriced.length} line${unpriced.length === 1 ? '' : 's'} could not be priced`,
      detail: `${unpriced.map((row) => row.symbol).join(', ')} — check the ticker symbol (and exchange suffix) and re-upload.`,
      symbols: unpriced.map((row) => row.symbol),
    });
  }
  const noCost = rows.filter((row) => row.avgCost === null);
  if (noCost.length) {
    flags.push({
      code: 'missing-cost',
      severity: 'low',
      title: `${noCost.length} position${noCost.length === 1 ? '' : 's'} left out of P/L`,
      detail: 'Add an average cost column to measure realized gains and tax lots.',
      symbols: noCost.map((row) => row.symbol),
    });
  }
  if (cashRows.length && totalValue > 0 && cashValue / totalValue < 0.02) {
    flags.push({
      code: 'low-cash',
      severity: 'low',
      title: 'Cash is under 2% of the book',
      detail: 'No dry powder for new setups or margin calls. Consider raising cash if the regime turns.',
      symbols: [],
    });
  }

  const analysed = analysedSymbols === null ? rows.filter((row) => row.analysed).length : analysedSymbols;

  return {
    generatedAt,
    fileName,
    baseCurrency: 'USD',
    totals: {
      positions: rows.length,
      analysed,
      grossInvested: round(grossInvested, 2),
      netInvested: round(netInvested, 2),
      marketValue: round(grossInvested, 2),
      costBasis: costPriced.length ? round(costBasis, 2) : null,
      unrealizedPnl: costPriced.length ? round(unrealizedPnl, 2) : null,
      unrealizedPnlPct: costPriced.length && costBasis ? round((unrealizedPnl / Math.abs(costBasis)) * 100, 2) : null,
      dayChange: round(dayChange, 2),
      dayChangePct: grossInvested ? round((dayChange / (grossInvested - dayChange)) * 100, 2) : null,
      cash: round(cashValue, 2),
      totalValue: round(totalValue, 2),
      investedPct: round(pctOf(grossInvested, totalValue), 2),
      cashPct: round(pctOf(cashValue, totalValue), 2),
      cashIncluded: cashRows.some((row) => (row.valueUsd ?? 0) > 0),
      costBasisComplete: costPriced.length === rows.length,
    },
    cash: cashRows,
    concentration: {
      top1Pct,
      top5Pct: round(top5Pct, 2),
      hhi: round(hhi, 4),
      effectiveHoldings: hhi ? round(1 / hhi, 1) : null,
      largest: sortedByWeight[0]?.symbol ?? null,
    },
    exposure: sectorExposure,
    counts,
    callCounts,
    flags,
    warnings,
    positions: rows,
  };
}

/**
 * Slim view for the agent tool: enough to reason and cite levels, without
 * blowing the model's context budget on 25 full engine payloads.
 */
export function compactPortfolioReview(review, { maxPositions = 20 } = {}) {
  if (!review) return null;
  const shown = review.positions.slice(0, maxPositions);
  return {
    generatedAt: review.generatedAt,
    fileName: review.fileName,
    totals: review.totals,
    concentration: review.concentration,
    exposure: review.exposure,
    counts: review.counts,
    callCounts: review.callCounts,
    flags: review.flags,
    positionsShown: shown.length,
    positionsTotal: review.positions.length,
    ...(shown.length < review.positions.length
      ? { note: `Showing ${shown.length} of ${review.positions.length} positions (largest and most actionable first).` }
      : {}),
    positions: shown.map((row) => ({
      symbol: row.symbol,
      name: row.name,
      quantity: row.quantity,
      avgCost: row.avgCost,
      price: row.price,
      marketValue: row.marketValue,
      weightPct: row.weightPct,
      unrealizedPnl: row.unrealizedPnl,
      unrealizedPnlPct: row.unrealizedPnlPct,
      call: row.callLabel,
      setup: row.setupLabel,
      score: row.score,
      stopLoss: row.stopLoss,
      stopDistancePct: row.stopDistancePct,
      targets: row.targets.map((target) => target.price),
      buyZone: row.buyZone,
      recommendation: row.recommendation,
      trimShares: row.trimShares,
      reason: row.recommendationReason,
      flags: row.flags.map((flag) => flag.label),
    })),
    warnings: review.warnings,
  };
}

/** Holdings snapshot for the system prompt, so the first answer is grounded
 * even if the model never calls get_portfolio_review. */
export function portfolioContextBlock(review, { limit = 12 } = {}) {
  if (!review) return '';
  const money = (value) => (typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(0)}` : '—');
  const rows = review.positions.slice(0, limit).map((row) => {
    const action = row.recommendation === 'exit' ? 'EXIT' : row.recommendation.toUpperCase();
    return `- ${row.symbol} | qty ${row.quantity} | avg cost ${money(row.avgCost)} | weight ${row.weightPct?.toFixed(1) ?? '—'}% | P/L ${
      row.unrealizedPnlPct === null ? 'unknown' : `${row.unrealizedPnlPct.toFixed(1)}%`
    } | ${row.callLabel ?? 'no engine plan'} | stop ${money(row.stopLoss)} | ${action}${row.trimShares ? ` ${row.trimShares} sh` : ''}`;
  });
  const flags = review.flags.slice(0, 4).map((flag) => `- ${flag.title}`);
  return `${portfolioPromptLine(review)}\n${rows.join('\n')}${
    review.positions.length > limit ? `\n- (+${review.positions.length - limit} more lines in get_portfolio_review)` : ''
  }${flags.length ? `\nPortfolio flags:\n${flags.join('\n')}` : ''}`;
}

/** Plain-language holdings line for the system prompt (never invent numbers). */
export function portfolioPromptLine(review) {
  if (!review) return '';
  const total = review.totals;
  const top = review.positions
    .filter((row) => row.marketValue !== null)
    .slice(0, 6)
    .map((row) => `${row.symbol} ${row.weightPct?.toFixed(1)}%`)
    .join(', ');
  return `Attached portfolio ${review.fileName}: ${total.positions} positions, ${total.totalValue === null ? 'unpriced' : `$${total.totalValue.toFixed(0)}`} total, ${total.cashPct ?? 0}% cash${
    top ? `; largest ${top}` : ''
  }. Action counts: ${review.counts.exit} exit, ${review.counts.trim} trim, ${review.counts.add} add, ${review.counts.hold} hold.`;
}

export const _internals = { cleanSymbol, splitDelimited, detectDelimiter, resolveHeader, usdRate };
