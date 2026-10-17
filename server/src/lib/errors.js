export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const notFound = (message) => new HttpError(404, message);

export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const SYMBOL_RE = /^[A-Z0-9^][A-Z0-9.\-^=]{0,14}$/;

export function normalizeSymbol(raw) {
  if (typeof raw !== 'string') throw badRequest('Symbol is required');
  const symbol = raw.trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    throw badRequest(`"${raw}" is not a valid ticker symbol`);
  }
  return symbol;
}
