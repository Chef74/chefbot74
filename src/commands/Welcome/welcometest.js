import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { getWelcomeConfig } from '../../utils/database.js';
import { formatWelcomeMessage } from '../../utils/welcome.js';
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
        .setName('welcometest')
        .setDescription('Preview the welcome card for any member, in their own accent color')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('Who to preview as. Defaults to you.')
                .setRequired(false))
        .addStringOption(option =>
            option
                .setName('message')
                .setDescription('Override the message. Defaults to the configured one.')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('ping')
                .setDescription('Show the ping the way it would be sent')
                .setRequired(false)),

    async execute(interaction) {
        try {
            const deferSuccess = await InteractionHelper.safeDefer(interaction);
            if (!deferSuccess) {
                logger.warn(`WelcomeTest interaction defer failed`, {
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    commandName: 'welcometest'
                });
                return;
            }
        } catch (deferError) {
            logger.error(`WelcomeTest defer error`, { error: deferError.message });
            return;
        }

        const { options, guild, client } = interaction;

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: 'You need the **Manage Server** permission to use `/welcometest`.'
            });
        }

        try {
            const target = options.getUser('user') ?? interaction.user;
            const override = options.getString('message');
            const ping = options.getBoolean('ping') ?? false;

            const member = await guild.members.fetch(target.id).catch(() => null);
            if (!member) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.UNKNOWN,
                    message: 'That member is not in this server.'
                });
            }

            const config = await getWelcomeConfig(client, guild.id);
            const template = override || config?.welcomeMessage || 'Welcome {user} to **{server}**! You are member #{memberCount}.';

            const welcomeMessage = formatWelcomeMessage(template, {
                user: member.user,
                guild
            });

            const accentColor = await getMemberAccentColor(member, getColor('success'));

            logger.info(`[Welcome] test preview for ${member.user.tag} in ${guild.name}: ${toHex(accentColor)} (${accentSource(member)})`);

            const embed = new EmbedBuilder()
                .setColor(accentColor)
                .setTitle('🎉 Welcome!')
                .setDescription(welcomeMessage)
                .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
                .addFields(
                    { name: 'Member', value: `${member.user.tag}\n\`${member.user.id}\``, inline: true },
                    { name: 'Account created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
                    { name: 'Member count', value: guild.memberCount.toString(), inline: true }
                )
                .setFooter({ text: `Accent ${toHex(accentColor)} — from their ${accentSource(member)}` })
                .setTimestamp();

            if (config?.welcomeImage) embed.setImage(config.welcomeImage);

            await InteractionHelper.safeEditReply(interaction, {
                content: ping ? `<@${member.id}>` : undefined,
                embeds: [embed]
            });
        } catch (error) {
            logger.error(`[Welcome] test command failed for guild ${interaction.guildId}:`, error);
            await replyUserError(interaction, {
                type: ErrorTypes.UNKNOWN,
                message: 'Something went wrong building the preview.'
            });
        }
    },
};
