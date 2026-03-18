import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";
import fs from "fs";
import * as cheerio from "cheerio";
import { parse } from "@plist/plist";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FILE_PATH = "./tensei.webarchive";

const MAX_DISCORD_REPLY_LENGTH = 1800;
const MAX_CONTEXT_LENGTH = 12000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

function bufferToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function normalizeWhitespace(text) {
  return text
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u3000]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractMainHtmlFromWebarchive(filePath) {
  const raw = fs.readFileSync(filePath);

  if (typeof parse !== "function") {
    throw new Error("plist の parse が利用できない");
  }

  const parsed = parse(bufferToArrayBuffer(raw));

  if (!parsed || typeof parsed !== "object") {
    throw new Error("webarchive の plist 解析に失敗した");
  }

  const main = parsed.WebMainResource;
  if (!main || !main.WebResourceData) {
    throw new Error("WebMainResource が見つからない");
  }

  const data = main.WebResourceData;
  const mime = main.WebResourceMIMEType || "";
  const encoding =
    typeof main.WebResourceTextEncodingName === "string"
      ? main.WebResourceTextEncodingName.toLowerCase()
      : "utf-8";

  let htmlBuffer;
  if (Buffer.isBuffer(data)) {
    htmlBuffer = data;
  } else if (data instanceof Uint8Array) {
    htmlBuffer = Buffer.from(data);
  } else if (Array.isArray(data)) {
    htmlBuffer = Buffer.from(data);
  } else if (data?.buffer instanceof ArrayBuffer) {
    htmlBuffer = Buffer.from(data.buffer);
  } else {
    throw new Error("WebResourceData の形式が想定外");
  }

  if (mime && !String(mime).includes("html")) {
    console.warn(`Main resource MIME type: ${mime}`);
  }

  try {
    return htmlBuffer.toString(encoding || "utf-8");
  } catch {
    return htmlBuffer.toString("utf-8");
  }
}

function htmlToCleanText(html) {
  const $ = cheerio.load(html);

  $("script, style, noscript, svg").remove();

  const title = $("title").first().text().trim();
  const bodyText = $("body").text();

  const merged = [title, bodyText].filter(Boolean).join("\n\n");
  return normalizeWhitespace(merged);
}

function buildKeywordList(question) {
  const cleaned = question
    .replace(/<@!?\d+>/g, " ")
    .replace(/[^\p{L}\p{N}一-龠ぁ-んァ-ヶー]+/gu, " ")
    .trim();

  const words = cleaned
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);

  return [...new Set(words)].slice(0, 15);
}

function extractRelevantChunks(fullText, question) {
  const keywords = buildKeywordList(question);

  if (keywords.length === 0) {
    return fullText.slice(0, MAX_CONTEXT_LENGTH);
  }

  const text = fullText;
  const chunks = [];
  const seen = new Set();

  for (const keyword of keywords) {
    let startIndex = 0;

    while (true) {
      const idx = text.toLowerCase().indexOf(keyword.toLowerCase(), startIndex);
      if (idx === -1) break;

      const start = Math.max(0, idx - 600);
      const end = Math.min(text.length, idx + 1600);
      const snippet = text.slice(start, end).trim();

      if (!seen.has(snippet)) {
        seen.add(snippet);
        chunks.push(`【キーワード: ${keyword}】\n${snippet}`);
      }

      startIndex = idx + keyword.length;

      const total = chunks.join("\n\n---\n\n");
      if (total.length > MAX_CONTEXT_LENGTH) {
        return total.slice(0, MAX_CONTEXT_LENGTH);
      }
    }
  }

  if (chunks.length === 0) {
    return text.slice(0, MAX_CONTEXT_LENGTH);
  }

  return chunks.join("\n\n---\n\n").slice(0, MAX_CONTEXT_LENGTH);
}

function splitForDiscord(text) {
  if (text.length <= MAX_DISCORD_REPLY_LENGTH) return [text];

  const parts = [];
  let rest = text;

  while (rest.length > 0) {
    let cut = rest.slice(0, MAX_DISCORD_REPLY_LENGTH);
    const lastNewline = cut.lastIndexOf("\n");

    if (lastNewline > 400) {
      cut = cut.slice(0, lastNewline);
    }

    parts.push(cut);
    rest = rest.slice(cut.length).trimStart();
  }

  return parts;
}

async function answerWithArchive(question) {
  const html = extractMainHtmlFromWebarchive(FILE_PATH);
  const fullText = htmlToCleanText(html);
  const relevantText = extractRelevantChunks(fullText, question);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "あなたはスマスロ・パチスロの情報整理が得意なアシスタントです。回答は必ず与えられた資料の内容を優先して、日本語で分かりやすく答えてください。資料に根拠が薄い場合は断定しすぎず、『資料上では』『この資料の範囲では』と前置きしてください。",
      },
      {
        role: "user",
        content: `以下はSafariの.webarchiveから抽出した本文です。

【資料抜粋】
${relevantText}

【質問】
${question}

上の資料を優先して答えてください。`,
      },
    ],
  });

  return completion.choices[0]?.message?.content || "回答を生成できなかった";
}

client.once("ready", () => {
  console.log(`ログイン完了: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  try {
    await message.channel.sendTyping();

    const question = message.content.replace(/<@!?\d+>/g, "").trim();

    if (!question) {
      await message.reply("質問文を入れてください");
      return;
    }

    const answer = await answerWithArchive(question);
    const messages = splitForDiscord(answer);

    for (const part of messages) {
      await message.reply(part);
    }
  } catch (error) {
    console.error(error);
    const errorMessage =
      error && error.message ? error.message : String(error);
    await message.reply(`エラー: ${errorMessage}`);
  }
});

client.login(DISCORD_TOKEN);
