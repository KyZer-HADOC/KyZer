const { cmd } = require("../command");
const fs = require("fs");
const path = require("path");
const {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
  delay,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Storage } = require("megajs");
const config = require("../config");

function removeFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true });
  } catch (e) {
    console.error("Error removing temp pair session:", e);
  }
}

// Requires MEGA_EMAIL / MEGA_PASSWORD in config.js (same MEGA account used by
// the pairing site). If these aren't set, this command can't upload sessions.
function uploadToMega(filePath, fileName) {
  return new Promise((resolve, reject) => {
    if (!config.MEGA_EMAIL || !config.MEGA_PASSWORD) {
      return reject(new Error("MEGA_EMAIL / MEGA_PASSWORD not set in config.js"));
    }
    const storage = new Storage(
      { email: config.MEGA_EMAIL, password: config.MEGA_PASSWORD },
      async (err) => {
        if (err) return reject(err);
        try {
          const buffer = fs.readFileSync(filePath);
          const uploadStream = storage.upload(fileName, buffer);
          uploadStream.on("complete", async (file) => {
            try {
              const url = await file.link();
              storage.close();
              resolve(url);
            } catch (e) {
              reject(e);
            }
          });
          uploadStream.on("error", reject);
        } catch (e) {
          reject(e);
        }
      }
    );
    storage.on("error", reject);
  });
}

function getMegaFileId(url) {
  const match = url.match(/\/file\/([^#]+#[^/]+)/);
  return match ? match[1] : null;
}

const pendingPair = {};

cmd({
  pattern: "pair",
  react: "🔗",
  desc: "Generate your own bot session (pair your WhatsApp number)",
  category: "main",
  filename: __filename,
}, async (test, m, msg, { from, args, reply }) => {
  const targetNumber = (args[0] || "").replace(/[^0-9]/g, "");

  if (!targetNumber || targetNumber.length < 8) {
    return reply("❌ Usage: #pair 947XXXXXXXX (full number with country code, no + or spaces)");
  }

  if (pendingPair[targetNumber]) {
    return reply("⏳ A pairing request for this number is already in progress. Please wait.");
  }

  pendingPair[targetNumber] = true;
  await reply("🔄 Generating pairing code, wait...");

  const dirs = path.join(__dirname, "..", "temp_pair_" + targetNumber);
  removeFile(dirs);

  let attempts = 0;
  const MAX_ATTEMPTS = 4;

  async function connect() {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(dirs);
      const { version } = await fetchLatestBaileysVersion();

      const tempSocket = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "fatal" }),
        browser: Browsers.windows("Chrome"),
        markOnlineOnConnect: false,
      });

      tempSocket.ev.on("creds.update", saveCreds);

      tempSocket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          try {
            const credsPath = path.join(dirs, "creds.json");
            const megaUrl = await uploadToMega(credsPath, `creds_${targetNumber}_${Date.now()}.json`);
            const megaFileId = getMegaFileId(megaUrl);
            const userJid = jidNormalizedUser(targetNumber + "@s.whatsapp.net");

            if (megaFileId) {
              await tempSocket.sendMessage(userJid, { text: `✅ Your session ID:\n\n${megaFileId}` });
            } else {
              await tempSocket.sendMessage(userJid, { text: "❌ Failed to generate session ID. Try again later." });
            }
          } catch (e) {
            console.error("Pair upload error:", e);
          } finally {
            await delay(1000);
            try { tempSocket.ev.removeAllListeners(); tempSocket.end?.(undefined); } catch (e) {}
            removeFile(dirs);
            delete pendingPair[targetNumber];
          }
        }

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;

          if (statusCode === 401) {
            removeFile(dirs);
            delete pendingPair[targetNumber];
            return;
          }

          attempts++;
          if (attempts > MAX_ATTEMPTS) {
            removeFile(dirs);
            delete pendingPair[targetNumber];
            return;
          }

          try { tempSocket.ev.removeAllListeners(); tempSocket.end?.(undefined); } catch (e) {}
          const backoff = Math.min(8000, 2000 * attempts);
          setTimeout(connect, backoff);
        }
      });

      if (!tempSocket.authState.creds.registered) {
        await delay(2000);
        try {
          let code = await tempSocket.requestPairingCode(targetNumber);
          code = code?.match(/.{1,4}/g)?.join("-") || code;
          await reply(`🔗 Your pairing code: *${code}*\n\nWhatsApp > Linked Devices > Link with phone number > enter this code within 60s.`);
        } catch (e) {
          console.error("Pairing code error:", e);
          await reply("❌ Failed to generate pairing code. Check the number and try again.");
          delete pendingPair[targetNumber];
          removeFile(dirs);
        }
      }
    } catch (e) {
      console.error("Pair command error:", e);
      reply("❌ Something went wrong generating your session.");
      delete pendingPair[targetNumber];
      removeFile(dirs);
    }
  }

  connect();
});
