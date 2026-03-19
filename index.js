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
    .replace(/\s+/g, "")
    .replace(/　+/g, "")
    .trim()
    .toLowerCase();
}

function includesAny(text, keywords) {
  return keywords.some((k) => text.includes(normalizeText(k)));
}

function extractAveshi(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(/(\d+)(?=あべし)/);
  if (!match) return null;
  return Number(match[1]);
}

function getMachineMatched(text) {
  const normalized = normalizeText(text);
  const aliases = tenseiData?.machine_aliases || tenseiData?.normalized?.machine_aliases || [
    "転生",
    "北斗転生",
    "転生の章2",
    "スマスロ転生",
  ];
  return aliases.some((alias) => normalized.includes(normalizeText(alias)));
}

function getSettingChangeTable() {
  return (
    tenseiData?.normalized?.shutter_expectation_tables?.setting_change_after ||
    []
  );
}

function getAfterAtTable() {
  return tenseiData?.normalized?.shutter_expectation_tables?.after_at || [];
}

function getShutterYesTable() {
  return tenseiData?.normalized?.shutter_expectation_tables?.shutter_yes_after || [];
}

function getShutterNoTable() {
  return tenseiData?.normalized?.shutter_expectation_tables?.shutter_no_after || [];
}

function getTenjoNormalTable() {
  return tenseiData?.normalized?.tenjo_tables?.normal || [];
}

function getTenjoIgnoreTable() {
  return tenseiData?.normalized?.tenjo_tables?.shutter_ignore || [];
}

function findRowByAveshi(table, aveshi) {
  if (!Array.isArray(table)) return null;
  return table.find((row) => Number(row.start_aveshi) === Number(aveshi)) || null;
}

function formatYen(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "不明";
  const n = Number(value);
  return `${n}円`;
}

function formatRate(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "不明";
  return `${Number(value)}%`;
}

function formatMinutes(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "不明";
  return `${Number(value)}分`;
}

function buildExactAnswer(title, row, extra = {}) {
  const lines = [];
  lines.push(`結論: ${title} の期待値は ${formatYen(row.expected_yen)}`);

  lines.push("");
  lines.push("根拠:");
  lines.push(`・開始あべし: ${row.start_aveshi}あべし`);
  lines.push(`・期待値: ${formatYen(row.expected_yen)}`);
  if (row.payout_rate !== undefined) {
    lines.push(`・出玉率: ${formatRate(row.payout_rate)}`);
  }
  if (row.play_time_min !== undefined) {
    lines.push(`・消化時間: ${formatMinutes(row.play_time_min)}`);
  }
  if (row.hourly_yen !== undefined) {
    lines.push(`・時給: ${formatYen(row.hourly_yen)}`);
  }
  if (row.source) {
    lines.push(`・出典: ${row.source}`);
  }
  if (extra.note) {
    lines.push(`・補足: ${extra.note}`);
  }

  return lines.join("\n");
}

function buildNotFoundAnswer(question, hints = []) {
  const lines = [];
  lines.push("結論: 資料上で質問条件に完全一致する数値を断定できなかった");
  lines.push("");
  lines.push(`質問: ${question}`);
  if (hints.length > 0) {
    lines.push("");
    lines.push("近い候補:");
    for (const hint of hints) {
      lines.push(`・${hint}`);
    }
  }
  lines.push("");
  lines.push("補足: 回答は machines/tensei/data.json の範囲だけを参照しており、外部期待値表は使っていない");
  return lines.join("\n");
}

function answerTenseiQuestion(question) {
  const q = normalizeText(question);

  const aveshi = extractAveshi(question);

  // 1. リセット後 / 設定変更後 シャッター狙い
  const isReset = includesAny(q, ["リセット後", "設定変更後", "リセ後", "朝イチ"]);
  const isShutter = includesAny(q, ["シャッター狙い", "シャッター", "シャッター有無"]);
  const isAfterAt = includesAny(q, ["AT後", "at後"]);
  const isShutterYes = includesAny(q, ["シャッター有り", "シャッターあり"]);
  const isShutterNo = includesAny(q, ["シャッター無し", "シャッターなし"]);
  const isTenjo = includesAny(q, ["天井狙い", "天井"]);
  const isIgnore = includesAny(q, ["有無不問", "シャッター有無不問", "不問"]);

  // リセット後シャッター狙い
  if (isReset && isShutter && aveshi !== null) {
    const row = findRowByAveshi(getSettingChangeTable(), aveshi);
    if (row) {
      return buildExactAnswer(`リセット後${aveshi}あべしからのシャッター狙い`, row, {
        note: "設定変更後シャッター狙い表を参照",
      });
    }
    return buildNotFoundAnswer(question, getSettingChangeTable().map((r) => `設定変更後 ${r.start_aveshi}あべし → ${formatYen(r.expected_yen)}`));
  }

  // AT後シャッター狙い
  if (isAfterAt && isShutter && aveshi !== null) {
    const row = findRowByAveshi(getAfterAtTable(), aveshi);
    if (row) {
      return buildExactAnswer(`AT後${aveshi}あべしからのシャッター狙い`, row, {
        note: "AT後シャッター狙い表を参照",
      });
    }
    return buildNotFoundAnswer(question, getAfterAtTable().map((r) => `AT後 ${r.start_aveshi}あべし → ${formatYen(r.expected_yen)}`));
  }

  // シャッター有り
  if (isShutterYes && aveshi !== null) {
    const row = findRowByAveshi(getShutterYesTable(), aveshi);
    if (row) {
      return buildExactAnswer(`シャッター有り後${aveshi}あべしからの期待値`, row, {
        note: "シャッター有り後表を参照",
      });
    }
    return buildNotFoundAnswer(question, getShutterYesTable().map((r) => `シャッター有り ${r.start_aveshi}あべし → ${formatYen(r.expected_yen)}`));
  }

  // シャッター無し
  if (isShutterNo && aveshi !== null) {
    const row = findRowByAveshi(getShutterNoTable(), aveshi);
    if (row) {
      return buildExactAnswer(`シャッター無し後${aveshi}あべしからの期待値`, row, {
        note: "シャッター無し後表を参照",
      });
    }
    return buildNotFoundAnswer(question, getShutterNoTable().map((r) => `シャッター無し ${r.start_aveshi}あべし → ${formatYen(r.expected_yen)}`));
  }

  // 天井狙い（有無不問）
  if (isTenjo && isIgnore && aveshi !== null) {
    const row = findRowByAveshi(getTenjoIgnoreTable(), aveshi);
    if (row) {
      return buildExactAnswer(`シャッター有無不問で${aveshi}あべしからの天井狙い`, row, {
        note: "シャッター有無不問の天井狙い表を参照",
      });
    }
    return buildNotFoundAnswer(question, getTenjoIgnoreTable().map((r) => `有無不問 ${r.start_aveshi}あべし → ${formatYen(r.expected_yen)}`));
  }

  // 天井狙い（通常）
  if (isTenjo && aveshi !== null) {
    const row = findRowByAveshi(getTenjoNormalTable(), aveshi);
    if (row) {
      return buildExactAnswer(`${aveshi}あべしからの天井狙い`, row, {
        note: "通常時天井狙い表を参照",
      });
    }
    return buildNotFoundAnswer(question, getTenjoNormalTable().map((r) => `通常時 ${r.start_aveshi}あべし → ${formatYen(r.expected_yen)}`));
  }

  // リセット後 + あべし数だけ聞かれた場合はシャッター狙いを優先
  if (isReset && aveshi !== null) {
    const row = findRowByAveshi(getSettingChangeTable(), aveshi);
    if (row) {
      return buildExactAnswer(`リセット後${aveshi}あべしの主要期待値`, row, {
        note: "設定変更後シャッター狙い表を優先参照",
      });
    }
  }

  // AT後 + あべし数だけ
  if (isAfterAt && aveshi !== null) {
    const row = findRowByAveshi(getAfterAtTable(), aveshi);
    if (row) {
      return buildExactAnswer(`AT後${aveshi}あべしの主要期待値`, row, {
        note: "AT後シャッター狙い表を優先参照",
      });
    }
  }

  // 概要質問
  if (includesAny(q, ["教えて", "要約", "まとめ", "概要"])) {
    const lines = [];
    lines.push("結論: 転生の章2に関する data.json の主要ポイント");
    lines.push("");
    lines.push("・設定変更後シャッター狙い: 32あべし 2203円 / 64あべし 1712円");
    lines.push("・AT後シャッター狙い: 32あべし 0円 / 64あべし 676円");
    lines.push("・シャッター有り後: 32あべし 2713円 / 64あべし 3004円");
    lines.push("・シャッター無し後: 32あべし -88円 / 64あべし 402円");
    lines.push("・通常時天井狙い: 600あべし 533円 / 800あべし 1676円");
    lines.push("・シャッター有無不問の天井狙い: 600あべし 621円 / 800あべし 1811円");
    lines.push("");
    lines.push("補足: 必要なら『リセット後32あべしのシャッター狙い期待値は？』のように条件を具体的に聞いてください");
    return lines.join("\n");
  }

  return buildNotFoundAnswer(question, [
    "リセット後32あべしからのシャッター狙い",
    "リセット後64あべしからのシャッター狙い",
    "AT後64あべしからのシャッター狙い",
    "シャッター有り後64あべし",
    "シャッター無し後64あべし",
    "600あべしからの天井狙い",
  ]);
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
    "例: 転生のリセット後32あべしからのシャッター狙い期待値は？",
  ].join("\n");
}

function stripBotMention(content, clientUserId) {
  if (!content) return "";
  return content
    .replace(new RegExp(`<@!?${clientUserId}>`, "g"), "")
    .trim();
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
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!client.user) return;

    const isMentioned = message.mentions.users.has(client.user.id);
    if (!isMentioned) return;

    const question = stripBotMention(message.content, client.user.id);

    if (!question) {
      await message.reply("質問内容を書いてください\n例: 転生のリセット後32あべしからのシャッター狙い期待値は？");
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
