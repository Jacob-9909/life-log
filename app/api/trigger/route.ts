import { NextResponse } from "next/server";
import { getContent, putContent } from "../../../lib/github";
import { weekKeyKST } from "../../../lib/week";

export const runtime = "nodejs";

// 데몬에 명령 전달: fetch(주간 스캔) 또는 generate-weekly(주간 정리 md 생성)
export async function POST(req) {
  const code = req.headers.get("x-access-code");
  if (!process.env.ACCESS_CODE || code !== process.env.ACCESS_CODE) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const action = body.action === "generate-weekly" ? "generate-weekly" : "fetch";
  const command = {
    action,
    week: body.week || weekKeyKST().key,
    requestedAt: new Date().toISOString(),
  };
  try {
    await putContent("data/command.json", command, `chore(command): ${action} ${command.week}`);
    return NextResponse.json({ ok: true, command });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET() {
  try {
    const cmd = await getContent("data/command.json");
    return NextResponse.json(cmd?.content ?? null);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
