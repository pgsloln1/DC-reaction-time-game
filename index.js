import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { customAlphabet } from 'nanoid';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  PUBLIC_URL,
  PORT = 3000,
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !PUBLIC_URL) {
  console.error('Missing DISCORD_TOKEN, DISCORD_CLIENT_ID or PUBLIC_URL in .env');
  process.exit(1);
}

// --- Discord setup ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// --- Commands ---
const commands = [
  {
    name: 'play',
    description: 'Získať odkaz na hru (platný ~15 minút).'
  },
  {
    name: 'leaderboard',
    description: 'Zobraziť alebo obnoviť tabuľku lídrov v tomto kanáli.'
  }
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  try {
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
}

// --- DB setup ---
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS scores (
  channelId TEXT NOT NULL,
  userId TEXT NOT NULL,
  username TEXT NOT NULL,
  avgMs INTEGER NOT NULL,
  bestMs INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (channelId, userId)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Store leaderboard message ID per-channel
const getLbMsg = db.prepare('SELECT value FROM meta WHERE key = ?');
const setLbMsg = db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');

// --- Token store ---
const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 24);
const activeTokens = new Map(); // token -> { channelId, userId, username, expiresAt }

function createToken({ channelId, userId, username }) {
  const token = nanoid();
  const expiresAt = Date.now() + 15 * 60 * 1000;
  activeTokens.set(token, { channelId, userId, username, expiresAt });
  return token;
}

function cleanTokens() {
  const now = Date.now();
  for (const [t, meta] of activeTokens.entries()) {
    if (meta.expiresAt < now) activeTokens.delete(t);
  }
}
setInterval(cleanTokens, 60 * 1000);

// --- Express app ---
const app = express();
app.use(express.json());

// Find a valid public directory
const candidates = [
  path.join(__dirname, 'public'),
  path.join(process.cwd(), 'public'),
];

let publicDir = null;
for (const p of candidates) {
  try {
    if (fs.existsSync(path.join(p, 'index.html'))) {
      publicDir = p;
      break;
    }
  } catch {}
}

if (!publicDir) {
  console.error('❌ Could not find public/index.html. Tried:', candidates);
} else {
  console.log('✅ Serving static from:', publicDir);
  app.use(express.static(publicDir, { index: 'index.html', extensions: ['html'] }));
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
}
// health
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Accept score
app.post('/score', async (req, res) => {
  try {
    const { token, average, best, score } = req.body || {};
    if (!token || typeof average !== 'number' || typeof best !== 'number' || typeof score !== 'number') {
      return res.status(400).json({ ok: false, error: 'invalid_payload' });
    }
    const meta = activeTokens.get(token);
    if (!meta) {
      return res.status(401).json({ ok: false, error: 'invalid_or_expired_token' });
    }
    // simple anti-abuse: require score == 50
    if (score !== 50) {
      return res.status(400).json({ ok: false, error: 'score_must_be_50' });
    }

    const { channelId, userId, username } = meta;

    // Upsert: keep best (lowest) average and lowest bestMs
    const existing = db.prepare('SELECT avgMs, bestMs FROM scores WHERE channelId = ? AND userId = ?').get(channelId, userId);
    let finalAvg = average;
    let finalBest = best;
    if (existing) {
      finalAvg = Math.min(existing.avgMs, average);
      finalBest = Math.min(existing.bestMs, best);
    }

    db.prepare(`
      INSERT INTO scores(channelId, userId, username, avgMs, bestMs, updatedAt)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(channelId, userId) DO UPDATE SET
        username=excluded.username,
        avgMs=excluded.avgMs < scores.avgMs ? excluded.avgMs : scores.avgMs,
        bestMs=excluded.bestMs < scores.bestMs ? excluded.bestMs : scores.bestMs,
        updatedAt=excluded.updatedAt
    `).run(channelId, userId, username, finalAvg, finalBest, Date.now());

    // Update leaderboard message
    await postOrUpdateLeaderboard(channelId);

    // Invalidate token after submit
    activeTokens.delete(token);

    return res.json({ ok: true });
  } catch (err) {
    console.error('Score error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

async function postOrUpdateLeaderboard(channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const top = db.prepare('SELECT username, userId, avgMs, bestMs FROM scores WHERE channelId = ? ORDER BY avgMs ASC, bestMs ASC LIMIT 20').all(channelId);

  const lines = top.map((r, i) => `**${i+1}.** ${r.username} — priemer **${r.avgMs} ms**, najlepší ${r.bestMs} ms`);
  const desc = lines.length ? lines.join('\n') : 'Zatiaľ žiadne výsledky. Zahraj `/play`!';

  const embed = new EmbedBuilder()
    .setTitle('🏆 Tabuľka lídrov — najnižší priemerný čas (ms)')
    .setDescription(desc)
    .setColor(0x00AEEF)
    .setTimestamp(new Date());

  const key = `lbmsg:${channelId}`;
  const row = getLbMsg.get(key);
  if (row) {
    const msgId = row.value;
    try {
      const msg = await channel.messages.fetch(msgId);
      await msg.edit({ embeds: [embed] });
      return;
    } catch (_) {
      // fallthrough to post new
    }
  }

  const msg = await channel.send({ embeds: [embed] });
  // try to pin (ignore if not allowed)
  try { await msg.pin(); } catch {}
  setLbMsg.run(key, msg.id);
}

// --- Discord handlers ---
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'play') {
    const channelId = interaction.channelId;
    const userId = interaction.user.id;
    const username = interaction.user.globalName || interaction.user.username;
    const token = createToken({ channelId, userId, username });
    const link = `${PUBLIC_URL}/?t=${encodeURIComponent(token)}`;
    await interaction.reply({ content: `Tu je tvoj súkromný odkaz na hru (platí cca 15 min):\n${link}`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'leaderboard') {
    await interaction.deferReply({ ephemeral: true });
    await postOrUpdateLeaderboard(interaction.channelId);
    await interaction.editReply({ content: 'Leaderboard bol zobrazený/obnovený.' });
  }
});

client.login(DISCORD_TOKEN);

// --- Start HTTP server ---
app.listen(PORT, () => {
  console.log(`HTTP server on http://localhost:${PORT} — public base ${PUBLIC_URL}`);
});
