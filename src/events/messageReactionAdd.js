// ============================================================
// src/events/messageReactionAdd.js
// Gives the verified role when a member reacts ✅ to the
// configured verification message.
// ============================================================
import { Events } from 'discord.js';
import { getVerifyConfig } from '../../utils/verifyConfig.js';
import { logger } from '../../utils/logger.js';

export default {
  name: Events.MessageReactionAdd,   // 'messageReactionAdd'
  // Use the raw event so it fires even for cached messages
  // If your loader uses { name, execute } just swap to the raw event below.

  async execute(reaction, user) {
    // Ignore bots
    if (user.bot) return;

    // Fetch partial reaction/message if needed (Discord.js partials)
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch { return; }
    }

    if (String(reaction.emoji) !== '✅') return;

    const guild = reaction.message.guild;
    if (!guild) return;

    const cfg = await getVerifyConfig(guild.id);
    if (!cfg) return;
    if (reaction.message.id !== cfg.messageId) return;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    const role = guild.roles.cache.get(cfg.roleId);
    if (!role) {
      return logger.warn(`[Verify] Role ${cfg.roleId} not found in guild ${guild.id}`);
    }

    try {
      await member.roles.add(role, 'Reaction verification');
      logger.info(`[Verify] Gave role "${role.name}" to ${user.tag} in ${guild.name}`);
    } catch (err) {
      logger.error(`[Verify] Failed to add role to ${user.id}: ${err.message}`);
    }
  },
};
