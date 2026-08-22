import { NextResponse } from "next/server";
import { getContent } from "../../../lib/github";

export const runtime = "nodejs";

// data/calendar.json = { "2026-08-22": true, ... } (그날 업무 정리를 한 날짜)
export async function GET() {
  try {
    const cal = await getContent("data/calendar.json");
    return NextResponse.json(cal?.content ?? {});
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
