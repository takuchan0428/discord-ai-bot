import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: message.content }],
    });

    message.reply(response.choices[0].message.content);
  } catch (error) {
    console.error(error);
    message.reply("エラー出た");
  }
});

client.login(process.env.DISCORD_TOKEN);
