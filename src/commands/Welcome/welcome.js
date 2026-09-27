import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, MessageFlags } from 'discord.js';
import { getWelcomeConfig, updateWelcomeConfig } from '../../utils/database.js';
import { formatWelcomeMessage, truncateForEmbedField } from '../../utils/welcome.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Accent color: profile banner color -> average of avatar -> role -> default
// ---------------------------------------------------------------------------

const DEFAULT_ACCENT = 0x5865f2;
const avatarColorCache = new Map();

/** Discord exposes the profile banner color as `user.accentColor`. */
function getBannerColor(user) {
    return typeof user?.accentColor === 'number' ? user.accentColor : null;
}

/** Minimal PNG decoder: 8-bit truecolor (with or without alpha), non-interlaced. */
function decodePng(buffer) {
    if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return null;

    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    const idat = [];
    let offset = 8;

    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const start = offset + 8;
        const data = buffer.subarray(start, start + length);

        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            if (data[12] !== 0) return null; // interlaced
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset = start + length + 4; // skip CRC
    }

    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
    if (bitDepth !== 8 || channels === 0 || width === 0 || height === 0) return null;

    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = Buffer.alloc(width * height * 4);
    const line = Buffer.alloc(stride);
    const previous = Buffer.alloc(stride);

    for (let y = 0; y < height; y += 1) {
        const filter = raw[y * (stride + 1)];
        raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
        unfilter(filter, line, previous, channels);

        for (let x = 0; x < width; x += 1) {
            const src = x * channels;
            const dst = (y * width + x) * 4;
            out[dst] = line[src];
            out[dst + 1] = line[src + 1];
            out[dst + 2] = line[src + 2];
            out[dst + 3] = channels === 4 ? line[src + 3] : 255;
        }
        line.copy(previous);
    }

    return { width, height, data: out };
}

function unfilter(filter, line, previous, bpp) {
    for (let i = 0; i < line.length; i += 1) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = previous[i];
        const c = i >= bpp ? previous[i - bpp] : 0;
        let value = line[i];
        if (filter === 1) value += a;
        else if (filter === 2) value += b;
        else if (filter === 3) value += (a + b) >> 1;
        else if (filter === 4) value += paeth(a, b, c);
        line[i] = value & 0xff;
    }
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

/** Alpha-weighted average of the avatar's opaque pixels. */
async function averageAvatarColor(url) {
    const response = await fetch(url);
    if (!response.ok) return null;

    const image = decodePng(Buffer.from(await response.arrayBuffer()));
    if (!image) return null;

    let r = 0, g = 0, b = 0, weight = 0;
    for (let i = 0; i < image.data.length; i += 4) {
        const alpha = image.data[i + 3] / 255;
        if (alpha < 0.5) continue;
        r += image.data[i] * alpha;
        g += image.data[i + 1] * alpha;
        b += image.data[i + 2] * alpha;
        weight += alpha;
    }
    if (weight === 0) return null;

    r = Math.round(r / weight);
    g = Math.round(g / weight);
    b = Math.round(b / weight);

    // Near-grey avatars make a washed-out accent; skip to the next fallback.
    if (Math.max(r, g, b) - Math.min(r, g, b) < 24) return null;

    return (r << 16) | (g << 8) | b;
}

function toHex(color) {
    return `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * Banner color if they have one, else the average of their avatar,
 * else their role color, else the fallback.
 */
async function getMemberAccentColor(member, fallbackColor = DEFAULT_ACCENT) {
    const bannerColor = getBannerColor(member.user);
    if (bannerColor !== null) return bannerColor;

    const cached = avatarColorCache.get(member.id);
    if (cached !== undefined) return cached;

    try {
        const averaged = await averageAvatarColor(
            member.displayAvatarURL({ size: 32, extension: 'png' })
        );
        if (averaged !== null) {
            avatarColorCache.set(member.id, averaged);
            return averaged;
        }
    } catch (error) {
        logger.warn(`[Welcome] avatar color failed for ${member.id}: ${error.message}`);
    }

    return member.displayColor || fallbackColor;
}

function accentSource(member) {
    if (getBannerColor(member.user) !== null) return 'profile banner';
    if (avatarColorCache.has(member.id)) return 'avatar average';
    if (member.displayColor) return 'role color';
    return 'default';
}

export default {
    data: new SlashCommandBuilder()
        .setName('welcome')
        .setDescription('Configure the welcome system')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Set up the welcome message')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('The channel to send welcome messages to')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('message')
                        .setDescription('Welcome message. Variables: {user}, {username}, {server}, {memberCount}')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('image')
                        .setDescription('URL of the image to include in the welcome message')
                        .setRequired(false))
                .addBooleanOption(option =>
                    option.setName('ping')
                        .setDescription('Whether to ping the user in the welcome message')
                        .setRequired(false))),

    async execute(interaction) {
        try {
            const deferSuccess = await InteractionHelper.safeDefer(interaction);
            if (!deferSuccess) {
                logger.warn(`Welcome interaction defer failed`, {
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    commandName: 'welcome'
                });
                return;
            }
        } catch (deferError) {
            logger.error(`Welcome defer error`, { error: deferError.message });
            return;
        }

        const { options, guild, client } = interaction;

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the **Manage Server** permission to use `/welcome`.' });
        }

        const subcommand = options.getSubcommand();

        if (subcommand === 'setup') {
            const channel = options.getChannel('channel');
            const message = options.getString('message');
            const image = options.getString('image');
            const ping = options.getBoolean('ping') ?? false;

            const existingConfig = await getWelcomeConfig(client, guild.id);
            if (existingConfig?.channelId) {
                logger.info(`[Welcome] Setup blocked because config already exists in channel ${existingConfig.channelId} for guild ${guild.id}`);
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `Welcome is already configured for <#${existingConfig.channelId}>. Use **/greet dashboard** to customize channel, message, ping, or image.` });
            }
            
            if (!message || message.trim().length === 0) {
                logger.warn(`[Welcome] Empty message provided by ${interaction.user.tag} in ${guild.name}`);
                return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Welcome message cannot be empty' });
            }

            if (image) {
                try {
                    new URL(image);
                } catch (e) {
                    logger.warn(`[Welcome] Invalid image URL provided by ${interaction.user.tag}: ${image}`);
                    return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Please provide a valid image URL (must start with http:// or https://' });
                }
            }

            try {
                await updateWelcomeConfig(client, guild.id, {
                    enabled: true,
                    channelId: channel.id,
                    welcomeMessage: message,
                    welcomeImage: image || undefined,
                    welcomePing: ping
                });

                logger.info(`[Welcome] Setup configured by ${interaction.user.tag} for guild ${guild.name} (${guild.id})`);

                const previewMessage = formatWelcomeMessage(message, {
                    user: interaction.user,
                    guild
                });

                // Preview uses the admin's own banner/avatar color, so they see
                // exactly what a new member's welcome will look like.
                const previewMember = guild.members.cache.get(interaction.user.id);
                const accentColor = previewMember
                    ? await getMemberAccentColor(previewMember, getColor('success'))
                    : getColor('success');
                const accentFrom = previewMember ? accentSource(previewMember) : 'default';

                const embed = new EmbedBuilder()
                    .setColor(accentColor)
                    .setTitle('Welcome System Configured')
                    .setDescription(`Welcome messages will now be sent to ${channel}`)
                    .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }))
                    .addFields(
                        { name: 'Message Preview', value: truncateForEmbedField(previewMessage) },
                        { name: 'Ping User', value: ping ? 'Yes' : 'No' },
                        { name: 'Accent Color', value: `${toHex(accentColor)} (${accentFrom})`, inline: true },
                        { name: 'Status', value: 'Enabled' }
                    )
                    .setFooter({ text: 'Tip: Use /greet dashboard to customize welcome settings' });

                if (image) {
                    embed.setImage(image);
                }

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            } catch (error) {
                logger.error(`[Welcome] Failed to setup welcome system for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while configuring the welcome system. Please try again.' });
            }
        }
    },
};
