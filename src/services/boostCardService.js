// ============================================================
//  src/services/boostCardService.js
//  Shared boost-card canvas renderer + per-guild config store
//
//  Dependency: @napi-rs/canvas
// ============================================================

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Persistent config store at <project root>/data/boostConfig.json
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
 * Save a guild's boost-message config.
 * @param {string} guildId
 * @param {string} channelId
 * @param {string} message – custom subtext shown under the username
 */
export function setBoostConfig(guildId, channelId, message) {
  const store = _loadStore();
  store[guildId] = { channelId, message };
  _saveStore(store);
}

/**
 * Retrieve a guild's boost-message config.
 * @param {string} guildId
 * @returns {{ channelId: string, message: string } | null}
 */
export function getBoostConfig(guildId) {
  const store = _loadStore();
  return store[guildId] ?? null;
}

/**
 * Renders a 620×320 PNG boost thank-you card.
 */
async function buildBoostCard(member, customText) {
  const W = 620;
  const H = 320;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#1a1a2e';
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 24);
  ctx.fill();

  // Purple wing ellipses
  const WING = '#b44fe8';

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(-28, H / 2, 98, 155, 0, 0, Math.PI * 2);
  ctx.fillStyle = WING;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(W + 28, H / 2, 98, 155, 0, 0, Math.PI * 2);
  ctx.fillStyle = WING;
  ctx.fill();
  ctx.restore();

  // "Thank you!" pill
  const BADGE = 'Thank you!';
  ctx.font = 'bold 14px sans-serif';
  const bw = ctx.measureText(BADGE).width + 36;
  const bh = 28;
  const bx = (W - bw) / 2;
  const by = 26;

  ctx.fillStyle = '#2c2c3e';
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 14);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(BADGE, W / 2, by + bh / 2);

  // Circular avatar
  const avatarURL = member.user.displayAvatarURL({
    extension: 'png',
    size: 256,
    forceStatic: true,
  });

  const radius = 56;
  const ax = W / 2;
  const ay = H / 2 + 12;

  // White border ring
  ctx.save();
  ctx.beginPath();
  ctx.arc(ax, ay, radius + 4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();

  // Avatar clipped to circle
  try {
    const img = await loadImage(avatarURL);
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax, ay, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, ax - radius, ay - radius, radius * 2, radius * 2);
    ctx.restore();
  } catch {
    // Fallback: blurple disc if avatar fetch fails
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax, ay, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#5865F2';
    ctx.fill();
    ctx.restore();
  }

  // Username
  const displayName =
    member.nickname ??
    member.user.globalName ??
    member.user.username;

  ctx.font = 'bold 21px sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(displayName, W / 2, ay + radius + 14);

  // Custom subtext
  ctx.font = '15px sans-serif';
  ctx.fillStyle = '#b0b0c8';
  ctx.fillText(customText, W / 2, ay + radius + 44);

  return canvas.toBuffer('image/png');
}

/**
 * Build and send the boost card to the guild's configured channel.
 * @param {import('discord.js').GuildMember} member
 */
export async function sendBoostCard(member) {
  const cfg = getBoostConfig(member.guild.id);
  if (!cfg) return;

  const channel = member.guild.channels.cache.get(cfg.channelId);
  if (!channel) return;

  try {
    const buffer = await buildBoostCard(member, cfg.message);
    const attachment = new AttachmentBuilder(buffer, { name: 'boost-card.png' });

    const embed = new EmbedBuilder()
      .setColor(0xb44fe8)
      .setImage('attachment://boost-card.png');

    await channel.send({ embeds: [embed], files: [attachment] });
  } catch (err) {
    logger.error(`[BoostCard] Failed in ${member.guild.name}:`, err);
  }
}
