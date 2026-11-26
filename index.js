'use strict';

const path = require('path');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const attachVoice = require('./voice');

const TOKEN = String(process.env.DISCORD_TOKEN || '').trim();
const BOT_NAME = 'متلازم أول';
const PROVIDER = String(process.env.AI_PROVIDER || '').toLowerCase() ||
  (process.env.GEMINI_API_KEY ? 'gemini' : process.env.OPENAI_API_KEY ? 'openai' : 'kilo');

/* ── خادم الصحة (self-ping 24/7) ── */
const app = express();
app.get('/', (_req, res) => res.json({ status: 'ok', bot: BOT_NAME }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`[web] health server on ${PORT}`));

const selfUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL || process.env.SELF_URL || '').replace(/\/+$/, '');
if (selfUrl) {
  setInterval(() => fetch(selfUrl + '/health').catch(() => {}), 5 * 60 * 1000).unref();
  console.log('[web] self ping → ' + selfUrl);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const voice = attachVoice(client, {
  ghRepo: 'ai-971-bot',
  log: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a)
});

/* ── معرفة السيرفر ── */
const contextCache = new Map();

function buildContext(guild) {
  const textChans = guild.channels.cache
    .filter((c) => c.isTextBased() && !c.isThread())
    .map((c) => `#${c.name}${c.topic ? ' — ' + String(c.topic).slice(0, 100) : ''}`)
    .slice(0, 60);
  const voiceChans = guild.channels.cache
    .filter((c) => c.isVoiceBased())
    .map((c) => `🔊 ${c.name}`)
    .slice(0, 40);
  const roles = guild.roles.cache
    .filter((r) => r.name !== '@everyone')
    .map((r) => r.name)
    .slice(0, 50);

  return [
    `اسم السيرفر: ${guild.name}`,
    `عدد الأعضاء: ${guild.memberCount}`,
    `المالك: <@${guild.ownerId}>`,
    `القنوات النصية: ${textChans.join(' | ') || '(ما فيه)'}`,
    `القنوات الصوتية: ${voiceChans.join(' | ') || '(ما فيه)'}`,
    `الرتب: ${roles.join(' | ') || '(ما فيه)'}`,
    'أنظمة السيرفر: بوت تذاكر لفتح تذاكر الدعم، بوت حماية، بوت ترحيب، وأوامر /join و /leave و /status لإدخال البوتات للروم الصوتي.'
  ].join('\n');
}

async function refreshContexts() {
  for (const guild of client.guilds.cache.values()) {
    try { contextCache.set(guild.id, buildContext(guild)); }
    catch (e) { console.warn('[i] فشل بناء سياق السيرفر:', e.message); }
  }
}
setInterval(() => refreshContexts().catch(() => {}), 5 * 60 * 1000).unref();

function systemPrompt(guild) {
  const ctx = guild ? (contextCache.get(guild.id) || buildContext(guild)) : 'ما فيه سيرفر حالياً.';
  return [
    `اسمك الرسمي هو «${BOT_NAME}». إذا سألك أحد «من أنت؟» أو «وش اسمك؟» أو «ما اسمك؟» قل له بالضبط: أنا ${BOT_NAME}.`,
    'أنت مساعد ذكي وودود داخل سيرفر ديسكورد عربي، وترد على أي سؤال في أي مجال.',
    'أجب بنفس لغة السؤال (العربية غالباً)، وباختصار ووضوح وبدون إطالة.',
    'معلومات السيرفر اللي لازم تعرفها:',
    ctx,
    'قواعد:',
    '- إذا سألك أحد عن شراء منتج أو سعر، وجّهه لفتح تذكرة عند فريق الدعم.',
    '- لا تخترع معلومات عن السيرفر؛ إذا ما تعرف شي قل «ما أعرف، اسأل الإدارة».',
    '- كون مهذباً ولا تذكر أنك تستخدم نموذجاً مجانياً.'
  ].join('\n');
}

/* ── ردود فورية (بدون حتى استدعاء الذكاء الاصطناعي) ── */
function quickAnswer(text) {
  const q = String(text || '').trim();
  if (/(من أنت|مين انت|مين أنت|وش اسمك|واسمك|ما اسمك|اسمك|who are you|what.?s your name)/i.test(q)) {
    return `أنا ${BOT_NAME}، مساعد السيرفر الذكي. اسألني أي شي وأرد عليك فوراً.`;
  }
  if (/^(السلام عليكم|وعليكم السلام|مرحبا|مرحباً|هاي|أهلا|اهلا|hi|hello|hey)\b/i.test(q)) {
    return `وعليكم السلام! أنا ${BOT_NAME}، تفضل اسألني أي سؤال.`;
  }
  if (/(شكرا|شكراً|thanx|thanks|thank you)/i.test(q)) {
    return 'العفو! أي شي ثاني أقدر أساعدك فيه؟';
  }
  return null;
}

/* ── مزوّد سريع بلا مفتاح ولا حد انتظار ── */
async function callKilo(system, question) {
  const model = String(process.env.KILO_MODEL || 'openrouter/free').trim();
  const r = await fetch('https://api.kilo.ai/api/gateway/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: question }]
    }),
    signal: AbortSignal.timeout(25000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || j?.message || `HTTP ${r.status}`);
  const out = j.choices?.[0]?.message?.content || '';
  if (!out.trim()) throw new Error('ما جى رد من مزوّد الذكاء');
  return out.trim();
}

/* ── طابور الذكاء الاصطناعي (احترام حد 45 ثانية للخطة المجانية كحل احتياطي) ── */
let lastCall = 0;
let chain = Promise.resolve();

function queueAI(fn) {
  const task = chain.then(async () => {
    const wait = Math.max(0, 46000 - (Date.now() - lastCall));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  chain = task.catch(() => {});
  return task;
}

async function callPollinations(system, question) {
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = 'https://text.pollinations.ai/' + encodeURIComponent(question) + '?system=' + encodeURIComponent(system);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const txt = await r.text();
      if (r.ok && txt.trim()) return txt.trim();
      lastErr = txt.slice(0, 120);
      const m = txt.match(/wait (\d+) seconds/i);
      const wait = m ? Number(m[1]) + 3 : 46;
      await new Promise((res) => setTimeout(res, wait * 1000));
    } catch (e) {
      lastErr = e.message;
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
  throw new Error(lastErr || 'الخدمة غير متاحة');
}

async function callGemini(system, question) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  const model = String(process.env.GEMINI_MODEL || 'gemini-2.0-flash').trim();
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: question }] }]
    }),
    signal: AbortSignal.timeout(60000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  const out = (j.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n');
  if (!out.trim()) throw new Error('ما جى رد من Gemini');
  return out.trim();
}

async function callOpenAI(system, question) {
  const key = String(process.env.OPENAI_API_KEY || '').trim();
  const model = String(process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: question }]
    }),
    signal: AbortSignal.timeout(60000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  const out = j.choices?.[0]?.message?.content || '';
  if (!out.trim()) throw new Error('ما جى رد من OpenAI');
  return out.trim();
}

async function askAI(guild, question) {
  const fast = quickAnswer(question);
  if (fast) return fast;

  const system = systemPrompt(guild);
  if (PROVIDER === 'gemini') {
    try { return await callGemini(system, question); }
    catch { return callKilo(system, question); }
  }
  if (PROVIDER === 'openai') {
    try { return await callOpenAI(system, question); }
    catch { return callKilo(system, question); }
  }
  if (PROVIDER === 'pollinations') return queueAI(() => callPollinations(system, question));

  // الوضع الافتراضي: مزوّد سريع، ولو فشل نرجع للخطة المجانية
  try {
    return await callKilo(system, question);
  } catch (err) {
    console.warn('[i] المزوّد السريع فشل، جرّب الاحتياطي:', err.message);
    try { return await queueAI(() => callPollinations(system, question)); }
    catch (err2) {
      if (process.env.GEMINI_API_KEY) return callGemini(system, question);
      if (process.env.OPENAI_API_KEY) return callOpenAI(system, question);
      throw err2;
    }
  }
}

/* ── نية الشراء ── */
const BUY_RE = /(اشتري|اشترى|شراء|منتج|منتجات|سعر|السعر|كم السعر|ابغى اشتري|ابغاء اشتري|أبغي أشتري|بغيت اشتري|أريد الشراء|buy|purchase|product|products|price|order)/i;

function isPurchaseIntent(text) {
  return BUY_RE.test(String(text || ''));
}

function ticketHint(guild) {
  if (!guild) return '🎫 إذا تبي تشتري منتج، افتح تذكرة عند فريق الدعم.';
  const ch = guild.channels.cache.find(
    (c) => c.isTextBased() && /ticket|تكت|تذاكر|دعم|support/i.test(c.name)
  );
  return ch
    ? `🎫 إذا تبي تشتري منتج، افتح تذكرة في <#${ch.id}> وفريق الدعم بيكمل معاك.`
    : '🎫 إذا تبي تشتري منتج، افتح تذكرة عبر بوت التذاكر الموجود في السيرفر وفريق الدعم بيكمل معاك.';
}

/* ── الأوامر ── */
const askCommand = new SlashCommandBuilder()
  .setName('ask')
  .setDescription('اسأل البوت الذكي أي سؤال')
  .addStringOption((o) => o.setName('question').setDescription('سؤالك').setRequired(true))
  .toJSON();

/* ── أمر النشر: البوت يرسل عنك أي شي لأي روم ── */
const sendCommand = new SlashCommandBuilder()
  .setName('send')
  .setDescription('البوت يرسل رسالتك لأي روم — نصوص وصور ومنشنات وإمbed')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addChannelOption((o) => o.setName('channel').setDescription('الروم اللي بيوصل فيه الشي').setRequired(true)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread))
  .addStringOption((o) => o.setName('message').setDescription('النص اللي تبي البوت يكتبه (اتركه فاضي إذا صور بس)').setRequired(false))
  .addAttachmentOption((o) => o.setName('file1').setDescription('صورة أو ملف أول').setRequired(false))
  .addAttachmentOption((o) => o.setName('file2').setDescription('صورة أو ملف ثاني').setRequired(false))
  .addAttachmentOption((o) => o.setName('file3').setDescription('صورة أو ملف ثالث').setRequired(false))
  .addBooleanOption((o) => o.setName('embed').setDescription('true = إرسال كإمbed منسق، false = رسالة عادية').setRequired(false))
  .addStringOption((o) => o.setName('title').setDescription('عنوان الإمbed').setRequired(false))
  .addStringOption((o) => o.setName('description').setDescription('وصف الإمbed').setRequired(false))
  .addStringOption((o) => o.setName('color').setDescription('لون الإمbed مثال #DC143C').setRequired(false))
  .addStringOption((o) => o.setName('image_url').setDescription('رابط صورة تظهر داخل الإمbed').setRequired(false))
  .addStringOption((o) => o.setName('footer').setDescription('نص سفلي للإمbed').setRequired(false))
  .addBooleanOption((o) => o.setName('everyone').setDescription('true = منشن @everyone').setRequired(false))
  .addBooleanOption((o) => o.setName('here').setDescription('true = منشن @here').setRequired(false))
  .addRoleOption((o) => o.setName('role').setDescription('رتبة تبيها تمنشن مع الرسالة').setRequired(false))
  .addUserOption((o) => o.setName('user').setDescription('شخص تبيه يمنشن مع الرسالة').setRequired(false))
  .addStringOption((o) => o.setName('button_label').setDescription('نص زر رابط يظهر تحت الرسالة').setRequired(false))
  .addStringOption((o) => o.setName('button_url').setDescription('رابط الزر (لازم يبدأ https://)').setRequired(false))
  .toJSON();

/* ── أمر لوحة نسخ السيرفر ── */
const clonePanelCommand = new SlashCommandBuilder()
  .setName('clone-panel')
  .setDescription('الأدمن يرسل لوحة نسخ السيرفر للروم اللي يختاره')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addChannelOption((o) => o.setName('channel').setDescription('الروم اللي بتنزل فيه اللوحة').setRequired(true)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
  .toJSON();

function parseColor(input) {
  if (!input) return undefined;
  const s = String(input).trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(s) ? parseInt(s, 16) : undefined;
}

async function handleSend(interaction) {
  const member = interaction.member;
  const allowed = member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has?.(PermissionFlagsBits.ManageMessages) ||
    interaction.user.id === interaction.guild?.ownerId;
  if (!allowed) {
    return interaction.reply({ content: '❌ هذا الأمر للأدمن فقط.', flags: 64 });
  }

  const channel = interaction.options.getChannel('channel', true);
  if (!channel?.isTextBased()) {
    return interaction.reply({ content: '❌ الروم المحدد ما ينقبل فيه إرسال.', flags: 64 });
  }

  const text = interaction.options.getString('message') || '';
  const role = interaction.options.getRole('role');
  const user = interaction.options.getUser('user');
  const everyone = interaction.options.getBoolean('everyone');
  const here = interaction.options.getBoolean('here');
  const asEmbed = interaction.options.getBoolean('embed');

  let content = text;
  if (everyone) content += (content ? '\n' : '') + '@everyone';
  if (here) content += (content ? '\n' : '') + '@here';
  if (role) content += (content ? '\n' : '') + `<@&${role.id}>`;
  if (user) content += (content ? '\n' : '') + `<@${user.id}>`;

  const files = [];
  for (const key of ['file1', 'file2', 'file3']) {
    const att = interaction.options.getAttachment(key);
    if (att) files.push(att.url);
  }

  const payload = {
    allowedMentions: { parse: ['users', 'roles', 'everyone'] }
  };
  if (content.trim()) payload.content = content.slice(0, 1900);
  if (files.length) payload.files = files;

  const title = interaction.options.getString('title');
  const description = interaction.options.getString('description');
  const imageUrl = interaction.options.getString('image_url');
  const footer = interaction.options.getString('footer');
  if (asEmbed || title || description || imageUrl || footer) {
    const embed = new EmbedBuilder()
      .setColor(parseColor(interaction.options.getString('color')) || 0xDC143C)
      .setTimestamp();
    if (title) embed.setTitle(title.slice(0, 256));
    if (description) embed.setDescription(description.slice(0, 4000));
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) embed.setImage(imageUrl);
    if (footer) embed.setFooter({ text: footer.slice(0, 2048) });
    payload.embeds = [embed];
  }

  const label = interaction.options.getString('button_label');
  const url = interaction.options.getString('button_url');
  if (label && url && /^https?:\/\//i.test(url)) {
    payload.components = [
      new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(label.slice(0, 80)).setStyle(ButtonStyle.Link).setURL(url))
    ];
  }

  try {
    const sent = await channel.send(payload);
    return interaction.reply({
      content: `✅ أرسلت الرسالة في <#${channel.id}> — [افتحها](https://discord.com/channels/${interaction.guild.id}/${channel.id}/${sent.id})`,
      flags: 64
    });
  } catch (err) {
    console.error('[!] فشل النشر:', err.message);
    return interaction.reply({ content: '❌ ما قدرت أرسل — تأكد إن البوت عنده صلاحية إرسال وقراءة في الروم: ' + err.message, flags: 64 });
  }
}

/* ── نسخ السيرفر بحساب العضو ── */
const DISCORD_API = 'https://discord.com/api/v10';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// منع السبام: طلب نسخ واحد كل 10 دقائق لكل عضو في كل سيرفر
const CLONE_COOLDOWN_MS = 10 * 60 * 1000;
const cloneCooldown = new Map();
const cloneKey = (interaction) => `${interaction.guildId || 'dm'}:${interaction.user.id}`;
function cloneCooldownLeft(interaction) {
  return Math.max(0, (cloneCooldown.get(cloneKey(interaction)) || 0) - Date.now());
}
function cloneCooldownText(ms) {
  const mins = Math.ceil(ms / 60000);
  return `⏳ تقدر تسوي طلب نسخ جديد بعد ${mins} ${mins === 1 ? 'دقيقة' : 'دقائق'}.`;
}

const CLONE_GUILD_ID = '1546676470053601462';
const CLONE_ICON_FALLBACK = 'https://cdn.discordapp.com/icons/1546676470053601462/9bdd03dc3f3342e49034dcf3ebe693ce.png?size=256';

async function clonePanelMessage() {
  const guild = client.guilds.cache.get(CLONE_GUILD_ID);
  const iconUrl = guild?.iconURL({ size: 256 }) || CLONE_ICON_FALLBACK;
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('نسخ 971i SERVER')
    .setDescription(
      'تَستَخدم الاداه لنسخ أي سيرفر دسكورد تريده\n' +
      'قم بضغط الزر ادناه وقم بوضع توكن حسابك و ايدي السيرفر التي تريد نسخه وايدي السيرفر الخاص بك !'
    )
    .setThumbnail(iconUrl)
    .setFooter({ text: '971i' });
  // لو حطيت رابط الصورة/KFD الكامل هنا أو في المتغير البيئي، بينزل كصورة داخل الكرت
  const panelImage = String(process.env.CLONE_PANEL_IMAGE_URL || '').trim();
  if (/^https:\/\//i.test(panelImage)) embed.setImage(panelImage);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('clone_open').setEmoji('<:copy971:1575640315526778972>').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('clone_help').setEmoji('<:question971:1575640317334392942>').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

function cloneHelpMessage() {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('❓ طريقة استخدام نسخ السيرفر')
    .setDescription(
      '1) حط توكن حسابك في خانة **Account Token**.\n' +
      '2) في **Server ID To Copy** حط آيدي السيرفر المصدر.\n' +
      '3) في **Server ID To Paste** حط آيدي السيرفر الهدف.\n' +
      '4) في **Clone Emojis & Stickers?** اكتب `نعم` إذا تبي الإيموجيات والملصقات، أو اتركها فاضية للنسخ السريع.\n\n' +
      '🔹 الآيدي = الرقم الطويل للسيرفر (من رابط الدعوة أو إعدادات السيرفر).\n' +
      '🔹 لازم تكون داخل السيرفرين، وما تحتاج أي رتبة عند هذا البوت.\n' +
      '🔹 التوكن ما ينحفظ ولا يظهر لأحد — يستعمل بس وقت النسخ.\n' +
      '🔹 بين كل طلب وثاني 10 دقائق (ما يمدي تسوي سبام).\n' +
      '🔹 إذا ما عندك صلاحية إنشاء رومات/رتب في الهدف، بينظهر لك تنبيه باللي ما اننسخ.'
    )
    .setFooter({ text: BOT_NAME });
  return { embeds: [embed], flags: 64 };
}

function cloneModal() {
  const input = (customId, label, placeholder) =>
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(placeholder)
      .setRequired(customId !== 'clone_es');
  return new ModalBuilder()
    .setCustomId('clone_modal')
    .setTitle('نسخ السيرفر')
    .addComponents(
      new ActionRowBuilder().addComponents(input('clone_token', 'Account Token', 'حط توكن حسابك')),
      new ActionRowBuilder().addComponents(input('clone_src', 'Server ID To Copy', 'مثال: 1546676470053601462')),
      new ActionRowBuilder().addComponents(input('clone_dst', 'Server ID To Paste', 'مثال: 123456789012345678')),
      new ActionRowBuilder().addComponents(input('clone_es', 'Clone Emojis & Stickers? (نعم/لا)', 'نعم أو فاضي للنسخ السريع'))
    );
}

async function authModeFor(token) {
  for (const mode of ['user', 'bot']) {
    try {
      const auth = mode === 'bot' ? `Bot ${token}` : token;
      const r = await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: auth } });
      if (r.ok) return { mode, auth, me: await r.json() };
    } catch { /* جرّب النوع الثاني */ }
  }
  throw new Error('التوكن غير صحيح أو منتهي');
}

async function apiCall(auth, method, path, payload, rawBody) {
  const headers = { Authorization: auth };
  let body;
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  } else if (rawBody !== undefined) {
    body = rawBody;
  }
  const r = await fetch(DISCORD_API + path, { method, headers, body });
  const txt = await r.text();
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = JSON.parse(txt);
      msg = j.message || JSON.stringify(j.errors || j) || msg;
    } catch { msg = txt.slice(0, 180) || msg; }
    const err = new Error(String(msg).slice(0, 220));
    err.status = r.status;
    throw err;
  }
  if (r.status === 204 || !txt) return null;
  try { return JSON.parse(txt); } catch { return txt; }
}

async function cloneServer(token, srcId, dstId, copyExtras) {
  const { auth, me } = await authModeFor(token);
  const note = [];

  const guilds = await apiCall(auth, 'GET', '/users/@me/guilds');
  const ids = new Set((guilds || []).map((g) => g.id));
  if (!ids.has(srcId)) throw new Error('لازم تكون داخل السيرفر المصدر (Server ID To Copy).');
  if (!ids.has(dstId)) throw new Error('لازم تكون داخل السيرفر الهدف (Server ID To Paste).');

  const result = { roles: 0, categories: 0, channels: 0, emojis: 0, stickers: 0, errors: note, me: me.username };

  // الرتب أولاً عشان نربطها بالإيموجيات
  let roleMap = new Map();
  try {
    const roles = await apiCall(auth, 'GET', `/guilds/${srcId}/roles`);
    for (const r of roles || []) {
      if (r.name === '@everyone' || r.managed) continue;
      try {
        const made = await apiCall(auth, 'POST', `/guilds/${dstId}/roles`, {
          name: r.name, color: r.color, hoist: !!r.hoist,
          mentionable: !!r.mentionable, permissions: String(r.permissions)
        });
        roleMap.set(r.id, made.id);
        result.roles++;
        await sleep(120);
      } catch (e) { note.push(`رتبة ${r.name}: ${e.message}`); }
    }
  } catch (e) { note.push(`الرتب: ${e.message}`); }

  // الكاتاغوريات قبل الرومات
  let catMap = new Map();
  try {
    const chans = await apiCall(auth, 'GET', `/guilds/${srcId}/channels`);
    for (const c of chans || []) {
      if (c.type !== 4) continue;
      try {
        const made = await apiCall(auth, 'POST', `/guilds/${dstId}/channels`, {
          name: c.name, type: 4, position: c.position || 0
        });
        catMap.set(c.id, made.id);
        result.categories++;
        await sleep(120);
      } catch (e) { note.push(`كاتاغوري ${c.name}: ${e.message}`); }
    }
    for (const c of chans || []) {
      if (c.type === 4 || [11, 12].includes(c.type)) continue; // الرومات الفرعية/الثريدز ما تننسخ مباشرة
      const payload = { name: c.name, type: c.type, position: c.position || 0 };
      if (c.parent_id && catMap.has(c.parent_id)) payload.parent_id = catMap.get(c.parent_id);
      if ([0, 5, 15].includes(c.type)) {
        if (c.topic) payload.topic = String(c.topic).slice(0, 4096);
        if (c.nsfw) payload.nsfw = true;
        if (c.rate_limit_per_user) payload.rate_limit_per_user = c.rate_limit_per_user;
      }
      if ([2, 13].includes(c.type)) {
        if (c.bitrate) payload.bitrate = c.bitrate;
        if (c.user_limit !== undefined) payload.user_limit = c.user_limit;
      }
      try {
        await apiCall(auth, 'POST', `/guilds/${dstId}/channels`, payload);
        result.channels++;
        await sleep(120);
      } catch (e) { note.push(`روم ${c.name}: ${e.message}`); }
    }
  } catch (e) { note.push(`الرومات: ${e.message}`); }

  if (copyExtras) {
    try {
      const emojis = await apiCall(auth, 'GET', `/guilds/${srcId}/emojis`);
      for (const em of emojis || []) {
        try {
          const url = `https://cdn.discordapp.com/emojis/${em.id}.${em.animated ? 'gif' : 'png'}?size=128`;
          const img = await fetch(url);
          if (!img.ok) throw new Error('ما جيت صورة الإيموجي');
          const buf = Buffer.from(await img.arrayBuffer());
          const mime = em.animated ? 'image/gif' : 'image/png';
          const roles = (em.roles || []).map((r) => roleMap.get(r)).filter(Boolean);
          await apiCall(auth, 'POST', `/guilds/${dstId}/emojis`, {
            name: em.name,
            image: `data:${mime};base64,${buf.toString('base64')}`,
            roles
          });
          result.emojis++;
          await sleep(120);
        } catch (e) { note.push(`إيموجي ${em.name || em.id}: ${e.message}`); }
      }
    } catch (e) { note.push(`الإيموجيات: ${e.message}`); }

    try {
      const stickers = await apiCall(auth, 'GET', `/guilds/${srcId}/stickers`);
      for (const st of stickers || []) {
        try {
          const ext = st.format === 3 ? 'gif' : st.format === 4 ? 'json' : 'png';
          const mime = st.format === 3 ? 'image/gif' : st.format === 4 ? 'application/json' : 'image/png';
          const url = `https://cdn.discordapp.com/stickers/${st.id}.${ext}`;
          const img = await fetch(url);
          if (!img.ok) throw new Error('ما جيت صورة الملصق');
          const buf = Buffer.from(await img.arrayBuffer());
          const fd = new FormData();
          fd.append('name', st.name);
          fd.append('description', st.description || '');
          fd.append('tags', st.tags || '');
          fd.append('file', new Blob([buf], { type: mime }), `sticker.${ext}`);
          await apiCall(auth, 'POST', `/guilds/${dstId}/stickers`, undefined, fd);
          result.stickers++;
          await sleep(120);
        } catch (e) { note.push(`ملصق ${st.name || st.id}: ${e.message}`); }
      }
    } catch (e) { note.push(`الملصقات: ${e.message}`); }
  }

  return result;
}

async function registerCommands() {
  if (!client.user) return;
  const all = [...voice.commands(), askCommand, sendCommand, clonePanelCommand];
  try {
    await client.application.commands.set(all);
    console.log('[✓] تم تسجيل أوامر /ask و /send و /clone-panel و /join و /leave و /status عالمياً');
    for (const g of client.guilds.cache.values()) {
      await g.commands.set(all).catch(() => {});
    }
    console.log('[✓] الأوامر جاهزة في كل السيرفرات');
  } catch (e) {
    console.error('[!] فشل تسجيل الأوامر:', e.message);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[✓] مسجّل دخول كـ ${c.user.tag}`);
  console.log(`[i] السيرفرات: ${c.guilds.cache.size}`);
  for (const g of c.guilds.cache.values()) console.log(`   - ${g.name} (${g.id})`);
  console.log(`[i] مزوّد الذكاء: ${PROVIDER}`);
  if (c.user.username !== BOT_NAME) {
    await c.user.setUsername(BOT_NAME).catch((e) => console.warn('[i] ما قدرت أغيّر الاسم:', e.message));
  }

  await voice.restore();
  await refreshContexts();

  // لا نرد على البوستات القديمة — بس الجديدة من بعد التشغيل
  try {
    const ch = await c.channels.fetch(BOOST_CHANNEL_ID);
    if (ch?.isTextBased()) {
      const old = await ch.messages.fetch({ limit: 50 });
      for (const m of old.values()) rememberBoost(m.id);
    }
    console.log('[✓] روم البوست جاهز: ' + BOOST_CHANNEL_ID);
  } catch (e) {
    console.warn('[i] ما قدرت أقرأ روم البوست:', e.message);
  }
  setInterval(() => pollBoosts().catch(() => {}), 10000).unref();

  registerCommands();
});

/* ── شكر تلقائي على البوست (Server Boost) ──
   ديسكورد أحياناً ما يرسل رسائل البوست للـ gateway، ففي فحص احتياطي بالـ REST كل 10 ثواني */
const BOOST_CHANNEL_ID = '1573251981881905343';
const BOOST_MESSAGE_TYPES = new Set([8, 9, 10, 11]); // UserPremiumGuildSubscription (+Tier1..3)
const boostSeen = new Set();

function rememberBoost(id) {
  boostSeen.add(id);
  if (boostSeen.size > 600) boostSeen.delete(boostSeen.values().next().value);
}

async function sendBoostThanks(msg) {
  if (!msg) return;
  if (!BOOST_MESSAGE_TYPES.has(Number(msg.type || 0))) return;
  if (boostSeen.has(msg.id)) return;
  rememberBoost(msg.id);
  const boosterId = msg.author?.id || msg.authorId;
  if (!boosterId || msg.author?.bot) return;
  try {
    // ديسكورد يمنع الرد على رسائل البوست (نظام)، فنرسل رسالة جديدة تحتها مباشرة
    const ch = msg.channel?.isTextBased?.()
      ? msg.channel
      : await client.channels.fetch(BOOST_CHANNEL_ID);
    if (!ch?.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setDescription(`شكرا على البوست ي عسل <@${boosterId}> 💙`)
      .setFooter({ text: BOT_NAME })
      .setTimestamp();
    await ch.send({
      embeds: [embed],
      allowedMentions: { parse: [] }
    });
    console.log(`[✓] شكر على البوست: ${boosterId}`);
  } catch (e) {
    console.warn('[i] ما قدرت أرسل شكر البوست:', e.message);
  }
}

client.on(Events.MessageCreate, (message) => {
  if (!message.guild || message.channelId !== BOOST_CHANNEL_ID) return;
  sendBoostThanks(message).catch(() => {});
});

async function pollBoosts() {
  try {
    const ch = await client.channels.fetch(BOOST_CHANNEL_ID);
    if (!ch?.isTextBased()) return;
    const recent = await ch.messages.fetch({ limit: 25 });
    for (const m of recent.values()) await sendBoostThanks(m);
  } catch (e) {
    console.warn('[i] فحص البوستات: ' + e.message);
  }
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const isDM = !message.guild;
  const mentioned = message.mentions.users.has(client.user.id);
  const repliedToBot = message.reference?.messageAuthorId === client.user.id;
  let question = String(message.content || '').replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
  const buy = isPurchaseIntent(question);
  const nameQuestion = /(من أنت|مين انت|مين أنت|وش اسمك|واسمك|ما اسمك|اسمك|who are you|what.?s your name)/i.test(question);

  if (!isDM && !mentioned && !repliedToBot && !buy && !nameQuestion) return;
  if (!question) question = 'مرحباً، كيف أقدر أساعدك؟';

  try {
    await message.channel.sendTyping().catch(() => {});
    let answer;
    try {
      answer = await askAI(message.guild, question);
    } catch (e) {
      console.warn('[i] فشل الذكاء الاصطناعي:', e.message);
      answer = buy
        ? 'عذراً، ما قدرت أجيب إجابة الحين.'
        : 'عذراً، ما قدرت أجيب إجابة الحين بسبب ضغط على خدمة الذكاء الاصطناعي. جرّب بعد شوي.';
    }

    const full = buy ? `${ticketHint(message.guild)}\n\n${answer}` : answer;
    await message.reply({
      content: full.slice(0, 1900),
      allowedMentions: { parse: [] }
    });
  } catch (e) {
    console.error('[!] خطأ في الرد:', e.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (await voice.handle(interaction)) return;

    if (interaction.isChatInputCommand() && interaction.commandName === 'clone-panel') {
      const member = interaction.member;
      const allowed = member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
        interaction.user.id === interaction.guild?.ownerId;
      if (!allowed) return interaction.reply({ content: '❌ هذا الأمر للأدمن فقط.', flags: 64 });
      const channel = interaction.options.getChannel('channel', true);
      if (!channel?.isTextBased()) {
        return interaction.reply({ content: '❌ الروم المحدد ما ينقبل فيه إرسال.', flags: 64 });
      }
      try {
        const sent = await channel.send(await clonePanelMessage());
        return interaction.reply({
          content: `✅ انزلت لوحة النسخ في <#${channel.id}> — [افتحها](https://discord.com/channels/${interaction.guild.id}/${channel.id}/${sent.id})`,
          flags: 64
        });
      } catch (e) {
        return interaction.reply({ content: '❌ ما قدرت أرسل اللوحة: ' + e.message, flags: 64 });
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'clone_open') {
        const left = cloneCooldownLeft(interaction);
        if (left > 0) return interaction.reply({ content: cloneCooldownText(left), flags: 64 });
        return interaction.showModal(cloneModal());
      }
      if (interaction.customId === 'clone_help') return interaction.reply(cloneHelpMessage());
    }

    if (interaction.isModalSubmit() && interaction.customId === 'clone_modal') {
      const left = cloneCooldownLeft(interaction);
      if (left > 0) return interaction.reply({ content: cloneCooldownText(left), flags: 64 });
      // نحجز الوقت من بداية الطلب عشان ما يقدر يرسل طلبين بنفس اللحظة
      cloneCooldown.set(cloneKey(interaction), Date.now() + CLONE_COOLDOWN_MS);
      await interaction.deferReply({ flags: 64 });
      const token = interaction.fields.getTextInputValue('clone_token').trim();
      const srcId = interaction.fields.getTextInputValue('clone_src').trim();
      const dstId = interaction.fields.getTextInputValue('clone_dst').trim();
      const es = interaction.fields.getTextInputValue('clone_es').trim();
      const copyExtras = /^(نعم|yes|y|1|true)$/i.test(es);

      if (!/^\d{15,25}$/.test(srcId) || !/^\d{15,25}$/.test(dstId)) {
        return interaction.editReply({ content: '❌ الآيدي لازم يكون رقم طويل (15-25 رقم).' });
      }
      if (srcId === dstId) {
        return interaction.editReply({ content: '❌ السيرفر المصدر والهدف لازم يكونون مختلفين.' });
      }

      await interaction.editReply({ content: '⏳ جاري النسخ... انتظر شوي.' });
      try {
        const res = await cloneServer(token, srcId, dstId, copyExtras);
        const embed = new EmbedBuilder()
          .setColor(res.errors.length ? 0xffaa00 : 0x23a55a)
          .setTitle(res.errors.length ? 'تم النسخ مع بعض التنبيهات' : 'تم النسخ بنجاح')
          .setDescription([
            `الحساب: ${res.me}`,
            `📁 كاتاغوريات: ${res.categories}`,
            `💬 رومات: ${res.channels}`,
            `🎭 رتب: ${res.roles}`,
            `😀 إيموجيات: ${res.emojis}`,
            `🏷️ ملصقات: ${res.stickers}`,
            '',
            res.errors.length ? '⚠️ التنبيهات:\n• ' + res.errors.slice(0, 8).join('\n• ') : 'كل شي اننسخ بدون أخطاء.'
          ].join('\n'))
          .setFooter({ text: BOT_NAME })
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) {
        return interaction.editReply({ content: '❌ فشل النسخ: ' + e.message });
      }
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'send') return handleSend(interaction);
    if (interaction.commandName === 'ask') {
      const q = interaction.options.getString('question', true);
      await interaction.deferReply();
      let answer;
      try { answer = await askAI(interaction.guild, q); }
      catch (e) { answer = 'عذراً، ما قدرت أجيب إجابة الحين: ' + e.message; }
      const hint = isPurchaseIntent(q) ? `${ticketHint(interaction.guild)}\n\n` : '';
      await interaction.editReply({ content: (hint + answer).slice(0, 1900) });
    }
  } catch (e) {
    console.error('[!] خطأ في التفاعل:', e.message);
    const payload = { content: '❌ صار خطأ.', flags: 64 };
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch { /* ignore */ }
  }
});

client.on(Events.Error, (err) => console.error('[!] خطأ في الاتصال:', err.message));

process.on('SIGTERM', () => {
  console.log('[i] SIGTERM — إغلاق آمن...');
  client.destroy();
  process.exit(0);
});

if (!TOKEN) {
  console.error('[!] DISCORD_TOKEN غير مضبوط');
} else {
  client.login(TOKEN).catch((err) => console.error('[!] فشل تسجيل الدخول:', err.message));
}
