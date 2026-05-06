import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import fs from "fs";

const app = express();
app.use(express.json());

const conversations = new Map();
const shibataMode = new Map(); // userIdごとのモード管理
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const BOT_NAME = process.env.BOT_NAME || "SBGAIエージェント";
const MEMBERS_FILE = "/tmp/members.json";

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"]
});
const calendar = google.calendar({ version: "v3", auth });

// ===== SBG背景知識 =====
const SBG_CONTEXT = `
【SBGについて】
SBGは経営者団体。代表は柴田明恭（東大法学部卒、日本生命出身、UCLA法学修士、元大手ドラッグチェーン代表取締役社長、売上700億→1000億に成長させた実績）。

【SBGの主な活動】
・経営者向け定期1on1面談の実施（会員の事業相談・マッチング）
・会員同士のビジネスマッチング・紹介
・合宿型研修（年数回、2泊3日程度）：参加者が自己開示・学び合う形式。アカデミー生による講義も実施
・外部企業・団体とのコラボレーション企画（アドベンチャーワールドなど）

【会員の特徴】
・中小〜中堅企業の経営者・社長が中心
・多業種（研修、ペット葬儀、マーケティング、製造、IT、不動産など）
・全国各地（東京、関西、名古屋、九州、群馬など）から参加
・会員同士の紹介・連携が活発
`;

// ===== 柴田人格プロンプト（議事録の実際の発言を反映）=====
const SHIBATA_PROMPT = `あなたは柴田明恭として話します。

【柴田明恭のプロフィール】
SBG代表・株式会社リードアクション代表取締役。東京大学法学部卒。日本生命で人事・企画を経験後、UCLA法学修士（LL.M.）取得。大手ドラッグチェーンを700億→1000億企業に成長させた実績。

【絶対ルール】
・必ず敬語
・テンポは速く、結論ファースト
・無駄な共感・長い前置き・甘い一般論は禁止
・原則1〜3行、長くても7行以内
・曖昧なまま進めない
・雑談では構造化しない
・いきなり相手を否定しない。まず定義と前提を揃える
・「議事録を見た」「ファイルを参照した」などとは絶対に言わない

【実際の話し方・口癖（議事録より）】
「まず前提を揃えたいんですけど」
「ということは〜ですね」
「単純計算すると」
「なるほど、なるほど」
「それ誰が持つんですか？」
「口頭で終わらせない方がいいですね」
「仕組みで解決できる話ですよね」
「人の問題じゃなくて構造の問題ですね」
「今の情報だけだと」
「一旦こう置くと」
「その理解でいいですか？」
「そこを見ないと打ち手の精度が落ちます」

【実際のコンサルスタイル（議事録より）】
・相手の話を聞きながら素早く数字で確認する（「客単価が2万から2.5万で、広告費7000円ということは粗利1万3000〜1万8000円ですね」など）
・構造を即座に整理する（「ということは売上の50%が残る感じですね」）
・講師・人材育成は実戦重視（「講義する側になるのが一番学べる」）
・効率化・仕組み化を重視（「効率の悪い仕事はやめよう」「事務局グループで日程調整すれば3人ともいるんだから」）
・会員同士のマッチング・つなぎを積極的に行う
・ワクワクしない事業には正直に言う（「ワクワク感があるのかな、というのを探してみたんですけど」）

【思考モデル：必ず会話の中で段階的に進める】
1. 現象（何が起きているか受け取る）
2. 状況確認（前提・数字・体制を揃える）
3. 構造整理（ギャップ・機能分解・再定義・抽象度上げ）
4. ラフ仮説（「今の情報だけだと〜の可能性が高いです」）
5. 課題定義
6. 施策提示（最も勝率が高い1手を具体的に）

【初回は必ず質問から入る】
「まず前提を揃えたいんですけど、
・誰に何を提供していて
・どういう形で売っていて
・収益はどうなっていて
・体制はどうなっていて
・今どこが一番詰まってるのか
このあたり教えてもらっていいですか。」

【禁止事項】
・長い講釈・ふわっとした一般論・過剰な共感
・SBG運営論に話をすり替えること
・情報不足のまま結論だけ言い切ること
・1回答で現象〜施策まで全部進めること

${SBG_CONTEXT}`;

// ===== 通常エージェントプロンプト =====
const AGENT_PROMPT = `あなたはSBG（経営者団体）のLINE公式アカウントを運営するサポートエージェントです。

【最重要：場を読んだ対応】
・会員が送ってきたメッセージの内容・文脈・トーンに合わせて自然に返答してください
・「ようこそ」「ご登録ありがとうございます」などの新規加入を前提とした定型挨拶は絶対にしないでください
・「はじめまして」は単なる挨拶です。自然に返すだけで構いません
・会員はすでにSBGのメンバーです

【会員情報の学習】
会話の中から以下を自然に収集し次回に活かしてください：名前・呼び方・役職・会社名・趣味・関心領域・日程の傾向

会員情報を新たに得たら返答の最後に出力してください：
MEMBER_UPDATE:{"name":"田中太郎","nickname":"田中さん","company":"〇〇株式会社","role":"社長","interests":["ゴルフ"],"notes":""}

新情報がない場合はMEMBER_UPDATEを出力しないでください。

【日程調整】
・空き候補が提供された場合、そのまま丁寧に伝えてください
・「前後1時間空けた」などの内部的な説明は絶対に書かないでください
・候補提示後は必ず「スタッフより改めて最終確認のご連絡をいたします」と添えてください

【その他】
・資料送付依頼・対応できない内容はスタッフにエスカレーションする旨を伝えてください
・常に丁寧でプロフェッショナルな日本語で対応し、SBGの品格を保ちます

${SBG_CONTEXT}`;

// ===== 会員情報の読み書き =====
function loadMembers() {
  try {
    if (fs.existsSync(MEMBERS_FILE)) return JSON.parse(fs.readFileSync(MEMBERS_FILE, "utf8"));
  } catch (e) { console.error("会員情報読み込みエラー:", e); }
  return {};
}

function saveMembers(members) {
  try { fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 2)); }
  catch (e) { console.error("会員情報保存エラー:", e); }
}

function getMemberInfo(userId) { return loadMembers()[userId] || null; }

function updateMemberInfo(userId, newInfo) {
  const members = loadMembers();
  members[userId] = { ...(members[userId] || {}), ...newInfo, updatedAt: new Date().toISOString() };
  saveMembers(members);
}

// ===== カレンダー関連 =====
function nowJST() { return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })); }
function toJSTDate(date) { return new Date(date.toLocaleString("en-US", { timeZone: "Asia/Tokyo" })); }

async function fetchEvents() {
  const now = new Date();
  const twoMonthsLater = new Date();
  twoMonthsLater.setDate(now.getDate() + 60);
  const response = await calendar.events.list({
    calendarId: CALENDAR_ID, timeMin: now.toISOString(), timeMax: twoMonthsLater.toISOString(),
    singleEvents: true, orderBy: "startTime", timeZone: "Asia/Tokyo"
  });
  const items = response.data.items || [];
  console.log(`カレンダー取得件数: ${items.length}件`);
  return items;
}

function mergeSlots(hours) {
  if (hours.length === 0) return [];
  const merged = [];
  let startHour = hours[0], prevHour = hours[0];
  for (let i = 1; i < hours.length; i++) {
    if (hours[i] === prevHour + 1) { prevHour = hours[i]; }
    else { merged.push(`${startHour}:00〜${prevHour + 1}:00`); startHour = hours[i]; prevHour = hours[i]; }
  }
  merged.push(`${startHour}:00〜${prevHour + 1}:00`);
  return merged;
}

async function computeAvailableSlots() {
  const events = await fetchEvents();
  const jstNow = nowJST();
  const blockedRanges = events.map(event => {
    const start = toJSTDate(new Date(event.start.dateTime || event.start.date));
    const end = toJSTDate(new Date(event.end.dateTime || event.end.date));
    return { blockStart: new Date(start.getTime() - 60 * 60 * 1000), blockEnd: new Date(end.getTime() + 60 * 60 * 1000) };
  });
  const candidates = [];
  for (let dayOffset = 0; dayOffset <= 60 && candidates.length < 5; dayOffset++) {
    const checkDay = new Date(jstNow);
    checkDay.setDate(jstNow.getDate() + dayOffset);
    checkDay.setHours(0, 0, 0, 0);
    if (checkDay.getDay() === 0 || checkDay.getDay() === 6) continue;
    const freeHours = [];
    for (let hour = 9; hour <= 16; hour++) {
      const slotStart = new Date(checkDay); slotStart.setHours(hour, 0, 0, 0);
      const slotEnd = new Date(checkDay); slotEnd.setHours(hour + 1, 0, 0, 0);
      if (slotStart <= jstNow) continue;
      const isBlocked = blockedRanges.some(r => slotStart < r.blockEnd && slotEnd > r.blockStart);
      if (!isBlocked) freeHours.push(hour);
    }
    if (freeHours.length > 0) {
      const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
      candidates.push(`${checkDay.getMonth() + 1}月${checkDay.getDate()}日（${weekdays[checkDay.getDay()]}）：${mergeSlots(freeHours).join("、")}`);
    }
  }
  return candidates;
}

async function checkSpecificDateTime(userMessage) {
  const events = await fetchEvents();
  const jstNow = nowJST();
  const blockedRanges = events.map(event => {
    const start = toJSTDate(new Date(event.start.dateTime || event.start.date));
    const end = toJSTDate(new Date(event.end.dateTime || event.end.date));
    return { blockStart: new Date(start.getTime() - 60 * 60 * 1000), blockEnd: new Date(end.getTime() + 60 * 60 * 1000) };
  });
  const matchMonthDay = userMessage.match(/(\d{1,2})月(\d{1,2})日/);
  const matchSlash = userMessage.match(/(\d{1,2})\/(\d{1,2})/);
  let targetMonth = null, targetDay = null;
  if (matchMonthDay) { targetMonth = parseInt(matchMonthDay[1]); targetDay = parseInt(matchMonthDay[2]); }
  else if (matchSlash) { targetMonth = parseInt(matchSlash[1]); targetDay = parseInt(matchSlash[2]); }
  if (!targetMonth || !targetDay) return null;
  let targetYear = jstNow.getFullYear();
  if (new Date(targetYear, targetMonth - 1, targetDay) < jstNow) targetYear += 1;
  const finalDate = new Date(targetYear, targetMonth - 1, targetDay);
  const timeMatch = userMessage.match(/(\d{1,2})時/) || userMessage.match(/(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]);
    const slotStart = new Date(finalDate); slotStart.setHours(hour, 0, 0, 0);
    const slotEnd = new Date(finalDate); slotEnd.setHours(hour + 1, 0, 0, 0);
    const isBlocked = blockedRanges.some(r => slotStart < r.blockEnd && slotEnd > r.blockStart);
    return { dateLabel: `${targetMonth}月${targetDay}日`, hour, available: !isBlocked };
  }
  return null;
}

// ===== Claude API =====
async function askClaude(userId, userMessage, calendarInfo = "", useShibata = false) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);

  const memberInfo = getMemberInfo(userId);
  const memberContext = memberInfo
    ? `\n\n【この会員の情報】\n${JSON.stringify(memberInfo, null, 2)}`
    : "\n\n【この会員の情報】\nまだ情報がありません。会話から収集してください。";

  const systemPrompt = (useShibata ? SHIBATA_PROMPT : AGENT_PROMPT) + memberContext;
  const messageWithCalendar = calendarInfo ? `${userMessage}${calendarInfo}` : userMessage;
  history.push({ role: "user", content: messageWithCalendar });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        system: systemPrompt,
        messages: history
      })
    });

    const data = await response.json();
    let fullReply = data.content[0].text;

    // 会員情報を抽出して保存
    const memberUpdateMatch = fullReply.match(/MEMBER_UPDATE:(\{.*?\})/s);
    if (memberUpdateMatch) {
      try {
        updateMemberInfo(userId, JSON.parse(memberUpdateMatch[1]));
        console.log(`会員情報を更新: ${userId}`);
      } catch (e) { console.error("会員情報パースエラー:", e); }
      fullReply = fullReply.replace(/\nMEMBER_UPDATE:(\{.*?\})/s, "").trim();
    }

    history.push({ role: "assistant", content: fullReply });
    if (history.length > 20) history.splice(0, 2);
    return fullReply;
  } catch (error) {
    console.error("APIエラー:", error);
    return "申し訳ございません。一時的なエラーが発生しました。スタッフよりご連絡いたします。";
  }
}

// ===== LINEへの返信 =====
async function replyToLine(replyToken, text) {
  const trimmed = text.length > 4000 ? text.substring(0, 4000) + "…" : text;
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: trimmed }] })
  });
}

// ===== Webhookの処理 =====
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  for (const event of req.body.events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    const userId = event.source.userId;
    const replyToken = event.replyToken;
    const sourceType = event.source.type;
    let userMessage = event.message.text;

    // グループはメンションされたときだけ反応
    if (sourceType === "group" || sourceType === "room") {
      if (!userMessage.includes(`@${BOT_NAME}`)) continue;
      userMessage = userMessage.replace(`@${BOT_NAME}`, "").trim();
    }

    console.log(`[${sourceType}] メッセージ: ${userMessage}`);

    // ===== モード切り替え =====
    // 柴田モードに切り替え
    if (userMessage.includes("経営相談") || userMessage.includes("事業相談") ||
        userMessage.includes("雑談") || userMessage.includes("柴田モード")) {
      shibataMode.set(userId, true);
      const reply = await askClaude(userId, userMessage, "", true);
      await replyToLine(replyToken, `【柴田人格で話します】\n\n${reply}`);
      continue;
    }

    // エージェントモードに戻す
    if (userMessage.includes("エージェントモード") || userMessage.includes("通常モード") ||
        userMessage.includes("サポートモード")) {
      shibataMode.set(userId, false);
      conversations.delete(userId); // 会話履歴をリセット
      await replyToLine(replyToken, "【サポートエージェントモードに戻りました】\n\nお気軽にご用件をお申し付けください。");
      continue;
    }

    // 現在のモードを確認
    const useShibata = shibataMode.get(userId) || false;

    // 日程関連の判定（エージェントモードのみ）
    const isScheduleRelated = !useShibata && (
      userMessage.includes("日程") || userMessage.includes("スケジュール") ||
      userMessage.includes("予定") || userMessage.includes("打ち合わせ") ||
      userMessage.includes("ミーティング") || userMessage.includes("会議") ||
      /(\d{1,2})月(\d{1,2})日/.test(userMessage) || /(\d{1,2})\/(\d{1,2})/.test(userMessage)
    );

    const hasSpecificDate =
      /(\d{1,2})月(\d{1,2})日/.test(userMessage) || /(\d{1,2})\/(\d{1,2})/.test(userMessage);

    let calendarInfo = "";
    if (isScheduleRelated) {
      try {
        if (hasSpecificDate) {
          const result = await checkSpecificDateTime(userMessage);
          if (result) {
            calendarInfo = result.available
              ? `\n\n【確認結果】${result.dateLabel} ${result.hour}:00〜${result.hour + 1}:00 は空いております。`
              : `\n\n【確認結果】${result.dateLabel} ${result.hour}:00〜${result.hour + 1}:00 はすでに予定が入っております。`;
          }
          const slots = await computeAvailableSlots();
          if (slots.length > 0) calendarInfo += `\n\n【空き日程候補】\n${slots.slice(0, 3).join("\n")}`;
        } else {
          const slots = await computeAvailableSlots();
          calendarInfo = slots.length > 0
            ? `\n\n【空き日程候補】\n${slots.slice(0, 3).join("\n")}`
            : "\n\n【空き日程候補】\n今後60日間で調整可能な日程が見つかりませんでした。";
        }
      } catch (error) {
        console.error("カレンダーエラー:", error);
        calendarInfo = "\n\n【カレンダーの取得に失敗しました。スタッフより確認のご連絡をいたします。】";
      }
    }

    const reply = await askClaude(userId, userMessage, calendarInfo, useShibata);
    console.log(`返答: ${reply}`);
    await replyToLine(replyToken, reply);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`SBGボット起動中 ポート: ${PORT}`); });
