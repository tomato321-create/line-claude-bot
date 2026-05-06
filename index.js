import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const conversations = new Map();

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"]
});

const calendar = google.calendar({ version: "v3", auth });

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
  items.forEach(item => {
    console.log(`予定: ${item.summary} / 開始: ${item.start.dateTime || item.start.date}`);
  });
  return items;
}

// 連続する時間帯をまとめる（例：9:00〜10:00、10:00〜11:00 → 9:00〜11:00）
function mergeSlots(hours) {
  if (hours.length === 0) return [];

  const merged = [];
  let startHour = hours[0];
  let prevHour = hours[0];

  for (let i = 1; i < hours.length; i++) {
    if (hours[i] === prevHour + 1) {
      // 連続している
      prevHour = hours[i];
    } else {
      // 途切れた
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
    const blockStart = new Date(start.getTime() - 60 * 60 * 1000);
    const blockEnd = new Date(end.getTime() + 60 * 60 * 1000);
    return { blockStart, blockEnd };
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

      const isBlocked = blockedRanges.some(range =>
        slotStart < range.blockEnd && slotEnd > range.blockStart
      );

      if (!isBlocked) {
        freeHours.push(hour);
      }
    }

    if (freeHours.length > 0) {
      const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
      const month = checkDay.getMonth() + 1;
      const day = checkDay.getDate();
      const weekday = weekdays[checkDay.getDay()];
      const mergedSlots = mergeSlots(freeHours);
      candidates.push(`${month}月${day}日（${weekday}）：${mergedSlots.join("、")}`);
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
    const blockStart = new Date(start.getTime() - 60 * 60 * 1000);
    const blockEnd = new Date(end.getTime() + 60 * 60 * 1000);
    return { blockStart, blockEnd };
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

    const isBlocked = blockedRanges.some(range =>
      slotStart < range.blockEnd && slotEnd > range.blockStart
    );

    return {
      dateLabel: `${targetMonth}月${targetDay}日`,
      hour,
      available: !isBlocked
    };
  }

  return null;
}

const SYSTEM_PROMPT = `あなたはSBG（経営者団体）のLINE公式アカウントを運営するサポートエージェントです。

日程調整について：
- 空き候補が提供された場合、その候補をそのまま丁寧に伝えてください
- 候補がない日は提示しないでください
- 「前後1時間空けた」などの内部的な説明は絶対に書かないでください
- 候補は日付と時間をシンプルに伝えてください
- 候補を提示した後は必ず「スタッフより改めて最終確認のご連絡をいたします」と添えてください
- 指定日時が空いている場合は「空いております」、埋まっている場合は「難しい状況です」と伝えてください

その他：
- 資料・ドキュメントの送付依頼はスタッフにエスカレーションする旨を伝えてください
- 対応できない内容もスタッフにエスカレーションする旨を伝えてください
- 常に丁寧でプロフェッショナルな日本語で対応し、SBGの品格を保ちます`;

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const events = req.body.events;
  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      const userId = event.source.userId;
      const userMessage = event.message.text;
      const replyToken = event.replyToken;

      console.log(`会員メッセージ: ${userMessage}`);

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
              if (result.available) {
                calendarInfo = `\n\n【確認結果】${result.dateLabel} ${result.hour}:00〜${result.hour + 1}:00 は空いております。`;
              } else {
                calendarInfo = `\n\n【確認結果】${result.dateLabel} ${result.hour}:00〜${result.hour + 1}:00 はすでに予定が入っております。`;
              }
            }
            const slots = await computeAvailableSlots();
            if (slots.length > 0) {
              calendarInfo += `\n\n【空き日程候補】\n${slots.slice(0, 3).join("\n")}`;
            }
          } else {
            const slots = await computeAvailableSlots();
            if (slots.length > 0) {
              calendarInfo = `\n\n【空き日程候補】\n${slots.slice(0, 3).join("\n")}`;
            } else {
              calendarInfo = "\n\n【空き日程候補】\n今後60日間で調整可能な日程が見つかりませんでした。";
            }
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
  }
});

async function askClaude(userId, userMessage, calendarInfo = "") {
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }
  const history = conversations.get(userId);

  const messageWithCalendar = calendarInfo
    ? `${userMessage}${calendarInfo}`
    : userMessage;

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
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: history
      })
    });

    const data = await response.json();
    const reply = data.content[0].text;

    history.push({ role: "assistant", content: reply });
    if (history.length > 20) history.splice(0, 2);

    return reply;
  } catch (error) {
    console.error("APIエラー:", error);
    return "申し訳ございません。一時的なエラーが発生しました。スタッフよりご連絡いたします。";
  }
}

async function replyToLine(replyToken, text) {
  const trimmed = text.length > 4000
    ? text.substring(0, 4000) + "…"
    : text;

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SBGボット起動中 ポート: ${PORT}`);
});
