import { useCurrency } from './CurrencyProvider.jsx';
import { convertMoneyText } from '../lib/currency.js';

function inline(text, keyPrefix = 'i') {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g).filter(Boolean);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith('_') && part.endsWith('_') && part.length > 2) return <em key={key}>{part.slice(1, -1)}</em>;
    return <span key={key}>{part}</span>;
  });
}

const isTableSeparator = (line) => /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');

export default function Markdown({ text = '', className = '' }) {
  // Re-render on currency changes and translate USD amounts in AI prose.
  useCurrency();
  const lines = convertMoneyText(text).replace(/\r/g, '').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^```/.test(line)) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={`code-${index}`} className="md-code">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (line.trim().startsWith('|') && lines[index + 1] && isTableSeparator(lines[index + 1])) {
      const header = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(
          lines[index]
            .split('|')
            .slice(1, -1)
            .map((cell) => cell.trim()),
        );
        index += 1;
      }
      blocks.push(
        <div key={`table-${index}`} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {header.map((cell, i) => (
                  <th key={i}>{inline(cell, `th-${i}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{inline(cell, `td-${rowIndex}-${cellIndex}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (line.startsWith('#')) {
      const level = Math.min(4, line.match(/^#+/)[0].length);
      const content = line.replace(/^#+\s*/, '');
      const Tag = `h${level}`;
      blocks.push(<Tag key={`h-${index}`}>{inline(content, `h-${index}`)}</Tag>);
      index += 1;
      continue;
    }

    if (line.trim().startsWith('>')) {
      const quote = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={`q-${index}`} className="md-quote">
          {quote.map((item, i) => (
            <p key={i}>{inline(item, `q-${index}-${i}`)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${index}`} className="md-list">
          {items.map((item, i) => (
            <li key={i}>{inline(item, `li-${index}-${i}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${index}`} className="md-list">
          {items.map((item, i) => (
            <li key={i}>{inline(item, `oli-${index}-${i}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index]) &&
      !lines[index].trim().startsWith('|') &&
      !lines[index].startsWith('#') &&
      !lines[index].trim().startsWith('>')
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`p-${index}`} className="md-p">
        {paragraph.map((item, i) => (
          <span key={i}>
            {inline(item, `p-${index}-${i}`)}
            {i < paragraph.length - 1 ? ' ' : ''}
          </span>
        ))}
      </p>,
    );
  }

  return <div className={`md ${className}`}>{blocks}</div>;
}
