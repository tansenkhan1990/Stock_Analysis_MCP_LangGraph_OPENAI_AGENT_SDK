import mongoose from 'mongoose';

/**
 * One Yahoo Finance snapshot per symbol per session: the quote, the technical
 * plan, the quality score, the engine call, news sentiment, Street tilt and the
 * fundamental/option context as they stood that day.
 *
 * This is the decision layer's memory. Live quotes still answer "now"; these
 * rows answer "has the call been stable, is the score trending, did the last
 * calls work" — and they are the only thing that survives a Yahoo feed window
 * or a process restart.
 */
const marketSnapshotSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, uppercase: true, index: true },
    date: { type: String, required: true, index: true }, // YYYY-MM-DD session
    capturedAt: { type: Date, default: Date.now },
    source: { type: String, default: 'yahoo-finance-daily' },

    name: { type: String, default: null },
    quoteType: { type: String, default: 'EQUITY' },
    currency: { type: String, default: 'USD' },
    exchange: { type: String, default: null },
    assetClass: { type: String, default: null },

    close: { type: Number, default: null },
    previousClose: { type: Number, default: null },
    change: { type: Number, default: null },
    changePercent: { type: Number, default: null },
    volume: { type: Number, default: null },
    averageVolume: { type: Number, default: null },
    marketCap: { type: Number, default: null },
    fiftyTwoWeekHigh: { type: Number, default: null },
    fiftyTwoWeekLow: { type: Number, default: null },

    score: { type: Number, default: null },
    scoreLabel: { type: String, default: null },
    confidence: { type: Number, default: null },
    scoreComponents: [
      {
        _id: false,
        key: String,
        label: String,
        score: Number,
        weight: Number,
      },
    ],

    direction: { type: String, default: null },
    entryRef: { type: Number, default: null },
    buyZoneLow: { type: Number, default: null },
    buyZoneHigh: { type: Number, default: null },
    shortZoneLow: { type: Number, default: null },
    shortZoneHigh: { type: Number, default: null },
    stopLoss: { type: Number, default: null },
    riskReward: { type: Number, default: null },
    riskRewardAtSpot: { type: Number, default: null },
    horizon: { type: String, default: null },
    invalidation: { type: String, default: null },
    target1: { type: Number, default: null },
    target2: { type: Number, default: null },
    target3: { type: Number, default: null },
    target1Probability: { type: Number, default: null },

    action: { type: String, default: null },
    actionLabel: { type: String, default: null },
    setup: { type: String, default: null },
    setupLabel: { type: String, default: null },
    actionConfidence: { type: Number, default: null },

    rsi14: { type: Number, default: null },
    macdHistogram: { type: Number, default: null },
    adx14: { type: Number, default: null },
    atr14: { type: Number, default: null },
    atrPct: { type: Number, default: null },
    volumeRatio: { type: Number, default: null },
    annualizedVolatility: { type: Number, default: null },
    maxDrawdown: { type: Number, default: null },
    sma20: { type: Number, default: null },
    sma50: { type: Number, default: null },
    sma200: { type: Number, default: null },
    rangePosition: { type: Number, default: null },
    supportNearest: { type: Number, default: null },
    resistanceNearest: { type: Number, default: null },

    newsSentiment: { type: Number, default: null },
    newsLabel: { type: String, default: null },
    headlineCount: { type: Number, default: null },
    dealCount: { type: Number, default: null },
    analystTilt: { type: Number, default: null },
    earningsDate: { type: String, default: null },

    sector: { type: String, default: null },
    valuation: {
      _id: false,
      trailingPE: { type: Number, default: null },
      forwardPE: { type: Number, default: null },
      pegRatio: { type: Number, default: null },
      revenueGrowth: { type: Number, default: null },
      earningsGrowth: { type: Number, default: null },
      profitMargin: { type: Number, default: null },
      analystTarget: { type: Number, default: null },
      recommendationMean: { type: Number, default: null },
    },

    options: {
      _id: false,
      expiration: { type: String, default: null },
      atmIv: { type: Number, default: null },
      ivState: { type: String, default: null },
      expectedMovePct: { type: Number, default: null },
      maxPain: { type: Number, default: null },
      pcrOi: { type: Number, default: null },
    },
  },
  { versionKey: false },
);

marketSnapshotSchema.index({ symbol: 1, date: 1 }, { unique: true });
marketSnapshotSchema.index({ date: -1 });

export const MarketSnapshot =
  mongoose.models.MarketSnapshot || mongoose.model('MarketSnapshot', marketSnapshotSchema);
