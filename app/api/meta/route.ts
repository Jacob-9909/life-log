import { NextResponse } from "next/server";
import { getContent } from "../../../lib/github";

export const runtime = "nodejs";

// data/meta.json = { lastGeneratedAt } — 업적 판정 등에 사용
export async function GET() {
  try {
    const meta = await getContent("data/meta.json");
    return NextResponse.json(meta?.content ?? {});
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
