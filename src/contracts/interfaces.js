export const SIGNATURES = Object.freeze({
  'src/domain/index.js': {
    registerTally: 1,
    applyVerifiedTally: 2,
    readTotals: 2,
    ranking: 3,
    snapshot: 1,
    readHistorySince: 2,
  },
  'src/fanout/index.js': { subscribe: 2, unsubscribe: 2 },
  'src/verification/index.js': { takeCase: 1, releaseCase: 3 },
  'src/presence/index.js': { presentAuditors: 0 },
});
