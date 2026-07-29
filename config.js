const fs = require('fs');
if (fs.existsSync('config.env')) require('dotenv').config({ path: './config.env' });

function convertToBool(text, fault = 'true') {
    return text === fault ? true : false;
}
module.exports = {
SESSION_ID: process.env.SESSION_ID || "W3gV2Sqa#AvoMYbmWzyZs_cMS_lECBfPTmS3eWtPsHJSCAkkBx4w",
ALIVE_IMG: process.env.ALIVE_IMG || "https://github.com/KyZer-HADOC/KyZer/blob/main/images/KyZer%20bot_%20gothic%20cyberpunk%20aesthetic.png?raw=true",
ALIVE_MSG: process.env.ALIVE_MSG || "*Hello👋 KyZer-Fea Is Alive Now😍*",
BOT_OWNER: '94718354800',  // Replace with the owner's phone number
AUTO_STATUS_SEEN: 'false',
AUTO_STATUS_REACT: 'true',



};
