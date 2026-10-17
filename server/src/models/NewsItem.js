import mongoose from 'mongoose';

/**
 * One archived headline or business-deal story per symbol. Deduplicated on
 * `link` so the daily job can re-run safely without growing duplicates.
 */
const newsItemSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, uppercase: true, index: true },
    name: { type: String, default: null },
    title: { type: String, required: true },
    summary: { type: String, default: '' },
    publisher: { type: String, default: null },
    link: { type: String, required: true },
    publishedAt: { type: Date, default: null },
    day: { type: String, required: true, index: true }, // YYYY-MM-DD of publishedAt (or ingest day)
    direction: { type: String, enum: ['bullish', 'bearish', 'neutral'], default: 'neutral' },
    score: { type: Number, default: 0 }, // -100..100
    tags: { type: [String], default: [] },
    isDeal: { type: Boolean, default: false, index: true },
    relevance: { type: Number, default: null },
    ingestedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

newsItemSchema.index({ symbol: 1, publishedAt: -1 });
newsItemSchema.index({ symbol: 1, link: 1 }, { unique: true });
newsItemSchema.index({ isDeal: 1, publishedAt: -1 });

export const NewsItem = mongoose.models.NewsItem || mongoose.model('NewsItem', newsItemSchema);
