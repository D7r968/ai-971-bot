'use strict';

const path = require('path');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require('discord.js');
const attachVoice = require('./voice');

const TOKEN = String(process.env.DISCORD_TOKEN || '').trim();
const PROVIDER = String(process.env.AI_PROVIDER || '').toLowerCase() ||
  (process.env.GEMINI_API_KEY ? 'gemini' : process.env.OPENAI_API_KEY ? 'openai' : 'pollinations');

/* ── خادم الصحة (self-ping 24/7) ── */
const app = express();
app.get('/', (_req, res) => res.json({ status: 'ok', bot: '971 AI' }));
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
    'أنت «971 AI»، مساعد ذكي وودود داخل سيرفر ديسكورد عربي.',
    'أجب بنفس لغة السؤال (العربية غالباً)، وباختصار ووضوح وبدون إطالة.',
    'معلومات السيرفر اللي لازم تعرفها:',
    ctx,
    'قواعد:',
    '- إذا سألك أحد عن شراء منتج أو سعر، وجّهه لفتح تذكرة عند فريق الدعم.',
    '- لا تخترع معلومات عن السيرفر؛ إذا ما تعرف شي قل «ما أعرف، اسأل الإدارة».',
    '- كون مهذباً ولا تذكر أنك تستخدم نموذجاً مجانياً.'
  ].join('\n');
}

/* ── طابور الذكاء الاصطناعي (احترام حد 45 ثانية للخطة المجانية) ── */
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
  const system = systemPrompt(guild);
  if (PROVIDER === 'gemini') return callGemini(system, question);
  if (PROVIDER === 'openai') return callOpenAI(system, question);
  return queueAI(() => callPollinations(system, question));
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

async function registerCommands() {
  if (!client.user) return;
  const all = [...voice.commands(), askCommand];
  try {
    await client.application.commands.set(all);
    console.log('[✓] تم تسجيل أوامر /ask و /join و /leave و /status عالمياً');
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

  await voice.restore();
  await refreshContexts();
  registerCommands();
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const isDM = !message.guild;
  const mentioned = message.mentions.users.has(client.user.id);
  let question = String(message.content || '').replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
  const buy = isPurchaseIntent(question);

  if (!isDM && !mentioned && !buy) return;
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
