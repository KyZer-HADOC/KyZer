import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Storage } from "megajs";

const SESSION_FOLDER_NAME = "KyZer-Fea Sessions";
const SESSION_FILE_PREFIX = "session-";
const MAX_BACKUPS = 3;

async function openSessionFolder() {
    const email = process.env.MEGA_EMAIL;
    const password = process.env.MEGA_PASSWORD;

    if (!email || !password) {
        throw new Error("MEGA_EMAIL and MEGA_PASSWORD must be set in the service environment.");
    }

    const storage = await new Storage({
        email,
        password,
        keepalive: false,
    }).ready;

    try {
        await storage.reload();
        let folder = storage.root.children.find(
            (item) => item.directory && item.name === SESSION_FOLDER_NAME,
        );

        if (!folder) {
            folder = await storage.root.mkdir(SESSION_FOLDER_NAME);
        }

        return { storage, folder };
    } catch (error) {
        storage.close();
        throw error;
    }
}

function makeSessionBundle(files) {
    return Buffer.from(JSON.stringify({
        format: "kyzer-baileys-multifile-session",
        version: 1,
        createdAt: new Date().toISOString(),
        files,
    }), "utf8");
}

export async function uploadSessionFolder(folderPath, _requestedName) {
    const entries = await readdir(folderPath, { withFileTypes: true });
    const files = {};

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const safeName = path.basename(entry.name);
        const contents = await readFile(path.join(folderPath, safeName));
        files[safeName] = contents.toString("base64");
    }

    if (!files["creds.json"]) {
        throw new Error("Baileys session is missing creds.json.");
    }

    const buffer = makeSessionBundle(files);
    const { storage, folder } = await openSessionFolder();

    try {
        const fileName = `${SESSION_FILE_PREFIX}${Date.now()}.json`;
        const uploaded = await folder.upload({
            name: fileName,
            size: buffer.length,
        }, buffer).complete;

        // Keep a few recent snapshots so an interrupted write never removes the last good session.
        const backups = folder.children
            .filter((item) => !item.directory && item.name.startsWith(SESSION_FILE_PREFIX))
            .sort((a, b) => b.name.localeCompare(a.name));

        for (const oldFile of backups.slice(MAX_BACKUPS)) {
            try {
                await oldFile.delete(true);
            } catch (error) {
                console.warn("Could not remove old session snapshot:", error.message);
            }
        }

        return await uploaded.link();
    } finally {
        storage.close();
    }
}

export async function downloadLatestSessionBundle() {
    const { storage, folder } = await openSessionFolder();

    try {
        const latest = folder.children
            .filter((item) => !item.directory && item.name.startsWith(SESSION_FILE_PREFIX))
            .sort((a, b) => b.name.localeCompare(a.name))[0];

        if (!latest) return null;
        const buffer = await latest.downloadBuffer();
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            throw new Error("The newest MEGA session snapshot is empty.");
        }
        return buffer;
    } finally {
        storage.close();
    }
}
