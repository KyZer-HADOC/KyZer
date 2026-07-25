const fs = require('fs');
if (fs.existsSync('config.env')) require('dotenv').config({ path: './config.env' });

function convertToBool(text, fault = 'true') {
    return text === fault ? true : false;
}
module.exports = {
SESSION_ID: process.env.SESSION_ID || "f6Y3GK7D#VAg30M6hWaJT7QJ8_-z_IiArG_kkVjx0PyhM8O8KCbk",
ALIVE_IMG: process.env.ALIVE_IMG || "https://github.com/KyZer-HADOC/KyZer/blob/main/images/KyZer%20bot_%20gothic%20cyberpunk%20aesthetic.png?raw=true",
ALIVE_MSG: process.env.ALIVE_MSG || "*Hello👋 KyZer-Fea Is Alive Now😍*",
BOT_OWNER: '94716252002',  // Replace with the owner's phone number



};
