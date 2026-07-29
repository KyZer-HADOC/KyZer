const { cmd } = require("../command");
const axios = require("axios");

// Only works for PUBLIC channels/posts (preview enabled). Private channels or
// groups need the Telegram Bot API + membership, which is a different flow.
function toPreviewUrl(link) {
  return link.replace(/^https?:\/\/t\.me\//i, "https://t.me/s/");
}

cmd({
  pattern: "tgdl",
  alias: ["tg", "telegram"],
  react: "📥",
  desc: "Download media from a public Telegram post link",
  category: "download",
  filename: __filename,
}, async (test, m, msg, { from, args, q, reply }) => {
  const link = (q || args[0] || "").trim();

  if (!link || !/^https?:\/\/t\.me\//i.test(link)) {
    return reply("❌ Usage: #tgdl https://t.me/channelname/123 (public post link)");
  }

  await reply("🔄 Fetching from Telegram...");

  try {
    const previewUrl = toPreviewUrl(link);
    const { data: html } = await axios.get(previewUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const videoMatch = html.match(/<video[^>]+src="([^"]+)"/i);
    const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
    const captionMatch = html.match(/<meta property="og:description" content="([^"]*)"/i);
    const caption = captionMatch ? captionMatch[1] : "";

    const mediaUrl = videoMatch?.[1] || imageMatch?.[1];

    if (!mediaUrl) {
      return reply("❌ No downloadable media found. The post may be private, text-only, or the link is wrong.");
    }

    const mediaRes = await axios.get(mediaUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(mediaRes.data);

    if (videoMatch) {
      await test.sendMessage(from, { video: buffer, caption }, { quoted: m });
    } else {
      await test.sendMessage(from, { image: buffer, caption }, { quoted: m });
    }
  } catch (e) {
    console.error("Telegram download error:", e);
    reply("❌ Failed to download. Make sure it's a public channel/post link.");
  }
});
