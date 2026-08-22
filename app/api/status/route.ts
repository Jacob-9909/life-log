import { NextResponse } from "next/server";
import { getContent } from "../../../lib/github";

export const runtime = "nodejs";

// 데몬이 repo마다 갱신해 두는 status.json을 그대로 프록시
export async function GET() {
  try {
    const status = await getContent("data/status.json");
    return NextResponse.json(status?.content ?? { repos: [] });
  } catch (e) {
    return NextResponse.json({ error: String(e), repos: [] }, { status: 500 });
  }
}
