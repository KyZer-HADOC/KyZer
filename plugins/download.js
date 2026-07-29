const { cmd } = require("../command");
const axios = require("axios");
const path = require("path");

cmd({
  pattern: "download",
  alias: ["dl"],
  react: "📥",
  desc: "Download any file from a direct URL",
  category: "download",
  filename: __filename,
}, async (test, m, msg, { from, args, q, reply }) => {
  const url = (q || args[0] || "").trim();

  if (!url || !/^https?:\/\//i.test(url)) {
    return reply("❌ Usage: #download <direct file URL>");
  }

  await reply("🔄 Downloading...");

  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      maxContentLength: 100 * 1024 * 1024, // 100MB cap
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const buffer = Buffer.from(res.data);
    const contentType = res.headers["content-type"] || "";
    const urlPath = new URL(url).pathname;
    const fileName = path.basename(urlPath) || "file";

    if (contentType.startsWith("image/")) {
      await test.sendMessage(from, { image: buffer }, { quoted: m });
    } else if (contentType.startsWith("video/")) {
      await test.sendMessage(from, { video: buffer }, { quoted: m });
    } else if (contentType.startsWith("audio/")) {
      await test.sendMessage(from, { audio: buffer, mimetype: contentType }, { quoted: m });
    } else {
      await test.sendMessage(from, {
        document: buffer,
        mimetype: contentType || "application/octet-stream",
        fileName,
      }, { quoted: m });
    }
  } catch (e) {
    console.error("Download command error:", e);
    if (e.message?.includes("maxContentLength")) {
      reply("❌ File is too large (max 100MB).");
    } else {
      reply("❌ Failed to download the file. Check the URL and try again.");
    }
  }
});
