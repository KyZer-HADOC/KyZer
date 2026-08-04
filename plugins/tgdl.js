/**
 * #tgdl plugin — Telegram downloader
 * -----------------------------------
 * Supports TWO modes:
 *  1) Public post link:   #tgdl https://t.me/channelname/123
 *  2) Bot-token code:     #tgdl AB12CD   (code given by your Telegram bot
 *                          after someone forwards a file to it — see
 *                          telegram-listener.js)
 *
 * Also supports replying to a message that contains the link/code:
 *     #tgdl   (as a reply to a message with the t.me link)
 *
 * NOTE: This plugin follows the common `cmd()` plugin pattern used in
 * Danuwa-MD / Levanter-style forks. If your bot's plugin loader uses a
 * different wrapper (different destructured props, different require
 * path for `cmd`), adjust the top two lines and the destructured
 * params to match your `../command` module — the download logic itself
 * (fetchPublicPost / fetchByCode) does not need to change.
 *
 * ENV required (put in your bot's .env / config.js):
 *   TG_LISTENER_URL   -> base URL of the telegram-listener.js service
 *                         e.g. http://localhost:4000  or your deployed URL
 */

const { cmd, commands } = require('../command');
const axios = require('axios');
const cheerio = require('cheerio');

const TG_LISTENER_URL = process.env.TG_LISTENER_URL || 'http://localhost:4000';

// Matches t.me/channelname/123 or t.me/c/12345/123 style links
const TG_LINK_REGEX = /https?:\/\/t\.me\/(?:s\/)?([A-Za-z0-9_]+)\/(\d+)/i;
// Matches a bare 6-char code from the listener bot
const TG_CODE_REGEX = /^[A-Za-z0-9]{6}$/;

async function fetchPublicPost(channel, postId) {
    // Scrape the public embed page (works for public channels, no login needed)
    const embedUrl = `https://t.me/s/${channel}/${postId}`;
    const { data: html } = await axios.get(embedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
    });

    const $ = cheerio.load(html);
    const block = $('.tgme_widget_message').last();

    if (!block.length) {
        throw new Error('Post not found or channel is private / does not exist.');
    }

    const caption = block.find('.tgme_widget_message_text').text().trim();

    // Video
    const videoTag = block.find('video.tgme_widget_message_video');
    if (videoTag.length) {
        const videoUrl = videoTag.attr('src');
        if (videoUrl) return { type: 'video', url: videoUrl, caption };
    }

    // Photo (background-image style)
    const photoDiv = block.find('.tgme_widget_message_photo_wrap');
    if (photoDiv.length) {
        const style = photoDiv.attr('style') || '';
        const match = style.match(/url\(['"]?(.*?)['"]?\)/);
        if (match) return { type: 'image', url: match[1], caption };
    }

    // Document
    const docTag = block.find('.tgme_widget_message_document');
    if (docTag.length) {
        const href = docTag.find('a.tgme_widget_message_document_wrap').attr('href')
                   || docTag.find('a').attr('href');
        if (href) return { type: 'document', url: href, caption };
    }

    throw new Error('No downloadable media found in that post (it may be text-only or restricted).');
}

async function fetchByCode(code) {
    // Ask the telegram-listener service for the file it cached for this code
    const { data } = await axios.get(`${TG_LISTENER_URL}/file/${code}`, { timeout: 15000 });
    if (!data || !data.url) {
        throw new Error('Invalid or expired code. Ask them to forward the file to the bot again.');
    }
    return { type: data.type || 'document', url: data.url, caption: data.caption || '' };
}

cmd({
    pattern: 'tgdl',
    react: '📥',
    desc: 'Download media from a public Telegram post link, or via a bot-token code',
    category: 'download',
    filename: __filename
},
async (danuwa, mek, m, { from, quoted, body, args, q, reply }) => {
    try {
        // Get input either from the command args or from the quoted/replied message
        let input = q && q.trim();
        if (!input && quoted && quoted.text) input = quoted.text.trim();

        if (!input) {
            return reply(
                '*Telegram Downloader*\n\n' +
                '➤ Link: `#tgdl https://t.me/channel/123`\n' +
                '➤ Code: `#tgdl AB12CD` (from bot-token forward)\n' +
                '➤ Or reply to a message containing the link with `#tgdl`'
            );
        }

        const linkMatch = input.match(TG_LINK_REGEX);
        let result;

        if (linkMatch) {
            const [, channel, postId] = linkMatch;
            await reply('⏳ Fetching from Telegram channel...');
            result = await fetchPublicPost(channel, postId);
        } else if (TG_CODE_REGEX.test(input)) {
            await reply('⏳ Fetching your forwarded file...');
            result = await fetchByCode(input);
        } else {
            return reply('❌ That doesn\'t look like a valid t.me link or a 6-character code.');
        }

        const caption = result.caption ? `📩 ${result.caption}` : '📩 Downloaded via Telegram';

        if (result.type === 'video') {
            await danuwa.sendMessage(from, { video: { url: result.url }, caption }, { quoted: mek });
        } else if (result.type === 'image') {
            await danuwa.sendMessage(from, { image: { url: result.url }, caption }, { quoted: mek });
        } else {
            await danuwa.sendMessage(from, { document: { url: result.url }, mimetype: 'application/octet-stream', fileName: 'telegram_file', caption }, { quoted: mek });
        }

    } catch (e) {
        reply(`❌ Error: ${e.message}`);
    }
});
