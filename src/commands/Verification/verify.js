// ============================================================
// src/commands/Verify/verify.js
// Slash command: /verify setup   /verify remove   /verify status
// ============================================================
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { getVerifyConfig, setVerifyConfig, clearVerifyConfig } from '../../utils/verifyConfig.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { getColor } from '../../config/bot.js';

export default {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Manage the reaction-verification system')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

    // ── /verify setup ───────────────────────────────────────
    .addSubcommand(sub =>
      sub
        .setName('setup')
        .setDescription('Post a verify message and configure the verified role')
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('Channel where the verify message will be posted')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addRoleOption(opt =>
          opt
            .setName('role')
            .setDescription('Role given to members when they react ✅')
            .setRequired(true),
        )
        .addStringOption(opt =>
          opt
            .setName('message')
            .setDescription('Custom text shown in the verify embed (optional)')
            .setRequired(false),
        ),
    )

    // ── /verify remove ──────────────────────────────────────
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Disable reaction verification and remove the stored config'),
    )

    // ── /verify status ──────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Show the current verification configuration'),
    ),

  // ──────────────────────────────────────────────────────────
  async execute(interaction) {
    await InteractionHelper.safeDefer(interaction);

    const { guild, options } = interaction;
    const sub = options.getSubcommand();

    // ── /verify status ──────────────────────────────────────
    if (sub === 'status') {
      const cfg = await getVerifyConfig(guild.id);

      if (!cfg) {
        return InteractionHelper.safeEditReply(interaction, {
          embeds: [
            new EmbedBuilder()
              .setColor(getColor('warning'))
              .setDescription('❌ Verification is **not configured** on this server.\nRun `/verify setup` to get started.'),
          ],
        });
      }

      return InteractionHelper.safeEditReply(interaction, {
        embeds: [
          new EmbedBuilder()
            .setColor(getColor('primary'))
            .setTitle('✅ Verification Config')
            .addFields(
              { name: 'Channel', value: `<#${cfg.channelId}>`, inline: true },
              { name: 'Message ID', value: cfg.messageId, inline: true },
              { name: 'Role', value: `<@&${cfg.roleId}>`, inline: true },
            ),
        ],
      });
    }

    // ── /verify remove ──────────────────────────────────────
    if (sub === 'remove') {
      const cfg = await getVerifyConfig(guild.id);
      if (!cfg) {
        return replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: 'Verification is not configured on this server.',
        });
      }

      // Try to delete the original verify message
      try {
        const ch = guild.channels.cache.get(cfg.channelId);
        const msg = await ch?.messages.fetch(cfg.messageId).catch(() => null);
        await msg?.delete();
      } catch {
        // best-effort – don't block removal if message is already gone
      }

      await clearVerifyConfig(guild.id);
      logger.info(`[Verify] Config removed for guild ${guild.id} by ${interaction.user.tag}`);

      return InteractionHelper.safeEditReply(interaction, {
        embeds: [
          new EmbedBuilder()
            .setColor(getColor('success'))
            .setDescription('✅ Verification has been **disabled** and the config removed.'),
        ],
      });
    }

    // ── /verify setup ───────────────────────────────────────
    if (sub === 'setup') {
      const existing = await getVerifyConfig(guild.id);
      if (existing) {
        return replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: `Verification is already configured in <#${existing.channelId}>.\nRun \`/verify remove\` first if you want to reconfigure it.`,
        });
      }

      const channel = options.getChannel('channel');
      const role    = options.getRole('role');
      const text    = options.getString('message') ?? 'React with ✅ below to verify yourself and gain access to the server!';

      // Check the bot can send messages & add reactions in that channel
      const me = guild.members.me;
      if (!channel.permissionsFor(me).has(['SendMessages', 'AddReactions', 'ViewChannel'])) {
        return replyUserError(interaction, {
          type: ErrorTypes.PERMISSION,
          message: `I don't have **Send Messages** and **Add Reactions** permissions in ${channel}.`,
        });
      }

      // Build and send the verify embed
      const verifyEmbed = new EmbedBuilder()
        .setColor(getColor('primary'))
        .setTitle('✅  Verification')
        .setDescription(text)
        .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined });

      const verifyMsg = await channel.send({ embeds: [verifyEmbed] });
      await verifyMsg.add_reaction?.('✅').catch(() => verifyMsg.react('✅'));

      // Persist config
      await setVerifyConfig(guild.id, {
        channelId : channel.id,
        messageId : verifyMsg.id,
        roleId    : role.id,
      });

      logger.info(`[Verify] Setup complete for guild ${guild.id} – msg ${verifyMsg.id}`);

      return InteractionHelper.safeEditReply(interaction, {
        embeds: [
          new EmbedBuilder()
            .setColor(getColor('success'))
            .setTitle('Verification Configured')
            .addFields(
              { name: 'Channel',    value: `${channel}`,      inline: true },
              { name: 'Role',       value: `${role}`,         inline: true },
              { name: 'Message ID', value: verifyMsg.id,      inline: true },
            )
            .setFooter({ text: 'Members who react ✅ will receive the role automatically.' }),
        ],
      });
    }
  },
};
