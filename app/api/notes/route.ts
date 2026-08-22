import { NextResponse } from "next/server";
import { getContent, putContent } from "../../../lib/github";
import { weekKeyKST, todayKST } from "../../../lib/week";

export const runtime = "nodejs";

function check(req) {
  return process.env.ACCESS_CODE && req.headers.get("x-access-code") === process.env.ACCESS_CODE;
}

// 채팅형 업무 메모: data/notes/<week>.json 에 append
export async function GET(req) {
  if (!check(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const week = new URL(req.url).searchParams.get("week") || weekKeyKST().key;
  try {
    const file = await getContent(`data/notes/${week}.json`);
    return NextResponse.json(file?.content ?? { week, notes: [] });
  } catch (e) {
    return NextResponse.json({ error: String(e), notes: [] }, { status: 500 });
  }
}

export async function POST(req) {
  if (!check(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const text = (body.text || "").trim();
  if (!text) return NextResponse.json({ error: "empty" }, { status: 400 });
  const { key } = weekKeyKST();
  try {
    const file = await getContent(`data/notes/${key}.json`);
    const data = file?.content ?? { week: key, notes: [] };
    data.notes.push({
      at: new Date().toISOString(),
      text,
      repo: body.repo || null,
    });
    await putContent(`data/notes/${key}.json`, data, `chore(notes): ${key} 메모 추가`);
    // 오늘(KST) 업무 정리 완료로 달력에 체크
    const today = todayKST();
    const calFile = await getContent("data/calendar.json");
    const calendar = calFile?.content ?? {};
    if (!calendar[today]) {
      calendar[today] = true;
      await putContent("data/calendar.json", calendar, `chore(calendar): ${today} 체크`);
    }
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
