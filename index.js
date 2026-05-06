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

const SYSTEM_PROMPT = `あなたはSBG（経営者団体）のLINE公式アカウントを運営するサポートエージェントです。

【日程調整のルール】
カレンダー情報が渡されたとき、以下のルールで空き時間を判断してください。

ルール1：ブロック範囲の計算
予定がある場合、その予定の「開始1時間前」から「終了1時間後」までを完全にブロックします。
例：11:00〜12:00に予定がある場合 → 10:00〜13:00はすべてNG。候補にできるのは13:00以降か10:00より前。
例：14:00〜15:00に予定がある場合 → 13:00〜16:00はすべてNG。

ルール2：候補の条件
・平日（月〜金）のみ
・9:00〜18:00の範囲内
・1時間単位のスロット（例：10:00〜11:00、13:00〜14:00など）
・過去の日時は絶対に含めない

ルール3：候補の提示数
・異なる日から3件程度を選ぶ
・なるべく近い日から提示する

ルール4：返答の書き方
・候補の時間だけをシンプルに書く
・「前後1時間空けました」などの説明は絶対に書かない
・丁寧でプロフェッショナルな日本語で書く
・候補を提示したら最後に「スタッフより改めて最終確認のご連絡をいたします」と添える

【日時指定への対応】
会員が「〇月〇日の〇時はどうですか？」と聞いてきた場合：
・その時間がブロック範囲（予定の前後1時間含む）に入っていなければ「空いております」と答える
・ブロック範囲に入っていれば「その日時は難しい状況です」と答えて別の候補を提示する

【その他の対応】
・資料・ドキュメントの送付依頼はスタッフにエスカレーションする旨を伝える
・対応できない内容もスタッフにエスカレーションする旨を伝える
・常に丁寧でプロフェッショナルな日本語で対応し、SBGの品格を保つ`;

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

      let calendarInfo = "";
      if (isScheduleRelated) {
        try {
          const calendarText = await getCalendarText();
          const todayJST = new Date().toLocaleString("ja-JP", {
            timeZone: "Asia/Tokyo",
            year: "numeric",
            month: "long",
            day: "numeric",
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit"
          });
          calendarInfo = `\n\n【現在の日時（日本時間）】${todayJST}\n\n【カレンダーに入っている予定一覧】\n${calendarText}\n\n上記の予定を参考に、各予定の開始1時間前〜終了1時間後をブロックして、空いている時間帯から候補を提示してください。`;
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
