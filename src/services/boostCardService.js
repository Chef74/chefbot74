// ============================================================
//  src/services/boostCardService.js
//  Per-guild boost config + boost thank-you message sender
// ============================================================

import { EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '../../data');
const CONFIG_FILE = path.join(DATA_DIR, 'boostConfig.json');

function _loadStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function _saveStore(store) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    logger.error('[BoostCard] Could not write config:', err);
  }
}

/**
 * @param {string} guildId
 * @param {string} channelId
 * @param {string} message
 */
export function setBoostConfig(guildId, channelId, message) {
  const store = _loadStore();
  store[guildId] = { channelId, message };
  _saveStore(store);
}

/**
 * @param {string} guildId
 * @returns {{ channelId: string, message: string } | null}
 */
export function getBoostConfig(guildId) {
  const store = _loadStore();
  return store[guildId] ?? null;
}

/**
 * Send a boost thank-you embed to the guild's configured channel.
 * @param {import('discord.js').GuildMember} member
 */
export async function sendBoostCard(member) {
  const cfg = getBoostConfig(member.guild.id);
  if (!cfg) return;

  const channel = member.guild.channels.cache.get(cfg.channelId);
  if (!channel?.isTextBased?.()) return;

  const displayName =
    member.nickname ??
    member.user.globalName ??
    member.user.username;

  try {
    const embed = new EmbedBuilder()
      .setColor(0xb44fe8)
      .setTitle('Thank you!')
      .setDescription(`**${displayName}** ${cfg.message}`)
      .setThumbnail(member.user.displayAvatarURL({ size: 256, extension: 'png' }))
      .setFooter({ text: `${member.guild.name} • Boost` });

    await channel.send({
      content: `${member}`,
      embeds: [embed],
    });
  } catch (err) {
    logger.error(`[BoostCard] Failed in ${member.guild.name}:`, err);
  }
}
