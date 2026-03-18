import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";
import fs from "fs";
import * as cheerio from "cheerio";
import { parse } from "@plist/plist";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FILE_PATH = "./tensei.webarchive";

const MAX_DISCORD_REPLY_LENGTH = 1800;
const MAX_CONTEXT_LENGTH = 16000;
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
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u3000]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeCompact(text) {
  return String(text || "").replace(/\s+/g, "").trim();
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

  throw new Error("WebResourceData の形式が想定外");
}

function parseWebarchive(filePath) {
  const raw = fs.readFileSync(filePath);
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
  const encoding =
    typeof main.WebResourceTextEncodingName === "string"
      ? main.WebResourceTextEncodingName.toLowerCase()
      : "utf-8";

  const htmlBuffer = decodeWebResourceData(data);

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

function extractQuestionConditions(question) {
  const q = String(question || "");

  const startAveshi =
    q.match(/(\d+)\s*あべし/)?.[1] ||
    q.match(/(\d+)\s*abeshi/i)?.[1] ||
    null;

  return {
    raw: q,
    asksExpectedValue: /期待値|何円|円で|いくら|出玉率|機械割/.test(q),
    asksSummary: /要約|まとめ|内容/.test(q),
    resetAfter: /リセット後|設定変更後|設定変更/.test(q),
    afterAT: /AT後|ＡＴ後|AT終了後/.test(q),
    shutterSnipe: /シャッター狙い/.test(q),
    shutterAriExplicit: /シャッター有り|シャッターあり|有り確定|あり確定/.test(q),
    shutterNashiExplicit: /シャッター無し|シャッターなし/.test(q),
    startAveshi,
  };
}

function buildKeywordList(question) {
  const cleaned = String(question || "")
    .replace(/<@!?\d+>/g, " ")
    .replace(/[^\p{L}\p{N}一-龠ぁ-んァ-ヶー]+/gu, " ")
    .trim();

  const words = cleaned
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);

  return [...new Set(words)].slice(0, 20);
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

function findNearestHeadingText($, tableEl) {
  const results = [];

  let node = tableEl.prev();
  let steps = 0;

  while (node.length && steps < 18) {
    const tag = (node[0]?.tagName || "").toLowerCase();
    const text = normalizeWhitespace(node.text());

    if (text) {
      if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
        results.push(text);
        break;
      }

      if (text.length <= 120) {
        results.push(text);
      }
    }

    node = node.prev();
    steps += 1;
  }

  return normalizeWhitespace(results.reverse().join(" / "));
}

function classifyConditionGroup(text) {
  const t = String(text || "");

  if (/設定変更後|リセット後|設定変更/.test(t)) return "設定変更後";
  if (/AT後|AT終了後/.test(t)) return "AT後";
  if (/シャッター有り|シャッターあり|有り確定|あり確定/.test(t)) return "シャッター有り";
  if (/シャッター無し|シャッターなし/.test(t)) return "シャッター無し";
  if (/シャッター狙い/.test(t)) return "シャッター狙い";

  return "不明";
}

function looksLikeAveshiLabel(value) {
  const s = normalizeCompact(value);
  return /^\d+-$/.test(s) || /^\d+$/.test(s);
}

function normalizeRowLabel(value) {
  const s = normalizeCompact(value);
  if (/^\d+$/.test(s)) return `${s}-`;
  if (/^\d+-$/.test(s)) return s;
  return s;
}

function extractNumberOnly(value) {
  const s = normalizeCompact(value);
  const m = s.match(/(\d+)/);
  return m ? m[1] : "";
}

function detectColumnIndexes(headers) {
  const normalized = headers.map((h) => normalizeCompact(h));

  const indexOfAny = (patterns) =>
    normalized.findIndex((h) => patterns.some((p) => h.includes(p)));

  return {
    aveshi: indexOfAny(["あべし", "開始", "ゲーム数", "g数"]),
    expectedValue: indexOfAny(["期待値"]),
    payoutRate: indexOfAny(["出玉率", "機械割"]),
    notes: indexOfAny(["備考", "条件", "補足"]),
    time: indexOfAny(["消化時間"]),
    wage: indexOfAny(["時給"]),
    hitRate: indexOfAny(["初当り", "初当たり"]),
  };
}

function scoreTableMeta(title, headerCells, contextText) {
  let score = 0;
  const full = normalizeCompact([title, ...headerCells, contextText].join(" "));

  if (full.includes("シャッター狙い")) score += 12;
  if (full.includes("設定変更後") || full.includes("リセット後") || full.includes("設定変更")) score += 12;
  if (full.includes("あべし")) score += 10;
  if (full.includes("期待値")) score += 10;
  if (full.includes("出玉率")) score += 8;
  if (full.includes("消化時間")) score += 4;
  if (full.includes("時給")) score += 4;

  if (full.includes("ランキング")) score -= 15;
  if (full.includes("優先順位")) score -= 15;
  if (full.includes("105%以上")) score -= 8;

  return score;
}

function extractRowsFromHtmlTables(html) {
  const $ = cheerio.load(html);
  const tables = [];

  $("table").each((_, tableEl) => {
    const table = $(tableEl);
    const heading = findNearestHeadingText($, table);
    const parentText = normalizeWhitespace(table.parent().text()).slice(0, 600);
    const tableText = normalizeWhitespace(table.text()).slice(0, 600);
    const contextText = normalizeWhitespace([heading, parentText, tableText].join(" / "));
    const conditionGroup = classifyConditionGroup(contextText);

    const trs = table.find("tr");
    const rowsRaw = [];
    trs.each((__, tr) => {
      const row = [];
      $(tr)
        .find("th, td")
        .each((___, cell) => {
          row.push(normalizeWhitespace($(cell).text()));
        });
      if (row.length > 0) rowsRaw.push(row);
    });

    if (rowsRaw.length === 0) return;

    let headerCells = [];
    let dataRows = rowsRaw;

    const firstRow = rowsRaw[0].map((v) => normalizeCompact(v));
    const headerLikeScore =
      firstRow.filter((v) =>
        ["あべし", "初当り", "初当たり", "期待値", "出玉率", "消化時間", "時給", "シミュ回数"].some((k) =>
          v.includes(k)
        )
      ).length;

    if (headerLikeScore >= 2) {
      headerCells = rowsRaw[0];
      dataRows = rowsRaw.slice(1);
    }

    const col = detectColumnIndexes(headerCells);
    const tableQualityScore = scoreTableMeta(heading, headerCells, contextText);
    const parsedRows = [];

    for (const cells of dataRows) {
      const compactCells = cells.map((c) => normalizeCompact(c));

      let rowLabel = "";
      let startAveshi = "";
      let expectedValueYen = "";
      let payoutRate = "";
      let notes = "";

      if (col.aveshi >= 0 && cells[col.aveshi]) {
        rowLabel = normalizeRowLabel(cells[col.aveshi]);
        startAveshi = extractNumberOnly(cells[col.aveshi]);
      } else {
        const firstAveshiCell = cells.find((c) => looksLikeAveshiLabel(c));
        if (firstAveshiCell) {
          rowLabel = normalizeRowLabel(firstAveshiCell);
          startAveshi = extractNumberOnly(firstAveshiCell);
        }
      }

      if (col.expectedValue >= 0 && cells[col.expectedValue]) {
        expectedValueYen = normalizeCompact(cells[col.expectedValue]);
      } else {
        const yenCells = compactCells.filter((c) => /円/.test(c));
        if (yenCells.length > 0) {
          expectedValueYen = yenCells[0];
        }
      }

      if (col.payoutRate >= 0 && cells[col.payoutRate]) {
        payoutRate = normalizeCompact(cells[col.payoutRate]);
      } else {
        const rateCell = compactCells.find((c) => /%/.test(c));
        if (rateCell) payoutRate = rateCell;
      }

      notes = normalizeWhitespace(cells.join(" / "));

      if (!rowLabel && !expectedValueYen && !payoutRate) continue;

      parsedRows.push({
        row_label: rowLabel,
        start_aveshi: startAveshi,
        expected_value_yen: expectedValueYen,
        payout_rate: payoutRate,
        notes,
      });
    }

    if (parsedRows.length > 0) {
      tables.push({
        table_title: heading || "HTML表",
        condition_group: conditionGroup,
        context_text: contextText,
        table_quality_score: tableQualityScore,
        rows: parsedRows,
      });
    }
  });

  return { tables };
}

function isSupportedImageMime(mime) {
  return ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"].includes(
    String(mime).toLowerCase()
  );
}

function scoreImageResource(resource) {
  const url = resource.WebResourceURL || "";
  const mime = String(resource.WebResourceMIMEType || "").toLowerCase();
  const data = resource._decodedBuffer;
  let score = data ? data.length : 0;

  if (/chart|graph|table|img|figure|image|capture|screen|jpg|jpeg|png|webp/i.test(url)) {
    score += 5000;
  }

  if (data && data.length < 20 * 1024) score -= 8000;
  if (mime === "image/gif") score -= 3000;

  return score;
}

function extractImageInputsFromParsedArchive(parsed) {
  const subresources = Array.isArray(parsed.WebSubresources) ? parsed.WebSubresources : [];
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
    if (match) return JSON.parse(match[0]);
    throw new Error("JSON parse に失敗した");
  }
}

async function extractTableRowsFromImages(question, relevantText, imageInputs) {
  if (!imageInputs || imageInputs.length === 0) {
    return { tables: [] };
  }

  const prompt = `画像内の表をそのまま読んで行データを抽出してください。
自由要約は禁止です。JSONのみ返してください。

【質問】
${question}

【本文参考】
${relevantText}

【出力形式】
{
  "tables": [
    {
      "table_title": "表タイトル",
      "condition_group": "設定変更後 / AT後 / シャッター狙い / 不明",
      "rows": [
        {
          "row_label": "64-",
          "start_aveshi": "64",
          "expected_value_yen": "1712円",
          "payout_rate": "109.1%",
          "notes": "画像表から読める条件"
        }
      ]
    }
  ]
}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1",
    temperature: 0,
    max_tokens: 1600,
    messages: [
      {
        role: "system",
        content:
          "あなたは画像表の行抽出専用アシスタントです。JSON以外を返さず、見えた数字だけをそのまま返してください。",
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...imageInputs,
        ],
      },
    ],
  });

  const content = completion.choices[0]?.message?.content || '{"tables":[]}';
  return safeJsonParse(content);
}

function mergeTables(primary, fallback) {
  return {
    tables: [
      ...(Array.isArray(primary?.tables) ? primary.tables : []),
      ...(Array.isArray(fallback?.tables) ? fallback.tables : []),
    ],
  };
}

function cleanYenText(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function normalizeConditionGroup(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function normalizeNotes(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function rowMatchesQuestion(row, table, conditions) {
  const rowLabel = String(row.row_label || "").trim();
  const rowAveshi = String(row.start_aveshi || "").trim();
  const conditionGroup = normalizeConditionGroup(table.condition_group);
  const title = normalizeConditionGroup(table.table_title);
  const notes = normalizeNotes(row.notes);
  const context = normalizeConditionGroup(table.context_text || "");
  const full = `${conditionGroup} ${title} ${notes} ${context}`;

  if (conditions.startAveshi !== null) {
    const target = String(conditions.startAveshi);
    const labelOk =
      rowLabel === `${target}-` ||
      rowLabel === `${target} -` ||
      rowLabel === target ||
      rowAveshi === target;

    if (!labelOk) return false;
  }

  if (conditions.resetAfter) {
    const ok = /設定変更後|設定変更|リセット後/.test(full);
    if (!ok) return false;
    if (/at後|at終了後/.test(full) && !/設定変更後|設定変更|リセット後/.test(full)) {
      return false;
    }
  }

  if (conditions.afterAT) {
    const ok = /at後|at終了後/.test(full);
    if (!ok) return false;
  }

  if (conditions.shutterSnipe) {
    const ok = /シャッター狙い/.test(full);
    if (!ok) return false;
  }

  if (conditions.shutterAriExplicit) {
    const ok = /シャッター有り|シャッターあり|有り確定|あり確定/.test(full);
    if (!ok) return false;
  }

  if (conditions.shutterNashiExplicit) {
    const ok = /シャッター無し|シャッターなし/.test(full);
    if (!ok) return false;
  }

  return true;
}

function buildCandidate(table, row) {
  return {
    table_title: table.table_title || "",
    condition_group: table.condition_group || "",
    context_text: table.context_text || "",
    table_quality_score: Number(table.table_quality_score || 0),
    row_label: row.row_label || "",
    start_aveshi: row.start_aveshi || "",
    expected_value_yen: cleanYenText(row.expected_value_yen || ""),
    payout_rate: row.payout_rate || "",
    notes: row.notes || "",
  };
}

function findBestMatches(extractedTables, conditions) {
  const exactMatches = [];
  const nearbyCandidates = [];

  const tables = Array.isArray(extractedTables.tables) ? extractedTables.tables : [];

  for (const table of tables) {
    const rows = Array.isArray(table.rows) ? table.rows : [];

    for (const row of rows) {
      const candidate = buildCandidate(table, row);

      if (rowMatchesQuestion(row, table, conditions)) {
        exactMatches.push(candidate);
      } else {
        nearbyCandidates.push(candidate);
      }
    }
  }

  return { exactMatches, nearbyCandidates };
}

function applyStrictPreference(matches, conditions) {
  let filtered = [...matches];

  if (conditions.resetAfter) {
    const resetPreferred = filtered.filter((m) => {
      const full = `${m.condition_group} ${m.table_title} ${m.notes} ${m.context_text}`;
      return /設定変更後|設定変更|リセット後/.test(full) && !/AT後|AT終了後/.test(full);
    });
    if (resetPreferred.length > 0) filtered = resetPreferred;
  }

  if (conditions.afterAT) {
    const atPreferred = filtered.filter((m) => {
      const full = `${m.condition_group} ${m.table_title} ${m.notes} ${m.context_text}`;
      return /AT後|AT終了後/.test(full);
    });
    if (atPreferred.length > 0) filtered = atPreferred;
  }

  if (conditions.shutterSnipe) {
    const shutterPreferred = filtered.filter((m) => {
      const full = `${m.condition_group} ${m.table_title} ${m.notes} ${m.context_text}`;
      return /シャッター狙い/.test(full);
    });
    if (shutterPreferred.length > 0) filtered = shutterPreferred;
  }

  if (conditions.asksExpectedValue) {
    const withExpectedValue = filtered.filter((m) => /円/.test(m.expected_value_yen));
    if (withExpectedValue.length > 0) filtered = withExpectedValue;
  }

  return filtered;
}

function pickBestExactMatch(matches, conditions) {
  if (matches.length === 0) return null;

  const strictlyFiltered = applyStrictPreference(matches, conditions);

  const scored = strictlyFiltered.map((m) => {
    let score = 0;

    if (conditions.startAveshi !== null) {
      if (String(m.start_aveshi) === String(conditions.startAveshi)) score += 30;
      if (String(m.row_label) === `${conditions.startAveshi}-`) score += 30;
    }

    const full = `${m.condition_group} ${m.notes} ${m.table_title} ${m.context_text}`;

    if (conditions.resetAfter && /設定変更後|設定変更|リセット後/.test(full)) score += 20;
    if (conditions.afterAT && /AT後|AT終了後/.test(full)) score += 20;
    if (conditions.shutterSnipe && /シャッター狙い/.test(full)) score += 20;
    if (conditions.shutterAriExplicit && /シャッター有り|シャッターあり|有り確定|あり確定/.test(full)) score += 8;
    if (conditions.shutterNashiExplicit && /シャッター無し|シャッターなし/.test(full)) score += 8;

    if (m.expected_value_yen && /円/.test(m.expected_value_yen)) score += 25;
    if (m.payout_rate && /%/.test(m.payout_rate)) score += 8;

    score += Number(m.table_quality_score || 0);

    if (/ランキング|優先順位|105%以上/.test(full)) score -= 20;
    if (/AT後|AT終了後/.test(full) && conditions.resetAfter) score -= 50;
    if (/設定変更後|設定変更|リセット後/.test(full) && conditions.afterAT) score -= 50;

    return { ...m, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);
  return scored[0];
}

function formatAnswer(question, bestMatch, nearbyCandidates) {
  if (bestMatch) {
    const lines = [];
    lines.push(`結論: ${question} の期待値は ${bestMatch.expected_value_yen}`);
    lines.push("");
    lines.push("根拠:");
    lines.push(`- 行ラベル: ${bestMatch.row_label}`);
    lines.push(`- 条件群: ${bestMatch.condition_group || "不明"}`);
    lines.push(`- 表タイトル: ${bestMatch.table_title || "不明"}`);
    lines.push(`- 期待値: ${bestMatch.expected_value_yen || "不明"}`);
    if (bestMatch.payout_rate) lines.push(`- 出玉率: ${bestMatch.payout_rate}`);
    if (bestMatch.notes) lines.push(`- 補足: ${bestMatch.notes}`);
    return lines.join("\n");
  }

  const lines = [];
  lines.push("結論: 資料上で質問条件に完全一致する数値を断定できなかった");
  lines.push("");
  lines.push("近い候補:");
  for (const c of nearbyCandidates.slice(0, 8)) {
    lines.push(
      `- 行:${c.row_label || "不明"} / 条件:${c.condition_group || "不明"} / 期待値:${c.expected_value_yen || "不明"} / 表:${c.table_title || "不明"}`
    );
  }
  lines.push("");
  lines.push(`質問: ${question}`);

  return lines.join("\n");
}

async function answerWithArchive(question) {
  const parsed = parseWebarchive(FILE_PATH);
  const html = extractMainHtmlFromParsedArchive(parsed);
  const fullText = htmlToCleanText(html);
  const relevantText = extractRelevantChunks(fullText, question);
  const conditions = extractQuestionConditions(question);

  const htmlTables = extractRowsFromHtmlTables(html);
  const imageInputs = extractImageInputsFromParsedArchive(parsed);
  const imageTables = await extractTableRowsFromImages(question, relevantText, imageInputs);

  const merged = mergeTables(htmlTables, imageTables);
  const { exactMatches, nearbyCandidates } = findBestMatches(merged, conditions);
  const bestMatch = pickBestExactMatch(exactMatches, conditions);

  return formatAnswer(question, bestMatch, nearbyCandidates);
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
    const errorMessage = error?.message || String(error);
    await message.reply(`エラー: ${errorMessage}`);
  }
});

client.login(DISCORD_TOKEN);
