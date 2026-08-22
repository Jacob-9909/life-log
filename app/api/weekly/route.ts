import { NextResponse } from "next/server";
import { listDir, getRawContent } from "../../../lib/github";

export const runtime = "nodejs";

function check(req) {
  return process.env.ACCESS_CODE && req.headers.get("x-access-code") === process.env.ACCESS_CODE;
}

// 생성된 주간 정리: GET (목록) / GET ?file=2026-08-21_2026-08-22.md.json (내용)
export async function GET(req) {
  if (!check(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const file = new URL(req.url).searchParams.get("file");
  try {
    if (file) {
      // 경로 탈출 방지
      if (!/^[\w.-]+\.md\.json$/.test(file)) {
        return NextResponse.json({ error: "bad filename" }, { status: 400 });
      }
      const raw = await getRawContent(`data/weekly/${file}`);
      if (!raw) return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json({ file, markdown: JSON.parse(raw).markdown ?? "" });
    }
    const items = await listDir("data/weekly");
    const files = items
      .filter((i) => i.name.endsWith(".md.json"))
      .map((i) => i.name.replace(/\.md\.json$/, ""))
      .sort()
      .reverse();
    return NextResponse.json({ files });
  } catch (e) {
    return NextResponse.json({ error: String(e), files: [] }, { status: 500 });
  }
}
