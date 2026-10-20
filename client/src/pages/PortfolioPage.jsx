import { useRef, useState } from 'react';
import PortfolioReview from '../components/PortfolioReview.jsx';
import { api } from '../lib/api.js';

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// A broker table is small type: keeping the screenshot near its native width
// is what lets the reader resolve tickers. PNG first, because JPEG smears
// glyph edges — exactly the detail that has to be read.
const MAX_IMAGE_EDGE = 2600;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function prepareImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.onload = () => {
      const original = String(reader.result || '');
      const image = new Image();
      image.onerror = () => reject(new Error('That file is not a readable image.'));
      image.onload = () => {
        const base64Of = (value) => String(value).split(',')[1] || '';
        const fits = (value) => base64Of(value).length * 0.75 <= MAX_IMAGE_BYTES;
        let dataUrl = original;
        let mimeType = file.type || 'image/png';
        if (Math.max(image.width, image.height) > MAX_IMAGE_EDGE || file.size > MAX_IMAGE_BYTES) {
          const longest = Math.max(image.width, image.height);
          const render = (scale, type, quality) => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.round(image.width * scale));
              canvas.height = Math.max(1, Math.round(image.height * scale));
              const context = canvas.getContext('2d');
              if (!context) return null;
              // Screenshots are transparent wherever the page background shows;
              // the reader expects a light table, not black glyphs on black.
              context.fillStyle = '#fff';
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.drawImage(image, 0, 0, canvas.width, canvas.height);
              return { url: canvas.toDataURL(type, quality), type };
            } catch {
              return null;
            }
          };
          let edge = MAX_IMAGE_EDGE;
          let encoded = render(Math.min(1, edge / longest), 'image/png');
          if (!encoded) {
            reject(new Error('Could not prepare that image for upload.'));
            return;
          }
          if (!fits(encoded.url)) {
            encoded = render(Math.min(1, edge / longest), 'image/jpeg', 0.92) || encoded;
          }
          // Only shrink once the sharpest encodings are over the byte cap.
          while (!fits(encoded.url) && edge > 800) {
            edge = Math.round(edge * 0.85);
            encoded = render(edge / longest, 'image/jpeg', 0.9) || encoded;
          }
          dataUrl = encoded.url;
          mimeType = encoded.type;
        }
        const data = base64Of(dataUrl);
        if (data.length * 0.75 > MAX_IMAGE_BYTES) {
          reject(new Error('Could not reduce the screenshot below the 4 MB upload limit.'));
          return;
        }
        resolve({ data, dataUrl, mimeType });
      };
      image.src = original;
    };
    reader.readAsDataURL(file);
  });
}

function numericValue(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function PortfolioPage({ health }) {
  const fileRef = useRef(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState('');
  const [holdings, setHoldings] = useState([]);
  const [cash, setCash] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [model, setModel] = useState('');
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [error, setError] = useState('');

  const upload = async (file) => {
    if (!file) return;
    setReview(null);
    setError('');
    setHoldings([]);
    setCash([]);
    setWarnings([]);
    setPreview('');
    setModel('');
    setFileName(file.name);
    if (!IMAGE_TYPES.includes(file.type)) {
      setError('Use a PNG, JPEG or WebP screenshot.');
      // Clear the input so choosing the same file again still fires onChange.
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('That screenshot is larger than 15 MB.');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }

    setBusy(true);
    setStep('Preparing screenshot…');
    try {
      const image = await prepareImage(file);
      setPreview(image.dataUrl);
      setStep('Reading visible holdings…');
      const extracted = await api.portfolioExtractImage({
        fileName: file.name,
        mimeType: image.mimeType,
        data: image.data,
      });
      setHoldings(extracted.positions.map((position) => ({ ...position })));
      setCash((extracted.cash || []).map((row) => ({ ...row })));
      setWarnings([
        ...(extracted.warnings || []),
        ...(extracted.ignored || []).map(
          (row) => `Row ${row.line}${row.symbol ? ` (${row.symbol})` : ''} was skipped: ${row.reason}. Add it manually if it is a real holding.`,
        ),
      ]);
      setModel(extracted.model || '');
      setStep('');
    } catch (err) {
      // A screenshot the reader cannot resolve should not be a dead end: the
      // verification table is already on screen, so point at manual entry.
      const manual = /readable|could not read|no holdings/i.test(err.message || '')
        ? ' You can also type the rows in yourself with “+ Add row”.'
        : '';
      setError(`${err.message}${manual}`);
      setStep('');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const updateHolding = (index, field, value) => {
    setHoldings((current) => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
    setReview(null);
  };

  const updateCash = (index, field, value) => {
    setCash((current) => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
    setReview(null);
  };

  const runReview = async (event) => {
    event.preventDefault();
    setError('');
    const positions = holdings
      .map((row) => ({
        symbol: String(row.symbol || '').trim().toUpperCase(),
        name: row.name,
        quantity: numericValue(row.quantity),
        avgCost: numericValue(row.avgCost),
        currency: String(row.currency || 'USD').trim().toUpperCase() || 'USD',
        assetType: row.assetType || 'EQUITY',
        sector: row.sector,
      }))
      .filter((row) => row.symbol);
    if (!positions.length) {
      setError('Add at least one ticker with a share quantity before reviewing.');
      setStep('');
      return;
    }
    // A screenshot can identify the ticker but not the share count. Block the
    // review with the exact rows instead of silently dropping them server-side.
    const missingQuantity = positions.filter((row) => row.quantity === null || row.quantity === 0);
    if (missingQuantity.length) {
      setError(
        `Enter a share quantity for ${missingQuantity.map((row) => row.symbol).join(', ')} before reviewing.`,
      );
      setStep('');
      return;
    }
    // Cash is sent as its own currency row so the review can include it in the
    // book value instead of silently ignoring a visible balance.
    const cashRows = cash
      .map((row) => ({
        symbol: String(row.currency || 'USD').trim().toUpperCase() || 'USD',
        name: row.label || 'Cash',
        currency: String(row.currency || 'USD').trim().toUpperCase() || 'USD',
        quantity: numericValue(row.value),
      }))
      .filter((row) => row.quantity !== null);

    setBusy(true);
    setStep('Pricing holdings and building portfolio review…');
    try {
      const payload = await api.portfolioReview({ fileName, holdings: [...positions, ...cashRows] });
      setReview(payload);
      setStep('');
    } catch (err) {
      setError(err.message);
      setStep('');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFileName('');
    setPreview('');
    setHoldings([]);
    setCash([]);
    setWarnings([]);
    setModel('');
    setReview(null);
    setError('');
    setStep('');
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="page portfolio-page">
      <section className="page-head">
        <div>
          <div className="eyebrow">PORTFOLIO · SCREENSHOT REVIEW</div>
          <h1>Understand your portfolio</h1>
          <p className="page-sub">
            Upload a screenshot of your holdings. We’ll read the visible tickers, share counts, cost basis and cash balance, let
            you verify them, then compare each position with live quotes, risk, concentration and the current engine plan.
          </p>
        </div>
      </section>

      <section className="panel portfolio-upload-panel">
        <div className="portfolio-upload-copy">
          <div>
            <div className="eyebrow">STEP 1 · UPLOAD A SCREENSHOT</div>
            <h2>Start with your broker’s holdings screen</h2>
            <p>Use a clear image with ticker symbols and quantities visible. Average cost improves the P/L calculation.</p>
          </div>
          <div className="portfolio-upload-actions">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => upload(event.target.files?.[0])}
              disabled={busy}
              aria-label="Choose portfolio screenshot"
            />
            <span className="muted small">PNG, JPEG or WebP · max 15 MB before resizing</span>
          </div>
        </div>

        <div className="portfolio-privacy">
          Your screenshot is sent to the configured vision model to read holdings and is not saved by this feature. Review the
          extracted data before running the analysis. Hide account numbers and personal details before uploading.
        </div>
        {health?.agent && (
          <div className={`portfolio-vision-status ${health.agent.vision ? 'ready' : 'unavailable'}`}>
            {health.agent.vision
              ? `Screenshot reading is available with ${health.agent.model}.`
              : 'Screenshot reading needs a configured vision-capable model. Configure one in .env and restart the server.'}
          </div>
        )}

        {busy && <div className="alert alert-info tiny">{step}</div>}
        {error && <div className="alert alert-error tiny">{error}</div>}

        {preview && (
          <div className="portfolio-image-preview">
            <img src={preview} alt={`Preview of ${fileName}`} />
            <div>
              <strong>{fileName}</strong>
              <span>{model ? `Extracted by ${model}` : 'Screenshot preview'}</span>
            </div>
            <button type="button" className="btn btn-ghost btn-mini" onClick={reset} disabled={busy}>
              Clear
            </button>
          </div>
        )}

        {preview && (
          <form className="portfolio-extraction" onSubmit={runReview}>
            <div className="portfolio-extraction-head">
              <div>
                <div className="eyebrow">STEP 2 · VERIFY EXTRACTED HOLDINGS</div>
                <h2>{holdings.length} position{holdings.length === 1 ? '' : 's'} found</h2>
                <p>Correct any ticker, quantity or cost basis that was read incorrectly before continuing.</p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-mini"
                onClick={() => {
                  setHoldings((current) => [...current, { symbol: '', quantity: '', avgCost: null, currency: 'USD', name: '' }]);
                  setReview(null);
                }}
                disabled={busy}
              >
                + Add row
              </button>
            </div>
            <div className="pf-table-wrap">
              <table className="pf-table portfolio-edit-table">
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th className="num">Shares</th>
                    <th className="num">Average cost</th>
                    <th>Currency</th>
                    <th aria-label="Remove row" />
                  </tr>
                </thead>
                <tbody>
                  {holdings.length ? holdings.map((row, index) => (
                    <tr key={`${row.symbol}-${index}`}>
                      <td>
                        <input
                          aria-label={`Ticker for position ${index + 1}`}
                          value={row.symbol}
                          onChange={(event) => updateHolding(index, 'symbol', event.target.value.toUpperCase())}
                          required
                          maxLength={15}
                        />
                      </td>
                      <td className="num">
                        <input
                          aria-label={`Share quantity for ${row.symbol || `position ${index + 1}`}`}
                          type="number"
                          step="any"
                          value={row.quantity ?? ''}
                          onChange={(event) => updateHolding(index, 'quantity', event.target.value)}
                          placeholder={row.quantity === null || row.quantity === undefined ? 'Required' : ''}
                          required
                        />
                      </td>
                      <td className="num">
                        <input
                          aria-label={`Average cost for ${row.symbol || `position ${index + 1}`}`}
                          type="number"
                          min="0"
                          step="any"
                          value={row.avgCost ?? ''}
                          onChange={(event) => updateHolding(index, 'avgCost', event.target.value)}
                          placeholder="Optional"
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`Currency for ${row.symbol || `position ${index + 1}`}`}
                          value={row.currency || 'USD'}
                          onChange={(event) => updateHolding(index, 'currency', event.target.value.toUpperCase())}
                          maxLength={5}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="icon-btn portfolio-remove-row"
                          onClick={() => {
                            setHoldings((current) => current.filter((_, i) => i !== index));
                            setReview(null);
                          }}
                          aria-label={`Remove ${row.symbol || `position ${index + 1}`}`}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  )) : (
                    <tr><td colSpan="5" className="muted">No positions remain. Add a row or upload another screenshot.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="portfolio-cash">
              <div className="portfolio-cash-head">
                <div>
                  <div className="eyebrow">CASH BALANCE</div>
                  <p className="muted small">
                    Add the broker&apos;s cash row if the screenshot shows one — it changes position weights and total value. A
                    negative balance is a margin debit.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-mini"
                  onClick={() => {
                    setCash((current) => [...current, { currency: 'USD', value: '', label: 'Cash' }]);
                    setReview(null);
                  }}
                  disabled={busy}
                >
                  + Add cash
                </button>
              </div>
              {cash.length ? (
                <div className="portfolio-cash-rows">
                  {cash.map((row, index) => (
                    <div className="portfolio-cash-row" key={`${row.currency}-${index}`}>
                      <input
                        aria-label={`Cash currency ${index + 1}`}
                        value={row.currency || 'USD'}
                        onChange={(event) => updateCash(index, 'currency', event.target.value.toUpperCase())}
                        maxLength={5}
                      />
                      <input
                        aria-label={`Cash balance ${index + 1}`}
                        type="number"
                        step="any"
                        value={row.value ?? ''}
                        onChange={(event) => updateCash(index, 'value', event.target.value)}
                        placeholder="Balance (negative for margin)"
                      />
                      <button
                        type="button"
                        className="icon-btn portfolio-remove-row"
                        aria-label={`Remove cash balance ${index + 1}`}
                        onClick={() => {
                          setCash((current) => current.filter((_, i) => i !== index));
                          setReview(null);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="muted small">No cash row added.</span>
              )}
            </div>
            {warnings.map((warning) => (
              <div className="portfolio-extraction-warning" key={warning}>
                {warning}
              </div>
            ))}
            <div className="portfolio-submit-row">
              <span className="muted small">
                {cash.length
                  ? `${cash.length} cash balance${cash.length === 1 ? '' : 's'} included in the book value`
                  : 'Cash is optional — add it to measure weights and dry powder'}
              </span>
              <button type="submit" className="btn btn-primary" disabled={busy || holdings.length === 0}>
                {busy ? 'Reviewing…' : 'Review my portfolio'}
              </button>
            </div>
          </form>
        )}
      </section>

      {review && (
        <section className="panel portfolio-result-panel">
          <div className="portfolio-result-head">
            <div>
              <div className="eyebrow">STEP 3 · PORTFOLIO DECISIONS</div>
              <h2>Live portfolio review</h2>
              <p>
                Recommendations are based on live quotes, position sizing and engine analysis—not a guarantee of future
                performance. “Add” applies to a position you already hold.
              </p>
            </div>
            <button type="button" className="btn btn-ghost btn-mini" onClick={() => setReview(null)}>
              Edit holdings
            </button>
          </div>
          {review.totals && (
            <div className="portfolio-action-summary">
              <span><strong>{review.positions.filter((row) => row.recommendation === 'exit').length}</strong> exit / cover</span>
              <span><strong>{review.positions.filter((row) => row.recommendation === 'trim').length}</strong> trim</span>
              <span><strong>{review.positions.filter((row) => row.recommendation === 'add').length}</strong> add</span>
              <span><strong>{review.positions.filter((row) => row.recommendation === 'hold').length}</strong> hold</span>
              <span><strong>{review.positions.filter((row) => row.recommendation === 'review').length}</strong> check data</span>
            </div>
          )}
          <PortfolioReview data={review} />
        </section>
      )}

      <p className="portfolio-disclaimer">
        This is educational analysis, not personalized financial advice. Verify all extracted holdings, prices, tax effects and
        trading costs before taking action. A “sell” or “exit” recommendation is a risk-management signal, not a short-sale
        recommendation.
      </p>
    </div>
  );
}
