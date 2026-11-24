const fs = require('fs');

if (fs.existsSync('config.env')) {
    require('dotenv').config({ path: './config.env' });
}

function convertToBool(text, fault = 'true') {
    return text === fault;
}

module.exports = {
    // Add SESSION_ID in the host's environment variables. Never commit a live session.
    SESSION_ID: process.env.SESSION_ID || '',
    ALIVE_IMG: process.env.ALIVE_IMG || 'https://github.com/KyZer-HADOC/KyZer/blob/main/images/KyZer%20bot_%20gothic%20cyberpunk%20aesthetic.png?raw=true',
    ALIVE_MSG: process.env.ALIVE_MSG || '*Hello👋 KyZer-Fea Is Alive Now😍*',
    BOT_OWNER: process.env.BOT_OWNER || '94718354800',
    AUTO_STATUS_SEEN: process.env.AUTO_STATUS_SEEN || 'false',
    AUTO_STATUS_REACT: process.env.AUTO_STATUS_REACT || 'true'
};
