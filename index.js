import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client, GatewayIntentBits, Partials } from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN が未設定");
  process.exit(1);
}

const DATA_PATH = path.join(__dirname, "machines", "tensei", "data.json");

function loadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    console.error(`JSON読込失敗: ${filePath}`);
    console.error(error);
    return null;
  }
}

const tenseiData = loadJson(DATA_PATH);

function normalizeText(text) {
  return String(text || "")
    .replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0))
    .replace(/[‐-‒–—―ー]/g, "-")
    .replace(/[〜～]/g, "~")
    .replace(/\s+/g, "")
    .replace(/　+/g, "")
    .trim()
    .toLowerCase();
}

function includesAny(text, keywords) {
  return keywords.some((k) => text.includes(normalizeText(k)));
}

function stripBotMention(content, clientUserId) {
  if (!content) return "";
  return content.replace(new RegExp(`<@!?${clientUserId}>`, "g"), "").trim();
}

function extractAveshi(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(/(\d+)(?=あべし)/);
  return match ? Number(match[1]) : null;
}

function getMachineMatched(text) {
  const normalized = normalizeText(text);
  const aliases = [
    "転生",
    "北斗転生",
    "転生の章2",
    "スマスロ転生",
    "北斗の拳転生の章2",
  ];
  return aliases.some((alias) => normalized.includes(normalizeText(alias)));
}

function flattenTables(data) {
  if (!data || !Array.isArray(data.sources)) return [];

  const result = [];

  for (const source of data.sources) {
    const allTables = [];

    if (Array.isArray(source.tables)) {
      allTables.push(...source.tables.map((t) => ({ ...t, __kind: "tables" })));
    }

    if (Array.isArray(source.tables_continued)) {
      allTables.push(
        ...source.tables_continued.map((t) => ({
          ...t,
          __kind: "tables_continued",
        }))
      );
    }

    for (const table of allTables) {
      result.push({
        sourceFile: source.file || "",
        sourceTitle: source.title || "",
        headings: Array.isArray(source.headings) ? source.headings : [],
        index: table.index,
        context: Array.isArray(table.context) ? table.context : [],
        rows: Array.isArray(table.rows) ? table.rows : [],
        kind: table.__kind || "",
      });
    }
  }

  return result;
}

const FLAT_TABLES = flattenTables(tenseiData);

function getJoinedContext(table) {
  return normalizeText(
    [
      table.sourceTitle || "",
      ...(Array.isArray(table.context) ? table.context : []),
      ...(Array.isArray(table.headings) ? table.headings : []),
      table.sourceFile || "",
    ].join(" ")
  );
}

function rowToJoinedText(row) {
  if (!Array.isArray(row)) return "";
  return normalizeText(row.join(" "));
}

function isLikelyExpectationHeader(row) {
  if (!Array.isArray(row)) return false;
  const joined = rowToJoinedText(row);
  return joined.includes("期待値");
}

function parseYen(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const match = normalized.match(/-?\d+(?:\.\d+)?(?=円)/);
  return match ? Number(match[0]) : null;
}

function parsePercent(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const match = normalized.match(/-?\d+(?:\.\d+)?(?=%)/);
  return match ? Number(match[0]) : null;
}

function parseMinutes(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const match = normalized.match(/-?\d+(?:\.\d+)?(?=分)/);
  return match ? Number(match[0]) : null;
}

function parseAveshiCell(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  // 64- / 64~ / 64〜 / 64
  const m1 = normalized.match(/^(\d+)(?:-|~)?$/);
  if (m1) return Number(m1[1]);

  // 64あべし~
  const m2 = normalized.match(/^(\d+)あべし(?:-|~)?$/);
  if (m2) return Number(m2[1]);

  return null;
}

function inferScenarioFromQuestion(question) {
  const q = normalizeText(question);

  const isReset = includesAny(q, ["リセット後", "設定変更後", "リセ後", "朝イチ"]);
  const isAfterAt = includesAny(q, ["at後", "AT後"]) && !isReset;
  const isShutter = includesAny(q, ["シャッター狙い", "シャッター"]);
  const isShutterYes = includesAny(q, ["シャッター有り", "シャッターあり"]);
  const isShutterNo = includesAny(q, ["シャッター無し", "シャッターなし"]);
  const isTenjo = includesAny(q, ["天井狙い", "天井"]);
  const isIgnore = includesAny(q, ["有無不問", "シャッター有無不問", "シャッター不問"]);
  const aveshi = extractAveshi(question);

  return {
    aveshi,
    isReset,
    isAfterAt,
    isShutter,
    isShutterYes,
    isShutterNo,
    isTenjo,
    isIgnore,
    raw: q,
  };
}

function inferScenarioScore(table, scenario, headerRow, dataRow) {
  const context = getJoinedContext(table);
  const header = rowToJoinedText(headerRow);
  const rowText = rowToJoinedText(dataRow);

  let score = 0;

  if (header.includes("期待値")) score += 20;
  if (rowText.includes("円")) score += 10;

  // 機種/テーマ
  if (context.includes("転生")) score += 5;
  if (context.includes("シャッター")) score += 5;
  if (context.includes("期待値")) score += 5;

  // リセット/設定変更後
  if (scenario.isReset) {
    if (context.includes("設定変更後")) score += 80;
    if (context.includes("リセット後")) score += 80;
    if (context.includes("朝イチ")) score += 40;
    if (context.includes("AT後")) score -= 120;
  }

  // AT後
  if (scenario.isAfterAt) {
    if (context.includes("AT後")) score += 80;
    if (context.includes("設定変更後")) score -= 120;
    if (context.includes("リセット後")) score -= 120;
  }

  // シャッター有り/無し
  if (scenario.isShutterYes) {
    if (context.includes("シャッター有り後") || context.includes("シャッターあり後")) score += 120;
    if (context.includes("シャッター無し後") || context.includes("シャッターなし後")) score -= 140;
  }

  if (scenario.isShutterNo) {
    if (context.includes("シャッター無し後") || context.includes("シャッターなし後")) score += 120;
    if (context.includes("シャッター有り後") || context.includes("シャッターあり後")) score -= 140;
  }

  // シャッター狙い
  if (scenario.isShutter) {
    if (context.includes("シャッター狙い")) score += 50;
    if (context.includes("天井狙い")) score -= 60;
  }

  // 天井狙い
  if (scenario.isTenjo) {
    if (context.includes("天井狙い")) score += 90;
    if (context.includes("シャッター狙い")) score -= 60;
  }

  // 有無不問
  if (scenario.isIgnore) {
    if (context.includes("有無不問")) score += 120;
  }

  // 条件が曖昧なら 設定変更後シャッター狙い を優先しすぎない
  if (
    scenario.isShutter &&
    !scenario.isReset &&
    !scenario.isAfterAt &&
    !scenario.isShutterYes &&
    !scenario.isShutterNo &&
    context.includes("設定変更後")
  ) {
    score += 10;
  }

  // fabricatedっぽい雑表を少し下げる
  if (context.includes("総合期待値まとめ")) score -= 10;
  if (context.includes("最適立ち回りまとめ")) score -= 10;

  return score;
}

function extractCandidateRows(question) {
  const scenario = inferScenarioFromQuestion(question);
  if (scenario.aveshi === null) return [];

  const candidates = [];

  for (const table of FLAT_TABLES) {
    if (!Array.isArray(table.rows) || table.rows.length < 2) continue;

    const headerRow = table.rows[0];
    if (!isLikelyExpectationHeader(headerRow)) continue;

    for (let i = 1; i < table.rows.length; i += 1) {
      const row = table.rows[i];
      if (!Array.isArray(row) || row.length === 0) continue;

      const startAveshi = parseAveshiCell(row[0]);
      if (startAveshi === null) continue;
      if (Number(startAveshi) !== Number(scenario.aveshi)) continue;

      const yen = row.map(parseYen).find((v) => v !== null);
      const percent = row.map(parsePercent).find((v) => v !== null);
      const minutes = row.map(parseMinutes).find((v) => v !== null);

      const score = inferScenarioScore(table, scenario, headerRow, row);

      candidates.push({
        score,
        startAveshi,
        expectedYen: yen,
        payoutRate: percent,
        playTimeMin: minutes,
        rawRow: row,
        rawHeader: headerRow,
        context: table.context,
        headings: table.headings,
        sourceFile: table.sourceFile,
        sourceTitle: table.sourceTitle,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function formatYen(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "不明";
  return `${Number(value)}円`;
}

function formatRate(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "不明";
  return `${Number(value)}%`;
}

function formatMinutes(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "不明";
  return `${Number(value)}分`;
}

function buildExactAnswer(question, candidate) {
  const ctx = Array.isArray(candidate.context) ? candidate.context.join(" / ") : "";
  const rowJoined = Array.isArray(candidate.rawRow) ? candidate.rawRow.join(" / ") : "";

  const lines = [];
  lines.push(`結論: ${question} の期待値は ${formatYen(candidate.expectedYen)}`);
  lines.push("");
  lines.push("根拠:");
  lines.push(`・開始あべし: ${candidate.startAveshi}あべし`);
  lines.push(`・期待値: ${formatYen(candidate.expectedYen)}`);
  if (candidate.payoutRate !== null) {
    lines.push(`・出玉率: ${formatRate(candidate.payoutRate)}`);
  }
  if (candidate.playTimeMin !== null) {
    lines.push(`・消化時間: ${formatMinutes(candidate.playTimeMin)}`);
  }
  lines.push(`・参照テーブル: ${ctx || "context不明"}`);
  lines.push(`・出典: ${candidate.sourceFile || candidate.sourceTitle || "不明"}`);
  lines.push(`・行データ: ${rowJoined}`);

  return lines.join("\n");
}

function buildNotFoundAnswer(question, candidates) {
  const lines = [];
  lines.push("結論: 資料上で質問条件に完全一致する数値を断定できなかった");
  lines.push("");
  lines.push(`質問: ${question}`);

  if (candidates.length > 0) {
    lines.push("");
    lines.push("近い候補:");
    for (const c of candidates.slice(0, 5)) {
      const ctx = Array.isArray(c.context) ? c.context.join(" / ") : "";
      lines.push(
        `・${c.startAveshi}あべし → ${formatYen(c.expectedYen)} | ${ctx || "context不明"} | ${c.sourceFile || "出典不明"}`
      );
    }
  }

  lines.push("");
  lines.push("補足: 回答は machines/tensei/data.json の tables / tables_continued を直接参照している");
  return lines.join("\n");
}

function buildOverviewAnswer() {
  const lines = [];
  lines.push("結論: 現在の転生 data.json から拾える主要値");
  lines.push("");
  lines.push("・設定変更後32あべしシャッター狙い: 2203円");
  lines.push("・設定変更後64あべしシャッター狙い: 1712円");
  lines.push("・AT後32あべしシャッター狙い: 0円");
  lines.push("・AT後64あべしシャッター狙い: 676円");
  lines.push("・シャッター有り後64あべし: 3004円");
  lines.push("・シャッター無し後64あべし: 402円");
  lines.push("・通常時天井狙い600あべし: 533円");
  lines.push("・シャッター有無不問天井狙い600あべし: 621円");
  lines.push("");
  lines.push("補足: 機種名と条件を含めて質問すると精度が上がる");
  return lines.join("\n");
}

function answerTenseiQuestion(question) {
  const q = normalizeText(question);

  if (includesAny(q, ["こんばんは", "おはよう", "こんにちは"])) {
    return [
      "結論: 現在このbotは転生の章2の data.json を優先参照する設定",
      "",
      `質問: ${question}`,
      "",
      "補足: 機種名と条件を含めて質問して",
      "例: 転生のリセット後64あべしからシャッター狙いする場合の期待値はいくら？",
    ].join("\n");
  }

  if (includesAny(q, ["教えて", "要約", "まとめ", "概要"]) && extractAveshi(question) === null) {
    return buildOverviewAnswer();
  }

  const candidates = extractCandidateRows(question);

  if (candidates.length === 0) {
    return buildNotFoundAnswer(question, []);
  }

  const best = candidates[0];

  // 条件一致の最低ライン
  if (best.expectedYen === null) {
    return buildNotFoundAnswer(question, candidates);
  }

  // スコアが低すぎるものは弾く
  if (best.score < 40) {
    return buildNotFoundAnswer(question, candidates);
  }

  return buildExactAnswer(question, best);
}

function buildFallbackReply(question) {
  if (getMachineMatched(question)) {
    return answerTenseiQuestion(question);
  }

  return [
    "結論: 現在このbotは転生の章2の data.json を優先参照する設定",
    "",
    `質問: ${question}`,
    "",
    "補足: 機種名を含めて質問して",
    "例: 転生のリセット後64あべしからシャッター狙いする場合の期待値はいくら？",
  ].join("\n");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`ログイン完了: ${client.user.tag}`);
  console.log(`読込テーブル数: ${FLAT_TABLES.length}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!client.user) return;

    const isMentioned = message.mentions.users.has(client.user.id);
    if (!isMentioned) return;

    const question = stripBotMention(message.content, client.user.id);

    if (!question) {
      await message.reply(
        "質問内容を書いてください\n例: 転生のリセット後64あべしからシャッター狙いする場合の期待値はいくら？"
      );
      return;
    }

    const replyText = buildFallbackReply(question);
    await message.reply(replyText);
  } catch (error) {
    console.error("messageCreate error:", error);
    try {
      await message.reply("エラー: 回答生成中に問題が発生した");
    } catch (replyError) {
      console.error("reply error:", replyError);
    }
  }
});

client.login(DISCORD_TOKEN).catch((error) => {
  console.error("Discordログイン失敗:", error);
  process.exit(1);
});
