const fs = require('fs');
const P = require('pino');
const express = require('express');
const axios = require('axios');
const path = require('path');
const qrcode = require('qrcode-terminal');

const config = require('./config');
const { sms, downloadMediaMessage } = require('./lib/msg');
const {
  getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson
} = require('./lib/functions');
const { commands, replyHandlers } = require('./command');

const app = express();
const port = process.env.PORT || 8000;

const prefix = '#';
const ownerNumber = String(config.BOT_OWNER || '').split(',').map((value) => value.trim()).filter(Boolean);
const authDir = path.join(__dirname, 'auth_info_baileys');
const credsPath = path.join(authDir, 'creds.json');
let isWhatsAppConnected = false;

function restoreSessionBundle(data) {
  let bundle;
  try {
    bundle = JSON.parse(Buffer.from(data).toString('utf8'));
  } catch {
    // Backward compatibility with the older pair service, which uploaded creds.json only.
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(credsPath, data, { mode: 0o600 });
    return;
  }

  if (
    bundle?.format !== 'kyzer-baileys-multifile-session' ||
    bundle?.version !== 1 ||
    !bundle.files ||
    typeof bundle.files !== 'object'
  ) {
    // A legacy MEGA file may contain a plain Baileys creds.json JSON object.
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(credsPath, data, { mode: 0o600 });
    return;
  }

  fs.mkdirSync(authDir, { recursive: true });
  for (const [name, base64Content] of Object.entries(bundle.files)) {
    if (
      path.basename(name) !== name ||
      !/^[a-zA-Z0-9._-]+\.json$/.test(name) ||
      typeof base64Content !== 'string'
    ) {
      throw new Error('Invalid file entry in the MEGA session bundle.');
    }
    fs.writeFileSync(
      path.join(authDir, name),
      Buffer.from(base64Content, 'base64'),
      { mode: 0o600 },
    );
  }

  if (!fs.existsSync(credsPath)) {
    throw new Error('The MEGA session bundle does not contain creds.json.');
  }
}

async function restoreLatestSessionAndConnect() {
  if (isWhatsAppConnected) {
    console.log("✅ WhatsApp bot is already connected.");
    return true;
  }

  const { downloadLatestSessionBundle } = await import("./web-pair/mega.js");
  const bundle = await downloadLatestSessionBundle();

  if (!bundle) {
    console.warn("⚠️ No saved session found in MEGA yet. Open the Pair Code page to link WhatsApp.");
    return false;
  }

  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
  }

  restoreSessionBundle(bundle);
  console.log("✅ Latest WhatsApp session restored from MEGA.");
  await connectToWA();
  return true;
}

async function ensureSessionFile() {
  if (fs.existsSync(credsPath)) {
    console.log("✅ Local WhatsApp session found.");
    setTimeout(() => connectToWA(), 1000);
    return;
  }

  if (!process.env.MEGA_EMAIL || !process.env.MEGA_PASSWORD) {
    console.warn("⚠️ MEGA_EMAIL / MEGA_PASSWORD are missing. Bot will remain offline until the MEGA session store is configured.");
    return;
  }

  try {
    await restoreLatestSessionAndConnect();
  } catch (error) {
    console.error("❌ Could not restore the latest MEGA session:", error.message || error);
  }
}

global.activateLatestSession = restoreLatestSessionAndConnect;

let sessionBackupTimer = null;
let sessionBackupInterval = null;
let sessionBackupInProgress = null;

async function backupSessionToMega() {
  if (!isWhatsAppConnected || !fs.existsSync(credsPath)) return;
  if (sessionBackupInProgress) return sessionBackupInProgress;

  sessionBackupInProgress = (async () => {
    const { uploadSessionFolder } = await import("./web-pair/mega.js");
    await uploadSessionFolder(authDir, `session-${Date.now()}.json`);
    console.log("✅ WhatsApp auth snapshot saved to MEGA.");
  })();

  try {
    await sessionBackupInProgress;
  } finally {
    sessionBackupInProgress = null;
  }
}

function scheduleSessionBackup() {
  if (sessionBackupTimer) clearTimeout(sessionBackupTimer);
  sessionBackupTimer = setTimeout(() => {
    backupSessionToMega().catch((error) => {
      console.error("⚠️ Automatic MEGA session backup failed:", error.message || error);
    });
  }, 10000);
}

function startSessionBackupInterval() {
  if (sessionBackupInterval) clearInterval(sessionBackupInterval);
  sessionBackupInterval = setInterval(() => {
    backupSessionToMega().catch((error) => {
      console.error("⚠️ Scheduled MEGA session backup failed:", error.message || error);
    });
  }, 10 * 60 * 1000);
  sessionBackupInterval.unref?.();
}

const antiDeletePlugin = require('./plugins/antidelete.js');
global.pluginHooks = global.pluginHooks || [];
global.pluginHooks.push(antiDeletePlugin);

let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

async function connectToWA() {
  if (isConnecting) {
    console.log("⏳ connectToWA already running, skipping duplicate call.");
    return;
  }
  isConnecting = true;
  try {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      jidNormalizedUser,
      getContentType,
      fetchLatestBaileysVersion,
      Browsers,
    } = await import('@whiskeysockets/baileys');

    console.log("STEP 1 - connectToWA started");

    const { state, saveCreds } = await useMultiFileAuthState(
      path.join(__dirname, '/auth_info_baileys/')
    );
    console.log("STEP 2 - Auth loaded");

    const { version } = await fetchLatestBaileysVersion();
    console.log("STEP 3 - Baileys version:", version);

    const danuwa = makeWASocket({
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.macOS("Firefox"),
      auth: state,
      version,
      syncFullHistory: true,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
    });

    console.log("STEP 4 - Socket created");
    isConnecting = false;

  danuwa.ev.on('connection.update', async (update) => {
  console.log("UPDATE:", update);

  const { connection, lastDisconnect } = update;

  if (connection === 'close') {
    isWhatsAppConnected = false;
    const statusCode = lastDisconnect?.error?.output?.statusCode;

    if (statusCode === DisconnectReason.loggedOut) {
      console.error("❌ Logged out from WhatsApp. Deleting session and stopping.");
      try {
        fs.rmSync(path.join(__dirname, '/auth_info_baileys/'), { recursive: true, force: true });
      } catch (e) {
        console.error("Failed to clear session folder:", e);
      }
      isConnecting = false;
      return;
    }

    reconnectAttempts++;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error(`❌ Reached max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}). Stopping to avoid a restart loop.`);
      isConnecting = false;
      return;
    }

    const delay = Math.min(30000, 5000 * reconnectAttempts); // 5s, 10s, 15s ... capped at 30s
    console.log(`🔄 Connection closed. Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    isConnecting = false;
    setTimeout(() => connectToWA(), delay);
  } else if (connection === 'open') {
    isWhatsAppConnected = true;
    reconnectAttempts = 0;
    console.log('✅ KyZer-Fea connected to WhatsApp');
    startSessionBackupInterval();
    scheduleSessionBackup();

    const up = `KyZer-Fea connected ✅\n\nPREFIX: ${prefix}`;
    await danuwa.sendMessage(ownerNumber[0] + "@s.whatsapp.net", {
      image: {
        url: "https://github.com/KyZer-HADOC/KyZer/blob/main/images/KyZer%20bot_%20gothic%20cyberpunk%20aesthetic.png?raw=true"
      },
      caption: up
    });

    fs.readdirSync("./plugins/").forEach((plugin) => {
      if (path.extname(plugin).toLowerCase() === ".js") {
        require(`./plugins/${plugin}`);
      }
    });
  }
});

  danuwa.ev.on('creds.update', async () => {
    try {
      await saveCreds();
      scheduleSessionBackup();
    } catch (error) {
      console.error("Failed to persist WhatsApp credentials:", error);
    }
  });

  danuwa.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.messageStubType === 68) {
        await danuwa.sendMessageAck(msg.key);
      }
    }

    const mek = messages[0];
    if (!mek || !mek.message) return;

    mek.message = getContentType(mek.message) === 'ephemeralMessage' ? mek.message.ephemeralMessage.message : mek.message;
    
if (mek.key?.remoteJid === 'status@broadcast') {
  const senderJid = mek.key.participant || mek.key.remoteJid || "unknown@s.whatsapp.net";
  const mentionJid = senderJid.includes("@s.whatsapp.net") ? senderJid : senderJid + "@s.whatsapp.net";

  if (config.AUTO_STATUS_SEEN === "true") {
    try {
      await danuwa.readMessages([mek.key]);
      console.log(`[✓] Status seen: ${mek.key.id}`);
    } catch (e) {
      console.error("❌ Failed to mark status as seen:", e);
    }
  }

  if (config.AUTO_STATUS_REACT === "true" && mek.key.participant) {
    try {
      const emojis = ['❤️', '💸', '😇', '🍂', '💥', '💯', '🔥', '💫', '💎', '💗', '🤍', '🖤', '👀', '🙌', '🙆', '🚩', '🥰', '💐', '😎', '🤎', '✅', '🫀', '🧡', '😁', '😄', '🌸', '🕊️', '🌷', '⛅', '🌟', '🗿', '💜', '💙', '🌝', '🖤', '💚'];
      const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];

      await danuwa.sendMessage(mek.key.participant, {
        react: {
          text: randomEmoji,
          key: mek.key,
        }
      });

      console.log(`[✓] Reacted to status of ${mek.key.participant} with ${randomEmoji}`);
    } catch (e) {
      console.error("❌ Failed to react to status:", e);
    }
  }
}


    const m = sms(danuwa, mek);
    const type = getContentType(mek.message);
    const from = mek.key.remoteJid;
    const body = type === 'conversation' ? mek.message.conversation : mek.message[type]?.text || mek.message[type]?.caption || '';
    const isCmd = body.startsWith(prefix);
    const commandName = isCmd ? body.slice(prefix.length).trim().split(" ")[0].toLowerCase() : '';
    const args = body.trim().split(/ +/).slice(1);
    const q = args.join(' ');

    const sender = mek.key.fromMe ? danuwa.user.id : (mek.key.participant || mek.key.remoteJid);
    const senderNumber = sender.split('@')[0];
    const isGroup = from.endsWith('@g.us');
    const botNumber = danuwa.user.id.split(':')[0];
    const pushname = mek.pushName || 'Sin Nombre';
    const isMe = botNumber.includes(senderNumber);
    const isOwner = ownerNumber.includes(senderNumber) || isMe;
    const botNumber2 = await jidNormalizedUser(danuwa.user.id);

    const groupMetadata = isGroup ? await danuwa.groupMetadata(from).catch(() => {}) : '';
    const groupName = isGroup ? groupMetadata.subject : '';
    const participants = isGroup ? groupMetadata.participants : '';
    const groupAdmins = isGroup ? await getGroupAdmins(participants) : '';
    const isBotAdmins = isGroup ? groupAdmins.includes(botNumber2) : false;
    const isAdmins = isGroup ? groupAdmins.includes(sender) : false;

    const reply = (text) => danuwa.sendMessage(from, { text }, { quoted: mek });

    if (isCmd) {
      const cmd = commands.find((c) => c.pattern === commandName || (c.alias && c.alias.includes(commandName)));
      if (cmd) {
        if (cmd.react) danuwa.sendMessage(from, { react: { text: cmd.react, key: mek.key } });
        try {
          cmd.function(danuwa, mek, m, {
            from, quoted: mek, body, isCmd, command: commandName, args, q,
            isGroup, sender, senderNumber, botNumber2, botNumber, pushname,
            isMe, isOwner, groupMetadata, groupName, participants, groupAdmins,
            isBotAdmins, isAdmins, reply,
          });
        } catch (e) {
          console.error("[PLUGIN ERROR]", e);
        }
      }
    }

    const replyText = body;
    for (const handler of replyHandlers) {
      if (handler.filter(replyText, { sender, message: mek })) {
        try {
          await handler.function(danuwa, mek, m, {
            from, quoted: mek, body: replyText, sender, reply,
          });
          break;
        } catch (e) {
          console.log("Reply handler error:", e);
        }
      }
    }
  });

  danuwa.ev.on('messages.update', async (updates) => {
    if (global.pluginHooks) {
      for (const plugin of global.pluginHooks) {
        if (plugin.onDelete) {
          try {
            await plugin.onDelete(danuwa, updates);
          } catch (e) {
            console.log("onDelete error:", e);
          }
        }
      }
    }
  });
    } catch (err) {
  console.error("Connection Error:", err);
  isConnecting = false;

  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.error(`❌ Reached max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}). Stopping to avoid a restart loop.`);
    return;
  }
  const delay = Math.min(30000, 5000 * reconnectAttempts);
  console.log(`🔄 Retrying connectToWA in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  setTimeout(() => connectToWA(), delay);
}
}

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});



async function startHttpServer() {
  app.set("trust proxy", 1);

  const [{ default: pairRouter }, { default: qrRouter }, { rateLimit }] = await Promise.all([
    import("./web-pair/pair.js"),
    import("./web-pair/qr.js"),
    import("express-rate-limit"),
  ]);

  const pairingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many pairing attempts. Please try again later." },
  });

  app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "web-pair", "pair.html"));
  });

  app.get("/bot", (_req, res) => {
    res.status(200).send("Hey, KyZer-Fea is running ✅");
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "KyZer-Fea",
      whatsappConnected: isWhatsAppConnected,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  app.use("/pair", pairingLimiter, pairRouter);
  app.use("/qr", pairingLimiter, qrRouter);

  app.listen(port, "0.0.0.0", () => {
    console.log(`KyZer-Fea + Web Pair listening on port ${port}`);
    ensureSessionFile();
  });
}

startHttpServer().catch((error) => {
  console.error("Failed to start HTTP server:", error);
  process.exitCode = 1;
});
