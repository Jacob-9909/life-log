import { NextResponse } from "next/server";
import { getContent, putContent } from "../../../lib/github";
import { todayKST } from "../../../lib/week";

export const runtime = "nodejs";

function check(req) {
  return process.env.ACCESS_CODE && req.headers.get("x-access-code") === process.env.ACCESS_CODE;
}

// 보충 메모: data/notes/all.json 에 append (정리 생성 시 마지막 생성 이후 것만 소비)
export async function GET(req) {
  if (!check(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const file = await getContent("data/notes/all.json");
    return NextResponse.json(file?.content ?? { notes: [] });
  } catch (e) {
    return NextResponse.json({ error: String(e), notes: [] }, { status: 500 });
  }
}

export async function POST(req) {
  if (!check(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const text = (body.text || "").trim();
  if (!text) return NextResponse.json({ error: "empty" }, { status: 400 });
  try {
    const file = await getContent("data/notes/all.json");
    const data = file?.content ?? { notes: [] };
    const at = new Date().toISOString();
    data.notes.push({ at, text, repo: body.repo || null });
    await putContent("data/notes/all.json", data, `chore(notes): 메모 추가`);
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

export async function DELETE(req) {
  if (!check(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const at = new URL(req.url).searchParams.get("at");
  if (!at) return NextResponse.json({ error: "missing at" }, { status: 400 });
  try {
    const file = await getContent("data/notes/all.json");
    const data = file?.content ?? { notes: [] };
    data.notes = data.notes.filter((n) => n.at !== at);
    await putContent("data/notes/all.json", data, `chore(notes): 메모 삭제 (${at})`);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
