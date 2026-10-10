// ============================================================
//  src/commands/Utility/enableBoostMessage.js
//
//  Slash command: /enable boost-message <channel> <text>
// ============================================================

import {
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { setBoostConfig } from '../../services/boostCardService.js';
import { logger } from '../../utils/logger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('enable')
    .setDescription('Configure server features')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('boost-message')
        .setDescription('Set a channel and card text for Nitro boost alerts')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Channel where boost cards will be posted')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('text')
            .setDescription('Text on the card under the username (e.g. "just boosted the server!")')
            .setRequired(true)
            .setMaxLength(100)
        )
    ),

  async execute(interaction) {
    if (interaction.options.getSubcommand() !== 'boost-message') return;

    const channel = interaction.options.getChannel('channel');
    const text = interaction.options.getString('text');

    setBoostConfig(interaction.guildId, channel.id, text);

    const confirm = new EmbedBuilder()
      .setColor(0xb44fe8)
      .setTitle('Boost messages enabled')
      .setDescription(
        `Boost cards will be posted in ${channel}\n\n` +
          `**Card text:** ${text}\n\n` +
          `*Trigger: next member Nitro boost*`
      )
      .setFooter({ text: 'chefbot74 • Boost Module' });

    await interaction.reply({ embeds: [confirm], flags: MessageFlags.Ephemeral });

    logger.info('Boost message enabled', {
      guildId: interaction.guildId,
      channelId: channel.id,
      userId: interaction.user.id,
    });
  },
};
