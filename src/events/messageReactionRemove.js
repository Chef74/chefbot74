// ============================================================
// src/events/messageReactionRemove.js
// Removes the verified role when a member un-reacts from the
// verification message.
// ============================================================
import { Events } from 'discord.js';
import { getVerifyConfig } from '../../utils/verifyConfig.js';
import { logger } from '../../utils/logger.js';

export default {
  name: Events.MessageReactionRemove,  // 'messageReactionRemove'

  async execute(reaction, user) {
    if (user.bot) return;

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
      await member.roles.remove(role, 'Reaction verification removed');
      logger.info(`[Verify] Removed role "${role.name}" from ${user.tag} in ${guild.name}`);
    } catch (err) {
      logger.error(`[Verify] Failed to remove role from ${user.id}: ${err.message}`);
    }
  },
};
