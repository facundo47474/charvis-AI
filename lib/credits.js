/**
 * Sistema de créditos inicial (Mock para Beta)
 */

// En una beta real, esto vendría de una base de datos (Supabase, Firebase, Postgres)
const mockCreditsDB = new Map();

const LIMITS = {
  GUEST: 10,
  USER: 100,
  ADMIN: 999999
};

function getUserCredits(userId, isGuest = false) {
  if (!userId) return 0;
  if (!mockCreditsDB.has(userId)) {
    mockCreditsDB.set(userId, isGuest ? LIMITS.GUEST : LIMITS.USER);
  }
  return mockCreditsDB.get(userId);
}

function hasEnoughCredits(userId, estimatedCost = 1, isGuest = false) {
  const current = getUserCredits(userId, isGuest);
  return current >= estimatedCost;
}

function consumeCredits(userId, amount = 1, isGuest = false) {
  const current = getUserCredits(userId, isGuest);
  const next = Math.max(0, current - amount);
  mockCreditsDB.set(userId, next);
  return next;
}

module.exports = {
  getUserCredits,
  hasEnoughCredits,
  consumeCredits
};
