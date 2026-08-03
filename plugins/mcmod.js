const { cmd } = require('../command');
const axios = require('axios');

// state per chat: { stage, hits, projectId, projectTitle, versions, gameVersion, loader }
if (!global.modFlow) global.modFlow = {};

// -------- STEP 1: SEARCH --------
cmd({
    pattern: "mod",
    alias: ["modrinth", "mcmod"],
    desc: "Search & download Minecraft mods/resource packs from Modrinth",
    category: "download",
    react: "⛏️",
    filename: __filename
},
async (danuwa, mek, m, { from, q, reply }) => {
    try {
        if (!q) return reply("*Mod එකේ නම දෙන්න*\n\nඋදා: `#mod sodium`");

        const searchRes = await axios.get("https://api.modrinth.com/v2/search", {
            params: {
                query: q,
                limit: 8,
                facets: '[["project_type:mod","project_type:resourcepack","project_type:shader"]]'
            }
        });

        const hits = searchRes.data.hits;
        if (!hits || hits.length === 0) {
            return reply(`"${q}" කියලා කිසිම mod/resource pack එකක් හම්බුනේ නැහැ.`);
        }

        let listText = `⛏️ *Modrinth Search Results* - "${q}"\n\n`;
        hits.forEach((hit, i) => {
            listText += `*${i + 1}.* ${hit.title}\n`;
            listText += `   📦 ${hit.project_type} | ⬇️ ${hit.downloads.toLocaleString()} downloads\n\n`;
        });
        listText += `_Number එකක් reply කරන්න_`;

        await danuwa.sendMessage(from, { text: listText }, { quoted: mek });

        global.modFlow[from] = { stage: "select_project", hits };

    } catch (e) {
        console.log(e);
        reply(`Error: ${e.message}`);
    }
});

// -------- FLOW HANDLER (all steps after search) --------
cmd({
    on: "text"
}, async (danuwa, mek, m, { from, body, reply }) => {
    try {
        const state = global.modFlow[from];
        if (!state) return;

        const num = parseInt(body.trim());
        if (isNaN(num)) return;

        // ---- STEP 2: project selected -> show minecraft versions ----
        if (state.stage === "select_project") {
            const hits = state.hits;
            if (num < 1 || num > hits.length) return;
            const project = hits[num - 1];

            await reply(`⏳ "${project.title}" versions ගන්නවා...`);

            const versionsRes = await axios.get(`https://api.modrinth.com/v2/project/${project.project_id}/version`);
            const versions = versionsRes.data;
            if (!versions || versions.length === 0) {
                delete global.modFlow[from];
                return reply("Versions කිසිවක් හම්බුනේ නැහැ.");
            }

            // unique game versions, most recent first, keep order of appearance
            const seen = new Set();
            const gameVersions = [];
            versions.forEach(v => {
                v.game_versions.forEach(gv => {
                    if (!seen.has(gv)) { seen.add(gv); gameVersions.push(gv); }
                });
            });
            const topVersions = gameVersions.slice(0, 10);

            let listText = `🎮 *${project.title}* - Minecraft Version එක තෝරන්න\n\n`;
            topVersions.forEach((gv, i) => {
                listText += `*${i + 1}.* ${gv}\n`;
            });
            listText += `\n_Number එකක් reply කරන්න_`;

            await danuwa.sendMessage(from, { text: listText }, { quoted: mek });

            global.modFlow[from] = {
                stage: "select_version",
                projectId: project.project_id,
                projectTitle: project.title,
                versions,
                versionOptions: topVersions
            };
            return;
        }

        // ---- STEP 3: version selected -> show loader types ----
        if (state.stage === "select_version") {
            const { versionOptions, versions, projectTitle } = state;
            if (num < 1 || num > versionOptions.length) return;
            const gameVersion = versionOptions[num - 1];

            const matching = versions.filter(v => v.game_versions.includes(gameVersion));
            const seen = new Set();
            const loaders = [];
            matching.forEach(v => {
                v.loaders.forEach(l => {
                    if (!seen.has(l)) { seen.add(l); loaders.push(l); }
                });
            });

            if (loaders.length === 0) {
                delete global.modFlow[from];
                return reply("Loader type එකක් හම්බුනේ නැහැ.");
            }

            let listText = `🧩 *${projectTitle}* (${gameVersion}) - Loader තෝරන්න\n\n`;
            loaders.forEach((l, i) => {
                listText += `*${i + 1}.* ${l}\n`;
            });
            listText += `\n_Number එකක් reply කරන්න_`;

            await danuwa.sendMessage(from, { text: listText }, { quoted: mek });

            global.modFlow[from] = {
                stage: "select_loader",
                projectTitle,
                gameVersion,
                matching,
                loaderOptions: loaders
            };
            return;
        }

        // ---- STEP 4: loader selected -> send file ----
        if (state.stage === "select_loader") {
            const { loaderOptions, matching, projectTitle, gameVersion } = state;
            if (num < 1 || num > loaderOptions.length) return;
            const loader = loaderOptions[num - 1];

            const finalMatches = matching.filter(v => v.loaders.includes(loader));
            if (finalMatches.length === 0) {
                delete global.modFlow[from];
                return reply("File එකක් හම්බුනේ නැහැ.");
            }

            // most recent version first (Modrinth returns versions newest-first already)
            const chosen = finalMatches[0];
            const file = chosen.files.find(f => f.primary) || chosen.files[0];

            await reply(`⏳ Downloading "${file.filename}"...`);

            await danuwa.sendMessage(from, {
                document: { url: file.url },
                mimetype: "application/java-archive",
                fileName: file.filename,
                caption: `✅ *${projectTitle}*\n📁 ${file.filename}\n🎮 ${gameVersion}\n🧩 ${loader}`
            }, { quoted: mek });

            delete global.modFlow[from];
            return;
        }

    } catch (e) {
        console.log(e);
        delete global.modFlow[from];
    }
});
