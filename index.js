const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  getContentType,
  proto,
  generateWAMessageContent,
  generateWAMessage,
  AnyMessageContent,
  prepareWAMessageMedia,
  areJidsSameUser,
  downloadContentFromMessage,
  MessageRetryMap,
  generateForwardMessageContent,
  generateWAMessageFromContent,
  generateMessageID, makeInMemoryStore,
  jidDecode,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');

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
const { File } = require('megajs');
const { commands, replyHandlers } = require('./command');

const app = express();
const port = process.env.PORT || 8000;

const prefix = '#';
const ownerNumber = ['94718354800'];
const credsPath = path.join(__dirname, '/auth_info_baileys/creds.json');

async function ensureSessionFile() {
  if (!fs.existsSync(credsPath)) {
    if (!config.SESSION_ID) {
      console.error('❌ SESSION_ID env variable is missing. Cannot restore session.');
      process.exit(1);
    }

    console.log("🔄 creds.json not found. Downloading session from MEGA...");

    const sessdata = config.SESSION_ID;
    const filer = File.fromURL(`https://mega.nz/file/${sessdata}`);

    filer.download((err, data) => {
      if (err) {
        console.error("❌ Failed to download session file from MEGA:", err);
        process.exit(1);
      }

      fs.mkdirSync(path.join(__dirname, '/auth_info_baileys/'), { recursive: true });
      fs.writeFileSync(credsPath, data);
      console.log("✅ Session downloaded and saved. Restarting bot...");
      setTimeout(() => {
        connectToWA();
      }, 2000);
    });
  } else {
    setTimeout(() => {
      connectToWA();
    }, 1000);
  }
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
    reconnectAttempts = 0;
    console.log('✅ KyZer-Fea connected to WhatsApp');

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

  danuwa.ev.on('creds.update', saveCreds);

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



ensureSessionFile();

app.get("/", (req, res) => {
  res.send("Hey, KyZer-Fea is Back✅");
});

app.listen(port, () => console.log(`Server listening on http://localhost:${port}`));
