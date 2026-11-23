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
  ChannelType
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

async function registerCommands() {
  if (!client.user) return;
  const all = [...voice.commands(), askCommand, sendCommand];
  try {
    await client.application.commands.set(all);
    console.log('[✓] تم تسجيل أوامر /ask و /send و /join و /leave و /status عالمياً');
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
  registerCommands();
});

/* ── شكر تلقائي على البوست (Server Boost) ── */
const BOOST_CHANNEL_ID = '1573251981881905343';
const BOOST_MESSAGE_TYPES = new Set([8, 9, 10, 11]); // UserPremiumGuildSubscription (+Tier1..3)

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.channel.id !== BOOST_CHANNEL_ID) return;
  if (!BOOST_MESSAGE_TYPES.has(message.type)) return;
  const booster = message.author;
  if (!booster || booster.bot) return;
  try {
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setDescription(`شكرا على البوست ي عسل <@${booster.id}> 💙`)
      .setFooter({ text: BOT_NAME })
      .setTimestamp();
    await message.reply({
      embeds: [embed],
      allowedMentions: { parse: [], repliedUser: false },
      failIfNotExists: false
    });
    console.log(`[✓] شكر على البوست: ${booster.tag}`);
  } catch (e) {
    console.warn('[i] ما قدرت أرد على البوست:', e.message);
  }
});

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
