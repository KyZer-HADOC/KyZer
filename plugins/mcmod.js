const { cmd } = require('../command');
const axios = require('axios');

// ================= CONFIG =================
// CurseForge එකෙන් download කරන්නත් ඕන නම්, console.curseforge.com/api/keys
// එකෙන් API key එකක් ගෙන පහළින් දාන්න. නැත්නම් හිස්ව තියන්න - Modrinth විතරක් වැඩ කරයි.
const CURSEFORGE_API_KEY = "";
// ============================================

// -------- MODRINTH SEARCH + DOWNLOAD --------
cmd({
    pattern: "mod",
    alias: ["modrinth", "mcmod"],
    desc: "Search & download Minecraft mods/resource packs from Modrinth",
    category: "download",
    react: "⛏️",
    filename: __filename
},
async (danuwa, mek, m, { from, args, q, reply }) => {
    try {
        if (!q) return reply("*Mod එකේ නම දෙන්න*\n\nඋදා: `#mod sodium`\n\nResults list එකෙන් number එකක් reply කරලා download කරන්න පුලුවන්.");

        const searchRes = await axios.get("https://api.modrinth.com/v2/search", {
            params: {
                query: q,
                limit: 8,
                facets: '[["project_type:mod","project_type:resourcepack"]]'
            }
        });

        const hits = searchRes.data.hits;
        if (!hits || hits.length === 0) {
            return reply(`"${q}" කියලා කිසිම mod/resource pack එකක් හම්බුනේ නැහැ.`);
        }

        let listText = `⛏️ *Modrinth Search Results* - "${q}"\n\n`;
        hits.forEach((hit, i) => {
            listText += `*${i + 1}.* ${hit.title}\n`;
            listText += `   📦 ${hit.project_type} | ⬇️ ${hit.downloads.toLocaleString()} downloads\n`;
            listText += `   🎮 ${hit.versions.slice(-3).join(", ")}\n\n`;
        });
        listText += `_Reply කරන්න number එකක් download කරගන්න (e.g. 1)_`;

        const sentMsg = await danuwa.sendMessage(from, { text: listText }, { quoted: mek });

        // Store hits temporarily for the reply-based download
        if (!global.modSearchCache) global.modSearchCache = {};
        global.modSearchCache[sentMsg.key.id] = hits;

    } catch (e) {
        console.log(e);
        reply(`Error: ${e.message}`);
    }
});

// -------- HANDLE NUMBER REPLY TO DOWNLOAD --------
cmd({
    on: "text"
}, async (danuwa, mek, m, { from, body, reply }) => {
    try {
        if (!m.quoted) return;
        const cache = global.modSearchCache?.[m.quoted.id];
        if (!cache) return;

        const num = parseInt(body.trim());
        if (isNaN(num) || num < 1 || num > cache.length) return;

        const project = cache[num - 1];
        await reply(`⏳ "${project.title}" - versions ගන්නවා...`);

        const versionsRes = await axios.get(`https://api.modrinth.com/v2/project/${project.project_id}/version`);
        const versions = versionsRes.data;
        if (!versions || versions.length === 0) return reply("Versions කිසිවක් හම්බුනේ නැහැ.");

        const latest = versions[0];
        const file = latest.files.find(f => f.primary) || latest.files[0];

        await danuwa.sendMessage(from, {
            document: { url: file.url },
            mimetype: "application/java-archive",
            fileName: file.filename,
            caption: `✅ *${project.title}*\n📁 ${file.filename}\n🎮 ${latest.game_versions.join(", ")}\n📦 Loader: ${latest.loaders.join(", ")}`
        }, { quoted: mek });

    } catch (e) {
        console.log(e);
    }
});

// -------- CURSEFORGE SEARCH + DOWNLOAD (needs API key) --------
cmd({
    pattern: "cfmod",
    alias: ["curseforge"],
    desc: "Search & download Minecraft mods from CurseForge",
    category: "download",
    react: "🔶",
    filename: __filename
},
async (danuwa, mek, m, { from, args, q, reply }) => {
    try {
        if (!CURSEFORGE_API_KEY) {
            return reply("*CurseForge API key එක සෙට් වෙලා නැහැ.*\n\nconsole.curseforge.com/api/keys ගිහින් free key එකක් ගන්න, mcmod.js file එකේ CURSEFORGE_API_KEY එකට දාන්න.");
        }
        if (!q) return reply("*Mod එකේ නම දෙන්න*\n\nඋදා: `#cfmod jei`");

        const searchRes = await axios.get("https://api.curseforge.com/v1/mods/search", {
            headers: { "x-api-key": CURSEFORGE_API_KEY },
            params: {
                gameId: 432, // Minecraft
                searchFilter: q,
                pageSize: 8
            }
        });

        const results = searchRes.data.data;
        if (!results || results.length === 0) {
            return reply(`"${q}" කියලා CurseForge එකේ mod එකක් හම්බුනේ නැහැ.`);
        }

        let listText = `🔶 *CurseForge Search Results* - "${q}"\n\n`;
        results.forEach((mod, i) => {
            listText += `*${i + 1}.* ${mod.name}\n`;
            listText += `   ⬇️ ${mod.downloadCount.toLocaleString()} downloads\n\n`;
        });
        listText += `_Reply කරන්න number එකක් download කරගන්න_`;

        const sentMsg = await danuwa.sendMessage(from, { text: listText }, { quoted: mek });

        if (!global.cfSearchCache) global.cfSearchCache = {};
        global.cfSearchCache[sentMsg.key.id] = results;

    } catch (e) {
        console.log(e);
        reply(`Error: ${e.message}`);
    }
});

cmd({
    on: "text"
}, async (danuwa, mek, m, { from, body, reply }) => {
    try {
        if (!m.quoted) return;
        const cache = global.cfSearchCache?.[m.quoted.id];
        if (!cache) return;

        const num = parseInt(body.trim());
        if (isNaN(num) || num < 1 || num > cache.length) return;

        const mod = cache[num - 1];
        await reply(`⏳ "${mod.name}" - file ගන්නවා...`);

        const filesRes = await axios.get(`https://api.curseforge.com/v1/mods/${mod.id}/files`, {
            headers: { "x-api-key": CURSEFORGE_API_KEY },
            params: { pageSize: 1 }
        });

        const file = filesRes.data.data[0];
        const downloadUrl = file.downloadUrl;
        if (!downloadUrl) return reply("Direct download URL එක restrict කරලා. CurseForge site එකෙන්ම ගන්න වෙයි.");

        await danuwa.sendMessage(from, {
            document: { url: downloadUrl },
            mimetype: "application/java-archive",
            fileName: file.fileName,
            caption: `✅ *${mod.name}*\n📁 ${file.fileName}`
        }, { quoted: mek });

    } catch (e) {
        console.log(e);
    }
});
