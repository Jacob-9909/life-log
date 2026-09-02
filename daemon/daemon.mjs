#!/usr/bin/env node
// life-log 로컬 데몬
// - GitHub private repo의 data/command.json 을 폴링해 명령 감지
// - action=fetch: ~/Develop 아래 모든 git repo에 git fetch --all 후 이번 주(월요일 시작, KST) 커밋 수집
//   → repo 한 개 처리할 때마다 data/status.json 을 갱신 push (웹에서 체크가 순차적으로 초록색으로 변함)
// - action=generate-weekly: 커밋 + 채팅 메모를 합쳐 ~/job/docs/10_주간정리/YYYY-WW.md 생성

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const REPO = process.env.GITHUB_REPO; // 예: Jacob-9909/life-log
const BRANCH = process.env.GITHUB_BRANCH || "main";
const DEVELOP_DIR = process.env.DEVELOP_DIR || path.join(HOME, "Develop");
const JOB_DIR = process.env.JOB_DIR || path.join(HOME, "job");
const POLL_MS = Number(process.env.POLL_MS || 15000);
// NVIDIA NIM (OpenAI 호환 API)
const NIM_BASE = process.env.NIM_BASE_URL || "https://integrate.api.nvidia.com/v1";
const NIM_MODEL = process.env.NIM_MODEL || "nvidia/nemotron-3-ultra-550b-a55b";
const AUTHORS = /whjeong@didim365\.com|cj0336j@gmail\.com|Woohyuck Jeong|Jacob/;
const API = "https://api.github.com";
const TOKEN = process.env.GITHUB_TOKEN;

function gh(method, urlPath, body) {
  const res = execFileSync("curl", [
    "-sS", "-X", method,
    "-H", `Authorization: Bearer ${TOKEN}`,
    "-H", "Accept: application/vnd.github+json",
    ...(body ? ["-H", "Content-Type: application/json", "-d", JSON.stringify(body)] : []),
    `${API}/repos/${REPO}/${urlPath}`,
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return res ? JSON.parse(res) : null;
}

function getContent(file) {
  try {
    const json = gh("GET", `contents/${file}?ref=${BRANCH}`);
    if (!json || !json.content) return null;
    return { sha: json.sha, content: JSON.parse(Buffer.from(json.content, "base64").toString("utf8")) };
  } catch {
    return null;
  }
}

let pushing = false;
async function putContent(file, content, message) {
  // push 충돌 시 최대 5회 재시도 (sha 재조회)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const existing = getContent(file);
      await new Promise((r) => setTimeout(r, 300));
      gh("PUT", `contents/${file}`, {
        message,
        branch: BRANCH,
        content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
        ...(existing ? { sha: existing.sha } : {}),
      });
      return;
    } catch (e) {
      console.error(`push ${file} 실패 (${attempt + 1}/5):`, e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ---- 주차 계산 (KST, 월요일 시작) ----
function weekInfo(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = kst.getUTCDay();
  const monday = new Date(kst);
  monday.setUTCDate(kst.getUTCDate() - ((day + 6) % 7));
  const y = monday.getUTCFullYear();
  const onejan = new Date(Date.UTC(y, 0, 1));
  const week = Math.ceil(((monday - onejan) / 86400000 + onejan.getUTCDay() + 1) / 7);
  return {
    key: `${y}-W${String(week).padStart(2, "0")}`,
    mondayISO: `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, "0")}-${String(monday.getUTCDate()).padStart(2, "0")}`,
  };
}

// ---- 수집 기간 계산: 마지막 기록일 다음날 ~ 오늘 (KST). 기록이 없으면 이번 주 월요일 ----
function computeWindow() {
  const iso = (d) => d.toISOString().slice(0, 10);
  const today = new Date(Date.now() + 9 * 3600 * 1000);
  const todayISO = iso(today);
  let start;
  try {
    const cal = getContent("data/calendar.json")?.content ?? {};
    const lastRecorded = Object.keys(cal)
      .filter((k) => cal[k] && k < todayISO)
      .sort()
      .pop();
    if (lastRecorded) {
      const d = new Date(`${lastRecorded}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      start = iso(d);
    } else {
      start = weekInfo().mondayISO;
    }
  } catch {
    start = weekInfo().mondayISO;
  }
  if (start > todayISO) start = todayISO;
  return { start, todayISO };
}

// ---- repo 탐색 ----
function findRepos() {
  const repos = [];
  for (const name of fs.readdirSync(DEVELOP_DIR)) {
    const dir = path.join(DEVELOP_DIR, name);
    if (fs.existsSync(path.join(dir, ".git"))) repos.push({ name, dir });
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

function collectCommits(dir, mondayISO) {
  let out = "";
  try {
    out = execFileSync("git", [
      "-C", dir, "log", "--all",
      "--since", `${mondayISO}T00:00:00+09:00`,
      "--pretty=format:%h|%ad|%s", "--date=format:%m-%d %H:%M",
      "--author=whjeong@didim365.com", "--author=cj0336j@gmail.com",
      "--author=Woohyuck Jeong", "--author=Jacob",
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return [];
  }
  return out.split("\n").filter(Boolean).map((l) => l.trim());
}

// ---- 메인 액션 ----
async function runFetch(command) {
  const { start, todayISO } = computeWindow();
  const periodLabel = `${start.slice(5)} ~ ${todayISO.slice(5)}`;
  console.log(`[fetch] 수집 기간: ${start} ~ ${todayISO}`);
  const repos = findRepos();
  const status = {
    week: periodLabel,
    period: { start, end: todayISO },
    requestedAt: command.requestedAt,
    startedAt: new Date().toISOString(),
    running: true,
    finishedAt: null,
    repos: repos.map((r) => ({ name: r.name, state: "pending", commits: [] })),
  };
  await putContent("data/status.json", status, `chore(status): ${periodLabel} 스캔 시작`);

  for (const r of status.repos) {
    r.state = "running";
    await putContent("data/status.json", status, `chore(status): ${periodLabel} ${r.name} 스캔 중`);
    const found = repos.find((x) => x.name === r.name);
    try {
      execFileSync("git", ["-C", found.dir, "fetch", "--all", "--quiet"], { timeout: 120000 });
      r.commits = collectCommits(found.dir, start);
      r.state = "done";
    } catch (e) {
      r.state = "done";
      // 에러 메시지에 토큰·URL이 포함될 수 있어 마스킹 후 저장
      r.error = String(e.message)
        .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "***")
        .replace(/https:\/\/[^@/\s]+@/g, "https://***@")
        .slice(0, 200);
    }
    await putContent("data/status.json", status, `chore(status): ${periodLabel} ${r.name} 완료 (+${r.commits.length})`);
  }

  status.running = false;
  status.finishedAt = new Date().toISOString();
  await putContent("data/status.json", status, `chore(status): ${periodLabel} 스캔 완료`);
  notify("⚔️ 던전 클리어!", `${periodLabel} 스캔 완료 — 커밋 ${status.repos.reduce((s, r) => s + r.commits.length, 0)}건 수집`);
  console.log(`[fetch] ${periodLabel} 완료`);
}

// ---- NVIDIA NIM 요약 ----
async function nimSummarize(week, notes, repos) {
  if (!process.env.NVIDIA_API_KEY) return null;
  const material = [
    "## 이번 기간 업무 메모 (사용자 직접 입력)",
    ...notes.map((n) => `- [${n.at.slice(5, 10)}] ${n.text}`),
    "",
    "## Git 커밋 로그 (repo별, 형식: MM-DD HH:MM 메시지)",
  ];
  for (const r of repos.filter((x) => x.commits.length)) {
    material.push(`### ${r.name} (${r.commits.length}건)`);
    material.push(...r.commits.map((c) => c.replace(/^[^|]*\|/, "")));
    material.push("");
  }

  const res = await fetch(`${NIM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: NIM_MODEL,
      temperature: 1,
      top_p: 0.95,
      max_tokens: 16384,
      chat_template_kwargs: { enable_thinking: true },
      messages: [
        {
          role: "system",
          content:
            "너는 개발자의 업무일지 및 주간 업무 정리 작성을 돕는 전문 AI 어시스턴트다.\n" +
            "제공된 두 가지 재료의 성격을 정확히 파악하여 전문적이고 구조화된 문서를 작성한다.\n" +
            "- Git 커밋 로그: 실제로 수행한 활동의 객관적 근거 (사실/Fact)\n" +
            "- 보충 메모: 사용자가 작업의 목적, 고민, 의도, 배경 및 적용 기술을 직접 기록한 메모\n\n" +
            "작성 가이드라인:\n" +
            "1. '## 이번 기간 주요 업무 요약' 헤더 아래 프로젝트(repo)별로 묶어 서술형 문단으로 구조화한다. 단순 커밋 목록 나열 금지.\n" +
            "2. 커밋 로그의 구현/수정 내역을 보충 메모의 목적 및 배경과 유기적으로 연결하여 '왜(Why), 무엇을(What), 어떻게(How)' 해결했는지 명확히 서술한다.\n" +
            "3. 사용된 기술 스택, 아키텍처/인프라적 결정, 성능/보안/신뢰성 개선 포인트를 구체적으로 기술한다.\n" +
            "4. '## 자소서/이력서 소재 후보 (STAR 초안)' 헤더 아래, 주요 성과나 기술적 문제해결 과정이 드러나는 STAR(Situation-Task-Action-Result) 구조의 소재를 1~3개 작성한다. (재료가 부족하면 생략 가능)\n" +
            "5. 사실을 과장하거나 재료에 없는 내용을 창작하지 않는다. 개발 문서에 적합한 깔끔하고 전문적인 한국어로 작성한다.",
        },
        { role: "user", content: `${week} 정리 재료:\n\n${material.join("\n")}` },
      ],
    }),
    signal: AbortSignal.timeout(300000), // NIM 응답 대기 (최대 5분)
  });
  if (!res.ok) throw new Error(`NIM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || null;
}

// ---- 알림 (macOS 알림 + Discord webhook 옵션) ----
function notify(title, body) {
  try {
    execFileSync("osascript", [
      "-e", `display notification "${body.replace(/"/g, "'")}" with title "${title}"`,
    ], { timeout: 10000 });
  } catch {}
  const hook = process.env.DISCORD_WEBHOOK_URL;
  if (hook) {
    try {
      execFileSync("curl", [
        "-sS", "-X", "POST", hook,
        "-H", "Content-Type: application/json",
        "-d", JSON.stringify({ content: `**${title}**\n${body}` }),
      ], { timeout: 15000 });
    } catch {}
  }
}

// 주간 정리 진행 상태를 status.json에 push (웹 버튼 피드백용)
async function pushWeeklyState(patch) {
  const cur = getContent("data/status.json")?.content ?? {};
  const weekly = { ...(cur.weekly || {}), ...patch };
  await putContent("data/status.json", { ...cur, weekly }, `chore(status): weekly ${patch.stage || (patch.running ? "진행 중" : patch.error ? "실패" : "완료")}`);
}

async function runWeekly(command) {
  await pushWeeklyState({ running: true, stage: "커밋 수집 중", startedAt: new Date().toISOString(), error: null, finishedAt: null });
  try {
    return await runWeeklyInner(command);
  } catch (e) {
    await pushWeeklyState({ running: false, stage: null, error: String(e.message || e).slice(0, 300) });
    throw e;
  }
}

async function runWeeklyInner(command) {
  const { start, todayISO } = computeWindow();
  // 최신 커밋 다시 수집 (기간: 마지막 기록일 다음날 ~ 오늘)
  const repos = findRepos().map((r) => ({
    name: r.name,
    commits: (() => {
      try {
        execFileSync("git", ["-C", r.dir, "fetch", "--all", "--quiet"], { timeout: 120000 });
      } catch {}
      return collectCommits(r.dir, start);
    })(),
  }));

  // 마지막 정리 생성 이후에 입력된 보충 메모만 사용
  const meta = getContent("data/meta.json")?.content ?? {};
  const lastGeneratedAt = meta.lastGeneratedAt ?? null;
  const allNotes = getContent("data/notes/all.json")?.content?.notes ?? [];
  const notes = lastGeneratedAt
    ? allNotes.filter((n) => n.at > lastGeneratedAt)
    : allNotes;
  console.log(`[weekly] 기간 ${start}~${todayISO}, 메모 ${notes.length}건 (전체 ${allNotes.length})`);

  const lines = [
    `# 업무 정리 (${start} ~ ${todayISO})`,
    "",
    `> 생성: ${todayISO} · life-log 대시보드에서 자동 생성 (LLM: ${NIM_MODEL})`,
    "",
  ];

  // NVIDIA NIM으로 서술형 요약 생성 (키 없음/실패 시 템플릿 폴백)
  let llmOk = false;
  try {
    await pushWeeklyState({ stage: "AI 요약 생성 중 (1~5분 소요)" });
    const summary = await nimSummarize(`${start} ~ ${todayISO}`, notes, repos);
    if (summary) {
      lines.push(summary, "");
      llmOk = true;
      console.log("[weekly] NIM 요약 생성 완료");
    }
  } catch (e) {
    console.error("[weekly] NIM 호출 실패, 템플릿으로 대체:", e.message);
  }

  if (!llmOk) {
    lines.push("## 기간 업무", "");
    for (const n of notes) {
      lines.push(`- [${n.at.slice(5, 16).replace("T", " ")}] ${n.text.replace(/\n/g, "\n  ")}`);
    }
    if (!notes.length) lines.push("(입력된 보충 메모 없음)");
  }

  lines.push("## Git 커밋 요약", "");
  for (const r of repos.filter((x) => x.commits.length)) {
    lines.push(`### ${r.name} — ${r.commits.length}건`, "", "```");
    lines.push(...r.commits.map((c) => c.replace(/^[^|]*\|[^|]*\|/, "")));
    lines.push("```", "");
  }
  if (!repos.some((x) => x.commits.length)) lines.push("(해당 기간 커밋 없음)", "");

  const md = lines.join("\n");
  // 로컬 job 폴더에 저장 (파일명: 시작일_종료일)
  const baseName = `${start}_${todayISO}`;
  const outDir = path.join(JOB_DIR, "docs", "10_주간정리");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${baseName}.md`), md);
  // 웹에서 볼 수 있게 repo에도 사본 push + 소비한 메모 기록 갱신
  await putContent(`data/weekly/${baseName}.md.json`, { markdown: md }, `docs(weekly): ${baseName} 정리 생성`);
  await putContent("data/meta.json", { ...meta, lastGeneratedAt: new Date().toISOString() }, "chore(meta): 정리 생성 시각 갱신");

  // 달력(calendar.json)에 업무 정리 기록 갱신
  try {
    const calRemote = getContent("data/calendar.json");
    const calendar = calRemote?.content ?? {};
    if (!calendar[todayISO]) {
      calendar[todayISO] = true;
      await putContent("data/calendar.json", calendar, `chore(calendar): ${todayISO} 업무 정리 기록 완료`);
      console.log(`[calendar] ${todayISO} 기록 완료 반영`);
    }
  } catch (e) {
    console.error("[calendar] 기록 갱신 실패:", e.message || e);
  }

  await pushWeeklyState({ running: false, stage: null, finishedAt: new Date().toISOString(), file: baseName });

  // 스토리뱅크 등록 초안: STAR 섹션을 별도 초안 파일에 적립
  const starMatch = md.match(/## 자소서[^\n]*\n([\s\S]*?)(?=\n## |$)/);
  if (starMatch && starMatch[1].trim()) {
    const draftPath = path.join(JOB_DIR, "docs", "03_스토리뱅크_초안.md");
    fs.appendFileSync(
      draftPath,
      `\n\n<!-- ${baseName} 자동 추출 -->\n## ${baseName}\n${starMatch[1].trim()}\n`
    );
    console.log(`[weekly] 스토리뱅크 초안 적립 → ${draftPath}`);
  }

  notify("📝 주간 정리 완료", `${start} ~ ${todayISO} 정리가 job 폴더에 저장되었습니다.`);
  console.log(`[weekly] ${outDir}/${baseName}.md 저장 완료`);
}

// ---- 시작 시: 기존 09_업무일지 및 10_주간정리 파일들을 읽어 달력에 과거 기록 시드 ----
async function seedCalendar() {
  const days = new Set();
  // 1. 기존 09_업무일지 (YYYY-MM-DD.md)
  const diaryDir = path.join(JOB_DIR, "docs", "09_업무일지");
  if (fs.existsSync(diaryDir)) {
    for (const f of fs.readdirSync(diaryDir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (m) days.add(m[1]);
    }
  }
  // 2. 기존 10_주간정리 (YYYY-MM-DD_YYYY-MM-DD.md -> 종료일자)
  const weeklyDir = path.join(JOB_DIR, "docs", "10_주간정리");
  if (fs.existsSync(weeklyDir)) {
    for (const f of fs.readdirSync(weeklyDir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.md$/);
      if (m) days.add(m[2]);
    }
  }
  if (!days.size) return;
  const remote = getContent("data/calendar.json");
  const calendar = remote?.content ?? {};
  let added = 0;
  for (const d of Array.from(days).sort()) {
    if (!calendar[d]) {
      calendar[d] = true;
      added++;
    }
  }
  if (added) {
    await putContent("data/calendar.json", calendar, `chore(calendar): 기존 일지/정리 ${added}일 시드`);
    console.log(`[calendar] 기존 일지/정리 ${added}일을 달력에 반영`);
  }
}

// ---- 루프 ----
let lastProcessedAt = null;
let autoGenDay = null;
try {
  const cur = getContent("data/command.json");
  lastProcessedAt = cur?.content?.requestedAt ?? null;
} catch {}

console.log(`[daemon] 시작. repo=${REPO}, develop=${DEVELOP_DIR}, poll=${POLL_MS}ms`);

seedCalendar().catch((e) => console.error("[calendar] 시드 실패:", e));

setInterval(async () => {
  if (!TOKEN) return;

  // 매일 20:30(KST) 자동 주간 정리 생성 (그날 아직 미생성일 때만)
  try {
    const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
    const todayISO = kstNow.toISOString().slice(0, 10);
    const hhmm = kstNow.toISOString().slice(11, 16);
    if (hhmm >= "20:30" && autoGenDay !== todayISO) {
      const m = getContent("data/meta.json")?.content ?? {};
      if ((m.lastGeneratedAt || "").slice(0, 10) !== todayISO) {
        autoGenDay = todayISO;
        console.log("[daemon] 자동 주간 정리 생성 시작");
        await runWeekly({ action: "generate-weekly", week: todayISO });
      } else {
        autoGenDay = todayISO;
      }
    }
  } catch (e) {
    console.error("[daemon] 자동 생성 오류:", e.message || e);
  }

  const cmd = getContent("data/command.json");
  if (!cmd?.content?.requestedAt) return;
  if (lastProcessedAt && cmd.content.requestedAt <= lastProcessedAt) return;
  lastProcessedAt = cmd.content.requestedAt;
  console.log(`[daemon] 명령 감지: ${cmd.content.action}`);
  try {
    if (cmd.content.action === "generate-weekly") await runWeekly(cmd.content);
    else await runFetch(cmd.content);
  } catch (e) {
    console.error("[daemon] 실행 오류:", e);
  }
}, POLL_MS);
