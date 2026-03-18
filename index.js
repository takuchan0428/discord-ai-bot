import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";
import fs from "fs";
import * as cheerio from "cheerio";
import { parse } from "@plist/plist";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FILE_PATH = "./tensei.webarchive";

const MAX_DISCORD_REPLY_LENGTH = 1800;
const MAX_CONTEXT_LENGTH = 14000;
const MAX_IMAGES_TO_SEND = 6;
const MIN_IMAGE_BYTES = 8 * 1024;

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

function describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Buffer.isBuffer(value)) return "Buffer";
  if (value instanceof Uint8Array) return "Uint8Array";
  if (value instanceof ArrayBuffer) return "ArrayBuffer";
  if (Array.isArray(value)) return "Array";
  return typeof value === "object"
    ? `object keys: ${Object.keys(value).join(", ")}`
    : typeof value;
}

function decodeWebResourceData(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (Array.isArray(data)) return Buffer.from(data);

  if (typeof data === "string") {
    const trimmed = data.trim();

    if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 0) {
      try {
        const base64Buf = Buffer.from(trimmed.replace(/\s+/g, ""), "base64");
        if (base64Buf.length > 0) return base64Buf;
      } catch {
        // fallthrough
      }
    }

    return Buffer.from(trimmed, "utf-8");
  }

  if (data && typeof data === "object") {
    if (Buffer.isBuffer(data.data)) return data.data;
    if (data.data instanceof Uint8Array) return Buffer.from(data.data);
    if (data.data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data.data));
    if (Array.isArray(data.data)) return Buffer.from(data.data);

    if (typeof data.data === "string") {
      try {
        const buf = Buffer.from(data.data.replace(/\s+/g, ""), "base64");
        if (buf.length > 0) return buf;
      } catch {
        return Buffer.from(data.data, "utf-8");
      }
    }

    if (typeof data.value === "string") {
      try {
        const buf = Buffer.from(data.value.replace(/\s+/g, ""), "base64");
        if (buf.length > 0) return buf;
      } catch {
        return Buffer.from(data.value, "utf-8");
      }
    }

    if (typeof data.base64 === "string") {
      return Buffer.from(data.base64.replace(/\s+/g, ""), "base64");
    }

    if (typeof data.raw === "string") {
      return Buffer.from(data.raw.replace(/\s+/g, ""), "base64");
    }
  }

  throw new Error(`WebResourceData の形式が想定外: ${describeValue(data)}`);
}

function parseWebarchive(filePath) {
  const raw = fs.readFileSync(filePath);

  if (typeof parse !== "function") {
    throw new Error("plist の parse が利用できない");
  }

  const parsed = parse(bufferToArrayBuffer(raw));

  if (!parsed || typeof parsed !== "object") {
    throw new Error("webarchive の plist 解析に失敗した");
  }

  return parsed;
}

function extractMainHtmlFromParsedArchive(parsed) {
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

  const htmlBuffer = decodeWebResourceData(data);

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

  return normalizeWhitespace([title, bodyText].filter(Boolean).join("\n\n"));
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

  return [...new Set(words)].slice(0, 20);
}

function extractQuestionConditions(question) {
  const q = question.toLowerCase();

  return {
    asksExpectedValue:
      /期待値|何円|円で|いくら|出玉率|機械割/.test(question),
    asksSummary:
      /要約|まとめ|教えて|内容/.test(question),
    resetAfter:
      /リセット後|設定変更後|設定変更/.test(question),
    afterAT:
      /at後|at終了後/.test(q) || /ＡＴ後|AT後|AT終了後/.test(question),
    fromZero:
      /0あべし|０あべし/.test(question),
    from256:
      /256あべし/.test(question),
    shutterSnipe:
      /シャッター狙い/.test(question),
    shutterAriExplicit:
      /シャッター有り|シャッターあり|有り確定|あり確定/.test(question),
    shutterNashiExplicit:
      /シャッター無し|シャッターなし/.test(question),
  };
}

function buildConditionGuidance(question) {
  const c = extractQuestionConditions(question);
  const lines = [];

  lines.push("【質問条件の整理】");

  if (c.resetAfter) lines.push("- 『リセット後 / 設定変更後』が指定されている");
  if (c.afterAT) lines.push("- 『AT後』が指定されている");
  if (c.fromZero) lines.push("- 『0あべし開始』が指定されている");
  if (c.from256) lines.push("- 『256あべし開始』が指定されている");
  if (c.shutterSnipe) lines.push("- 『シャッター狙い』がテーマ");
  if (c.shutterAriExplicit) lines.push("- 『シャッター有り』が明示指定されている");
  if (c.shutterNashiExplicit) lines.push("- 『シャッター無し』が明示指定されている");

  lines.push("");
  lines.push("【厳守ルール】");
  lines.push("- 質問条件と一致しない表や数値は答えに使わない");
  lines.push("- 特に『リセット後』と『AT後』は別物として扱う");
  lines.push("- 特に『シャッター狙い』と『シャッター有り確定時』は別物として扱う");
  lines.push("- ユーザーが明示していない限り、『シャッター有り』の数値を『シャッター狙い』の数値として流用しない");
  lines.push("- 条件が一致する数値を見つけられない場合、勝手に近い表を採用せず『資料上で完全一致の数値は確認できない』と答える");
  lines.push("- 数値を答える時は、『どの条件の数値か』を必ず1行目に明記する");

  return lines.join("\n");
}

function extractRelevantChunks(fullText, question) {
  const keywords = buildKeywordList(question);
  const conditions = extractQuestionConditions(question);
  const text = fullText;
  const chunks = [];
  const seen = new Set();

  const manualKeywords = [];

  if (conditions.resetAfter) manualKeywords.push("設定変更", "設定変更後", "リセット");
  if (conditions.afterAT) manualKeywords.push("AT後", "AT終了後");
  if (conditions.fromZero) manualKeywords.push("0あべし");
  if (conditions.from256) manualKeywords.push("256あべし");
  if (conditions.shutterSnipe) manualKeywords.push("シャッター狙い");
  if (conditions.shutterAriExplicit) manualKeywords.push("シャッター有り", "シャッターあり");
  if (conditions.shutterNashiExplicit) manualKeywords.push("シャッター無し", "シャッターなし");
  if (conditions.asksExpectedValue) manualKeywords.push("期待値", "円", "出玉率");

  const mergedKeywords = [...new Set([...keywords, ...manualKeywords])];

  for (const keyword of mergedKeywords) {
    let startIndex = 0;

    while (true) {
      const idx = text.toLowerCase().indexOf(keyword.toLowerCase(), startIndex);
      if (idx === -1) break;

      const start = Math.max(0, idx - 900);
      const end = Math.min(text.length, idx + 2200);
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

function isSupportedImageMime(mime) {
  return [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
  ].includes(String(mime).toLowerCase());
}

function scoreImageResource(resource) {
  const url = resource.WebResourceURL || "";
  const mime = String(resource.WebResourceMIMEType || "").toLowerCase();
  const data = resource._decodedBuffer;
  let score = data ? data.length : 0;

  if (/chart|graph|table|img|figure|image|capture|screen|jpg|jpeg|png|webp/i.test(url)) {
    score += 5000;
  }

  if (data && data.length < 20 * 1024) {
    score -= 8000;
  }

  if (mime === "image/gif") {
    score -= 3000;
  }

  return score;
}

function extractImageInputsFromParsedArchive(parsed) {
  const subresources = Array.isArray(parsed.WebSubresources)
    ? parsed.WebSubresources
    : [];

  const candidates = [];

  for (const resource of subresources) {
    try {
      const mime = String(resource.WebResourceMIMEType || "").toLowerCase();

      if (!isSupportedImageMime(mime)) continue;
      if (!resource.WebResourceData) continue;

      const buffer = decodeWebResourceData(resource.WebResourceData);
      if (!buffer || buffer.length < MIN_IMAGE_BYTES) continue;

      resource._decodedBuffer = buffer;

      candidates.push({
        mime,
        url: resource.WebResourceURL || "",
        buffer,
        score: scoreImageResource(resource),
      });
    } catch (error) {
      console.warn("画像サブリソースの解析をスキップ:", error?.message || error);
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  return candidates.slice(0, MAX_IMAGES_TO_SEND).map((item) => {
    const base64 = item.buffer.toString("base64");
    return {
      type: "image_url",
      image_url: {
        url: `data:${item.mime};base64,${base64}`,
        detail: "high",
      },
    };
  });
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
  const parsed = parseWebarchive(FILE_PATH);
  const html = extractMainHtmlFromParsedArchive(parsed);
  const fullText = htmlToCleanText(html);
  const relevantText = extractRelevantChunks(fullText, question);
  const imageInputs = extractImageInputsFromParsedArchive(parsed);
  const conditionGuidance = buildConditionGuidance(question);

  const userContent = [
    {
      type: "text",
      text: `以下はSafariの.webarchiveから抽出した本文です。

【資料抜粋】
${relevantText}

【補足】
このwebarchive内に含まれる画像も添付しています。画像内の表・数値・注釈・見出しも確認してください。

${conditionGuidance}

【質問】
${question}

【出力ルール】
- 条件に完全一致する数値だけ答える
- 一致しない近い条件の数値は使わない
- 数値回答の1行目で、どの条件の数値か必ず明記する
- 条件一致の数値が見つからない場合は、その旨を明記する
- パチスロ期待値の質問では、結論→根拠→補足の順に短く答える`,
    },
    ...imageInputs,
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.0,
    messages: [
      {
        role: "system",
        content:
          "あなたはパチスロ期待値稼働のプロです。資料の条件差を厳密に見分けてください。『リセット後』『AT後』『シャッター狙い』『シャッター有り確定』『シャッター無し』は別条件です。似た数値を流用せず、条件一致を最優先してください。",
      },
      {
        role: "user",
        content: userContent,
      },
    ],
    max_tokens: 1200,
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
