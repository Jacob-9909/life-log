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
  const { key, mondayISO } = weekInfo();
  const repos = findRepos();
  const status = {
    week: key,
    requestedAt: command.requestedAt,
    startedAt: new Date().toISOString(),
    running: true,
    finishedAt: null,
    repos: repos.map((r) => ({ name: r.name, state: "pending", commits: [] })),
  };
  await putContent("data/status.json", status, `chore(status): ${key} 스캔 시작`);

  for (const r of status.repos) {
    r.state = "running";
    await putContent("data/status.json", status, `chore(status): ${key} ${r.name} 스캔 중`);
    const found = repos.find((x) => x.name === r.name);
    try {
      execFileSync("git", ["-C", found.dir, "fetch", "--all", "--quiet"], { timeout: 120000 });
      r.commits = collectCommits(found.dir, mondayISO);
      r.state = "done";
    } catch (e) {
      r.state = "done";
      r.error = String(e.message).slice(0, 200);
    }
    await putContent("data/status.json", status, `chore(status): ${key} ${r.name} 완료 (+${r.commits.length})`);
  }

  status.running = false;
  status.finishedAt = new Date().toISOString();
  await putContent("data/status.json", status, `chore(status): ${key} 스캔 완료`);
  console.log(`[fetch] ${key} 완료`);
}

async function runWeekly(command) {
  const { key, mondayISO } = command.week === weekInfo().key ? weekInfo() : weekInfo(new Date(`${command.week}-1`));
  // 최신 커밋 다시 수집
  const repos = findRepos().map((r) => ({
    name: r.name,
    commits: (() => {
      try {
        execFileSync("git", ["-C", r.dir, "fetch", "--all", "--quiet"], { timeout: 120000 });
      } catch {}
      return collectCommits(r.dir, mondayISO);
    })(),
  }));

  const noteFile = getContent(`data/notes/${command.week}.json`);
  const notes = noteFile?.content?.notes ?? [];

  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const lines = [
    `# ${command.week} 주간 정리`,
    "",
    `> 생성: ${today} · life-log 대시보드에서 자동 생성`,
    "",
    "## 이번주 업무",
    "",
  ];
  for (const n of notes) {
    lines.push(`- [${n.at.slice(5, 16).replace("T", " ")}] ${n.text.replace(/\n/g, "\n  ")}`);
  }
  if (!notes.length) lines.push("(입력된 업무 메모 없음)");
  lines.push("", "## Git 커밋 요약", "");
  for (const r of repos.filter((x) => x.commits.length)) {
    lines.push(`### ${r.name} — ${r.commits.length}건`, "", "```");
    lines.push(...r.commits.map((c) => c.replace(/^[^|]*\|[^|]*\|/, "")));
    lines.push("```", "");
  }
  if (!repos.some((x) => x.commits.length)) lines.push("(해당 주 커밋 없음)", "");

  const md = lines.join("\n");
  // 로컬 job 폴더에 저장
  const outDir = path.join(JOB_DIR, "docs", "10_주간정리");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${command.week}.md`), md);
  // 웹에서 볼 수 있게 repo에도 사본 push
  await putContent(`data/weekly/${command.week}.md.json`, { markdown: md }, `docs(weekly): ${command.week} 정리 생성`);
  console.log(`[weekly] ${outDir}/${command.week}.md 저장 완료`);
}

// ---- 시작 시: 기존 09_업무일지 파일들을 읽어 달력에 과거 기록 시드 ----
async function seedCalendar() {
  const diaryDir = path.join(JOB_DIR, "docs", "09_업무일지");
  if (!fs.existsSync(diaryDir)) return;
  const days = fs
    .readdirSync(diaryDir)
    .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.md$/)?.[1])
    .filter(Boolean);
  if (!days.length) return;
  const remote = getContent("data/calendar.json");
  const calendar = remote?.content ?? {};
  let added = 0;
  for (const d of days) {
    if (!calendar[d]) {
      calendar[d] = true;
      added++;
    }
  }
  if (added) {
    await putContent("data/calendar.json", calendar, `chore(calendar): 기존 업무일지 ${added}일 시드`);
    console.log(`[calendar] 기존 업무일지 ${added}일을 달력에 반영`);
  }
}

// ---- 루프 ----
let lastProcessedAt = null;
try {
  const cur = getContent("data/command.json");
  lastProcessedAt = cur?.content?.requestedAt ?? null;
} catch {}

console.log(`[daemon] 시작. repo=${REPO}, develop=${DEVELOP_DIR}, poll=${POLL_MS}ms`);

seedCalendar().catch((e) => console.error("[calendar] 시드 실패:", e));

setInterval(async () => {
  if (!TOKEN) return;
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
