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
import QRCode from "qrcode";
import { uploadSessionFolder } from "./mega.js";

const router = express.Router();
const sessionsRoot = path.resolve("qr_sessions");
const hasMegaCredentials = () => Boolean(process.env.MEGA_EMAIL && process.env.MEGA_PASSWORD);

function removeFile(filePath) {
    try {
        fs.rmSync(filePath, { recursive: true, force: true });
    } catch (error) {
        console.error("Could not clean QR session:", error.message);
    }
}

function getMegaFileId(url) {
    if (typeof url !== "string") return null;
    const modern = url.match(/\/file\/([^#/?]+)#([^/?]+)/);
    if (modern) return `${modern[1]}#${modern[2]}`;
    const legacy = url.match(/#!([^!/?]+)!([^&/?]+)/);
    return legacy ? `${legacy[1]}#${legacy[2]}` : null;
}

router.get("/", async (_req, res) => {
    if (!hasMegaCredentials()) {
        return res.status(503).json({
            code: "Session storage is not configured. Set MEGA_EMAIL and MEGA_PASSWORD.",
        });
    }

    const sessionId = randomUUID();
    const sessionDir = path.join(sessionsRoot, `session_${sessionId}`);
    let socket = null;
    let responseSent = false;
    let completed = false;
    let cleaned = false;
    let timeout;

    const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(timeout);
        try {
            socket?.ev?.removeAllListeners();
            socket?.end?.(new Error("QR pairing flow finished"));
        } catch {}
        await delay(300);
        removeFile(sessionDir);
    };

    const finishPairing = async () => {
        if (completed) return;
        completed = true;

        try {
            console.log("WhatsApp paired with QR. Uploading complete multi-file session to MEGA...");
            const megaUrl = await uploadSessionFolder(
                sessionDir,
                `kyzer_qr_session_${Date.now()}.json`,
            );
            const megaFileId = getMegaFileId(megaUrl);
            if (!megaFileId) throw new Error("MEGA did not return a supported file link.");

            const userId = socket.authState.creds.me?.id || "";
            const number = userId.split("@")[0].split(":")[0];
            if (!number) throw new Error("Could not determine the paired WhatsApp account.");

            await socket.sendMessage(
                jidNormalizedUser(`${number}@s.whatsapp.net`),
                { text: megaFileId },
            );
            console.log("Session bundle sent to the paired WhatsApp account.");
        } catch (error) {
            console.error("Could not export QR session:", error);
        } finally {
            await cleanup();
            if (typeof global.activateLatestSession === "function") {
                await global.activateLatestSession().catch((error) => {
                    console.error("Could not start the main KyZer bot from the new QR session:", error);
                });
            }
        }
    };

    const startSession = async () => {
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
            const { connection, lastDisconnect, qr } = update;

            if (qr && !responseSent && !cleaned) {
                try {
                    const qrDataURL = await QRCode.toDataURL(qr, {
                        errorCorrectionLevel: "M",
                        type: "image/png",
                        quality: 0.92,
                        margin: 1,
                        color: { dark: "#000000", light: "#FFFFFF" },
                    });
                    if (!responseSent && !cleaned) {
                        responseSent = true;
                        res.json({
                            qr: qrDataURL,
                            message: "QR code generated. Scan it with WhatsApp.",
                            instructions: [
                                "1. Open WhatsApp on your phone",
                                "2. Go to Settings > Linked Devices",
                                '3. Tap "Link a Device"',
                                "4. Scan the QR code above",
                            ],
                        });
                    }
                } catch (error) {
                    console.error("QR image generation failed:", error);
                    if (!responseSent) {
                        responseSent = true;
                        res.status(500).json({ code: "Failed to generate QR code." });
                    }
                    await cleanup();
                }
            }

            if (connection === "open") {
                await finishPairing();
                return;
            }

            if (connection === "close" && !completed) {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`QR pairing socket closed (status ${statusCode ?? "unknown"}).`);
                if (!responseSent) {
                    responseSent = true;
                    res.status(503).json({ code: "QR session closed. Please generate a new QR code." });
                }
                await cleanup();
            }
        });
    };

    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    timeout = setTimeout(async () => {
        if (!responseSent) {
            responseSent = true;
            res.status(408).json({ code: "QR session timed out. Please generate a new QR code." });
        }
        await cleanup();
    }, 5 * 60 * 1000);

    try {
        await startSession();
    } catch (error) {
        console.error("QR session initialization failed:", error);
        if (!responseSent) {
            responseSent = true;
            res.status(503).json({ code: "QR service unavailable." });
        }
        await cleanup();
    }
});

export default router;
