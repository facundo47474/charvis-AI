const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', '.cache');
const USAGE_FILE = path.join(CACHE_DIR, 'usage.json');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

let usageCache = {};

try {
  if (fs.existsSync(USAGE_FILE)) {
    const data = fs.readFileSync(USAGE_FILE, 'utf8');
    usageCache = JSON.parse(data);
  }
} catch (e) {
  console.error('[UsageService] Error al cargar usage.json', e.message);
}

function saveUsage() {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usageCache, null, 2));
  } catch (e) {
    console.error('[UsageService] Error al guardar usage.json', e.message);
  }
}

function getUsage(userId) {
  if (!userId) return 0;
  return usageCache[userId] || 0;
}

function getLimit(isGuest) {
  return isGuest ? 100 : 300;
}

function hasEnoughCredits(userId, estimatedCost = 1, isGuest = false) {
  const currentUsage = getUsage(userId);
  return (currentUsage + estimatedCost) <= getLimit(isGuest);
}

function incrementUsage(userId, amount = 1) {
  if (!userId) return 0;
  if (!usageCache[userId]) usageCache[userId] = 0;
  
  usageCache[userId] += amount;
  saveUsage();
  
  return usageCache[userId];
}

module.exports = {
  getUsage,
  incrementUsage,
  getLimit,
  hasEnoughCredits
};
