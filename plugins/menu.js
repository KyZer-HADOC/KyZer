const { cmd, commands } = require("../command");
const config = require("../config"); // path ඔයාගේ project structure එකට අනුව adjust කරන්න

cmd(
  {
    pattern: "menu",
    desc: "Displays all available commands",
    category: "main",
    filename: __filename,
  },
  async (
    danuwa,
    mek,
    m,
    {
      from,
      reply
    }
  ) => {
    try {
      const categories = {};
      for (let cmdName in commands) {
        const cmdData = commands[cmdName];
        const cat = cmdData.category?.toLowerCase() || "other";
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push({
          pattern: cmdData.pattern,
          desc: cmdData.desc || "No description"
        });
      }
      let menuText = "📋 *Available Commands:*\n";
      for (const [cat, cmds] of Object.entries(categories)) {
        menuText += `\n📂 *${cat.toUpperCase()}*\n`;
        cmds.forEach(c => {
          menuText += `- .${c.pattern} : ${c.desc}\n`;
        });
      }

      // Image එකක් සමඟ menu එක යවනවා
      await danuwa.sendMessage(
        from,
        {
          image: { url: config.ALIVE_IMG }, // config.js එකේ alive image variable name එක මෙතන දාන්න
          caption: menuText.trim()
        },
        { quoted: mek }
      );

    } catch (err) {
      console.error(err);
      reply("❌ Error generating menu.");
    }
  }
);
