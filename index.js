require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ChannelType, PermissionFlagsBits, MessageFlags, SlashCommandBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

// =====================================================================
//  บอทแยก: คำสั่ง /ticket + /serverpobox (คัดลอกมาจากไฟล์เดิม)
//  มีเฉพาะระบบ Embed + ปุ่ม Create ticket + ห้อง Ticket (สนทนา / นับถอยหลัง / ปิดห้อง)
//  ไม่มี /setbox /setgame /setrole (ย้าย /setserver มาเป็น /serverpobox อยู่คู่กับ /ticket)
//  ⚠️ ต้องใช้ Token ของบอท "ตัวใหม่" (สร้างแอปใหม่ใน Developer Portal)
//     ห้ามใช้ Token เดียวกับบอทเดิม ไม่เช่นนั้นสองไฟล์จะเขียนทับคำสั่งของกันและกัน
// =====================================================================


process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

// ---------- Keep Alive (กันบอทหลับ) ----------
// เว็บเล็กๆ ให้ตัวบอทเองและ UptimeRobot เรียก เพื่อไม่ให้โฮสต์ฟรีหลับ
const app = express();
app.get('/', (req, res) => res.send('Ticket bot is alive!'));
app.get('/health', (req, res) => res.json({ ok: true, discordReady: client.isReady(), uptimeSec: Math.round(process.uptime()) }));
app.listen(process.env.PORT || 3000, () => console.log('🌐 Web server is running'));

// ปลุกตัวเองทุก 5 นาที (ปรับได้ที่ KEEP_ALIVE_MINUTES)
// URL: Render ตั้ง RENDER_EXTERNAL_URL ให้อัตโนมัติ / ที่อื่นให้ตั้ง KEEP_ALIVE_URL เป็น URL ของบอทเอง
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
const KEEP_ALIVE_MIN = Number(process.env.KEEP_ALIVE_MINUTES) || 5;
if (KEEP_ALIVE_URL) {
  setInterval(async () => {
    try {
      const res = await fetch(KEEP_ALIVE_URL);
      console.log(`💓 keep-alive ping: ${res.status}`);
    } catch (e) {
      console.error('keep-alive ping ล้มเหลว:', e.message);
    }
  }, KEEP_ALIVE_MIN * 60 * 1000);
  console.log(`💓 keep-alive เปิดอยู่ → ${KEEP_ALIVE_URL} (ทุก ${KEEP_ALIVE_MIN} นาที)`);
} else {
  console.log('⚠️ ไม่พบ RENDER_EXTERNAL_URL / KEEP_ALIVE_URL จึงไม่เปิด keep-alive ในตัวบอท (ตั้ง KEEP_ALIVE_URL หรือใช้ UptimeRobot)');
}

// ---------- Config ----------
// เวลาสนทนาหลังทีมงานกด "สนทนา" (ค่าเริ่มต้น 30 นาที) ปรับเองได้ที่ TICKET_MINUTES
const TICKET_LIFETIME = (Number(process.env.TICKET_MINUTES ?? 30) || 30) * 60 * 1000;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || '';
const CATEGORY_ID = process.env.CATEGORY_ID || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
// ห้อง Ticket ที่ยังไม่มีทีมงานกด "สนทนา" จะ "ไม่จับเวลา" และไม่ถูกลบอัตโนมัติ (ต้องกด Close ticket เอง)
// เวลา TICKET_MINUTES (ค่าเริ่มต้น 30 นาที) จะเริ่มนับเฉพาะตอนทีมงานกดปุ่ม "สนทนา" เท่านั้น
console.log(`⏱️ เวลา Ticket: เริ่มนับ ${TICKET_LIFETIME / 60000} นาที เฉพาะหลังทีมงานกดสนทนา (ห้องที่ยังไม่มีใครกดจะไม่ถูกลบ)`);
// กวาดลบห้อง ticket-#### ที่บอทไม่ได้ติดตามแล้ว (เช่นข้อมูลหายตอน Render รีสตาร์ท)
// ค่าเริ่มต้น "ปิด" เพื่อไม่ให้ลบห้องที่ยังรอทีมงานอยู่ เปิดได้ด้วย CLEANUP_ORPHANS=true
const CLEANUP_ORPHANS = String(process.env.CLEANUP_ORPHANS ?? 'false').toLowerCase() === 'true';
const DEFAULT_WAIT_MSG = 'รอแอดมินตอบกลับสักครู่...';
const DEFAULT_CHAT_MSG = 'กรุณาอธิบายปัญหาของคุณได้เลย';
// ปุ่มตอบด่วนของทีมงาน (ใช้เมื่อ Embed นั้นยังไม่ได้ตั้งข้อความเอง)
const DEFAULT_QUICK = ['มีอะไรให้ช่วยครับ', 'สอบถามปัญหาอะไรครับ', 'รอสักครู่นะครับ', 'ขอบคุณที่ติดต่อครับ'];
const COUNTDOWN_TICK_MS = 2 * 1000; // อัปเดตเวลานับถอยหลังในห้อง Ticket ทุก 2 วินาที (ถ้า Discord หน่วง ให้เพิ่มเป็น 3-5 วินาที)

// ---------- เก็บข้อมูล ----------
// ถ้าตั้ง MONGODB_URI → เก็บถาวรใน MongoDB (Embed ที่สร้างไว้ไม่หายตอน deploy ใหม่)
// ถ้าไม่ตั้ง → เก็บใน data.json (บน Render ฟรีจะหายเมื่อ deploy/รีสตาร์ท)
// ใช้ชื่อไฟล์/เอกสารคนละชื่อกับบอทเดิม กันข้อมูลชนกันถ้าใช้ MongoDB ก้อนเดียวกัน
const DATA_FILE = path.join(__dirname, 'ticket-data.json');
const MONGO_DOC = process.env.MONGODB_DOC || 'ticket-cmd';
let data = { counters: {}, tickets: {}, embeds: {}, servers: {} };
let mongoCol = null;
let saveTimer = null;

async function loadData() {
  if (MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const mc = new MongoClient(MONGODB_URI);
    await mc.connect();
    mongoCol = mc.db(process.env.MONGODB_DB || 'ticketbot').collection('botdata');
    const doc = await mongoCol.findOne({ _id: MONGO_DOC });
    if (doc && doc.data) data = doc.data;
    console.log('🗄️ เชื่อมต่อ MongoDB สำเร็จ (ข้อมูลเก็บถาวร)');
  } else {
    try {
      if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.error('อ่าน data.json ไม่สำเร็จ เริ่มใหม่:', e);
    }
    console.log('⚠️ ไม่ได้ตั้ง MONGODB_URI → ข้อมูลจะหายเมื่อ Render deploy/รีสตาร์ท');
  }
  data.counters ||= {};
  data.tickets ||= {};
  data.embeds ||= {};
  data.servers ||= {};
}

const writeMongo = () =>
  mongoCol.replaceOne({ _id: MONGO_DOC }, { _id: MONGO_DOC, data }, { upsert: true })
    .catch((e) => console.error('บันทึก MongoDB ไม่สำเร็จ:', e.message));

function save() {
  if (mongoCol) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeMongo, 500);
  } else {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.error('บันทึก data.json ไม่สำเร็จ:', e); }
  }
}

// Render ส่ง SIGTERM ตอน deploy → บันทึกให้เสร็จก่อนปิด
process.on('SIGTERM', async () => {
  if (mongoCol) { clearTimeout(saveTimer); await writeMongo(); }
  process.exit(0);
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.on('error', (e) => console.error('client error:', e));

// ---------- helpers ----------
const isUrl = (u) => /^https?:\/\/\S+$/i.test(u || '');
const isHex = (c) => /^#?[0-9a-f]{6}$/i.test(c || '');
const norm = (s) => String(s || '').trim().toLowerCase();
const bad = (i, text) => i.reply({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral });
const isAdmin = (i) => i.memberPermissions?.has(PermissionFlagsBits.Administrator);
// สีปุ่ม: Discord มีให้เลือกแค่ 4 สี (น้ำเงิน / เทา / เขียว / แดง) ใช้ HEX ไม่ได้
const BTN_STYLES = {
  primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success, danger: ButtonStyle.Danger,
};
const BTN_NAMES = { primary: 'น้ำเงิน', secondary: 'เทา', success: 'เขียว', danger: 'แดง' };
const BTN_ALIASES = {
  'น้ำเงิน': 'primary', blue: 'primary', primary: 'primary',
  'เทา': 'secondary', grey: 'secondary', gray: 'secondary', secondary: 'secondary',
  'เขียว': 'success', green: 'success', success: 'success',
  'แดง': 'danger', red: 'danger', danger: 'danger',
};
const parseBtnColor = (v) => {
  if (!v) return null;
  const k = BTN_ALIASES[norm(v)];
  if (!k) throw new Error(`สีปุ่ม "${v}" ใช้ไม่ได้ ต้องเป็น น้ำเงิน / เทา / เขียว / แดง (Discord มีให้แค่ 4 สีนี้)`);
  return k;
};
const btnStyle = (name, fallback) => BTN_STYLES[name] ?? fallback;
const guildEmbeds = (gid) => (data.embeds[gid] ||= []);
const findEmbed = (gid, name) => guildEmbeds(gid).find((e) => norm(e.name) === norm(name));

// ---------- Slash command: /ticket ----------
const nameOpt = (o, auto, desc) => o.setName('name').setDescription(desc || 'ชื่อ Embed')
  .setRequired(true).setMaxLength(50).setAutocomplete(auto);

const ticketCmd = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('ระบบ Ticket: สร้างและจัดการ Embed พร้อมปุ่ม Create ticket')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(s => s.setName('create')
    .setDescription('สร้าง Embed ใหม่ตั้งชื่อ (ห้ามซ้ำ) แล้วแก้ไขด้วยปุ่มใต้ตัวอย่าง')
    .addStringOption(o => nameOpt(o, false, 'ตั้งชื่อ Embed (ห้ามซ้ำกับที่มีอยู่)')))
  .addSubcommand(s => s.setName('edit')
    .setDescription('เปิดกล่องตัวอย่าง + ปุ่มแก้ไข ของ Embed ที่สร้างไว้')
    .addStringOption(o => nameOpt(o, true)))
  .addSubcommand(s => s.setName('list').setDescription('ดูรายชื่อ Embed ทั้งหมดที่สร้างไว้'))
  .addSubcommand(s => s.setName('send').setDescription('ส่ง Embed จริงไปยังห้องที่ต้องการ')
    .addStringOption(o => nameOpt(o, true))
    .addChannelOption(o => o.setName('channel').setDescription('ห้องที่จะส่ง (ไม่เลือก = ห้องนี้)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand(s => s.setName('delete').setDescription('ลบ Embed ที่สร้างไว้')
    .addStringOption(o => nameOpt(o, true)))
  .toJSON();

// ---------- สร้างหน้าตา Embed ----------
function buildEmbed(e) {
  const emb = new EmbedBuilder().setColor(e.color || 0x5865f2);
  if (e.author) emb.setAuthor({ name: e.author.slice(0, 256), iconURL: e.authorIcon || undefined });
  if (e.title) emb.setTitle(e.title.slice(0, 256));
  if (e.description) emb.setDescription(e.description.slice(0, 4096));
  if (e.image) emb.setImage(e.image);
  if (e.thumbnail) emb.setThumbnail(e.thumbnail);
  if (e.footer) emb.setFooter({ text: e.footer.slice(0, 2048) });
  if (e.timestamp !== false) emb.setTimestamp();
  return emb;
}

const hasContent = (e) => !!(e.title || e.description || e.image || e.author || e.footer || e.thumbnail);

// ปุ่ม Ticket ของจริง (ใต้ Embed ที่ส่งไปแล้ว)
const publicPayload = (e) => ({
  embeds: [buildEmbed(e)],
  components: e.button === false ? [] : [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_create:${e.id}`) // ใส่ id Embed ไว้ เพื่อดึงข้อความรอแอดมินมาแสดงในห้อง
      .setLabel(e.buttonLabel || '📩 Create ticket')
      .setStyle(btnStyle(e.btnCreate, ButtonStyle.Secondary)), // ค่าเริ่มต้น สีเทา
  )],
});

// ---------- กล่องตัวอย่าง + ปุ่มแก้ไข ----------
const mk = (id, label, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

function panelPayload(e, note) {
  const on = e.button !== false;
  const timeOn = e.timestamp !== false;
  const row1 = new ActionRowBuilder().addComponents(
    mk(`emb:basic:${e.id}`, '✏️ แก้ข้อมูลพื้นฐาน (สี / หัวข้อ / ข้อความ)'),
    mk(`emb:author:${e.id}`, '👤 แก้ผู้เขียน'),
    mk(`emb:footer:${e.id}`, '📝 แก้ footer'),
    mk(`emb:images:${e.id}`, '🖼️ แก้รูปภาพ'),
    mk(`emb:tkt:${e.id}`, '🎫 แก้กล่องในห้อง Ticket'),
  );
  const row2 = new ActionRowBuilder().addComponents(
    mk(`emb:tglbtn:${e.id}`, `🔘 ปุ่ม Ticket: ${on ? 'เปิด' : 'ปิด'}`, on ? ButtonStyle.Success : ButtonStyle.Secondary),
    mk(`emb:label:${e.id}`, '🏷️ แก้ข้อความ / สีปุ่ม'),
    mk(`emb:tgltime:${e.id}`, `🕒 เวลา: ${timeOn ? 'เปิด' : 'ปิด'}`, timeOn ? ButtonStyle.Success : ButtonStyle.Secondary),
    mk(`emb:delete:${e.id}`, '🗑️ ลบ Embed', ButtonStyle.Danger),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`embedsend:${e.id}`)
      .setPlaceholder('📤 เลือกห้องที่จะส่ง Embed จริง')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`embcat:${e.id}`)
      .setPlaceholder('📁 เลือกหมวดหมู่ที่ห้อง Ticket จะไปอยู่')
      .addChannelTypes(ChannelType.GuildCategory),
  );
  const row5 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(`embrole:${e.id}`)
      .setPlaceholder('🛡️ เลือกยศทีมงานที่เห็น/ใช้ปุ่มในห้อง Ticket (ได้หลายยศ)')
      .setMinValues(0)
      .setMaxValues(10),
  );
  const roleLine = (e.staffRoles && e.staffRoles.length)
    ? e.staffRoles.map((r) => `<@&${r}>`).join(' ')
    : STAFF_ROLE_ID ? `<@&${STAFF_ROLE_ID}> (จากค่า STAFF_ROLE_ID)` : '**ยังไม่ได้ตั้ง** (เฉพาะแอดมิน/คนมีสิทธิ์จัดการห้อง)';
  const catLine = e.categoryId ? `<#${e.categoryId}>`
    : CATEGORY_ID ? `<#${CATEGORY_ID}> (จากค่า CATEGORY_ID)`
    : '**ยังไม่ได้ตั้ง** (ห้องจะขึ้นนอกหมวดหมู่ ตั้งได้จากเมนูล่างสุด)';
  const btnInfo = (on ? `ปุ่มใต้ Embed: **${e.buttonLabel || '📩 Create ticket'}** (สี${BTN_NAMES[e.btnCreate] || 'เทา'})` : 'ไม่มีปุ่มใต้ Embed') +
    '\n🎫 กล่องที่สองด้านล่าง = ตัวอย่างกล่องที่จะขึ้นในห้อง Ticket (แก้ได้ที่ปุ่ม “แก้กล่องในห้อง Ticket”)' +
    `\n📁 หมวดหมู่ Ticket: ${catLine}\n🛡️ ยศทีมงาน: ${roleLine}`;
  return {
    content: note || `📌 **${e.name}** — ตัวอย่างก่อนส่งจริง\n${btnInfo}\nแก้ไขด้วยปุ่มด้านล่าง แล้วเลือกห้องจากเมนูล่างสุดเพื่อส่งของจริง`,
    embeds: [buildEmbed(e), ticketEmbed(previewInfo(e), true)],
    components: [row1, row2, row3, row4, row5],
    allowedMentions: { parse: [] }, // แสดง @ยศ ได้ แต่ไม่ทำให้ยศถูกแจ้งเตือน
  };
}

// ---------- Modal แก้ไข ----------
const input = (id, label, style, value, max, placeholder) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style)
    .setRequired(false).setMaxLength(max);
  if (value) t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(t);
};
const SHORT = TextInputStyle.Short;
const PARA = TextInputStyle.Paragraph;

function buildModal(action, e) {
  const m = new ModalBuilder().setCustomId(`embm:${action}:${e.id}`);
  if (action === 'basic') {
    m.setTitle('แก้ข้อมูลพื้นฐาน').addComponents(
      input('title', 'หัวข้อ (เว้นว่าง = ไม่มี)', SHORT, e.title, 256),
      input('description', 'ข้อความ (เว้นว่าง = ไม่มี)', PARA, e.description, 4000, 'ใช้ > ทำกรอบอ้างอิง, <#ไอดีห้อง> ลิงก์ห้อง'),
      input('color', 'สี HEX เช่น #5865F2', SHORT, e.color, 7),
      input('name', 'ชื่อ Embed (ห้ามซ้ำ)', SHORT, e.name, 50),
    );
  } else if (action === 'author') {
    m.setTitle('แก้ผู้เขียน').addComponents(
      input('author', 'ชื่อด้านบนสุด (เว้นว่าง = ไม่แสดง)', SHORT, e.author, 256),
      input('author_icon', 'ลิงก์รูปโปรไฟล์ข้างชื่อ', SHORT, e.authorIcon, 500, 'https://...'),
    );
  } else if (action === 'footer') {
    m.setTitle('แก้ footer').addComponents(
      input('footer', 'ข้อความท้าย Embed (เว้นว่าง = ไม่มี)', SHORT, e.footer, 2048),
    );
  } else if (action === 'images') {
    m.setTitle('แก้รูปภาพ').addComponents(
      input('image', 'ลิงก์รูป/GIF ใหญ่', SHORT, e.image, 500, 'https://...'),
      input('thumbnail', 'ลิงก์รูปเล็กมุมขวาบน', SHORT, e.thumbnail, 500, 'https://...'),
    );
  } else if (action === 'qr') {
    const cur = (e.quickReplies && e.quickReplies.length) ? e.quickReplies : DEFAULT_QUICK;
    m.setTitle('แก้ปุ่มตอบด่วนของทีมงาน').addComponents(
      ...[0, 1, 2, 3, 4].map((n) => input(
        `qr${n}`, `ข้อความปุ่มที่ ${n + 1}`, SHORT, cur[n], 300,
        n === 0 ? 'เช่น มีอะไรให้ช่วยครับ' : 'เว้นว่าง = ไม่มีปุ่มนี้',
      )),
    );
  } else if (action === 'tkt') {
    m.setTitle('แก้กล่องในห้อง Ticket').addComponents(
      input('ticket_title', 'หัวข้อกล่อง ({number} = เลขห้อง)', SHORT, e.ticketTitle, 256, '🎫 Ticket #{number}'),
      input('waitmsg', 'ข้อความตอนรอทีมงาน', PARA, e.waitMsg, 1000, DEFAULT_WAIT_MSG),
      input('chatmsg', 'ข้อความตอนเริ่มสนทนา', PARA, e.chatMsg, 1000, DEFAULT_CHAT_MSG),
      input('ticket_color', 'สีแถบตอนรอทีมงาน (HEX)', SHORT, e.ticketColor, 7, '#FEE75C'),
      input('ticket_image', 'ลิงก์รูป/GIF ในกล่อง', SHORT, e.ticketImage, 500, 'https://...'),
    );
  } else if (action === 'waitmsg') {
    m.setTitle('ข้อความรอแอดมินในห้อง Ticket').addComponents(
      input('waitmsg', 'ข้อความที่แสดงตอนรอ (เว้นว่าง = ค่าเริ่มต้น)', PARA, e.waitMsg, 1000, DEFAULT_WAIT_MSG),
    );
  } else if (action === 'label') {
    const hint = 'น้ำเงิน / เทา / เขียว / แดง (เว้นว่าง = ค่าเริ่มต้น)';
    m.setTitle('แก้ข้อความ / สีปุ่ม').addComponents(
      input('label', 'ข้อความบนปุ่ม Create ticket', SHORT, e.buttonLabel, 80, '📩 Create ticket'),
      input('c_create', 'สีปุ่ม Create ticket', SHORT, BTN_NAMES[e.btnCreate], 10, hint),
      input('c_start', 'สีปุ่ม สนทนา (ในห้อง Ticket)', SHORT, BTN_NAMES[e.btnStart], 10, hint),
      input('c_close', 'สีปุ่ม Close ticket (ในห้อง Ticket)', SHORT, BTN_NAMES[e.btnClose], 10, hint),
    );
  }
  return m;
}

// ---------- ปุ่มในกล่องตัวอย่าง ----------
async function handleEmbButton(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่แก้ Embed ได้');
  const [, action, id] = i.customId.split(':');
  const e = guildEmbeds(i.guildId).find((x) => x.id === id);
  if (!e) return bad(i, 'ไม่พบ Embed นี้แล้ว (อาจถูกลบไป)');

  if (['basic', 'author', 'footer', 'images', 'label', 'waitmsg', 'tkt', 'qr'].includes(action)) {
    return i.showModal(buildModal(action, e));
  }
  if (action === 'tglbtn') { e.button = e.button === false; save(); return i.update(panelPayload(e)); }
  if (action === 'tgltime') { e.timestamp = e.timestamp === false; save(); return i.update(panelPayload(e)); }
  if (action === 'delete') {
    return i.reply({
      content: `⚠️ ยืนยันลบ Embed **${e.name}** ?`,
      components: [new ActionRowBuilder().addComponents(mk(`emb:delok:${e.id}`, 'ยืนยันลบ', ButtonStyle.Danger))],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (action === 'delok') {
    data.embeds[i.guildId] = guildEmbeds(i.guildId).filter((x) => x.id !== e.id);
    save();
    return i.update({ content: `🗑️ ลบ Embed **${e.name}** แล้ว (ข้อความที่ส่งไปแล้วไม่ถูกลบ)`, components: [] });
  }
}

// ---------- ส่งข้อมูลจาก Modal ----------
async function handleEmbModal(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่แก้ Embed ได้');
  const [, action, id] = i.customId.split(':');
  const e = guildEmbeds(i.guildId).find((x) => x.id === id);
  if (!e) return bad(i, 'ไม่พบ Embed นี้แล้ว (อาจถูกลบไป)');

  const get = (k) => {
    const v = i.fields.getTextInputValue(k).trim();
    return v === '' || v === '-' ? null : v;
  };
  const urlOrNull = (k) => {
    const v = get(k);
    if (v && !isUrl(v)) throw new Error(`ลิงก์ในช่อง ${k} ไม่ถูกต้อง (ต้องขึ้นต้นด้วย https://)`);
    return v;
  };

  const draft = { ...e };
  try {
    if (action === 'basic') {
      const name = i.fields.getTextInputValue('name').trim();
      if (!name) throw new Error('ชื่อ Embed ห้ามว่าง');
      const dup = findEmbed(i.guildId, name);
      if (dup && dup.id !== e.id) throw new Error(`มี Embed ชื่อ **${name}** อยู่แล้ว กรุณาใช้ชื่ออื่น`);
      const color = get('color');
      if (color && !isHex(color)) throw new Error('สีต้องเป็น HEX เช่น #5865F2');
      draft.name = name;
      draft.title = get('title');
      draft.description = get('description');
      draft.color = color ? (color.startsWith('#') ? color : `#${color}`) : null;
    } else if (action === 'author') {
      draft.author = get('author');
      draft.authorIcon = urlOrNull('author_icon');
    } else if (action === 'footer') {
      draft.footer = get('footer');
    } else if (action === 'images') {
      draft.image = urlOrNull('image');
      draft.thumbnail = urlOrNull('thumbnail');
    } else if (action === 'label') {
      draft.buttonLabel = get('label');
      draft.btnCreate = parseBtnColor(get('c_create'));
      draft.btnStart = parseBtnColor(get('c_start'));
      draft.btnClose = parseBtnColor(get('c_close'));
    } else if (action === 'qr') {
      const list = [0, 1, 2, 3, 4].map((n) => get(`qr${n}`)).filter(Boolean);
      draft.quickReplies = list.length ? list : null; // ว่างทั้งหมด = ใช้ค่าเริ่มต้น
    } else if (action === 'tkt') {
      const tc = get('ticket_color');
      if (tc && !isHex(tc)) throw new Error('สีต้องเป็น HEX เช่น #FEE75C');
      draft.ticketTitle = get('ticket_title');
      draft.waitMsg = get('waitmsg');
      draft.chatMsg = get('chatmsg');
      draft.ticketColor = tc ? (tc.startsWith('#') ? tc : `#${tc}`) : null;
      draft.ticketImage = urlOrNull('ticket_image');
    } else if (action === 'waitmsg') {
      draft.waitMsg = get('waitmsg');
    }
    if (!hasContent(draft)) throw new Error('Embed ต้องมีข้อมูลอย่างน้อย 1 อย่าง (เช่น หัวข้อหรือข้อความ)');
  } catch (err) {
    return bad(i, err.message);
  }

  Object.assign(e, draft);
  save();
  return i.isFromMessage() ? i.update(panelPayload(e)) : i.reply(panelPayload(e));
}

// ---------- /ticket ----------
async function handleTicketCommand(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่ใช้คำสั่งนี้ได้');
  const sub = i.options.getSubcommand();
  const gid = i.guildId;

  if (sub === 'create') {
    const name = i.options.getString('name').trim();
    if (!name) return bad(i, 'ชื่อ Embed ห้ามว่าง');
    if (findEmbed(gid, name)) {
      return bad(i, `มี Embed ชื่อ **${name}** อยู่แล้ว กรุณาใช้ชื่ออื่น (หรือใช้ /ticket edit เพื่อแก้ของเดิม)`);
    }
    const e = {
      id: crypto.randomBytes(4).toString('hex'),
      name,
      title: 'หัวข้อ Embed',
      description: 'กดปุ่มด้านล่างเพื่อแก้ไข Embed นี้',
      author: i.member?.displayName || i.user.username,
      authorIcon: i.user.displayAvatarURL(),
      image: null, thumbnail: null, footer: null, color: null,
      timestamp: true, button: true, buttonLabel: null,
      createdBy: i.user.id, createdAt: Date.now(),
    };
    guildEmbeds(gid).push(e);
    save();
    return i.reply(panelPayload(e, `✅ สร้าง Embed ชื่อ **${name}** แล้ว — นี่คือตัวอย่างก่อนส่งจริง\nแก้ไขด้วยปุ่มด้านล่าง แล้วเลือกห้องจากเมนูล่างสุดเพื่อส่งของจริง`));
  }

  if (sub === 'list') {
    const list = guildEmbeds(gid);
    if (!list.length) return bad(i, 'ยังไม่มี Embed ที่สร้างไว้ ใช้ /ticket create เพื่อสร้าง');
    const lines = list.map((e, n) => `**${n + 1}.** \`${e.name}\`${e.title ? ` — ${e.title}` : ''}`);
    return i.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2)
        .setTitle(`📚 Embed ที่สร้างไว้ (${list.length})`)
        .setDescription(lines.join('\n').slice(0, 4000))],
      flags: MessageFlags.Ephemeral,
    });
  }

  const name = i.options.getString('name');
  const e = findEmbed(gid, name);
  if (!e) return bad(i, `ไม่พบ Embed ชื่อ **${name}** (ดูรายชื่อด้วย /ticket list)`);

  if (sub === 'edit') return i.reply(panelPayload(e));

  if (sub === 'send') {
    const target = i.options.getChannel('channel') || i.channel;
    try {
      const ch = await i.guild.channels.fetch(target.id);
      await ch.send(publicPayload(e));
      return i.reply({ content: `✅ ส่ง Embed **${e.name}** ไปที่ <#${ch.id}> แล้ว`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('ส่ง Embed ไม่สำเร็จ:', err.message);
      return bad(i, `ส่งไม่สำเร็จ: ${err.message} (ตรวจสิทธิ์ดู/ส่งข้อความของบอทในห้องนั้น)`);
    }
  }

  if (sub === 'delete') {
    data.embeds[gid] = guildEmbeds(gid).filter((x) => x.id !== e.id);
    save();
    return i.reply({ content: `🗑️ ลบ Embed **${e.name}** แล้ว (ข้อความที่ส่งไปแล้วในห้องต่างๆ ไม่ถูกลบ)`, flags: MessageFlags.Ephemeral });
  }
}

// เลือกห้องจากเมนูในกล่องตัวอย่าง → ส่งของจริง
async function handleSendSelect(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
  const id = i.customId.split(':')[1];
  const e = guildEmbeds(i.guildId).find((x) => x.id === id);
  if (!e) return bad(i, 'ไม่พบ Embed นี้แล้ว (อาจถูกลบไป)');
  const target = i.channels.first();
  try {
    const ch = await i.guild.channels.fetch(target.id);
    await ch.send(publicPayload(e));
    return i.update({ content: `✅ ส่ง Embed **${e.name}** ไปที่ <#${ch.id}> แล้ว (เลือกห้องอื่นเพื่อส่งซ้ำได้)` });
  } catch (err) {
    console.error('ส่ง Embed ไม่สำเร็จ:', err.message);
    return bad(i, `ส่งไม่สำเร็จ: ${err.message} (ตรวจสิทธิ์ดู/ส่งข้อความของบอทในห้องนั้น)`);
  }
}

// ---------- ตัวจับเวลาลบห้อง ----------
const timers = new Map();

function scheduleDelete(channelId, delayMs) {
  clearTimeout(timers.get(channelId));
  const t = setTimeout(() => deleteTicket(channelId), Math.max(delayMs, 0));
  timers.set(channelId, t);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ลบห้องจริงๆ (ลองซ้ำสูงสุด 3 ครั้ง) คืน true เมื่อห้องหายไปแล้ว
async function removeChannel(channelId, reason = 'Ticket closed') {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let ch;
    try {
      ch = await client.channels.fetch(channelId);
    } catch (err) {
      if (err.code === 10003) return true; // ห้องถูกลบไปแล้ว
      console.error(`ดึงห้อง ${channelId} ไม่สำเร็จ (ครั้งที่ ${attempt}):`, err.message);
      await sleep(1000 * attempt);
      continue;
    }
    if (!ch) return true;
    try {
      await ch.delete(reason);
      return true;
    } catch (err) {
      if (err.code === 10003) return true;
      console.error(`ลบห้อง ${channelId} ไม่สำเร็จ (ครั้งที่ ${attempt}):`, err.message);
      await sleep(1500 * attempt);
    }
  }
  console.error(`⚠️ ลบห้อง ${channelId} ไม่สำเร็จ ตรวจสิทธิ์ "จัดการช่อง" ของบอทในหมวดหมู่/ห้องนั้น`);
  return false;
}

async function deleteTicket(channelId) {
  clearTimeout(timers.get(channelId));
  timers.delete(channelId);
  delete data.tickets[channelId];
  save();
  await removeChannel(channelId);
}

// ห้องที่ลบไปเอง (หรือโดยคนอื่น) → เลิกติดตาม
client.on('channelDelete', (ch) => {
  clearTimeout(timers.get(ch.id));
  timers.delete(ch.id);
  if (data.tickets[ch.id]) { delete data.tickets[ch.id]; save(); }
});

// อายุห้องนานที่สุดที่เป็นไปได้ = เวลารอสูงสุด + เวลาสนทนา (ห้องที่ไม่ได้ติดตามและเก่ากว่านี้ ถือว่าค้าง)
const MAX_TICKET_LIFE = 60 * 60 * 1000 + TICKET_LIFETIME;
const TICKET_NAME_RE = /^ticket-\d{4}$/;
let sweeping = false;

// เก็บกวาด: 1) ห้องที่หมดเวลาแล้วแต่ยังไม่ถูกลบ 2) ห้องค้างที่ไม่มีข้อมูลติดตาม
async function sweepTickets() {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = Date.now();

    for (const [id, info] of Object.entries(data.tickets)) {
      // ลบเฉพาะห้องที่ทีมงานกดสนทนาแล้วและหมดเวลา (ห้องที่ยังรออยู่ไม่มีกำหนดเวลา จึงไม่ถูกลบ)
      if (info.expiresAt && info.expiresAt <= now) await deleteTicket(id);
    }

    if (CLEANUP_ORPHANS) {
      for (const guild of client.guilds.cache.values()) {
        for (const ch of guild.channels.cache.values()) {
          if (ch.type !== ChannelType.GuildText || !TICKET_NAME_RE.test(ch.name)) continue;
          if (data.tickets[ch.id]) continue;
          if (!ch.permissionOverwrites?.cache.has(client.user.id)) continue; // ห้องที่บอทสร้างเท่านั้น
          if (now - ch.createdTimestamp < MAX_TICKET_LIFE) continue;
          console.log(`🧹 ลบห้องค้าง ${ch.name} (${ch.id})`);
          await removeChannel(ch.id, 'Orphan ticket cleanup');
        }
      }
    }
  } catch (err) {
    console.error('sweepTickets error:', err);
  } finally {
    sweeping = false;
  }
}

// ---------- สี / Embed (คัดลอกมาจากไฟล์เดิม ใช้กับ /serverpobox) ----------
const COLOR_NAMES = {
  'แดง': '#ED4245', red: '#ED4245', 'เขียว': '#57F287', green: '#57F287',
  'น้ำเงิน': '#5865F2', blue: '#5865F2', 'ฟ้า': '#3BA5E9', cyan: '#3BA5E9',
  'เหลือง': '#FEE75C', yellow: '#FEE75C', 'ส้ม': '#F58B2A', orange: '#F58B2A',
  'ม่วง': '#9B59B6', purple: '#9B59B6', 'ชมพู': '#EB459E', pink: '#EB459E',
  'ขาว': '#FFFFFF', white: '#FFFFFF', 'ดำ': '#23272A', black: '#23272A',
  'ทอง': '#E0A526', gold: '#E0A526',
};
// สี: รับ HEX หรือชื่อสี → คืน '#RRGGBB'
function parseColor(s) {
  const v = norm(s);
  if (COLOR_NAMES[v]) return COLOR_NAMES[v];
  if (isHex(v)) return v.startsWith('#') ? v : `#${v}`;
  return null;
}
// สร้างหน้าตา Embed
function buildBoxEmbed(e) {
  const emb = new EmbedBuilder().setColor(e.color || 0x5865f2);
  if (e.author) emb.setAuthor({ name: e.author.slice(0, 256), iconURL: e.authorIcon || undefined });
  if (e.title) emb.setTitle(e.title.slice(0, 256));
  if (e.description) emb.setDescription(e.description.slice(0, 4096));
  if (e.image) emb.setImage(e.image);
  if (e.thumbnail) emb.setThumbnail(e.thumbnail);
  if (e.footer) emb.setFooter({ text: e.footer.slice(0, 2048) });
  if (e.timestamp !== false) emb.setTimestamp();
  return emb;
}
const boxHasContent = (e) => !!(e.title || e.description || e.image || e.author || e.footer || e.thumbnail);

// =====================================================================
// ระบบเสนอระบบ/ข้อเสนอแนะ /serverpobox
//  ปุ่ม (เหมือน ticket) → กล่องให้เขียนว่า "อยากเสนออะไร"
//  → ข้อความไปแสดงที่ "ห้องแสดงข้อเสนอ" พร้อมสถานะ 🛠️ กำลังแก้ไขระบบ
//  → อีกใบไปที่ "ห้องแอดมิน" มีปุ่ม ✅ ระบบนี้ได้รับการแก้ไขแล้ว
//  → แอดมินกดปุ่ม สถานะในห้องแสดงจะเปลี่ยนเป็น ✅ ระบบนี้ได้รับการแก้ไขแล้ว
//  เก็บค่าตั้งค่าใน data.servers (สถานะของแต่ละข้อเสนออยู่ในตัวข้อความเอง ไม่หายตอนรีสตาร์ท)
// =====================================================================
const SVR_COOLDOWN_MS = 60 * 1000;        // สมาชิกคนเดิมส่งข้อเสนอถี่ได้ทุก 60 วินาที (กันสแปม)
const SVR_WORKING = '🛠️ กำลังแก้ไขระบบ';
const SVR_DONE = '✅ ระบบนี้ได้รับการแก้ไขแล้ว';
const SVR_FAILED = '❌ ไม่สามารถแก้ไขระบบนี้ได้';
const svrCooldown = new Map();            // userId → เวลาที่ส่งล่าสุด
const svrBusy = new Set();                // กันแอดมินสองคนกดข้อเสนอเดียวกันพร้อมกัน

const guildServers = (gid) => (data.servers[gid] ||= []);
const findServer = (gid, name) => guildServers(gid).find((e) => norm(e.name) === norm(name));
const serverById = (gid, id) => guildServers(gid).find((x) => x.id === id);

// ---------- Slash command: /serverpobox ----------
const SVR_CMD = 'serverpobox'; // ชื่อคำสั่ง (เปลี่ยนชื่อได้ที่นี่ที่เดียว ต้องเป็นตัวพิมพ์เล็ก ไม่เว้นวรรค)
const setServerCmd = new SlashCommandBuilder()
  .setName(SVR_CMD)
  .setDescription('สร้างและจัดการระบบรับข้อเสนอ (สมาชิกกดปุ่ม → เขียนข้อเสนอ → แอดมินกดเมื่อแก้ไขแล้ว)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(s => s.setName('create')
    .setDescription('สร้างระบบรับข้อเสนอใหม่ตั้งชื่อ (ห้ามซ้ำ) แล้วแก้ไขด้วยปุ่มใต้ตัวอย่าง')
    .addStringOption(o => nameOpt(o, false, 'ตั้งชื่อ (ห้ามซ้ำกับที่มีอยู่)')))
  .addSubcommand(s => s.setName('edit')
    .setDescription('เปิดกล่องตัวอย่าง + ปุ่มแก้ไข ของระบบที่สร้างไว้')
    .addStringOption(o => nameOpt(o, true, 'ชื่อระบบ')))
  .addSubcommand(s => s.setName('list').setDescription('ดูรายชื่อระบบรับข้อเสนอทั้งหมดที่สร้างไว้'))
  .addSubcommand(s => s.setName('send').setDescription('ส่งปุ่มเสนอระบบจริงไปยังห้องที่ต้องการ')
    .addStringOption(o => nameOpt(o, true, 'ชื่อระบบ'))
    .addChannelOption(o => o.setName('channel').setDescription('ห้องที่จะส่งปุ่ม (ไม่เลือก = ห้องนี้)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand(s => s.setName('delete').setDescription('ลบระบบรับข้อเสนอที่สร้างไว้')
    .addStringOption(o => nameOpt(o, true, 'ชื่อระบบ')))
  .toJSON();

// ---------- ข้อความ + ปุ่มสาธารณะ (ห้องปุ่มกด) ----------
const svrPublicPayload = (g) => ({
  embeds: [buildBoxEmbed(g)],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`svr_open:${g.id}`)
      .setLabel(g.buttonLabel || '💡 เสนอระบบ')
      .setStyle(btnStyle(g.btnColor, ButtonStyle.Primary)),
  )],
});

// ตรวจว่าพร้อมใช้งานไหม (คืนข้อความ error หรือ null)
function svrReady(g, guild) {
  if (!g.displayChannelId || !guild.channels.cache.has(g.displayChannelId)) {
    return 'ยังไม่ได้เลือก “ห้องแสดงข้อเสนอ” (หรือห้องนั้นถูกลบไปแล้ว)';
  }
  if (!g.adminChannelId || !guild.channels.cache.has(g.adminChannelId)) {
    return 'ยังไม่ได้เลือก “ห้องแอดมินกดปุ่ม” (หรือห้องนั้นถูกลบไปแล้ว)';
  }
  return null;
}

// ---------- กล่องตัวอย่าง + ปุ่มแก้ไข ----------
// ค่าเริ่มต้นของกล่อง "ห้องแสดงข้อเสนอ" (disp) และ "ห้องแอดมิน" (adm) แก้ได้จากแผง
const SVR_BOX_DEFAULT = {
  disp: { title: '💡 ข้อเสนอระบบใหม่', description: '{text}', color: '#FEE75C', image: null, thumbnail: null, footer: null },
  adm: { title: '💡 ข้อเสนอระบบใหม่', description: '{text}', color: '#FEE75C', image: null, thumbnail: null, footer: null },
};
const svrBox = (g, kind) => ({
  ...SVR_BOX_DEFAULT[kind],
  ...((g && g[kind === 'disp' ? 'dispBox' : 'admBox']) || {}),
});

function svrPanel(g, note) {
  const guild = client.guilds.cache.get(g.guildId);
  const timeOn = g.timestamp !== false;

  const row1 = new ActionRowBuilder().addComponents(
    mk(`svr:basic:${g.id}`, '✏️ ข้อความกล่องปุ่มกด'),
    mk(`svr:images:${g.id}`, '🖼️ รูปกล่องปุ่มกด'),
    mk(`svr:label:${g.id}`, '🏷️ ปุ่ม / คำถามในกล่อง'),
    mk(`svr:tgltime:${g.id}`, `🕒 เวลา: ${timeOn ? 'เปิด' : 'ปิด'}`, timeOn ? ButtonStyle.Success : ButtonStyle.Secondary),
    mk(`svr:delete:${g.id}`, '🗑️ ลบ', ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder().addComponents(
    mk(`svr:dtext:${g.id}`, '📢 ข้อความกล่องห้องแสดง'),
    mk(`svr:dimg:${g.id}`, '🖼️ รูปกล่องห้องแสดง'),
    mk(`svr:atext:${g.id}`, '🛠️ ข้อความกล่องห้องแอดมิน'),
    mk(`svr:aimg:${g.id}`, '🖼️ รูปกล่องห้องแอดมิน'),
    mk(`svr:sendpick:${g.id}`, '📤 ส่งปุ่มจริง', ButtonStyle.Success),
  );

  const dispMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`svrdisp:${g.id}`)
    .setPlaceholder('📢 เลือก “ห้องแสดงข้อเสนอ” ที่ข้อความของสมาชิกจะไปโชว์')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  if (g.displayChannelId && guild?.channels.cache.has(g.displayChannelId)) dispMenu.setDefaultChannels(g.displayChannelId);
  const row3 = new ActionRowBuilder().addComponents(dispMenu);

  const admMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`svradm:${g.id}`)
    .setPlaceholder('🛠️ เลือก “ห้องแอดมิน” ที่มีปุ่มกดเมื่อแก้ไขระบบแล้ว')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  if (g.adminChannelId && guild?.channels.cache.has(g.adminChannelId)) admMenu.setDefaultChannels(g.adminChannelId);
  const row4 = new ActionRowBuilder().addComponents(admMenu);

  const roleMenu = new RoleSelectMenuBuilder()
    .setCustomId(`svrroles:${g.id}`)
    .setPlaceholder('🛡️ ยศทีมงานที่กดปุ่ม “แก้ไขแล้ว” ได้ + ถูกแท็ก (ไม่เลือก = เฉพาะแอดมิน)')
    .setMinValues(0)
    .setMaxValues(10);
  const roleDefaults = (g.approverRoles || []).filter((id) => guild?.roles.cache.has(id)).slice(0, 10);
  if (roleDefaults.length) roleMenu.setDefaultRoles(...roleDefaults);
  const row5 = new ActionRowBuilder().addComponents(roleMenu);

  const info =
    `📢 ห้องแสดงข้อเสนอ: ${g.displayChannelId ? `<#${g.displayChannelId}>` : '**ยังไม่ได้ตั้ง**'} (แสดงชื่อ + รูปโปรไฟล์ผู้เสนอ)\n` +
    `🛠️ ห้องแอดมินกดปุ่ม: ${g.adminChannelId ? `<#${g.adminChannelId}>` : '**ยังไม่ได้ตั้ง**'} (แสดงชื่อ + รูปโปรไฟล์ผู้เสนอ)\n` +
    `🛡️ ทีมงานที่กดได้: ${roleDefaults.length ? roleDefaults.map((id) => `<@&${id}>`).join(' ') : 'เฉพาะแอดมิน / คนมีสิทธิ์ Manage Server'}\n` +
    `ปุ่ม: **${g.buttonLabel || '💡 เสนอระบบ'}** (สี${BTN_NAMES[g.btnColor] || 'น้ำเงิน'}) • คำถามในกล่อง: **${g.question || 'อยากเสนออะไร'}**`;

  // กล่องตัวอย่าง 3 ใบ: ① ห้องปุ่มกด ② ห้องแสดงข้อเสนอ ③ ห้องแอดมิน (ข้อมูลผู้เสนอเป็นตัวอย่าง)
  const sample = {
    preview: true, user: '0', username: 'username', displayName: 'ชื่อผู้เสนอ',
    avatar: client.user?.displayAvatarURL(),
    text: 'ตัวอย่างข้อเสนอของสมาชิก — ข้อความที่สมาชิกเขียนจะมาอยู่ตรงนี้',
    createdAt: Date.now(),
  };
  const pub = buildBoxEmbed(g);
  const dispE = svrEmbed(sample, svrBox(g, 'disp'));
  const admE = svrEmbed(sample, svrBox(g, 'adm'))
    .addFields({ name: '🔗 ข้อความที่แสดง', value: '(ลิงก์ไปที่ข้อความในห้องแสดงข้อเสนอ)' });
  // Discord จำกัดความยาวรวมของ Embed ทั้งข้อความ ถ้ายาวเกินให้โชว์เฉพาะกล่องปุ่มกด
  const fits = (pub.length + dispE.length + admE.length) <= 5500;

  return {
    content: note || `📌 **${g.name}** — ตัวอย่างก่อนส่งจริง\n${info}\n` +
      (fits ? '**กล่อง ①** ห้องปุ่มกด • **②** ห้องแสดงข้อเสนอ • **③** ห้องแอดมิน (ข้อมูลผู้เสนอเป็นตัวอย่าง)\n' : '') +
      'แก้ไขด้วยปุ่ม/เมนูด้านล่าง แล้วกด **📤 ส่งปุ่มจริง** เพื่อเลือกห้องปุ่มกด',
    embeds: fits ? [pub, dispE, admE] : [pub],
    components: [row1, row2, row3, row4, row5],
    allowedMentions: { parse: [] },
  };
}

// ---------- Modal แก้ไข (ฝั่งแอดมิน) ----------
function buildSvrModal(action, g) {
  const m = new ModalBuilder().setCustomId(`svrm:${action}:${g.id}`);
  if (action === 'basic') {
    m.setTitle('แก้ข้อความกล่องปุ่มกด').addComponents(
      input('title', 'หัวข้อ (เว้นว่าง = ไม่มี)', SHORT, g.title, 256),
      input('description', 'ข้อความ (เว้นว่าง = ไม่มี)', PARA, g.description, 4000),
      input('color', 'สี HEX หรือชื่อสี', SHORT, g.color, 20, '#5865F2 หรือ แดง เขียว ฟ้า ทอง ม่วง ชมพู'),
      input('footer', 'footer ท้าย Embed (เว้นว่าง = ไม่มี)', SHORT, g.footer, 2048),
      input('name', 'ชื่อระบบ (ห้ามซ้ำ)', SHORT, g.name, 50),
    );
  } else if (action === 'images') {
    m.setTitle('แก้รูปกล่องปุ่มกด').addComponents(
      input('image', 'ลิงก์รูป/GIF ใหญ่', SHORT, g.image, 500, 'https://...'),
      input('thumbnail', 'ลิงก์รูป/GIF เล็กมุมขวาบน', SHORT, g.thumbnail, 500, 'https://...'),
    );
  } else if (action === 'label') {
    m.setTitle('แก้ปุ่ม และคำถามในกล่อง').addComponents(
      input('label', 'ข้อความบนปุ่มเสนอระบบ', SHORT, g.buttonLabel, 80, '💡 เสนอระบบ'),
      input('c_btn', 'สีปุ่ม', SHORT, BTN_NAMES[g.btnColor], 10, 'น้ำเงิน / เทา / เขียว / แดง (เว้นว่าง = น้ำเงิน)'),
      input('question', 'คำถามในกล่องที่สมาชิกกรอก', SHORT, g.question, 45, 'อยากเสนออะไร'),
    );
  } else if (action === 'dtext' || action === 'atext') {
    // แก้ข้อความ/สี ของกล่องในห้องแสดงข้อเสนอ (dtext) หรือห้องแอดมิน (atext)
    const b = svrBox(g, action === 'dtext' ? 'disp' : 'adm');
    m.setTitle(action === 'dtext' ? 'แก้กล่องห้องแสดงข้อเสนอ' : 'แก้กล่องห้องแอดมิน').addComponents(
      input('title', 'หัวข้อ (เว้นว่าง = ไม่มี)', SHORT, b.title, 256, 'ใส่ {name} = ชื่อผู้เสนอ ได้'),
      input('description', 'ข้อความ (ใช้ {text} แทนข้อเสนอ)', PARA, b.description, 1000,
        '{text}=ข้อเสนอ {user}=แท็กผู้เสนอ {name}=ชื่อผู้เสนอ'),
      input('color', 'สี HEX หรือชื่อสี', SHORT, b.color, 20, '#FEE75C หรือ แดง เขียว ฟ้า ทอง ม่วง ชมพู'),
      input('footer', 'footer ท้ายกล่อง (เว้นว่าง = ไม่มี)', SHORT, b.footer, 300),
    );
  } else if (action === 'dimg' || action === 'aimg') {
    const b = svrBox(g, action === 'dimg' ? 'disp' : 'adm');
    m.setTitle(action === 'dimg' ? 'แก้รูปกล่องห้องแสดงข้อเสนอ' : 'แก้รูปกล่องห้องแอดมิน').addComponents(
      input('image', 'ลิงก์รูป/GIF ใหญ่ (ไม่ใส่ = ไม่มีรูป)', SHORT, b.image, 500, 'https://... (รูปโปรไฟล์ผู้เสนออยู่มุมขวาบนให้เองแล้ว)'),
    );
  }
  return m;
}

// ---------- ปุ่มในกล่องตัวอย่าง ----------
async function handleSvrButton(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่แก้ระบบนี้ได้');
  const [, action, id] = i.customId.split(':');
  const g = serverById(i.guildId, id);
  if (!g) return bad(i, 'ไม่พบระบบนี้แล้ว (อาจถูกลบไป)');

  if (['basic', 'images', 'label', 'dtext', 'dimg', 'atext', 'aimg'].includes(action)) {
    return i.showModal(buildSvrModal(action, g));
  }
  if (action === 'tgltime') { g.timestamp = g.timestamp === false; save(); return i.update(svrPanel(g)); }
  if (action === 'sendpick') {
    // เลือกห้องปุ่มกด (เมนูส่วนตัว เห็นเฉพาะคนกด)
    return i.reply({
      content: `📤 เลือก “ห้องปุ่มกด” ที่จะส่งปุ่มเสนอระบบ **${g.name}**`,
      components: [new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`svrsendp:${g.id}`)
          .setPlaceholder('เลือกห้องที่จะส่งปุ่มจริง')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (action === 'delete') {
    return i.reply({
      content: `⚠️ ยืนยันลบระบบ **${g.name}** ?`,
      components: [new ActionRowBuilder().addComponents(mk(`svr:delok:${g.id}`, 'ยืนยันลบ', ButtonStyle.Danger))],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (action === 'delok') {
    data.servers[i.guildId] = guildServers(i.guildId).filter((x) => x.id !== g.id);
    save();
    return i.update({ content: `🗑️ ลบระบบ **${g.name}** แล้ว (ปุ่มที่ส่งไปแล้วจะกดไม่ได้อีก)`, components: [] });
  }
}

// ---------- ส่งข้อมูลจาก Modal แก้ไข ----------
async function handleSvrModal(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่แก้ระบบนี้ได้');
  const [, action, id] = i.customId.split(':');
  const g = serverById(i.guildId, id);
  if (!g) return bad(i, 'ไม่พบระบบนี้แล้ว (อาจถูกลบไป)');

  const get = (k) => {
    const v = i.fields.getTextInputValue(k).trim();
    return v === '' || v === '-' ? null : v;
  };
  const urlOrNull = (k) => {
    const v = get(k);
    if (v && !isUrl(v)) throw new Error(`ลิงก์ในช่อง ${k} ไม่ถูกต้อง (ต้องขึ้นต้นด้วย https://)`);
    return v;
  };

  const draft = { ...g };
  try {
    if (action === 'basic') {
      const name = i.fields.getTextInputValue('name').trim();
      if (!name) throw new Error('ชื่อระบบห้ามว่าง');
      const dup = findServer(i.guildId, name);
      if (dup && dup.id !== g.id) throw new Error(`มีระบบชื่อ **${name}** อยู่แล้ว กรุณาใช้ชื่ออื่น`);
      const c = get('color');
      if (c) {
        const parsed = parseColor(c);
        if (!parsed) throw new Error('สีไม่ถูกต้อง ใช้ HEX เช่น #5865F2 หรือชื่อสี เช่น แดง เขียว ฟ้า ทอง ม่วง ชมพู');
        draft.color = parsed;
      } else draft.color = null;
      draft.name = name;
      draft.title = get('title');
      draft.description = get('description');
      draft.footer = get('footer');
    } else if (action === 'images') {
      draft.image = urlOrNull('image');
      draft.thumbnail = urlOrNull('thumbnail');
    } else if (action === 'label') {
      draft.buttonLabel = get('label');
      draft.btnColor = parseBtnColor(get('c_btn'));
      draft.question = get('question');
    } else if (['dtext', 'atext', 'dimg', 'aimg'].includes(action)) {
      // กล่องห้องแสดงข้อเสนอ (d…) / ห้องแอดมิน (a…)
      const kind = action[0] === 'd' ? 'disp' : 'adm';
      const b = { ...svrBox(g, kind) };
      if (action.endsWith('text')) {
        const c = get('color');
        if (c) {
          const parsed = parseColor(c);
          if (!parsed) throw new Error('สีไม่ถูกต้อง ใช้ HEX เช่น #FEE75C หรือชื่อสี เช่น แดง เขียว ฟ้า ทอง ม่วง ชมพู');
          b.color = parsed;
        } else b.color = SVR_BOX_DEFAULT[kind].color;
        b.title = get('title');
        b.description = get('description') || '{text}';
        b.footer = get('footer');
      } else {
        b.image = urlOrNull('image');
      }
      draft[kind === 'disp' ? 'dispBox' : 'admBox'] = b;
    }
    if (!boxHasContent(draft)) throw new Error('ต้องมีข้อมูลอย่างน้อย 1 อย่าง (เช่น หัวข้อหรือข้อความ)');
  } catch (err) {
    return bad(i, err.message);
  }

  Object.assign(g, draft);
  save();
  return i.isFromMessage() ? i.update(svrPanel(g)) : i.reply(svrPanel(g));
}

// ---------- เมนูตั้งค่า: ห้องแสดง / ห้องแอดมิน / ยศทีมงาน ----------
async function handleSvrConfigSelect(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
  const [kind, id] = i.customId.split(':');
  const g = serverById(i.guildId, id);
  if (!g) return bad(i, 'ไม่พบระบบนี้แล้ว (อาจถูกลบไป)');

  if (kind === 'svrdisp') g.displayChannelId = i.channels.first().id;
  else if (kind === 'svradm') g.adminChannelId = i.channels.first().id;
  else if (kind === 'svrroles') g.approverRoles = [...i.values].filter((r) => r !== i.guildId); // ตัด @everyone ออก
  save();
  return i.update(svrPanel(g));
}

// ---------- ส่งปุ่มจริงไปห้องปุ่มกด ----------
async function sendSvrPanel(g, guild, channelId) {
  const notReady = svrReady(g, guild);
  if (notReady) return notReady;
  try {
    const ch = await guild.channels.fetch(channelId);
    await ch.send(svrPublicPayload(g));
    return null;
  } catch (err) {
    console.error('ส่งปุ่มเสนอระบบไม่สำเร็จ:', err.message);
    return `ส่งไม่สำเร็จ: ${err.message} (ตรวจสิทธิ์ดู/ส่งข้อความ/ฝัง Embed ของบอทในห้องนั้น)`;
  }
}

async function handleSvrSendSelect(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
  const g = serverById(i.guildId, i.customId.split(':')[1]);
  if (!g) return bad(i, 'ไม่พบระบบนี้แล้ว (อาจถูกลบไป)');
  const target = i.channels.first();
  await i.deferUpdate();
  const err = await sendSvrPanel(g, i.guild, target.id);
  const at = Math.floor(Date.now() / 1000);
  return i.editReply(svrPanel(g, err
    ? `❌ ${err}`
    : `✅ ส่งปุ่มเสนอระบบ **${g.name}** ไปที่ <#${target.id}> แล้ว เมื่อ <t:${at}:T>\nเลือกห้องอีกครั้งเพื่อส่งซ้ำได้`));
}

// เลือกห้องปุ่มกดจากเมนูส่วนตัว (ปุ่ม 📤 ส่งปุ่มจริง)
async function handleSvrSendPick(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
  const g = serverById(i.guildId, i.customId.split(':')[1]);
  if (!g) return bad(i, 'ไม่พบระบบนี้แล้ว (อาจถูกลบไป)');
  const target = i.channels.first();
  await i.deferUpdate();
  const err = await sendSvrPanel(g, i.guild, target.id);
  return i.editReply({
    content: err ? `❌ ${err}` : `✅ ส่งปุ่มเสนอระบบ **${g.name}** ไปที่ <#${target.id}> แล้ว`,
    components: [],
  });
}

// ---------- /serverpobox ----------
async function handleSetServer(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้นที่ใช้คำสั่งนี้ได้');
  const sub = i.options.getSubcommand();
  const gid = i.guildId;

  if (sub === 'create') {
    const name = i.options.getString('name').trim();
    if (!name) return bad(i, 'ชื่อระบบห้ามว่าง');
    if (findServer(gid, name)) {
      return bad(i, `มีระบบชื่อ **${name}** อยู่แล้ว กรุณาใช้ชื่ออื่น (หรือใช้ /serverpobox edit เพื่อแก้ของเดิม)`);
    }
    const g = {
      id: crypto.randomBytes(4).toString('hex'),
      guildId: gid,
      name,
      title: '💡 เสนอระบบใหม่',
      description: 'มีอะไรอยากเสนอให้เซิร์ฟเวอร์ กดปุ่มด้านล่างแล้วเขียนได้เลย\nทีมงานจะนำไปพิจารณาและแก้ไขให้',
      author: null, authorIcon: null,
      image: null, thumbnail: null, footer: null,
      color: '#FEE75C',
      timestamp: true,
      buttonLabel: null, btnColor: null,
      question: null,
      displayChannelId: null, adminChannelId: null, approverRoles: [],
      createdBy: i.user.id, createdAt: Date.now(),
    };
    guildServers(gid).push(g);
    save();
    return i.reply(svrPanel(g, `✅ สร้างระบบ **${name}** แล้ว\n` +
      '**ขั้นตอนต่อไป:** ① เลือก “ห้องแสดงข้อเสนอ” ② เลือก “ห้องแอดมินกดปุ่ม” ③ เลือกห้องจากเมนูแรกเพื่อส่งปุ่มจริง'));
  }

  if (sub === 'list') {
    const list = guildServers(gid);
    if (!list.length) return bad(i, 'ยังไม่มีระบบที่สร้างไว้ ใช้ /serverpobox create เพื่อสร้าง');
    const lines = list.map((g, n) => `**${n + 1}.** \`${g.name}\`${g.title ? ` — ${g.title}` : ''}`);
    return i.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2)
        .setTitle(`📚 ระบบรับข้อเสนอที่สร้างไว้ (${list.length})`)
        .setDescription(lines.join('\n').slice(0, 4000))],
      flags: MessageFlags.Ephemeral,
    });
  }

  const name = i.options.getString('name');
  const g = findServer(gid, name);
  if (!g) return bad(i, `ไม่พบระบบชื่อ **${name}** (ดูรายชื่อด้วย /serverpobox list)`);

  if (sub === 'edit') return i.reply(svrPanel(g));

  if (sub === 'send') {
    const target = i.options.getChannel('channel') || i.channel;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const err = await sendSvrPanel(g, i.guild, target.id);
    return i.editReply(err ? `❌ ${err}` : `✅ ส่งปุ่มเสนอระบบ **${g.name}** ไปที่ <#${target.id}> แล้ว`);
  }

  if (sub === 'delete') {
    data.servers[gid] = guildServers(gid).filter((x) => x.id !== g.id);
    save();
    return i.reply({ content: `🗑️ ลบระบบ **${g.name}** แล้ว (ปุ่มที่ส่งไปแล้วจะกดไม่ได้อีก)`, flags: MessageFlags.Ephemeral });
  }
}

// =====================================================================
// ฝั่งสมาชิก: กดปุ่ม → เขียนข้อเสนอ → ไปแสดงในห้องแสดง + ห้องแอดมิน
// =====================================================================
const svrWait = (userId) => {
  const left = SVR_COOLDOWN_MS - (Date.now() - (svrCooldown.get(userId) || 0));
  return left > 0 ? Math.ceil(left / 1000) : 0;
};

// สมาชิกกดปุ่มเสนอระบบ → เปิดกล่อง
async function handleSvrOpen(i) {
  const g = serverById(i.guildId, i.customId.split(':')[1]);
  if (!g) return bad(i, 'ระบบนี้ถูกปิดแล้ว');
  if (svrReady(g, i.guild)) return bad(i, 'ระบบเสนอยังตั้งค่าไม่เสร็จ กรุณาแจ้งทีมงาน');
  const wait = svrWait(i.user.id);
  if (wait) return bad(i, `ส่งข้อเสนอถี่เกินไป กรุณารออีก ${wait} วินาที`);
  return i.showModal(new ModalBuilder()
    .setCustomId(`svrform:${g.id}`)
    .setTitle('เสนอระบบ / ข้อเสนอแนะ')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('text')
        .setLabel((g.question || 'อยากเสนออะไร').slice(0, 45))
        .setStyle(PARA)
        .setRequired(true)
        .setMinLength(5)
        .setMaxLength(1500)
        .setPlaceholder('เขียนสิ่งที่อยากเสนอได้เลย'),
    )));
}

// สร้าง Embed ข้อเสนอ (ใช้ทั้งห้องแสดงข้อเสนอและห้องแอดมิน) — แสดงชื่อ + รูปโปรไฟล์ผู้เสนอ
// box = หน้าตากล่องที่แอดมินตั้งไว้ (หัวข้อ/ข้อความ/สี/รูป/footer)
//   ตัวแปรที่ใช้ได้: {text} = ข้อเสนอ, {user} = แท็กผู้เสนอ, {name} = ชื่อผู้เสนอ
function svrEmbed(s, box) {
  const name = String(s.displayName || s.username);
  const who = s.preview ? '**@ผู้เสนอ**' : `<@${s.user}>`;
  // หัวข้อ/footer แสดงแท็กไม่ได้ ใช้ชื่อธรรมดาแทน
  const fill = (t, plain = false) => String(t || '')
    .replace(/\{user\}/g, plain ? name : who)
    .replace(/\{name\}/g, name);

  let desc = fill(box.description);
  desc = desc.includes('{text}')
    ? desc.split('{text}').join(s.text) // แทน {text} เป็นอันสุดท้าย ข้อความสมาชิกจึงไม่ถูกตีความซ้ำ
    : (desc ? `${desc}\n\n${s.text}` : s.text);
  if (s.preview) desc = desc.slice(0, 400);

  const e = new EmbedBuilder()
    .setColor(box.color || 0xfee75c)
    .setDescription(desc.slice(0, 4096))
    .setAuthor({ name: name.slice(0, 256) })
    .addFields(
      { name: '👤 ผู้เสนอ', value: `${who} (\`${s.username}\`)`, inline: true },
      { name: '📌 สถานะ', value: SVR_WORKING, inline: true },
    )
    .setTimestamp(s.createdAt);
  const title = fill(box.title, true);
  if (title) e.setTitle(title.slice(0, 256));
  if (box.image) e.setImage(box.image);
  if (s.avatar) e.setThumbnail(s.avatar); // รูปโปรไฟล์ผู้เสนอ มุมขวาบนของกล่อง
  const footer = fill(box.footer, true);
  if (footer) e.setFooter({ text: footer.slice(0, 2048) });
  return e;
}

// เปลี่ยน Embed ที่มีอยู่ให้เป็นสถานะ "แก้ไขแล้ว" (ใช้ข้อมูลจากตัวข้อความเอง ไม่พึ่งฐานข้อมูล)
function svrMarkDone(embed, byId) {
  const e = EmbedBuilder.from(embed).setColor(0x57f287);
  const fields = (embed.fields || []).map((f) => (f.name.includes('สถานะ')
    ? { name: f.name, value: byId ? `${SVR_DONE}\nโดย <@${byId}>` : SVR_DONE, inline: f.inline }
    : { name: f.name, value: f.value, inline: f.inline }));
  return e.setFields(fields);
}

// สมาชิกกดส่งข้อเสนอ
async function handleSvrForm(i) {
  const g = serverById(i.guildId, i.customId.split(':')[1]);
  if (!g) return bad(i, 'ระบบนี้ถูกปิดแล้ว');
  const text = i.fields.getTextInputValue('text').trim();
  if (text.length < 5) return bad(i, 'กรุณาเขียนข้อเสนออย่างน้อย 5 ตัวอักษร');
  const wait = svrWait(i.user.id);
  if (wait) return bad(i, `ส่งข้อเสนอถี่เกินไป กรุณารออีก ${wait} วินาที`);

  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const disp = g.displayChannelId ? await i.guild.channels.fetch(g.displayChannelId).catch(() => null) : null;
  const adm = g.adminChannelId ? await i.guild.channels.fetch(g.adminChannelId).catch(() => null) : null;
  if (!disp?.isTextBased() || !adm?.isTextBased()) {
    return i.editReply('❌ ระบบเสนอยังตั้งค่าไม่เสร็จ กรุณาแจ้งทีมงาน');
  }

  const s = {
    user: i.user.id,
    username: i.user.username,
    displayName: i.member?.displayName || i.user.globalName || i.user.username,
    avatar: i.member?.displayAvatarURL?.() || i.user.displayAvatarURL(),
    text: text.slice(0, 1500), createdAt: Date.now(),
  };

  // 1) ห้องแสดงข้อเสนอ (สถานะ 🛠️ กำลังแก้ไขระบบ)
  let dispMsg;
  try {
    dispMsg = await disp.send({ embeds: [svrEmbed(s, svrBox(g, 'disp'))], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('ส่งข้อเสนอเข้าห้องแสดงไม่สำเร็จ:', err.message);
    return i.editReply('❌ ส่งข้อเสนอไม่สำเร็จ กรุณาแจ้งทีมงาน (บอทอาจไม่มีสิทธิ์ในห้องแสดงข้อเสนอ)');
  }

  // 2) ห้องแอดมิน (มีปุ่ม ✅ ระบบนี้ได้รับการแก้ไขแล้ว) — เก็บอ้างอิงห้องแสดงไว้ในรหัสปุ่ม
  const approvers = (g.approverRoles || []).filter((id) => i.guild.roles.cache.has(id));
  const admEmbed = svrEmbed(s, svrBox(g, 'adm'))
    .addFields({ name: '🔗 ข้อความที่แสดง', value: `[ไปที่ข้อความ](${dispMsg.url})` });
  try {
    await adm.send({
      content: approvers.length ? approvers.map((r) => `<@&${r}>`).join(' ') : undefined,
      embeds: [admEmbed],
      components: [new ActionRowBuilder().addComponents(
        mk(`svrdone:${disp.id}:${dispMsg.id}:${g.id}`, '✅ ระบบนี้ได้รับการแก้ไขแล้ว', ButtonStyle.Success),
        mk(`svrfail:${disp.id}:${dispMsg.id}:${g.id}`, SVR_FAILED, ButtonStyle.Danger))],
      allowedMentions: { roles: approvers, users: [] },
    });
  } catch (err) {
    console.error('ส่งข้อเสนอเข้าห้องแอดมินไม่สำเร็จ:', err.message);
    dispMsg.delete().catch(() => {}); // ไม่ให้เหลือข้อเสนอที่แอดมินไม่เห็น
    return i.editReply('❌ ส่งข้อเสนอไม่สำเร็จ กรุณาแจ้งทีมงาน (บอทอาจไม่มีสิทธิ์ในห้องแอดมิน)');
  }

  svrCooldown.set(i.user.id, Date.now());
  return i.editReply(`✅ ส่งข้อเสนอเรียบร้อยแล้ว ดูได้ที่ <#${disp.id}>\nสถานะตอนนี้: ${SVR_WORKING}`);
}

// แอดมินกดปุ่ม "ระบบนี้ได้รับการแก้ไขแล้ว"
async function handleSvrDone(i) {
  const emb = i.message.embeds[0];
  if (!emb) return bad(i, 'อ่านข้อมูลข้อเสนอนี้ไม่ได้');
  // รหัสปุ่มใหม่: svrdone:<ห้องแสดง>:<ข้อความแสดง>:<ระบบ> • ข้อความเก่า (ก่อนอัปเดต) เก็บอ้างอิงไว้ใน footer
  const parts = i.customId.split(':');
  let dispChId, dispMsgId, panelId;
  if (parts.length >= 4) {
    [, dispChId, dispMsgId, panelId] = parts;
  } else {
    const ref = /ref:(\d+):(\d+):([0-9a-f]+)/.exec(emb.footer?.text || '');
    if (!ref) return bad(i, 'อ่านข้อมูลข้อเสนอนี้ไม่ได้');
    [, dispChId, dispMsgId, panelId] = ref;
  }

  const g = serverById(i.guildId, panelId); // ถ้าระบบถูกลบไปแล้ว จะเหลือเฉพาะแอดมิน/Manage Server กดได้
  const m = i.member;
  const allowed = m && (
    m.permissions.has(PermissionFlagsBits.Administrator) ||
    m.permissions.has(PermissionFlagsBits.ManageGuild) ||
    (g?.approverRoles || []).some((id) => m.roles.cache.has(id))
  );
  if (!allowed) return bad(i, 'เฉพาะแอดมินหรือทีมงานที่ได้รับสิทธิ์เท่านั้น');

  if (svrBusy.has(i.message.id)) return bad(i, 'ข้อเสนอนี้กำลังถูกดำเนินการอยู่ รอสักครู่');
  svrBusy.add(i.message.id);
  try {
    await i.deferUpdate();

    // อัปเดตข้อความในห้องแสดงข้อเสนอ
    let warn = null;
    try {
      const ch = await i.guild.channels.fetch(dispChId);
      const msg = await ch.messages.fetch(dispMsgId);
      await msg.edit({ embeds: [svrMarkDone(msg.embeds[0], null)], allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('อัปเดตข้อความห้องแสดงข้อเสนอไม่สำเร็จ:', err.message);
      warn = '⚠️ อัปเดตข้อความในห้องแสดงข้อเสนอไม่สำเร็จ (ข้อความอาจถูกลบ หรือบอทไม่มีสิทธิ์)';
    }

    // อัปเดตข้อความในห้องแอดมิน (เอาปุ่มออก)
    await i.editReply({
      content: i.message.content || undefined,
      embeds: [svrMarkDone(emb, i.user.id)],
      components: [],
      allowedMentions: { parse: [] },
    });
    if (warn) await i.followUp({ content: warn, flags: MessageFlags.Ephemeral });
  } finally {
    svrBusy.delete(i.message.id);
  }
}

// =====================================================================
// ปุ่ม ❌ ไม่สามารถแก้ไขระบบนี้ได้ (ห้องแอดมิน)
//  กด → กล่องให้เขียนสาเหตุ → ส่ง → อัปเดตกล่องข้อเสนอทั้งห้องแสดงและห้องแอดมิน
//  ช่อง "📝 สาเหตุ" จะอยู่ใต้ ผู้เสนอ/สถานะ และแสดงเฉพาะกรณีกดปุ่มนี้เท่านั้น
// =====================================================================
// เปลี่ยน Embed เป็นสถานะ "ไม่สามารถแก้ไขได้" + แทรกช่องสาเหตุต่อจากช่องสถานะ
function svrMarkFailed(embed, byId, reason) {
  const e = EmbedBuilder.from(embed).setColor(0xed4245);
  const fields = [];
  for (const f of (embed.fields || [])) {
    if (f.name.includes('สถานะ')) {
      fields.push({ name: f.name, value: byId ? `${SVR_FAILED}\nโดย <@${byId}>` : SVR_FAILED, inline: f.inline });
      fields.push({ name: '📝 สาเหตุ', value: reason.slice(0, 1024), inline: false });
    } else {
      fields.push({ name: f.name, value: f.value, inline: f.inline });
    }
  }
  return e.setFields(fields);
}

// สิทธิ์กดปุ่มในห้องแอดมิน (เหมือนปุ่ม "แก้ไขแล้ว": แอดมิน / Manage Server / ยศทีมงานที่เลือกไว้)
function svrCanApprove(i, g) {
  const m = i.member;
  return !!m && (
    m.permissions.has(PermissionFlagsBits.Administrator) ||
    m.permissions.has(PermissionFlagsBits.ManageGuild) ||
    (g?.approverRoles || []).some((id) => m.roles.cache.has(id))
  );
}

// แอดมินกดปุ่ม "ไม่สามารถแก้ไขระบบนี้ได้" → เปิดกล่องเขียนสาเหตุ
async function handleSvrFailButton(i) {
  const [, dispChId, dispMsgId, panelId] = i.customId.split(':');
  const g = serverById(i.guildId, panelId);
  if (!svrCanApprove(i, g)) return bad(i, 'เฉพาะแอดมินหรือทีมงานที่ได้รับสิทธิ์เท่านั้น');
  if (!i.message.components?.length) return bad(i, 'ข้อเสนอนี้ถูกดำเนินการไปแล้ว');
  return i.showModal(new ModalBuilder()
    .setCustomId(`svrfailm:${dispChId}:${dispMsgId}:${panelId}`)
    .setTitle('สาเหตุที่ไม่สามารถแก้ไขระบบได้')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('เขียนสาเหตุ')
        .setStyle(PARA)
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(1000)
        .setPlaceholder('เช่น ระบบนี้ทำไม่ได้เพราะข้อจำกัดของ ... '),
    )));
}

// ส่งสาเหตุ → อัปเดตห้องแสดงข้อเสนอ + ห้องแอดมิน
async function handleSvrFailSubmit(i) {
  const [, dispChId, dispMsgId, panelId] = i.customId.split(':');
  const g = serverById(i.guildId, panelId);
  if (!svrCanApprove(i, g)) return bad(i, 'เฉพาะแอดมินหรือทีมงานที่ได้รับสิทธิ์เท่านั้น');
  if (!i.isFromMessage()) return bad(i, 'อ่านข้อมูลข้อเสนอนี้ไม่ได้');
  const emb = i.message.embeds[0];
  if (!emb) return bad(i, 'อ่านข้อมูลข้อเสนอนี้ไม่ได้');
  if (!i.message.components?.length) return bad(i, 'ข้อเสนอนี้ถูกดำเนินการไปแล้ว'); // มีคนกดปุ่มอื่นตัดหน้าไปแล้ว

  const reason = i.fields.getTextInputValue('reason').trim();
  if (!reason) return bad(i, 'กรุณาเขียนสาเหตุ');

  if (svrBusy.has(i.message.id)) return bad(i, 'ข้อเสนอนี้กำลังถูกดำเนินการอยู่ รอสักครู่');
  svrBusy.add(i.message.id);
  try {
    await i.deferUpdate();

    // อัปเดตข้อความในห้องแสดงข้อเสนอ
    let warn = null;
    try {
      const ch = await i.guild.channels.fetch(dispChId);
      const msg = await ch.messages.fetch(dispMsgId);
      await msg.edit({ embeds: [svrMarkFailed(msg.embeds[0], null, reason)], allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('อัปเดตข้อความห้องแสดงข้อเสนอไม่สำเร็จ:', err.message);
      warn = '⚠️ อัปเดตข้อความในห้องแสดงข้อเสนอไม่สำเร็จ (ข้อความอาจถูกลบ หรือบอทไม่มีสิทธิ์)';
    }

    // อัปเดตข้อความในห้องแอดมิน (เอาปุ่มออกทั้งสองปุ่ม)
    await i.editReply({
      content: i.message.content || undefined,
      embeds: [svrMarkFailed(emb, i.user.id, reason)],
      components: [],
      allowedMentions: { parse: [] },
    });
    if (warn) await i.followUp({ content: warn, flags: MessageFlags.Ephemeral });
  } finally {
    svrBusy.delete(i.message.id);
  }
}

client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    guild.commands.set([ticketCmd, setServerCmd]).catch(console.error);
  }
  for (const [channelId, info] of Object.entries(data.tickets)) {
    // ห้องที่ยังรอทีมงานกดสนทนา (expiresAt เป็น null) ยังไม่จับเวลา
    if (info.expiresAt) scheduleDelete(channelId, info.expiresAt - Date.now());
  }
  startCountdownTicker();
  sweepTickets();
  setInterval(sweepTickets, 60 * 1000);
});

client.on('guildCreate', (guild) => {
  guild.commands.set([ticketCmd, setServerCmd]).catch(console.error);
});


// ---------- สร้าง Ticket ----------
async function handleCreateTicket(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  // นับ 1 → 9999 แล้ววนกลับไปเริ่มที่ 1 ใหม่
  const prev = data.counters[i.guildId] || 0;
  const n = (prev % 9999) + 1;
  data.counters[i.guildId] = n;
  const number = String(n).padStart(4, '0');

  const allow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ];
  // ผู้สร้าง ticket เห็นห้องได้ แต่พิมพ์ไม่ได้จนกว่าทีมงานจะกดปุ่ม "สนทนา"
  const ownerAllow = allow.filter((p) => p !== PermissionFlagsBits.SendMessages);
  const overwrites = [
    { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: i.user.id, allow: ownerAllow, deny: [PermissionFlagsBits.SendMessages] },
    { id: client.user.id, allow: [...allow, PermissionFlagsBits.ManageChannels] },
  ];

  // Embed ที่ถูกกดสร้าง ticket (เพื่อดึงข้อความ/หมวดหมู่/ปุ่มตอบด่วนที่ตั้งไว้)
  const src = guildEmbeds(i.guildId).find((x) => x.id === i.customId.split(':')[1]);

  // ยศทีมงาน = STAFF_ROLE_ID (ถ้ามี) + ยศที่เลือกไว้ใน Embed → เห็นห้องได้
  const staffRoles = [...new Set([STAFF_ROLE_ID, ...((src && src.staffRoles) || [])]
    .filter((id) => id && i.guild.roles.cache.has(id)))];
  for (const id of staffRoles) overwrites.push({ id, allow });

  // หมวดหมู่: ตั้งใน Embed ก่อน ถ้าไม่มีใช้ CATEGORY_ID (ต้องเป็นหมวดหมู่ที่ยังมีอยู่จริง)
  const wantCat = (src && src.categoryId) || CATEGORY_ID;
  const catCh = wantCat ? i.guild.channels.cache.get(wantCat) : null;
  const parent = catCh && catCh.type === ChannelType.GuildCategory ? catCh.id : null;
  if (wantCat && !parent) console.error('ไม่พบหมวดหมู่ที่ตั้งไว้ (อาจถูกลบ) สร้างห้องนอกหมวดหมู่แทน:', wantCat);

  let channel;
  try {
    channel = await i.guild.channels.create({
      name: `ticket-${number}`,
      type: ChannelType.GuildText,
      parent,
      permissionOverwrites: overwrites,
    });
  } catch (err) {
    console.error('สร้างห้องไม่สำเร็จ:', err);
    if (data.counters[i.guildId] === n) { data.counters[i.guildId] = prev; save(); }
    return i.editReply(`❌ สร้างห้องไม่สำเร็จ: ${String(err.message).slice(0, 300)}`);
  }

  // ยังไม่จับเวลา (expiresAt = null) จนกว่าทีมงานจะกดปุ่ม "สนทนา"
  const info = {
    owner: i.user.id,
    number,
    waitMsg: (src && src.waitMsg) || DEFAULT_WAIT_MSG,
    chatMsg: (src && src.chatMsg) || null,
    quick: (src && src.quickReplies && src.quickReplies.length) ? src.quickReplies : null,
    tTitle: (src && src.ticketTitle) || null,
    tColor: (src && src.ticketColor) || null,
    tImage: (src && src.ticketImage) || null,
    staffRoles, // ยศทีมงานที่ใช้ปุ่มในห้องนี้ได้
    styles: { // สีปุ่มในห้อง (null = ค่าเริ่มต้น)
      start: (src && src.btnStart) || null,
      close: (src && src.btnClose) || null,
    },
    staff: null,
    expiresAt: null,
    waitUntil: null, // ไม่จับเวลาตอนรอทีมงาน (เริ่มนับเมื่อทีมงานกดสนทนา)
    messageId: null,
    warned: false,
  };
  data.tickets[channel.id] = info;
  save();

  const msg = await channel.send({ content: `<@${i.user.id}>`, ...ticketPayload(info) });
  info.messageId = msg.id; // เก็บไว้เพื่ออัปเดตเวลานับถอยหลัง
  save();
  return i.editReply(`✅ สร้างห้องให้แล้ว: ${channel}`);
}

// แทนที่ {user} / {number} ในข้อความที่แอดมินตั้งเอง
const fillText = (str, info) => String(str)
  .replace(/\{user\}/g, `<@${info.owner}>`)
  .replace(/\{number\}/g, info.number);

// แปลงมิลลิวินาทีเป็น นาที:วินาที เช่น 4:32
const fmtRemain = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ข้อมูลสมมติสำหรับดูตัวอย่างกล่องในห้อง Ticket ในแผงแก้ไข
const previewInfo = (e) => ({
  owner: e.createdBy, number: '0001',
  waitMsg: e.waitMsg || DEFAULT_WAIT_MSG, chatMsg: e.chatMsg,
  tTitle: e.ticketTitle, tColor: e.ticketColor, tImage: e.ticketImage,
  expiresAt: null,
});

// กล่อง Embed ในห้อง ticket (สถานะ: รอทีมงาน / กำลังสนทนา + นับถอยหลัง)
function ticketEmbed(info, preview = false) {
  const started = !!info.expiresAt;
  const remain = started ? Math.max(0, info.expiresAt - Date.now()) : TICKET_LIFETIME;

  let color = info.tColor || 0xfee75c;
  if (started) color = remain <= 60000 ? 0xed4245 : remain <= 120000 ? 0xfaa61a : 0x57f287;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(fillText(info.tTitle || '🎫 Ticket #{number}', info).slice(0, 256));
  if (info.tImage) embed.setImage(info.tImage);

  if (started) {
    const total = 10;
    const filled = Math.min(total, Math.ceil((remain / TICKET_LIFETIME) * total));
    const bar = '▰'.repeat(filled) + '▱'.repeat(total - filled);
    embed
      .setDescription(`สวัสดี <@${info.owner}> 👋\n${fillText(info.chatMsg || DEFAULT_CHAT_MSG, info)}`.slice(0, 4096))
      .addFields(
        { name: '👨‍💼 ทีมงานที่รับเรื่อง', value: `<@${info.staff}>`, inline: true },
        {
          name: '⏳ เวลาที่เหลือ',
          value: `**${fmtRemain(remain)}** นาที\n${bar}\nปิดเวลา <t:${Math.floor(info.expiresAt / 1000)}:T>`,
          inline: true,
        },
      );
  } else {
    embed
      .setDescription(`สวัสดี <@${info.owner}> 👋\n\n${fillText(info.waitMsg || DEFAULT_WAIT_MSG, info)}`.slice(0, 4096))
      .addFields({ name: '⏳ สถานะ', value: 'รอทีมงานกดสนทนา — ตอนนี้ยังพิมพ์ในห้องนี้ไม่ได้ (ยังไม่เริ่มจับเวลา)' });
  }
  if (preview) embed.setFooter({ text: 'ตัวอย่างกล่องในห้อง Ticket (ตอนรอทีมงาน)' });
  return embed;
}

// ปุ่มใต้ Embed ในห้อง ticket: สนทนา (ก่อนรับเรื่อง) / Close ticket
function controlRows(info) {
  const started = !!info.expiresAt;
  const st = info.styles || {};
  const rows = [];

  const row = new ActionRowBuilder();
  if (!started) {
    row.addComponents(new ButtonBuilder()
      .setCustomId('ticket_start')
      .setLabel('💬 สนทนา')
      .setStyle(btnStyle(st.start, ButtonStyle.Success)));
  }
  row.addComponents(new ButtonBuilder()
    .setCustomId('ticket_close')
    .setLabel('🔒 Close ticket')
    .setStyle(btnStyle(st.close, ButtonStyle.Danger)));
  rows.push(row);
  return rows;
}

// ข้อความ + ปุ่มในห้อง ticket (ปุ่มทั้งหมดอยู่ใต้ Embed ตรงๆ)
function ticketPayload(info) {
  return { embeds: [ticketEmbed(info)], components: controlRows(info) };
}

// ทีมงานกดปุ่มตอบด่วน → บอทพิมพ์ข้อความนั้นลงแชทให้เลย
async function handleQuickReply(i) {
  const info = data.tickets[i.channelId];
  if (!info) return bad(i, 'ไม่พบข้อมูล ticket นี้');
  if (!isStaff(i, info)) return bad(i, 'เฉพาะทีมงานเท่านั้นที่ใช้ปุ่มตอบด่วนได้');
  if (!info.expiresAt) return bad(i, 'กด “สนทนา” ก่อน จึงจะใช้ปุ่มตอบด่วนได้');

  const list = info.quick && info.quick.length ? info.quick : DEFAULT_QUICK;
  const text = list[Number(i.customId.split(':')[1])];
  if (!text) return bad(i, 'ไม่พบข้อความของปุ่มนี้');

  await i.deferUpdate();
  // ส่งเหมือนคนกดพิมพ์เอง โดย @ ชื่อคนกด (แสดงเป็นแท็กแต่ไม่แจ้งเตือนซ้ำ ยกเว้นเจ้าของห้อง)
  await i.channel.send({
    content: `<@${i.user.id}>: ${fillText(text, info)}`.slice(0, 2000),
    allowedMentions: { users: [info.owner] },
  });
}

// เลือกหมวดหมู่ของห้อง Ticket จากเมนูในกล่องตัวอย่าง
async function handleCategorySelect(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
  const id = i.customId.split(':')[1];
  const e = guildEmbeds(i.guildId).find((x) => x.id === id);
  if (!e) return bad(i, 'ไม่พบ Embed นี้แล้ว (อาจถูกลบไป)');
  e.categoryId = i.channels.first().id;
  save();
  return i.update(panelPayload(e));
}

// เลือกยศทีมงานของ Embed นี้ (เห็นห้อง + เห็นปุ่มเมนูทีมงานในห้อง Ticket)
async function handleRoleSelect(i) {
  if (!isAdmin(i)) return bad(i, 'เฉพาะแอดมินเท่านั้น');
  const id = i.customId.split(':')[1];
  const e = guildEmbeds(i.guildId).find((x) => x.id === id);
  if (!e) return bad(i, 'ไม่พบ Embed นี้แล้ว (อาจถูกลบไป)');
  e.staffRoles = [...i.values];
  save();
  return i.update(panelPayload(e));
}

// อัปเดตเวลานับถอยหลังในกล่องของทุกห้องที่กำลังสนทนา
let tickRunning = false;
function startCountdownTicker() {
  setInterval(async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      const now = Date.now();
      for (const [channelId, info] of Object.entries(data.tickets)) {
        if (!info.expiresAt || !info.messageId || info.expiresAt <= now) continue;
        const ch = client.channels.cache.get(channelId);
        if (!ch) continue;
        try {
          await ch.messages.edit(info.messageId, ticketPayload(info));
          // เตือนครั้งเดียวตอนเหลือไม่ถึง 1 นาที
          if (!info.warned && info.expiresAt > now && info.expiresAt - now <= 60000) {
            info.warned = true;
            save();
            await ch.send(`⚠️ <@${info.owner}> เหลือเวลาอีกไม่ถึง 1 นาที ห้องนี้จะถูกลบอัตโนมัติ`).catch(() => {});
          }
        } catch (err) {
          if (err.code === 10008) info.messageId = null; // ข้อความถูกลบแล้ว เลิกอัปเดต
          else console.error('อัปเดตเวลานับถอยหลังไม่สำเร็จ:', err.message);
        }
      }
    } finally {
      tickRunning = false;
    }
  }, COUNTDOWN_TICK_MS);
}

// ทีมงาน = แอดมิน / มีสิทธิ์จัดการห้อง / มี role ทีมงาน (STAFF_ROLE_ID หรือยศที่เลือกไว้ใน Embed ของห้องนั้น)
const isStaff = (i, info) => {
  const m = i.member;
  if (!m) return false;
  if (m.permissions.has(PermissionFlagsBits.Administrator) ||
      m.permissions.has(PermissionFlagsBits.ManageChannels)) return true;
  const ids = [STAFF_ROLE_ID, ...((info && info.staffRoles) || [])].filter(Boolean);
  return ids.some((id) => m.roles.cache.has(id));
};

// ทีมงานกด "สนทนา" → ปลดล็อกให้ผู้ใช้พิมพ์ + เริ่มจับเวลา
async function handleStartTicket(i) {
  const info = data.tickets[i.channelId];
  if (!info) return bad(i, 'ไม่พบข้อมูล ticket นี้');
  if (!isStaff(i, info)) return bad(i, 'เฉพาะทีมงานเท่านั้นที่กดสนทนาได้');
  if (info.expiresAt) return bad(i, 'ห้องนี้เริ่มสนทนาไปแล้ว');

  await i.deferUpdate();
  try {
    await i.channel.permissionOverwrites.edit(info.owner, { SendMessages: true });
  } catch (err) {
    console.error('ปลดล็อกการพิมพ์ไม่สำเร็จ:', err);
    return i.followUp({ content: `❌ ปลดล็อกการพิมพ์ไม่สำเร็จ: ${String(err.message).slice(0, 200)}`, flags: MessageFlags.Ephemeral });
  }

  info.staff = i.user.id;
  info.expiresAt = Date.now() + TICKET_LIFETIME;
  info.messageId = info.messageId || i.message.id; // ใช้อัปเดตเวลานับถอยหลัง
  info.warned = false;
  info.waitUntil = null; // เริ่มสนทนาแล้ว ใช้เวลานับถอยหลัง 30 นาทีแทน (TICKET_LIFETIME)
  save();
  scheduleDelete(i.channelId, TICKET_LIFETIME);

  await i.editReply(ticketPayload(info));
  await i.channel.send(`💬 ทีมงาน <@${i.user.id}> เข้ามาแล้ว <@${info.owner}> พิมพ์ข้อความได้เลย`).catch(console.error);
}


// ---------- Interactions ----------
client.on('interactionCreate', async (i) => {
  try {
    // autocomplete ชื่อ Embed
    if (i.isAutocomplete() && i.commandName === 'ticket') {
      const q = norm(i.options.getFocused());
      const choices = guildEmbeds(i.guildId)
        .filter((e) => norm(e.name).includes(q))
        .slice(0, 25)
        .map((e) => ({ name: e.name.slice(0, 100), value: e.name }));
      return await i.respond(choices);
    }

    if (i.isChatInputCommand() && i.commandName === 'ticket') return await handleTicketCommand(i);
    if (i.isChannelSelectMenu() && i.customId.startsWith('embcat:')) return await handleCategorySelect(i);
    if (i.isChannelSelectMenu() && i.customId.startsWith('embedsend:')) return await handleSendSelect(i);
    if (i.isRoleSelectMenu() && i.customId.startsWith('embrole:')) return await handleRoleSelect(i);
    if (i.isModalSubmit() && i.customId.startsWith('embm:')) return await handleEmbModal(i);
    if (i.isButton() && i.customId.startsWith('emb:')) return await handleEmbButton(i);

    // ----- /serverpobox (ระบบเสนอระบบ) -----
    if (i.isAutocomplete() && i.commandName === SVR_CMD) {
      const q = norm(i.options.getFocused());
      const choices = guildServers(i.guildId)
        .filter((e) => norm(e.name).includes(q))
        .slice(0, 25)
        .map((e) => ({ name: e.name.slice(0, 100), value: e.name }));
      return await i.respond(choices);
    }
    if (i.isChatInputCommand() && i.commandName === SVR_CMD) return await handleSetServer(i);
    if (i.isButton() && i.customId.startsWith('svr:')) return await handleSvrButton(i);
    if (i.isModalSubmit() && i.customId.startsWith('svrm:')) return await handleSvrModal(i);
    if (i.isChannelSelectMenu() && i.customId.startsWith('svrsend:')) return await handleSvrSendSelect(i);
    if (i.isChannelSelectMenu() && i.customId.startsWith('svrsendp:')) return await handleSvrSendPick(i);
    if (i.isChannelSelectMenu() && (i.customId.startsWith('svrdisp:') || i.customId.startsWith('svradm:'))) {
      return await handleSvrConfigSelect(i);
    }
    if (i.isRoleSelectMenu() && i.customId.startsWith('svrroles:')) return await handleSvrConfigSelect(i);
    if (i.isButton() && i.customId.startsWith('svr_open:')) return await handleSvrOpen(i);
    if (i.isModalSubmit() && i.customId.startsWith('svrform:')) return await handleSvrForm(i);
    if (i.isButton() && (i.customId === 'svrdone' || i.customId.startsWith('svrdone:'))) return await handleSvrDone(i);
    if (i.isButton() && i.customId.startsWith('svrfail:')) return await handleSvrFailButton(i);
    if (i.isModalSubmit() && i.customId.startsWith('svrfailm:')) return await handleSvrFailSubmit(i);

    if (!i.isButton()) return;

    // ปุ่ม Create ticket (ติด id Embed ไว้ เช่น ticket_create:ab12cd34)
    if (i.customId === 'ticket_create' || i.customId.startsWith('ticket_create:')) {
      return await handleCreateTicket(i);
    }
    if (i.customId.startsWith('ticket_qr:')) return await handleQuickReply(i);
    if (i.customId === 'ticket_start') return await handleStartTicket(i);

    if (i.customId === 'ticket_close') {
      const info = data.tickets[i.channelId];
      const canClose = (info && info.owner === i.user.id) || isStaff(i, info);
      if (!canClose) return bad(i, 'คุณไม่มีสิทธิ์ปิดห้องนี้');

      await i.reply('🔒 กำลังลบห้อง...');
      return deleteTicket(i.channelId);
    }
  } catch (err) {
    console.error(err);
    if (i.isAutocomplete?.()) return;
    const payload = { content: '❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้ง', flags: MessageFlags.Ephemeral };
    if (i.deferred || i.replied) i.followUp(payload).catch(() => {});
    else i.reply(payload).catch(() => {});
  }
});

(async () => {
  await loadData();
  await client.login(process.env.DISCORD_TOKEN);
})().catch((e) => { console.error('เริ่มบอทไม่สำเร็จ:', e); process.exit(1); });
