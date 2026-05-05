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

// 指定された日時が空いているか確認する関数
async function checkSpecificSlot(dateStr) {
  const now = new Date();
  const twoMonthsLater = new Date();
  twoMonthsLater.setDate(now.getDate() + 60);

  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.toISOString(),
    timeMax: twoMonthsLater.toISOString(),
    singleEvents: true,
    orderBy: "startTime"
  });

  const events = response.data.items || [];

  // 日付文字列から日付を推測（例：5月10日、5/10など）
  const currentYear = now.getFullYear();
  let targetDate = null;

  const matchMonthDay = dateStr.match(/(\d+)月(\d+)日/);
  const matchSlash = dateStr.match(/(\d+)\/(\d+)/);

  if (matchMonthDay) {
    targetDate = new Date(currentYear, parseInt(matchMonthDay[1]) - 1, parseInt(matchMonthDay[2]));
  } else if (matchSlash) {
    targetDate = new Date(currentYear, parseInt(matchSlash[1]) - 1, parseInt(matchSlash[2]));
  }

  if (!targetDate) return null;

  // その日の予定を抽出
  const dayEvents = events.filter(event => {
    const start = new Date(event.start.dateTime || event.start.date);
    return start.toDateString() === targetDate.toDateString();
  });

  // 時間指定があるか確認
  const timeMatch = dateStr.match(/(\d+)時/);
  if (timeMatch) {
    const targetHour = parseInt(timeMatch[1]);
    const slotStart = new Date(targetDate);
    slotStart.setHours(targetHour, 0, 0, 0);
    const slotEnd = new Date(slotStart);
    slotEnd.setHours(targetHour + 1, 0, 0, 0);

    // 前後1時間バッファで確認
    const bufferStart = new Date(slotStart);
    bufferStart.setHours(slotStart.getHours() - 1);
    const bufferEnd = new Date(slotEnd);
    bufferEnd.setHours(slotEnd.getHours() + 1);

    const conflict = dayEvents.some(event => {
      const start = new Date(event.start.dateTime || event.start.date);
      const end = new Date(event.end.dateTime || event.end.date);
      return start < bufferEnd && end > bufferStart;
    });

    return {
      date: targetDate,
      hour: targetHour,
      available: !conflict
    };
  }

  // 時間指定なしの場合はその日の空き時間を返す
  return {
    date: targetDate,
    hour: null,
    dayEvents: dayEvents.map(e => ({
      title: e.summary || "予定あり",
      start: new Date(e.start.dateTime || e.start.date).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
      end: new Date(e.end.dateTime || e.end.date).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
    }))
  };
}

// 空き日程候補を自動で探す関数
async function getAvailableSlots() {
  const now = new Date();
  const twoMonthsLater = new Date();
  twoMonthsLater.setDate(now.getDate() + 60);

  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.toISOString(),
    timeMax: twoMonthsLater.toISOString(),
    singleEvents: true,
    orderBy: "startTime"
  });

  const events = response.data.items || [];
  const candidates = [];
  const checkDate = new Date(now);
  checkDate.setHours(10, 0, 0, 0);

  while (candidates.length < 3 && checkDate < twoMonthsLater) {
    const dayOfWeek = checkDate.getDay();

    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const slots = [10, 14];

      for (const hour of slots) {
        const slotStart = new Date(checkDate);
        slotStart.setHours(hour, 0, 0, 0);
        const slotEnd = new Date(slotStart);
        slotEnd.setHours(hour + 1, 0, 0, 0);

        const bufferStart = new Date(slotStart);
        bufferStart.setHours(slotStart.getHours() - 1);
        const bufferEnd = new Date(slotEnd);
        bufferEnd.setHours(slotEnd.getHours() + 1);

        const conflict = events.some(event => {
          const start = new Date(event.start.dateTime || event.start.date);
          const end = new Date(event.end.dateTime || event.end.date);
          return start < bufferEnd && end > bufferStart;
        });

        if (!conflict && slotStart > now) {
          const dateStr = slotStart.toLocaleDateString("ja-JP", {
            month: "long", day: "numeric", weekday: "short"
          });
          candidates.push(`・${dateStr} ${hour}:00〜${hour + 1}:00`);
          if (candidates.length >= 3) break;
        }
      }
    }

    checkDate.setDate(checkDate.getDate() + 1);
  }

  return candidates;
}

const SYSTEM_PROMPT = `あなたはSBG（経営者団体）のLINE公式アカウントを運営するサポートエージェントです。会員からのメッセージに対応し、以下の業務を自動で行います：イベントや会議の日程候補の提示と仮調整、よくある質問への回答、会員向けお知らせの配信。

日程調整について：
- 会員から日程調整の依頼があった場合、提供された空き日程候補をそのまま丁寧に伝えてください
- 会員が特定の日時を指定してきた場合、カレンダー確認結果をそのまま伝えてください
- 空いている場合は「その日時は空いております」と伝え、別途空き候補も提示してください
- 埋まっている場合は「その日時はすでに予定が入っております」と伝え、代わりの空き候補を提示してください
- 候補を提示した後は必ず「スタッフより改めて最終確認のご連絡をいたします」とお伝えください

資料・ドキュメントの送付依頼はスタッフにエスカレーションする旨を伝えてください。対応できない内容もスタッフにエスカレーションする旨を伝えてください。常に丁寧でプロフェッショナルな日本語で対応し、SBGの品格を保ちます。`;

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const events = req.body.events;
  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      const userId = event.source.userId;
      const userMessage = event.message.text;
      const replyToken = event.replyToken;

      console.log(`会員メッセージ: ${userMessage}`);

      const isScheduleRequest = userMessage.includes("日程") ||
        userMessage.includes("スケジュール") ||
        userMessage.includes("予定") ||
        userMessage.includes("打ち合わせ") ||
        userMessage.includes("ミーティング") ||
        userMessage.includes("会議");

      const hasSpecificDate = /\d+月\d+日|\d+\/\d+/.test(userMessage);

      let calendarInfo = "";

      if (isScheduleRequest || hasSpecificDate) {
        try {
          if (hasSpecificDate) {
            // 指定日時をカレンダーで直接確認
            const result = await checkSpecificSlot(userMessage);

            if (result) {
              const dateLabel = result.date.toLocaleDateString("ja-JP", {
                month: "long", day: "numeric", weekday: "short"
              });

              if (result.hour !== null) {
                // 時間も指定されている場合
                if (result.available) {
                  calendarInfo = `\n\n【カレンダー確認結果】\n${dateLabel} ${result.hour}:00〜${result.hour + 1}:00 は空いております。`;
                } else {
                  calendarInfo = `\n\n【カレンダー確認結果】\n${dateLabel} ${result.hour}:00〜${result.hour + 1}:00 はすでに予定が入っております。`;
                }
              } else {
                // 日付のみ指定の場合
                if (result.dayEvents && result.dayEvents.length > 0) {
                  const eventList = result.dayEvents.map(e => `・${e.start}〜${e.end} ${e.title}`).join("\n");
                  calendarInfo = `\n\n【カレンダー確認結果】\n${dateLabel}の予定：\n${eventList}`;
                } else {
                  calendarInfo = `\n\n【カレンダー確認結果】\n${dateLabel}は現在予定が入っておりません。`;
                }
              }

              // 空き候補も併せて提示
              const slots = await getAvailableSlots();
              if (slots.length > 0) {
                calendarInfo += `\n\n【その他の空き日程候補】\n${slots.join("\n")}`;
              }
            }
          } else {
            // 日程調整の一般依頼は空き候補を提示
            const slots = await getAvailableSlots();
            if (slots.length > 0) {
              calendarInfo = `\n\n【空き日程候補】\n${slots.join("\n")}`;
            }
          }
        } catch (error) {
          console.error("カレンダーエラー:", error);
          calendarInfo = "\n\n【カレンダー確認中にエラーが発生しました。スタッフより確認のご連絡をいたします。】";
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
