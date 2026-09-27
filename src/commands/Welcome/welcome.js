import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import { getWelcomeConfig, updateWelcomeConfig } from '../../utils/database.js';
import { formatWelcomeMessage, truncateForEmbedField } from '../../utils/welcome.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { inflateSync } from 'node:zlib';

// ===========================================================================
// Mustache-style tag engine
// Matches welcomer.gg/formatting: {{User.Mention}}, {{Ordinal(...)}}, {{#Section}}
// ===========================================================================

const DEFAULT_WELCOME_MESSAGE =
    'Welcome {{User.Mention}} to **{{Guild.Name}}**! You are the {{Ordinal(Guild.Members)}} member!';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function toOrdinal(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return String(n);
    const mod100 = Math.abs(num) % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${num}th`;
    switch (Math.abs(num) % 10) {
        case 1: return `${num}st`;
        case 2: return `${num}nd`;
        case 3: return `${num}rd`;
        default: return `${num}th`;
    }
}

function formatNumber(n, locale = 'default') {
    const num = Number(n);
    if (!Number.isFinite(num)) return String(n);
    switch (locale) {
        case 'dots': return num.toLocaleString('de-DE');
        case 'commas': return num.toLocaleString('en-US');
        case 'indian': return num.toLocaleString('en-IN');
        case 'arabic': return num.toLocaleString('ar-EG');
        default: return num.toLocaleString('en-US');
    }
}

function formatTime(input, format = 'MMMM dd, yyyy') {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return String(input);

    const pad = (value) => String(value).padStart(2, '0');
    const tokens = {
        yyyy: date.getFullYear(),
        yy: String(date.getFullYear()).slice(-2),
        MMMM: MONTHS[date.getMonth()],
        MMM: MONTHS[date.getMonth()].slice(0, 3),
        MM: pad(date.getMonth() + 1),
        M: date.getMonth() + 1,
        dddd: DAYS[date.getDay()],
        ddd: DAYS[date.getDay()].slice(0, 3),
        dd: pad(date.getDate()),
        d: date.getDate(),
        HH: pad(date.getHours()),
        hh: pad(date.getHours() % 12 || 12),
        h: date.getHours() % 12 || 12,
        mm: pad(date.getMinutes()),
        m: date.getMinutes(),
        ss: pad(date.getSeconds()),
        s: date.getSeconds()
    };
    return format.replace(/yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|hh|h|mm|m|ss|s/g, (tag) => tokens[tag] ?? tag);
}

function sinceTime(input) {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return String(input);

    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    const units = [
        ['year', 31536000], ['month', 2592000], ['day', 86400],
        ['hour', 3600], ['minute', 60], ['second', 1]
    ];
    for (const [name, size] of units) {
        const value = Math.floor(seconds / size);
        if (value >= 1) return `${value} ${name}${value === 1 ? '' : 's'}`;
    }
    return '0 seconds';
}

/** Builds the flat lookup used by both `{{Tag}}` and `{{Function(Tag)}}`. */
function buildTagContext({ user, guild, member, invite }) {
    const now = Date.now();
    return {
        'User.ID': user.id,
        'User.Name': user.discriminator && user.discriminator !== '0'
            ? `${user.globalName || user.username}#${user.discriminator}`
            : (user.globalName || user.username),
        'User.Username': user.username,
        'User.Discriminator': user.discriminator || '0',
        'User.GlobalName': user.globalName || user.username,
        'User.Mention': `<@${user.id}>`,
        'User.CreatedAt': sinceTime(user.createdTimestamp),
        'User.JoinedAt': member?.joinedTimestamp ? sinceTime(member.joinedTimestamp) : 'unknown',
        'User.LeftAt': 'unknown',
        'User.Avatar': user.displayAvatarURL({ size: 256, extension: 'png' }),
        'User.Bot': Boolean(user.bot),
        'User.Pending': Boolean(member?.pending),

        'Guild.ID': guild.id,
        'Guild.Name': guild.name,
        'Guild.Icon': guild.iconURL({ size: 256, extension: 'png' }) || '',
        'Guild.Splash': guild.splashURL({ size: 512, extension: 'png' }) || '',
        'Guild.Members': guild.memberCount,
        'Guild.MembersJoined': now,
        'Guild.Banner': guild.bannerURL({ size: 512, extension: 'png' }) || '',

        'Invite.Code': invite?.code || 'unknown',
        'Invite.Uses': invite?.uses ?? 0,
        'Invite.Inviter': invite?.inviter?.tag || 'unknown',
        'Invite.ChannelID': invite?.channelId || 'unknown',
        'Invite.CreatedAt': invite?.createdTimestamp ? sinceTime(invite.createdTimestamp) : 'unknown',
        'Invite.ExpiresAt': invite?.expiresTimestamp ? sinceTime(invite.expiresTimestamp) : 'never',
        'Invite.MaxAge': invite?.maxAge ?? 0,
        'Invite.MaxUses': invite?.maxUses ?? 0,
        'Invite.Temporary': Boolean(invite?.temporary)
    };
}

const FUNCTIONS = {
    Ordinal: (value) => toOrdinal(value),
    FormatNumber: (value, locale) => formatNumber(value, locale),
    SinceTime: (value) => sinceTime(value),
    FormatTime: (value, format) => formatTime(value, format),
    Upper: (value) => String(value).toUpperCase(),
    Lower: (value) => String(value).toLowerCase(),
    Title: (value) => String(value).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
};

const TAG_PATTERN = /\{\{([#/^]?)([\w.]+)(?:\(([^)]*)\))?(?:\/)?\}\}/g;
const SECTION_PATTERN = /\{\{([#^])\/?([\w.]+)\}\}/g;

/** Resolves one tag, applying a function call if the tag was wrapped in one. */
function resolveTag(token, args, context, now) {
    const [funcName, ...funcArgs] = args;
    const raw = context[token];

    // {{Guild.MembersJoined}} is a timestamp, so relative times stay relative.
    const value = token === 'Guild.MembersJoined' && typeof raw === 'number'
        ? sinceTime(raw)
        : raw;

    if (!funcName || !FUNCTIONS[funcName]) return value ?? '';
    const resolvedArgs = funcArgs.map((arg) => (arg in context ? context[arg] : arg));
    try {
        return FUNCTIONS[funcName](value, ...resolvedArgs);
    } catch {
        return value ?? '';
    }
}

/**
 * Renders welcomer-style tags.
 * @param {string} template
 * @param {{user: import('discord.js').User, guild: import('discord.js').Guild, member?: import('discord.js').GuildMember, invite?: any}} data
 * @param {number} now fixed timestamp so every tag in one render agrees
 */
function renderTags(template, data, now = Date.now()) {
    if (typeof template !== 'string' || template.length === 0) return '';

    const context = buildTagContext({ ...data, now });

    // Mustache sections: {{#User.Bot}}yes{{/User.Bot}}{{^User.Bot}}no{{/User.Bot}}
    let output = template.replace(
        /\{\{([#^])([\w.]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g,
        (match, kind, tag, body) => {
            const truthy = Boolean(resolveTag(tag, [], context, now));
            return kind === '#' ? (truthy ? body : '') : (truthy ? '' : body);
        }
    );
    // Strip any orphaned section markers left by a mismatched tag.
    output = output.replace(SECTION_PATTERN, '');

    return output.replace(TAG_PATTERN, (match, prefix, tag, args) => {
        if (prefix) return '';
        const parts = (args || '').split(',').map((p) => p.trim()).filter(Boolean);
        const [token, ...rest] = parts;
        if (!token) return '';
        return String(resolveTag(token, rest, context, now));
    });
}

// ===========================================================================
// Accent color: profile banner color -> average of avatar -> role -> default
// ===========================================================================

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

export {
    renderTags,
    getMemberAccentColor,
    DEFAULT_WELCOME_MESSAGE
};

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
                        .setDescription('Welcome message. Tags: {{User.Mention}}, {{Guild.Name}}, {{Ordinal(Guild.Members)}}, {{#User.Bot}}...{{/User.Bot}}')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('image')
                        .setDescription('URL of the image to include in the welcome message')
                        .setRequired(false))
                .addBooleanOption(option =>
                    option.setName('ping')
                        .setDescription('Whether to ping the user in the welcome message')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('tags')
                .setDescription('List every tag and function you can use'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('test')
                .setDescription('Preview the welcome message as it would be sent')
                .addUserOption(option =>
                    option
                        .setName('user')
                        .setDescription('Who to preview as. Defaults to you.')
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

        // -------------------------------------------------------------------
        // /welcome tags
        // -------------------------------------------------------------------
        if (subcommand === 'tags') {
            const rows = [
                ['**User**', ''],
                ['`{{User.ID}}`', 'The user\'s id'],
                ['`{{User.Name}}`', 'Global name or username with discriminator'],
                ['`{{User.Username}}`', 'The user\'s username'],
                ['`{{User.GlobalName}}`', 'The user\'s global name'],
                ['`{{User.Discriminator}}`', 'The user\'s discriminator'],
                ['`{{User.Mention}}`', 'Mentions the user'],
                ['`{{User.CreatedAt}}`', 'Account age, relative'],
                ['`{{User.JoinedAt}}`', 'Join date, relative'],
                ['`{{User.Avatar}}`', 'Avatar URL'],
                ['`{{User.Bot}}`', 'True if the user is a bot'],
                ['`{{User.Pending}}``', 'True if pending membership screening'],
                ['**Guild**', ''],
                ['`{{Guild.ID}}`', 'The guild\'s id'],
                ['`{{Guild.Name}}`', 'The guild\'s name'],
                ['`{{Guild.Icon}}`', 'Guild icon URL'],
                ['`{{Guild.Splash}}`', 'Guild splash URL'],
                ['`{{Guild.Members}}`', 'Current member count'],
                ['`{{Guild.MembersJoined}}`', 'Join counter (never decreases)'],
                ['`{{Guild.Banner}}`', 'Guild banner URL'],
                ['**Invite**', ''],
                ['`{{Invite.Code}}`', 'The invite code'],
                ['`{{Invite.Uses}}`', 'Times the invite was used'],
                ['`{{Invite.Inviter}}`', 'Who created the invite'],
                ['`{{Invite.CreatedAt}}`', 'Invite creation, relative'],
                ['**Functions**', ''],
                ['`{{Ordinal(Guild.Members)}}`', '1st, 2nd, 3rd, 4th…'],
                ['`{{FormatNumber(n, commas)}}`', 'default, dots, commas, indian, arabic'],
                ['`{{SinceTime(User.CreatedAt)}}`', '\"7 years\" as a string'],
                ['`{{FormatTime(User.CreatedAt, MMMM dd, yyyy)}}`', 'Custom date format'],
                ['`{{Upper(x)}}` / `{{Lower(x)}}` / `{{Title(x)}}`', 'Change case'],
                ['**Sections**', ''],
                ['`{{#User.Bot}}bot{{/User.Bot}}`', 'Show only if a bot'],
                ['`{{^User.Bot}}human{{/User.Bot}}`', 'Show only if not a bot']
            ];

            const embed = new EmbedBuilder()
                .setColor(getColor('primary'))
                .setTitle('📝 Welcome tag reference')
                .setDescription(rows
                    .map(([name, desc]) => (desc ? `${name} — ${desc}` : `\n**${name.replace(/\*/g, '')}**`))
                    .join('\n'))
                .setFooter({ text: 'Example: ' + DEFAULT_WELCOME_MESSAGE });

            return await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        }

        // -------------------------------------------------------------------
        // /welcome test
        // -------------------------------------------------------------------
        if (subcommand === 'test') {
            const target = options.getUser('user') ?? interaction.user;
            const member = await guild.members.fetch(target.id).catch(() => null);
            if (!member) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.UNKNOWN,
                    message: 'That member is not in this server.'
                });
            }

            const config = await getWelcomeConfig(client, guild.id);
            const template = config?.welcomeMessage || DEFAULT_WELCOME_MESSAGE;
            const invite = await guild.invites.fetch().then((i) => i.first()).catch(() => null);
            const rendered = renderTags(template, { user: member.user, guild, member, invite });

            const accentColor = await getMemberAccentColor(member, getColor('success'));

            const embed = new EmbedBuilder()
                .setColor(accentColor)
                .setTitle('🎉 Preview')
                .setDescription(truncateForEmbedField(rendered))
                .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
                .setFooter({
                    text: `Accent ${toHex(accentColor)} from their ${accentSource(member)} • ${config?.welcomePing ? 'pings' : 'no ping'}`
                });

            return await InteractionHelper.safeEditReply(interaction, {
                content: config?.welcomePing ? `<@${member.id}>` : undefined,
                embeds: [embed]
            });
        }

        // -------------------------------------------------------------------
        // /welcome setup
        // -------------------------------------------------------------------
        if (subcommand === 'setup') {
            const channel = options.getChannel('channel');
            const message = options.getString('message') ?? DEFAULT_WELCOME_MESSAGE;
            const image = options.getString('image');
            const ping = options.getBoolean('ping') ?? false;

            const existingConfig = await getWelcomeConfig(client, guild.id);
            if (existingConfig?.channelId) {
                logger.info(`[Welcome] Setup blocked because config already exists in channel ${existingConfig.channelId} for guild ${guild.id}`);
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `Welcome is already configured for <#${existingConfig.channelId}>. Use **/greet dashboard** to customize channel, message, ping, or image.` });
            }

            if (message.trim().length === 0) {
                logger.warn(`[Welcome] Empty message provided by ${interaction.user.tag} in ${guild.name}`);
                return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Welcome message cannot be empty' });
            }

            const unknownTags = [...message.matchAll(/\{\{([#/^]?)([\w.]+)/g)]
                .map(([, , tag]) => tag)
                .filter((tag) => !(tag in buildTagContext({ user: interaction.user, guild, member: null })));
            if (unknownTags.length > 0) {
                logger.warn(`[Welcome] Unknown tags in message by ${interaction.user.tag}: ${unknownTags.join(', ')}`);
                return await replyUserError(interaction, {
                    type: ErrorTypes.VALIDATION,
                    message: `Unknown tag${unknownTags.length > 1 ? 's' : ''}: ${[...new Set(unknownTags)].map((t) => `\`{{${t}}}\``).join(', ')}. Run \`/welcome tags\` for the full list.`
                });
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

                const previewMessage = renderTags(message, {
                    user: interaction.user,
                    guild,
                    member: guild.members.cache.get(interaction.user.id) ?? null
                });

                // Preview in the admin's own banner color, so they see what a
                // new member's welcome will look like.
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
                    .setFooter({ text: 'Tip: Run /welcome test to preview, /welcome tags for variables' });

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
