import mongoose from 'mongoose';

/**
 * One row per symbol per day: the aggregate news read that day. Keeping the
 * daily aggregate (not just the raw items) makes the trend query cheap and
 * preserves how the feed looked at the time, even after headlines rotate out
 * of Yahoo's RSS window.
 */
const digestSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, uppercase: true, index: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    sentiment: { type: Number, default: 0 }, // -100..100
    label: { type: String, default: 'mixed' },
    headlineCount: { type: Number, default: 0 },
    counts: {
      bullish: { type: Number, default: 0 },
      bearish: { type: Number, default: 0 },
      neutral: { type: Number, default: 0 },
    },
    dealCount: { type: Number, default: 0 },
    deals: [
      {
        _id: false,
        title: String,
        link: String,
        score: Number,
        direction: String,
        publishedAt: Date,
      },
    ],
    catalysts: [
      {
        _id: false,
        title: String,
        direction: String,
        score: Number,
        tags: [String],
        link: String,
      },
    ],
    risks: [
      {
        _id: false,
        title: String,
        score: Number,
        tags: [String],
        link: String,
      },
    ],
    source: { type: String, default: 'yahoo-finance-rss' },
    capturedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

digestSchema.index({ symbol: 1, date: 1 }, { unique: true });
digestSchema.index({ date: -1 });

export const DailyNewsDigest =
  mongoose.models.DailyNewsDigest || mongoose.model('DailyNewsDigest', digestSchema);
