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
const MAX_IMAGES_TO_SEND = 8;
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
    if (data.data instanceof ArrayBuffer) {
      return Buffer.from(new Uint8Array(data.data));
    }
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

  const startAveshi =
    question.match(/(\d+)\s*あべし/)?.[1] ||
    question.match(/(\d+)\s*abeshi/i)?.[1] ||
    null;

  return {
    raw: question,
    asksExpectedValue:
      /期待値|何円|円で|いくら|出玉率|機械割/.test(question),
    resetAfter:
      /リセット後|設定変更後|設定変更/.test(question),
    afterAT:
      /at後|at終了後/.test(q) || /ＡＴ後|AT後|AT終了後/.test(question),
    shutterSnipe:
      /シャッター狙い/.test(question),
    shutterAriExplicit:
      /シャッター有り|シャッターあり|有り確定|あり確定/.test(question),
    shutterNashiExplicit:
      /シャッター無し|シャッターなし/.test(question),
    startAveshi,
  };
}

function buildConditionGuidance(question) {
  const c = extractQuestionConditions(question);
  const lines = [];

  lines.push("【質問条件】");
  if (c.resetAfter) lines.push("- リセット後 / 設定変更後");
  if (c.afterAT) lines.push("- AT後");
  if (c.shutterSnipe) lines.push("- シャッター狙い");
  if (c.shutterAriExplicit) lines.push("- シャッター有り明示");
  if (c.shutterNashiExplicit) lines.push("- シャッター無し明示");
  if (c.startAveshi !== null) lines.push(`- 開始あべし: ${c.startAveshi}`);

  lines.push("");
  lines.push("【厳守】");
  lines.push("- 表を行単位で読む");
  lines.push("- 32あべしなら 32- 行を探す");
  lines.push("- 0あべしなら 0- 行を探す");
  lines.push("- リセット後 と AT後 は別条件");
  lines.push("- シャッター狙い と シャッター有り確定 は別条件");
  lines.push("- 条件が近くても一致しない行は exact=false 扱い");
  lines.push("- 画像内の表の数字を優先的に読む");

  return lines.join("\n");
}

function extractRelevantChunks(fullText, question) {
  const keywords = buildKeywordList(question);
  const conditions = extractQuestionConditions(question);

  const manualKeywords = [];

  if (conditions.resetAfter) manualKeywords.push("設定変更", "設定変更後", "リセット");
  if (conditions.afterAT) manualKeywords.push("AT後", "AT終了後");
  if (conditions.shutterSnipe) manualKeywords.push("シャッター狙い");
  if (conditions.shutterAriExplicit) manualKeywords.push("シャッター有り", "シャッターあり");
  if (conditions.shutterNashiExplicit) manualKeywords.push("シャッター無し", "シャッターなし");
  if (conditions.asksExpectedValue) manualKeywords.push("期待値", "円", "出玉率");
  if (conditions.startAveshi !== null) manualKeywords.push(`${conditions.startAveshi}あべし`);

  const mergedKeywords = [...new Set([...keywords, ...manualKeywords])];
  const chunks = [];
  const seen = new Set();

  for (const keyword of mergedKeywords) {
    let startIndex = 0;

    while (true) {
      const idx = fullText.toLowerCase().indexOf(keyword.toLowerCase(), startIndex);
      if (idx === -1) break;

      const start = Math.max(0, idx - 900);
      const end = Math.min(fullText.length, idx + 2200);
      const snippet = fullText.slice(start, end).trim();

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
    return fullText.slice(0, MAX_CONTEXT_LENGTH);
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

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error("JSON parse に失敗した");
  }
}

async function extractTableRowsFromImages(question, relevantText, imageInputs) {
  const prompt = `あなたは画像内の表をそのまま読んで行データを抽出する役目です。
自由要約は禁止です。見える表の各行をそのまま抜いてください。

${buildConditionGuidance(question)}

【本文参考】
${relevantText}

【出力形式】
JSONのみを返してください。
{
  "tables": [
    {
      "table_title": "表タイトル",
      "condition_group": "設定変更後 / AT後 / 不明 など",
      "rows": [
        {
          "row_label": "0-",
          "start_aveshi": "0",
          "expected_value_yen": "1486円",
          "payout_rate": "108.1%",
          "notes": "表から読める条件"
        }
      ]
    }
  ]
}

【重要】
- 32あべしなら row_label は 32- と読む
- 読めないセルは空文字でよい
- 画像に複数表があるなら全部出す
- JSON以外の文章は書かない`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1",
    temperature: 0,
    max_tokens: 1800,
    messages: [
      {
        role: "system",
        content:
          "あなたは画像OCRと表抽出に特化したアシスタントです。表を行単位で正確に抜いてJSONで返してください。",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt,
          },
          ...imageInputs,
        ],
      },
    ],
  });

  const content = completion.choices[0]?.message?.content || "{}";
  return safeJsonParse(content);
}

function cleanYenText(value) {
  if (!value) return "";
  return String(value).replace(/\s+/g, "").trim();
}

function normalizeConditionGroup(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function normalizeNotes(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function rowMatchesQuestion(row, table, conditions) {
  const rowLabel = String(row.row_label || "").trim();
  const rowAveshi = String(row.start_aveshi || "").trim();
  const conditionGroup = normalizeConditionGroup(table.condition_group);
  const notes = normalizeNotes(row.notes);

  if (conditions.startAveshi !== null) {
    const target = String(conditions.startAveshi);
    const labelOk =
      rowLabel === `${target}-` ||
      rowLabel === `${target} -` ||
      rowLabel === target ||
      rowAveshi === target;

    if (!labelOk) {
      return false;
    }
  }

  if (conditions.resetAfter) {
    const ok =
      conditionGroup.includes("設定変更後".toLowerCase()) ||
      conditionGroup.includes("リセット後".toLowerCase()) ||
      conditionGroup.includes("設定変更".toLowerCase()) ||
      notes.includes("設定変更後") ||
      notes.includes("リセット後") ||
      notes.includes("設定変更");

    if (!ok) return false;
  }

  if (conditions.afterAT) {
    const ok =
      conditionGroup.includes("at後") ||
      conditionGroup.includes("at終了後") ||
      notes.includes("at後") ||
      notes.includes("at終了後");

    if (!ok) return false;
  }

  if (conditions.shutterSnipe) {
    const rejectAriOnly =
      !conditions.shutterAriExplicit &&
      (notes.includes("シャッター有り") ||
        notes.includes("シャッターあり") ||
        notes.includes("有り確定") ||
        notes.includes("あり確定"));

    if (rejectAriOnly) return false;
  }

  if (conditions.shutterAriExplicit) {
    const ok =
      notes.includes("シャッター有り") ||
      notes.includes("シャッターあり") ||
      notes.includes("有り確定") ||
      notes.includes("あり確定") ||
      conditionGroup.includes("シャッター有り") ||
      conditionGroup.includes("シャッターあり");

    if (!ok) return false;
  }

  if (conditions.shutterNashiExplicit) {
    const ok =
      notes.includes("シャッター無し") ||
      notes.includes("シャッターなし") ||
      conditionGroup.includes("シャッター無し") ||
      conditionGroup.includes("シャッターなし");

    if (!ok) return false;
  }

  return true;
}

function findBestMatches(extractedTables, conditions) {
  const exactMatches = [];
  const nearbyCandidates = [];

  const tables = Array.isArray(extractedTables.tables) ? extractedTables.tables : [];

  for (const table of tables) {
    const rows = Array.isArray(table.rows) ? table.rows : [];

    for (const row of rows) {
      const candidate = {
        table_title: table.table_title || "",
        condition_group: table.condition_group || "",
        row_label: row.row_label || "",
        start_aveshi: row.start_aveshi || "",
        expected_value_yen: cleanYenText(row.expected_value_yen || ""),
        payout_rate: row.payout_rate || "",
        notes: row.notes || "",
      };

      if (rowMatchesQuestion(row, table, conditions)) {
        exactMatches.push(candidate);
      } else {
        nearbyCandidates.push(candidate);
      }
    }
  }

  return { exactMatches, nearbyCandidates };
}

function pickBestExactMatch(matches, conditions) {
  if (matches.length === 0) return null;

  const scored = matches.map((m) => {
    let score = 0;

    if (conditions.startAveshi !== null) {
      if (String(m.start_aveshi) === String(conditions.startAveshi)) score += 10;
      if (String(m.row_label) === `${conditions.startAveshi}-`) score += 10;
    }

    const group = String(m.condition_group || "");
    const notes = String(m.notes || "");

    if (conditions.resetAfter && /設定変更後|設定変更|リセット後/.test(group + notes)) score += 8;
    if (conditions.afterAT && /AT後|AT終了後/.test(group + notes)) score += 8;

    if (conditions.shutterSnipe && /シャッター狙い/.test(group + notes + m.table_title)) score += 6;
    if (conditions.shutterAriExplicit && /シャッター有り|シャッターあり|有り確定|あり確定/.test(group + notes)) score += 6;
    if (conditions.shutterNashiExplicit && /シャッター無し|シャッターなし/.test(group + notes)) score += 6;

    if (m.expected_value_yen) score += 3;

    return { ...m, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);
  return scored[0];
}

function formatAnswer(question, conditions, bestMatch, nearbyCandidates) {
  if (bestMatch) {
    const lines = [];
    lines.push(`結論: ${question} の期待値は ${bestMatch.expected_value_yen}`);
    lines.push("");
    lines.push("根拠:");
    lines.push(`- 行ラベル: ${bestMatch.row_label}`);
    lines.push(`- 条件群: ${bestMatch.condition_group || "不明"}`);
    lines.push(`- 表タイトル: ${bestMatch.table_title || "不明"}`);
    lines.push(`- 期待値: ${bestMatch.expected_value_yen || "不明"}`);
    if (bestMatch.payout_rate) {
      lines.push(`- 出玉率: ${bestMatch.payout_rate}`);
    }
    if (bestMatch.notes) {
      lines.push(`- 補足: ${bestMatch.notes}`);
    }
    return lines.join("\n");
  }

  const lines = [];
  lines.push("結論: 資料上で質問条件に完全一致する数値を断定できなかった");
  lines.push("");
  lines.push("近い候補:");
  for (const c of nearbyCandidates.slice(0, 8)) {
    lines.push(
      `- 行:${c.row_label} / 条件:${c.condition_group || "不明"} / 期待値:${c.expected_value_yen || "不明"} / 表:${c.table_title || "不明"}`
    );
  }
  lines.push("");
  lines.push(`質問: ${question}`);
  return lines.join("\n");
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

  const conditions = extractQuestionConditions(question);
  const extractedTables = await extractTableRowsFromImages(
    question,
    relevantText,
    imageInputs
  );

  const { exactMatches, nearbyCandidates } = findBestMatches(
    extractedTables,
    conditions
  );

  const bestMatch = pickBestExactMatch(exactMatches, conditions);

  return formatAnswer(question, conditions, bestMatch, nearbyCandidates);
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
    const parts = splitForDiscord(answer);

    for (const part of parts) {
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
