const { cmd } = require("../command");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const pino = require("pino");
const config = require("../config");

const pendingPair = new Set();

function removeFile(filePath) {
  try {
    fs.rmSync(filePath, { recursive: true, force: true });
  } catch (error) {
    console.error("Could not clean temporary pair session:", error.message);
  }
}

function getMegaFileId(url) {
  if (typeof url !== "string") return null;
  const modern = url.match(/\/file\/([^#/?]+)#([^/?]+)/);
  if (modern) return `${modern[1]}#${modern[2]}`;
  const legacy = url.match(/#!([^!/?]+)!([^&/?]+)/);
  return legacy ? `${legacy[1]}#${legacy[2]}` : null;
}

async function uploadSessionToMega(sessionDir, fileName) {
  const email = process.env.MEGA_EMAIL || config.MEGA_EMAIL;
  const password = process.env.MEGA_PASSWORD || config.MEGA_PASSWORD;
  if (!email || !password) {
    throw new Error("MEGA_EMAIL and MEGA_PASSWORD must be configured in the host environment.");
  }

  const files = {};
  for (const name of fs.readdirSync(sessionDir)) {
    if (!name.endsWith(".json")) continue;
    const safeName = path.basename(name);
    files[safeName] = fs.readFileSync(path.join(sessionDir, safeName)).toString("base64");
  }
  if (!files["creds.json"]) throw new Error("Session is missing creds.json.");

  const payload = Buffer.from(JSON.stringify({
    format: "kyzer-baileys-multifile-session",
    version: 1,
    createdAt: new Date().toISOString(),
    files,
  }), "utf8");

  const { Storage } = await import("megajs");
  const storage = await new Storage({ email, password, keepalive: false }).ready;
  try {
    const uploadedFile = await storage.upload({
      name: fileName,
      size: payload.length,
    }, payload).complete;
    return await uploadedFile.link();
  } finally {
    storage.close();
  }
}

cmd({
  pattern: "pair",
  react: "🔗",
  desc: "Generate a WhatsApp session for the bot",
  category: "main",
  filename: __filename,
}, async (_socket, _message, _m, { args, reply }) => {
  const targetNumber = String(args[0] || "").replace(/\D/g, "");
  if (targetNumber.length < 8 || targetNumber.length > 15) {
    return reply("❌ Usage: #pair 947XXXXXXXX (full international number, digits only).");
  }

  if (pendingPair.has(targetNumber)) {
    return reply("⏳ A pairing request for this number is already running.");
  }

  if (!(process.env.MEGA_EMAIL || config.MEGA_EMAIL) ||
      !(process.env.MEGA_PASSWORD || config.MEGA_PASSWORD)) {
    return reply("❌ Session storage is not configured. Ask the bot owner to set MEGA_EMAIL and MEGA_PASSWORD.");
  }

  pendingPair.add(targetNumber);
  await reply("🔄 Generating a pairing code. Check your WhatsApp linked-device screen.");

  const sessionDir = path.join(__dirname, "..", `temp_pair_${targetNumber}_${randomUUID()}`);
  let socket = null;
  let attempts = 0;
  let complete = false;
  let cleaned = false;
  let timer;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    try {
      socket?.ev?.removeAllListeners();
      socket?.end?.(new Error("Pairing command finished"));
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
    removeFile(sessionDir);
    pendingPair.delete(targetNumber);
  };

  const connect = async () => {
    const {
      makeWASocket,
      useMultiFileAuthState,
      makeCacheableSignalKeyStore,
      Browsers,
      jidNormalizedUser,
      fetchLatestBaileysVersion,
      delay,
    } = await import("@whiskeysockets/baileys");

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    socket = makeWASocket({
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

    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open" && !complete) {
        complete = true;
        try {
          await delay(1200);
          const megaUrl = await uploadSessionToMega(
            sessionDir,
            `kyzer_session_${targetNumber}_${Date.now()}.json`,
          );
          const sessionId = getMegaFileId(megaUrl);
          if (!sessionId) throw new Error("MEGA returned an invalid file link.");

          const userJid = jidNormalizedUser(`${targetNumber}@s.whatsapp.net`);
          await socket.sendMessage(userJid, {
            text: `✅ Your KyZer-Fea session ID:\n\n${sessionId}`,
          });
          await reply("✅ Pairing complete. The complete session bundle was sent to your WhatsApp.");
        } catch (error) {
          console.error("Pair session export failed:", error);
          await reply("❌ Could not export the session. Check the MEGA credentials and try again.");
        } finally {
          await cleanup();
        }
        return;
      }

      if (connection === "close" && !complete) {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === 401) {
          await cleanup();
          return;
        }

        attempts += 1;
        if (attempts > 4) {
          await reply("❌ Pairing connection could not recover. Run #pair again.");
          await cleanup();
          return;
        }

        const backoff = Math.min(10000, 2000 * attempts);
        try {
          socket.ev.removeAllListeners();
          socket.end?.(new Error("Restarting pair command socket"));
        } catch {}
        setTimeout(() => {
          if (!cleaned && !complete) {
            connect().catch(async (error) => {
              console.error("Pair command reconnect failed:", error);
              await cleanup();
            });
          }
        }, backoff);
      }
    });

    if (!socket.authState.creds.registered) {
      await delay(2000);
      const code = await socket.requestPairingCode(targetNumber);
      const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
      await reply(`🔗 Your pairing code: *${formattedCode}*\n\nWhatsApp → Linked Devices → Link with phone number.`);
    } else {
      await reply("⚠️ This temporary session is already registered. Generate a fresh session.");
      await cleanup();
    }
  };

  fs.mkdirSync(sessionDir, { recursive: true });
  timer = setTimeout(async () => {
    if (!complete) {
      await reply("⌛ Pairing timed out. Run #pair again to generate a new code.");
      await cleanup();
    }
  }, 5 * 60 * 1000);

  connect().catch(async (error) => {
    console.error("Pair command failed:", error);
    await reply("❌ Something went wrong generating the pairing code.");
    await cleanup();
  });
});
