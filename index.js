import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const conversations = new Map();

// Googleカレンダーの設定
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"]
});

const calendar = google.calendar({ version: "v3", auth });

// カレンダーの空き時間を取得する関数
async function getAvailableSlots() {
  const now = new Date();
  const oneWeekLater = new Date();
  oneWeekLater.setDate(now.getDate() + 14);

  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.toISOString(),
    timeMax: oneWeekLater.toISOString(),
    singleEvents: true,
    orderBy: "startTime"
  });

  const events = response.data.items || [];

  // 平日の9時〜18時の中から候補を探す
  const candidates = [];
  const checkDate = new Date(now);
  checkDate.setHours(9, 0, 0, 0);

  while (candidates.length < 5 && checkDate < oneWeekLater) {
    const dayOfWeek = checkDate.getDay();

    // 土日はスキップ
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const slots = [9, 11, 14, 16]; // 確認する時間帯

      for (const hour of slots) {
        const slotStart = new Date(checkDate);
        slotStart.setHours(hour, 0, 0, 0);
        const slotEnd = new Date(slotStart);
        slotEnd.setHours(hour + 1, 0, 0, 0);

        // 前後1時間を含めた範囲で予定が入っていないか確認
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
          const timeStr = `${hour}:00〜${hour + 1}:00`;
          candidates.push(`・${dateStr} ${timeStr}`);

          if (candidates.length >= 5) break;
        }
      }
    }

    checkDate.setDate(checkDate.getDate() + 1);
  }

  return candidates;
}

const SYSTEM_PROMPT = `あなたはSBG（経営者団体）のLINE公式アカウントを運営するサポートエージェントです。会員からのメッセージに対応し、以下の業務を自動で行います：イベントや会議の日程候補の提示と仮調整、よくある質問への回答、会員向けお知らせの配信。

日程調整の依頼があった場合は、提示された候補日程をそのまま伝えてください。候補日程を提示した後は必ず「スタッフより改めて最終確認のご連絡をいたします」とお伝えください。

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

      // 日程調整の依頼かどうか判定
      const isScheduleRequest = userMessage.includes("日程") ||
        userMessage.includes("スケジュール") ||
        userMessage.includes("予定") ||
        userMessage.includes("打ち合わせ") ||
        userMessage.includes("ミーティング") ||
        userMessage.includes("会議");

      let calendarInfo = "";
      if (isScheduleRequest) {
        try {
          const slots = await getAvailableSlots();
          if (slots.length > 0) {
            calendarInfo = `\n\n【現在の空き日程候補】\n${slots.join("\n")}`;
          }
        } catch (error) {
          console.error("カレンダーエラー:", error);
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
