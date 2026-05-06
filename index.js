import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

const conversations = new Map();
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const BOT_NAME = process.env.BOT_NAME || "SBGAIエージェント";

// 会員情報ファイルのパス
const MEMBERS_FILE = "/tmp/members.json";

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"]
});
const calendar = google.calendar({ version: "v3", auth });

// ===== 会員情報の読み書き =====
function loadMembers() {
  try {
    if (fs.existsSync(MEMBERS_FILE)) {
      return JSON.parse(fs.readFileSync(MEMBERS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("会員情報読み込みエラー:", e);
  }
  return {};
}

function saveMembers(members) {
  try {
    fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 2));
  } catch (e) {
    console.error("会員情報保存エラー:", e);
  }
}

function getMemberInfo(userId) {
  const members = loadMembers();
  return members[userId] || null;
}

function updateMemberInfo(userId, newInfo) {
  const members = loadMembers();
  members[userId] = { ...(members[userId] || {}), ...newInfo, updatedAt: new Date().toISOString() };
  saveMembers(members);
}

// ===== カレンダー関連 =====
function nowJST() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
}

function toJSTDate(date) {
  return new Date(date.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
}

async function fetchEvents() {
  const now = new Date();
  const twoMonthsLater = new Date();
  twoMonthsLater.setDate(now.getDate() + 60);

  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.toISOString(),
    timeMax: twoMonthsLater.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    timeZone: "Asia/Tokyo"
  });

  const items = response.data.items || [];
  console.log(`カレンダー取得件数: ${items.length}件`);
  return items;
}

function mergeSlots(hours) {
  if (hours.length === 0) return [];
  const merged = [];
  let startHour = hours[0];
  let prevHour = hours[0];
  for (let i = 1; i < hours.length; i++) {
    if (hours[i] === prevHour + 1) {
      prevHour = hours[i];
    } else {
      merged.push(`${startHour}:00〜${prevHour + 1}:00`);
      startHour = hours[i];
      prevHour = hours[i];
    }
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
    return {
      blockStart: new Date(start.getTime() - 60 * 60 * 1000),
      blockEnd: new Date(end.getTime() + 60 * 60 * 1000)
    };
  });

  const candidates = [];
  for (let dayOffset = 0; dayOffset <= 60 && candidates.length < 5; dayOffset++) {
    const checkDay = new Date(jstNow);
    checkDay.setDate(jstNow.getDate() + dayOffset);
    checkDay.setHours(0, 0, 0, 0);
    if (checkDay.getDay() === 0 || checkDay.getDay() === 6) continue;

    const freeHours = [];
    for (let hour = 9; hour <= 16; hour++) {
      const slotStart = new Date(checkDay);
      slotStart.setHours(hour, 0, 0, 0);
      const slotEnd = new Date(checkDay);
      slotEnd.setHours(hour + 1, 0, 0, 0);
      if (slotStart <= jstNow) continue;

      const isBlocked = blockedRanges.some(r => slotStart < r.blockEnd && slotEnd > r.blockStart);
      if (!isBlocked) freeHours.push(hour);
    }

    if (freeHours.length > 0) {
      const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
      const month = checkDay.getMonth() + 1;
      const day = checkDay.getDate();
      const weekday = weekdays[checkDay.getDay()];
      candidates.push(`${month}月${day}日（${weekday}）：${mergeSlots(freeHours).join("、")}`);
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
    return {
      blockStart: new Date(start.getTime() - 60 * 60 * 1000),
      blockEnd: new Date(end.getTime() + 60 * 60 * 1000)
    };
  });

  const matchMonthDay = userMessage.match(/(\d{1,2})月(\d{1,2})日/);
  const matchSlash = userMessage.match(/(\d{1,2})\/(\d{1,2})/);
  let targetMonth = null, targetDay = null;

  if (matchMonthDay) {
    targetMonth = parseInt(matchMonthDay[1]);
    targetDay = parseInt(matchMonthDay[2]);
  } else if (matchSlash) {
    targetMonth = parseInt(matchSlash[1]);
    targetDay = parseInt(matchSlash[2]);
  }
  if (!targetMonth || !targetDay) return null;

  let targetYear = jstNow.getFullYear();
  const targetDate = new Date(targetYear, targetMonth - 1, targetDay);
  if (targetDate < jstNow) targetYear += 1;
  const finalDate = new Date(targetYear, targetMonth - 1, targetDay);

  const timeMatch = userMessage.match(/(\d{1,2})時/) || userMessage.match(/(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]);
    const slotStart = new Date(finalDate);
    slotStart.setHours(hour, 0, 0, 0);
    const slotEnd = new Date(finalDate);
    slotEnd.setHours(hour + 1, 0, 0, 0);
    const isBlocked = blockedRanges.some(r => slotStart < r.blockEnd && slotEnd > r.blockStart);
    return { dateLabel: `${targetMonth}月${targetDay}日`, hour, available: !isBlocked };
  }
  return null;
}

// ===== Claude API =====
async function askClaude(userId, userMessage, calendarInfo = "") {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);

  // 会員情報をシステムプロンプトに追加
  const memberInfo = getMemberInfo(userId);
  const memberContext = memberInfo
    ? `\n\n【この会員の情報】\n${JSON.stringify(memberInfo, null, 2)}`
    : "\n\n【この会員の情報】\nまだ情報がありません。会話から情報を収集してください。";

  const systemPrompt = `あなたはSBG（経営者団体）のLINE公式アカウントを運営するサポートエージェントです。

【最重要：場を読んだ対応】
- 会員が送ってきたメッセージの内容・文脈・トーンに合わせて自然に返答してください
- 「ようこそ」「ご登録ありがとうございます」などの新規加入を前提とした定型挨拶は絶対にしないでください
- 「はじめまして」と送ってきても、それはただの挨拶であり新規登録ではありません。自然に「はじめまして」と返すだけで構いません
- 会員はすでにSBGのメンバーです。加入を祝う言葉や説明は不要です
- 相手のメッセージに含まれる情報（名前・役職など）は自然に受け取り、堅苦しくなりすぎず会話してください

【会員情報の学習】
会話の中から以下の情報を自然に収集し、次回以降の会話に活かしてください：
- 名前・呼び方（例：田中さん、社長、〇〇ちゃんなど）
- 役職・会社名
- 趣味・関心領域
- よく希望する日程の傾向
- その他の個人的な情報

会員情報を新たに得たら、返答の最後に必ず以下の形式でJSONを出力してください（会話文とは別に）：
MEMBER_UPDATE:{"name":"田中太郎","nickname":"田中さん","company":"〇〇株式会社","role":"社長","interests":["ゴルフ","IT"],"notes":"木曜午後希望が多い"}

情報がない項目は含めなくて構いません。新情報がない場合はMEMBER_UPDATEを出力しないでください。${memberContext}

【日程調整】
- 空き候補が提供された場合、その候補をそのまま丁寧に伝えてください
- 「前後1時間空けた」などの内部的な説明は絶対に書かないでください
- 候補を提示した後は必ず「スタッフより改めて最終確認のご連絡をいたします」と添えてください
- 指定日時が空いている場合は「空いております」、埋まっている場合は「難しい状況です」と伝えてください

【その他】
- 会員の呼び方は覚えた情報に基づいて自然に使ってください
- 資料・ドキュメントの送付依頼はスタッフにエスカレーションする旨を伝えてください
- 対応できない内容もスタッフにエスカレーションする旨を伝えてください
- 常に丁寧でプロフェッショナルな日本語で対応し、SBGの品格を保ちます`;

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

    // MEMBER_UPDATEを抽出して保存
    const memberUpdateMatch = fullReply.match(/MEMBER_UPDATE:(\{.*?\})/s);
    if (memberUpdateMatch) {
      try {
        const newInfo = JSON.parse(memberUpdateMatch[1]);
        updateMemberInfo(userId, newInfo);
        console.log(`会員情報を更新: ${userId}`, newInfo);
      } catch (e) {
        console.error("会員情報パースエラー:", e);
      }
      // MEMBER_UPDATEの部分を返答から除去
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
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: trimmed }]
    })
  });
}

// ===== Webhookの処理 =====
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const events = req.body.events;
  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    const userId = event.source.userId;
    const replyToken = event.replyToken;
    const sourceType = event.source.type; // "user" or "group" or "room"
    let userMessage = event.message.text;

    // グループの場合はメンションされたときだけ反応
    if (sourceType === "group" || sourceType === "room") {
      if (!userMessage.includes(`@${BOT_NAME}`)) continue;
      // メンション部分を除去してメッセージを整理
      userMessage = userMessage.replace(`@${BOT_NAME}`, "").trim();
    }

    console.log(`[${sourceType}] 会員メッセージ: ${userMessage}`);

    // 日程関連か確認
    const isScheduleRelated =
      userMessage.includes("日程") ||
      userMessage.includes("スケジュール") ||
      userMessage.includes("予定") ||
      userMessage.includes("打ち合わせ") ||
      userMessage.includes("ミーティング") ||
      userMessage.includes("会議") ||
      /(\d{1,2})月(\d{1,2})日/.test(userMessage) ||
      /(\d{1,2})\/(\d{1,2})/.test(userMessage);

    const hasSpecificDate =
      /(\d{1,2})月(\d{1,2})日/.test(userMessage) ||
      /(\d{1,2})\/(\d{1,2})/.test(userMessage);

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

    const reply = await askClaude(userId, userMessage, calendarInfo);
    console.log(`返答: ${reply}`);
    await replyToLine(replyToken, reply);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SBGボット起動中 ポート: ${PORT}`);
});
