// ============================================================
// src/utils/verifyConfig.js
// Thin persistence layer for the verification config.
// Uses the same SQLite/JSON database pattern the rest of
// chefbot74 uses – swap the read/write calls if your DB util
// has a different API.
// ============================================================

// In-memory fallback (works without any DB changes)
// Replace with real DB calls if your project uses one.
const store = new Map(); // guildId → { channelId, messageId, roleId }

/**
 * Retrieve the verification config for a guild.
 * @param {string} guildId
 * @returns {Promise<{channelId:string, messageId:string, roleId:string}|null>}
 */
export async function getVerifyConfig(guildId) {
  return store.get(guildId) ?? null;
}

/**
 * Save / overwrite the verification config for a guild.
 * @param {string} guildId
 * @param {{ channelId:string, messageId:string, roleId:string }} config
 */
export async function setVerifyConfig(guildId, config) {
  store.set(guildId, config);
}

/**
 * Delete the verification config for a guild.
 * @param {string} guildId
 */
export async function clearVerifyConfig(guildId) {
  store.delete(guildId);
}

// ── Optional: swap to a real DB ─────────────────────────────
// If your project already has a database utility (e.g. the
// getWelcomeConfig / updateWelcomeConfig from database.js),
// replace the Map above with real read/write calls:
//
//   import db from './database.js';
//
//   export async function getVerifyConfig(guildId) {
//     return db.get('verify', guildId);
//   }
//   export async function setVerifyConfig(guildId, config) {
//     return db.set('verify', guildId, config);
//   }
//   export async function clearVerifyConfig(guildId) {
//     return db.delete('verify', guildId);
//   }
