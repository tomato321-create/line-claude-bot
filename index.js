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

// カレンダーのイベントを取得する共通関数
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

  return response.data.items || [];
}

// 空き日程候補を自動で探す関数（日本時間で処理）
async function getAvailableSlots() {
  const events = await fetchEvents();

  // 各イベントの開始・終了を日本時間のDateオブジェクトとして持っておく
  const eventTimes = events.map(event => ({
    start: new Date(event.start.dateTime || event.start.date),
    end: new Date(event.end.dateTime || event.end.date)
  }));

  const candidates = [];

  // 今日から60日先まで1日ずつ確認
  const now = new Date();
  const nowJST = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));

  for (let dayOffset = 0; dayOffset <= 60 && candidates.length < 3; dayOffset++) {
    const checkDay = new Date(nowJST);
    checkDay.setDate(nowJST.getDate() + dayOffset);

    // 土日はスキップ
    const dayOfWeek = checkDay.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    // 10時と14時を候補として確認
    for (const hour of [10, 14]) {
      // 候補スロットの開始・終了（日本時間）
      const slotStart = new Date(checkDay);
      slotStart.setHours(hour, 0, 0, 0);

      const slotEnd = new Date(checkDay);
      slotEnd.setHours(hour + 1, 0, 0, 0);

      // 過去はスキップ
      if (slotStart <= nowJST) continue;

      // 前後1時間バッファ
      const bufferStart = new Date(slotStart);
      bufferStart.setHours(hour - 1, 0, 0, 0);

      const bufferEnd = new Date(slotEnd);
      bufferEnd.setHours(hour + 2, 0, 0, 0);

      // バッファ範囲内に予定が入っていないか確認
      const conflict = eventTimes.some(event =>
        event.start < bufferEnd && event.end > bufferStart
      );

      if (!conflict) {
        const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
        const month = checkDay.getMonth() + 1;
        const day = checkDay.getDate();
        const weekday = weekdays[checkDay.getDay()];
        candidates.push(`・${month}月${day}日（${weekday}） ${hour}:00〜${hour + 1}:00`);
        if (candidates.length >= 3) break;
      }
    }
  }

  return candidates;
}

// 指定された日時が空いているか確認する関数
async function checkSpecificSlot(userMessage) {
  const events = await fetchEvents();

  const eventTimes = events.map(event => ({
    start: new Date(event.start.dateTime || event.start.date),
    end: new Date(event.end.dateTime || event.end.date),
    title: event.summary || "予定あり"
  }));

  const now = new Date();
  const nowJST = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const currentYear = nowJST.getFullYear();

  let targetMonth = null;
  let targetDay = null;

  const matchMonthDay = userMessage.match(/(\d{1,2})月(\d{1,2})日/);
  const matchSlash = userMessage.match(/(\d{1,2})\/(\d{1,2})/);

  if (matchMonthDay) {
    targetMonth = parseInt(matchMonthDay[1]);
    targetDay = parseInt(matchMonthDay[2]);
  } else if (matchSlash) {
    targetMonth = parseInt(matchSlash[1]);
    targetDay = parseInt(matchSlash[2]);
  }

  if (!targetMonth || !targetDay) return null;
  if (targetMonth < 1 || targetMonth > 12 || targetDay < 1 || targetDay > 31) return null;

  // 対象日のDateオブジェクト（日本時間）
  let targetYear = currentYear;
  const targetDate = new Date(currentYear, targetMonth - 1, targetDay, 0, 0, 0, 0);
  if (targetDate < nowJST) targetYear = currentYear + 1;

  const targetDateFinal = new Date(targetYear, targetMonth - 1, targetDay, 0, 0, 0, 0);

  // その日の予定を抽出
  const dayEvents = eventTimes.filter(event => {
    const eventDateJST = new Date(event.start.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    return (
      eventDateJST.getFullYear() === targetYear &&
      eventDateJST.getMonth() === targetMonth - 1 &&
      eventDateJST.getDate() === targetDay
    );
  });

  // 時間指定があるか確認
  const timeMatch = userMessage.match(/(\d{1,2})時/) || userMessage.match(/(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const targetHour = parseInt(timeMatch[1]);
    if (targetHour < 8 || targetHour > 20) return null;

    const slotStart = new Date(targetDateFinal);
    slotStart.setHours(targetHour, 0, 0, 0);

    const bufferStart = new Date(targetDateFinal);
    bufferStart.setHours(targetHour - 1, 0, 0, 0);

    const bufferEnd = new Date(targetDateFinal);
    bufferEnd.setHours(targetHour + 2, 0, 0, 0);

    const conflict = eventTimes.some(event => {
      const startJST = new Date(event.start.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      const endJST = new Date(event.end.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      return startJST < bufferEnd && endJST > bufferStart;
    });

    return {
      dateLabel: `${targetMonth}月${targetDay}日`,
      hour: targetHour,
      available: !conflict
    };
  }

  // 時間指定なしの場合はその日の予定一覧を返す
  return {
    dateLabel: `${targetMonth}月${targetDay}日`,
    hour: null,
    dayEvents: dayEvents.map(e => {
      const startJST = new Date(e.start.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      const endJST = new Date(e.end.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      return {
        title: e.title,
        start: `${String(startJST.getHours()).padStart(2, "0")}:${String(startJST.getMinutes()).padStart(2, "0")}`,
        end: `${String(endJST.getHours()).padStart(2, "0")}:${String(endJST.getMinutes()).padStart(2, "0")}`
      };
    })
  };
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

      const isScheduleRequest =
        userMessage.includes("日程") ||
        userMessage.includes("スケジュール") ||
        userMessage.includes("予定") ||
        userMessage.includes("打ち合わせ") ||
        userMessage.includes("ミーティング") ||
        userMessage.includes("会議");

      const hasSpecificDate = /(\d{1,2})月(\d{1,2})日|(\d{1,2})\/(\d{1,2})/.test(userMessage);

      let calendarInfo = "";

      if (isScheduleRequest || hasSpecificDate) {
        try {
          if (hasSpecificDate) {
            const result = await checkSpecificSlot(userMessage);

            if (result) {
              if (result.hour !== null) {
                if (result.available) {
                  calendarInfo = `\n\n【カレンダー確認結果】\n${result.dateLabel} ${result.hour}:00〜${result.hour + 1}:00 は空いております。`;
                } else {
                  calendarInfo = `\n\n【カレンダー確認結果】\n${result.dateLabel} ${result.hour}:00〜${result.hour + 1}:00 はすでに予定が入っております。`;
                }
              } else {
                if (result.dayEvents && result.dayEvents.length > 0) {
                  const eventList = result.dayEvents.map(e => `・${e.start}〜${e.end} ${e.title}`).join("\n");
                  calendarInfo = `\n\n【カレンダー確認結果】\n${result.dateLabel}の予定：\n${eventList}`;
                } else {
                  calendarInfo = `\n\n【カレンダー確認結果】\n${result.dateLabel}は現在予定が入っておりません。`;
                }
              }

              const slots = await getAvailableSlots();
              if (slots.length > 0) {
                calendarInfo += `\n\n【その他の空き日程候補】\n${slots.join("\n")}`;
              }
            }
          } else {
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
