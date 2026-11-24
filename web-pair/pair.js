import express from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";
import { uploadSessionFolder } from "./mega.js";

const router = express.Router();
const sessionsRoot = path.resolve("pair_sessions");
const hasMegaCredentials = () => Boolean(process.env.MEGA_EMAIL && process.env.MEGA_PASSWORD);

function removeFile(filePath) {
    try {
        fs.rmSync(filePath, { recursive: true, force: true });
    } catch (error) {
        console.error("Could not clean pairing session:", error.message);
    }
}

function getMegaFileId(url) {
    if (typeof url !== "string") return null;
    const modern = url.match(/\/file\/([^#/?]+)#([^/?]+)/);
    if (modern) return `${modern[1]}#${modern[2]}`;
    const legacy = url.match(/#!([^!/?]+)!([^&/?]+)/);
    return legacy ? `${legacy[1]}#${legacy[2]}` : null;
}

router.get("/", async (req, res) => {
    if (!hasMegaCredentials()) {
        return res.status(503).json({
            code: "Session storage is not configured. Set MEGA_EMAIL and MEGA_PASSWORD.",
        });
    }

    const rawNumber = typeof req.query.number === "string" ? req.query.number : "";
    const digits = rawNumber.replace(/\D/g, "");
    if (!digits || digits.length > 15) {
        return res.status(400).json({ code: "Enter a valid international WhatsApp number." });
    }

    const phone = pn(`+${digits}`);
    if (!phone.isValid()) {
        return res.status(400).json({
            code: "Invalid phone number. Enter the full international number including country code.",
        });
    }

    const number = phone.getNumber("e164").replace("+", "");
    const sessionDir = path.join(sessionsRoot, `${number}_${randomUUID()}`);
    let socket = null;
    let completed = false;
    let cleaned = false;
    let attempts = 0;
    let timeout;

    const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(timeout);
        try {
            socket?.ev?.removeAllListeners();
            socket?.end?.(new Error("Pairing flow finished"));
        } catch {}
        await delay(300);
        removeFile(sessionDir);
    };

    const saveSession = async () => {
        if (completed) return;
        completed = true;
        try {
            console.log("WhatsApp paired. Uploading complete multi-file session to MEGA...");
            const megaUrl = await uploadSessionFolder(
                sessionDir,
                `kyzer_session_${number}_${Date.now()}.json`,
            );
            const sessionId = getMegaFileId(megaUrl);
            if (!sessionId) throw new Error("MEGA did not return a supported file link.");

            const userJid = jidNormalizedUser(`${number}@s.whatsapp.net`);
            await socket.sendMessage(userJid, { text: sessionId });
            console.log("Session bundle sent to the paired WhatsApp account.");
        } catch (error) {
            console.error("Could not export WhatsApp session:", error);
        } finally {
            await cleanup();
            if (typeof global.activateLatestSession === "function") {
                await global.activateLatestSession().catch((error) => {
                    console.error("Could not start the main KyZer bot from the new session:", error);
                });
            }
        }
    };

    const initiateSession = async () => {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        socket = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(
                    state.keys,
                    pino({ level: "fatal" }).child({ level: "fatal" }),
                ),
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: Browsers.windows("Chrome"),
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 250,
            maxRetries: 5,
        });

        socket.ev.on("creds.update", saveCreds);
        socket.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                await saveSession();
                return;
            }

            if (connection === "close" && !completed) {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === 401) {
                    console.log("WhatsApp rejected the pairing session. Generate a fresh code.");
                    await cleanup();
                    return;
                }

                attempts += 1;
                if (attempts > 3) {
                    console.error("Pairing socket could not reconnect; ending this request.");
                    await cleanup();
                    return;
                }

                const waitMs = Math.min(10000, 2000 * attempts);
                console.log(`Pairing socket closed. Reconnecting in ${waitMs / 1000}s...`);
                try {
                    socket.ev.removeAllListeners();
                    socket.end?.(new Error("Reconnecting pairing socket"));
                } catch {}
                setTimeout(() => {
                    if (!cleaned && !completed) {
                        initiateSession().catch(async (error) => {
                            console.error("Pairing reconnect failed:", error);
                            if (!res.headersSent) {
                                res.status(503).json({ code: "Pairing service unavailable." });
                            }
                            await cleanup();
                        });
                    }
                }, waitMs);
            }
        });

        if (!socket.authState.creds.registered) {
            await delay(2500);
            const code = await socket.requestPairingCode(number);
            const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
            if (!res.headersSent && !cleaned) {
                res.json({ code: formattedCode });
            }
        } else {
            if (!res.headersSent) {
                res.status(409).json({ code: "This session is already registered. Generate a new session instead." });
            }
        }
    };

    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    timeout = setTimeout(async () => {
        if (!res.headersSent) {
            res.status(408).json({ code: "Pairing timed out. Please generate a new code." });
        }
        await cleanup();
    }, 5 * 60 * 1000);

    try {
        await initiateSession();
    } catch (error) {
        console.error("Pair-code generation failed:", error);
        if (!res.headersSent) {
            res.status(503).json({ code: "Could not generate a pairing code. Please try again." });
        }
        await cleanup();
    }
});

export default router;
