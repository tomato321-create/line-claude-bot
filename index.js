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

// カレンダーの予定を日本時間で取得してテキスト化する
async function getCalendarText() {
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

  const events = response.data.items || [];

  if (events.length === 0) {
    return "今後60日間の予定はありません。";
  }

  // 日本時間でフォーマット
  const lines = events.map(event => {
    const start = new Date(event.start.dateTime || event.start.date);
    const end = new Date(event.end.dateTime || event.end.date);

    const startJST = start.toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
    const endJST = end.toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      minute: "2-digit"
    });

    return `・${startJST}〜${endJST} ${event.summary || "予定あり"}`;
  });

  return lines.join("\n");
}

const SYSTEM_PROMPT = `あなたはSBG（経営者団体）のLINE公式アカウントを運営するサポートエージェントです。会員からのメッセージに対応し、以下の業務を自動で行います：イベントや会議の日程候補の提示と仮調整、よくある質問への回答、会員向けお知らせの配信。

日程調整について：
- カレンダー情報が提供された場合、その情報をもとに空き日程を判断してください
- 既存の予定の前後1時間は必ず空けて候補を提示してください
- 候補は平日の9時〜18時の範囲で、午前1件・午後1件を目安に3件程度提示してください
- 会員が特定の日時を指定してきた場合、その日時が空いているか（前後1時間含めて）判断して回答してください
- 空いている場合は「その日時は空いております」と伝えてください
- 埋まっている場合は「その日時はすでに予定が入っております」と伝え、代わりの候補を提示してください
- 候補を提示した後は必ず「スタッフより改めて最終確認のご連絡をいたします」とお伝えください
- 今日の日付・曜日を考慮して、過去の日程は候補に含めないでください

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

      // 日程関連のメッセージかどうか判定
      const isScheduleRelated =
        userMessage.includes("日程") ||
        userMessage.includes("スケジュール") ||
        userMessage.includes("予定") ||
        userMessage.includes("打ち合わせ") ||
        userMessage.includes("ミーティング") ||
        userMessage.includes("会議") ||
        /(\d{1,2})月(\d{1,2})日/.test(userMessage) ||
        /(\d{1,2})\/(\d{1,2})/.test(userMessage);

      let calendarInfo = "";
      if (isScheduleRelated) {
        try {
          const calendarText = await getCalendarText();
          // 今日の日本時間を伝える
          const todayJST = new Date().toLocaleString("ja-JP", {
            timeZone: "Asia/Tokyo",
            year: "numeric",
            month: "long",
            day: "numeric",
            weekday: "short"
          });
          calendarInfo = `\n\n【今日の日付】${todayJST}\n\n【今後60日間のカレンダー予定】\n${calendarText}`;
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
