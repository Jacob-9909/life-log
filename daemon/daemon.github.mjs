#!/usr/bin/env node
// life-log 데몬 (GitHub API 버전 — Oracle VM 등 원격 서버에서 실행)
//
// 로컬 맥 버전과의 차이:
// - 커밋 수집: 로컬 git 스캔 대신 GitHub Commits API 로 조회 (repo clone 불필요)
//   → GITHUB_OWNER 계정의 repo 를 /user/repos 로 자동 나열, 각 repo 에서
//     since/until + author 필터로 커밋을 가져온다. (push 된 커밋만 잡힘 — 기존과 동일)
// - 산출물: ~/job 은 VM 에 clone 된 git repo. md 를 쓴 뒤 commit & push 하여
//   맥에서 git pull 로 동기화한다.
// - macOS 알림/Discord 알림 없음.
//
// 필요한 환경변수:
//   GITHUB_REPO    life-log repo (예: Jacob-9909/life-log) — command/status/data 저장소
//   GITHUB_TOKEN   contents 읽기/쓰기 + repo 커밋 조회 권한
//   GITHUB_OWNER   커밋을 수집할 계정 (예: Jacob-9909). 미지정 시 토큰 소유자(/user/repos)
//   NVIDIA_API_KEY NIM 요약용 (없으면 템플릿 폴백)
//   JOB_DIR        job repo clone 경로 (기본 ~/job)
//   POLL_MS        폴링 주기 (기본 15000)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const REPO = process.env.GITHUB_REPO; // Jacob-9909/life-log
const BRANCH = process.env.GITHUB_BRANCH || "main";
const OWNER = process.env.GITHUB_OWNER || ""; // 비면 /user/repos (토큰 소유자)
const JOB_DIR = process.env.JOB_DIR || path.join(HOME, "job");
const POLL_MS = Number(process.env.POLL_MS || 15000);
const NIM_BASE = process.env.NIM_BASE_URL || "https://integrate.api.nvidia.com/v1";
const NIM_MODEL = process.env.NIM_MODEL || "nvidia/nemotron-3-ultra-550b-a55b";
const API = "https://api.github.com";
const TOKEN = process.env.GITHUB_TOKEN;

// 커밋 저자 매칭 (GitHub API 는 author=email 파라미터로 필터. 이름 매칭은 클라이언트에서 보강)
const AUTHOR_EMAILS = (process.env.AUTHOR_EMAILS || "whjeong@didim365.com,cj0336j@gmail.com")
  .split(",").map((s) => s.trim()).filter(Boolean);
const AUTHOR_NAME_RE = /Woohyuck Jeong|Jacob|whjeong|cj0336j/i;

// ---- GitHub REST 헬퍼 (fetch 기반) ----
async function ghFetch(method, urlPath, body) {
  const res = await fetch(`${API}/${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  return res;
}

async function getContent(file) {
  try {
    const res = await ghFetch("GET", `repos/${REPO}/contents/${file}?ref=${BRANCH}`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !json.content) return null;
    return { sha: json.sha, content: JSON.parse(Buffer.from(json.content, "base64").toString("utf8")) };
  } catch {
    return null;
  }
}

async function putContent(file, content, message) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const existing = await getContent(file);
      await new Promise((r) => setTimeout(r, 300));
      const res = await ghFetch("PUT", `repos/${REPO}/contents/${file}`, {
        message,
        branch: BRANCH,
        content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
        ...(existing ? { sha: existing.sha } : {}),
      });
      if (res.ok) return;
      throw new Error(`PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
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

// ---- 수집 기간 계산: 마지막 기록일 다음날 ~ 오늘 (KST) ----
async function computeWindow() {
  const iso = (d) => d.toISOString().slice(0, 10);
  const today = new Date(Date.now() + 9 * 3600 * 1000);
  const todayISO = iso(today);
  let start;
  try {
    const cal = (await getContent("data/calendar.json"))?.content ?? {};
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

// ---- GitHub repo 나열 (계정의 모든 repo, 페이지네이션) ----
async function listGitHubRepos() {
  const repos = [];
  for (let page = 1; page <= 20; page++) {
    // OWNER 지정 시 해당 유저/조직 repo, 아니면 토큰 소유자의 repo(private 포함)
    const urlPath = OWNER
      ? `users/${OWNER}/repos?per_page=100&page=${page}&type=owner&sort=full_name`
      : `user/repos?per_page=100&page=${page}&affiliation=owner&sort=full_name`;
    const res = await ghFetch("GET", urlPath);
    if (!res.ok) {
      console.error(`[repos] 나열 실패 page=${page}: ${res.status}`);
      break;
    }
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const r of arr) {
      if (r.fork) continue; // 포크는 제외 (내 커밋 아님)
      repos.push({ name: r.name, full: r.full_name });
    }
    if (arr.length < 100) break;
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- 특정 repo 에서 기간+저자 필터로 커밋 조회 ----
// 반환 형식은 로컬 버전과 동일: "MM-DD HH:MM|메시지" (KST)
async function collectCommitsFromGitHub(fullName, startISO, endISO) {
  const sinceUTC = new Date(`${startISO}T00:00:00+09:00`).toISOString();
  // endISO 는 그날 끝(24:00 KST)까지 포함하려고 +1일 00:00 KST
  const endDate = new Date(`${endISO}T00:00:00+09:00`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const untilUTC = endDate.toISOString();

  const seen = new Set();
  const out = [];
  // author 파라미터는 하나씩만 받으므로 이메일별로 조회 후 병합
  const authors = [...AUTHOR_EMAILS, null]; // null = author 필터 없이(이름으로 걸러냄)
  for (const author of authors) {
    for (let page = 1; page <= 10; page++) {
      const qs = new URLSearchParams({
        since: sinceUTC,
        until: untilUTC,
        per_page: "100",
        page: String(page),
      });
      if (author) qs.set("author", author);
      const res = await ghFetch("GET", `repos/${fullName}/commits?${qs}`);
      if (res.status === 409) return out; // 빈 repo
      if (!res.ok) break;
      const arr = await res.json();
      if (!Array.isArray(arr) || arr.length === 0) break;
      for (const c of arr) {
        const sha = c.sha;
        if (seen.has(sha)) continue;
        const name = c.commit?.author?.name || "";
        const email = c.commit?.author?.email || "";
        const matches = author
          ? true
          : AUTHOR_EMAILS.includes(email) || AUTHOR_NAME_RE.test(name);
        if (!matches) continue;
        seen.add(sha);
        const when = new Date(c.commit?.author?.date || c.commit?.committer?.date);
        const kst = new Date(when.getTime() + 9 * 3600 * 1000);
        const mmdd = `${String(kst.getUTCMonth() + 1).padStart(2, "0")}-${String(kst.getUTCDate()).padStart(2, "0")}`;
        const hhmm = `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`;
        const msg = (c.commit?.message || "").split("\n")[0];
        out.push({ date: when.getTime(), line: `${mmdd} ${hhmm}|${msg}` });
      }
      if (arr.length < 100) break;
    }
  }
  return out.sort((a, b) => a.date - b.date).map((x) => x.line);
}

// ---- fetch 액션: 전체 repo 스캔 후 status.json 갱신 ----
async function runFetch(command) {
  const { start, todayISO } = await computeWindow();
  const periodLabel = `${start.slice(5)} ~ ${todayISO.slice(5)}`;
  console.log(`[fetch] 수집 기간: ${start} ~ ${todayISO}`);
  const repos = await listGitHubRepos();
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

  for (let i = 0; i < status.repos.length; i++) {
    const r = status.repos[i];
    r.state = "running";
    await putContent("data/status.json", status, `chore(status): ${periodLabel} ${r.name} 스캔 중`);
    try {
      r.commits = await collectCommitsFromGitHub(repos[i].full, start, todayISO);
      r.state = "done";
    } catch (e) {
      r.state = "done";
      r.error = String(e.message).slice(0, 200);
    }
    await putContent("data/status.json", status, `chore(status): ${periodLabel} ${r.name} 완료 (+${r.commits.length})`);
  }

  status.running = false;
  status.finishedAt = new Date().toISOString();
  await putContent("data/status.json", status, `chore(status): ${periodLabel} 스캔 완료`);
  console.log(`[fetch] ${periodLabel} 완료 — 커밋 ${status.repos.reduce((s, r) => s + r.commits.length, 0)}건`);
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
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`NIM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || null;
}

// ---- job repo commit & push ----
function jobGitPush(message) {
  try {
    execFileSync("git", ["-C", JOB_DIR, "add", "-A"], { timeout: 30000 });
    // 변경사항 없으면 commit 이 non-zero 로 죽으므로 무시
    try {
      execFileSync("git", ["-C", JOB_DIR, "commit", "-m", message], { timeout: 30000 });
    } catch {
      return; // nothing to commit
    }
    execFileSync("git", ["-C", JOB_DIR, "push", "origin", "HEAD"], { timeout: 120000 });
    console.log(`[job] push 완료: ${message}`);
  } catch (e) {
    console.error("[job] git push 실패:", e.message);
  }
}

async function pushWeeklyState(patch) {
  const cur = (await getContent("data/status.json"))?.content ?? {};
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
  const { start, todayISO } = await computeWindow();
  // job repo 최신화 (충돌 방지)
  try {
    execFileSync("git", ["-C", JOB_DIR, "pull", "--ff-only", "--quiet"], { timeout: 60000 });
  } catch (e) {
    console.error("[job] pull 경고:", e.message);
  }

  // GitHub API 로 커밋 수집
  const ghRepos = await listGitHubRepos();
  const repos = [];
  for (const r of ghRepos) {
    let commits = [];
    try {
      commits = await collectCommitsFromGitHub(r.full, start, todayISO);
    } catch (e) {
      console.error(`[weekly] ${r.name} 커밋 조회 실패:`, e.message);
    }
    repos.push({ name: r.name, commits });
  }

  const meta = (await getContent("data/meta.json"))?.content ?? {};
  const lastGeneratedAt = meta.lastGeneratedAt ?? null;
  const allNotes = (await getContent("data/notes/all.json"))?.content?.notes ?? [];
  const notes = lastGeneratedAt ? allNotes.filter((n) => n.at > lastGeneratedAt) : allNotes;
  console.log(`[weekly] 기간 ${start}~${todayISO}, 메모 ${notes.length}건 (전체 ${allNotes.length})`);

  const lines = [
    `# 업무 정리 (${start} ~ ${todayISO})`,
    "",
    `> 생성: ${todayISO} · life-log 대시보드에서 자동 생성 (LLM: ${NIM_MODEL})`,
    "",
  ];

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
    lines.push(...r.commits.map((c) => c.replace(/^[^|]*\|/, "")));
    lines.push("```", "");
  }
  if (!repos.some((x) => x.commits.length)) lines.push("(해당 기간 커밋 없음)", "");

  const md = lines.join("\n");
  const baseName = `${start}_${todayISO}`;
  const outDir = path.join(JOB_DIR, "docs", "10_주간정리");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${baseName}.md`), md);

  // 웹에서 볼 수 있게 life-log repo 에도 사본 push + 메모 소비 기록 갱신
  await putContent(`data/weekly/${baseName}.md.json`, { markdown: md }, `docs(weekly): ${baseName} 정리 생성`);
  await putContent("data/meta.json", { ...meta, lastGeneratedAt: new Date().toISOString() }, "chore(meta): 정리 생성 시각 갱신");

  // 달력 갱신
  try {
    const calRemote = await getContent("data/calendar.json");
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

  // 스토리뱅크 초안 적립
  const starMatch = md.match(/## 자소서[^\n]*\n([\s\S]*?)(?=\n## |$)/);
  if (starMatch && starMatch[1].trim()) {
    const draftPath = path.join(JOB_DIR, "docs", "03_스토리뱅크_초안.md");
    fs.appendFileSync(draftPath, `\n\n<!-- ${baseName} 자동 추출 -->\n## ${baseName}\n${starMatch[1].trim()}\n`);
    console.log(`[weekly] 스토리뱅크 초안 적립 → ${draftPath}`);
  }

  // job repo 로 commit & push (맥에서 git pull 로 동기화)
  jobGitPush(`docs(weekly): ${baseName} 정리 자동 생성`);
  console.log(`[weekly] ${outDir}/${baseName}.md 저장 완료`);
}

// ---- 시작 시: job repo 의 기존 일지/정리로 달력 시드 ----
async function seedCalendar() {
  const days = new Set();
  const diaryDir = path.join(JOB_DIR, "docs", "09_업무일지");
  if (fs.existsSync(diaryDir)) {
    for (const f of fs.readdirSync(diaryDir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (m) days.add(m[1]);
    }
  }
  const weeklyDir = path.join(JOB_DIR, "docs", "10_주간정리");
  if (fs.existsSync(weeklyDir)) {
    for (const f of fs.readdirSync(weeklyDir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.md$/);
      if (m) days.add(m[2]);
    }
  }
  if (!days.size) return;
  const remote = await getContent("data/calendar.json");
  const calendar = remote?.content ?? {};
  let added = 0;
  for (const d of Array.from(days).sort()) {
    if (!calendar[d]) { calendar[d] = true; added++; }
  }
  if (added) {
    await putContent("data/calendar.json", calendar, `chore(calendar): 기존 일지/정리 ${added}일 시드`);
    console.log(`[calendar] 기존 일지/정리 ${added}일을 달력에 반영`);
  }
}

// ---- 루프 ----
let lastProcessedAt = null;
let autoGenDay = null;

async function main() {
  if (!TOKEN) {
    console.error("[daemon] GITHUB_TOKEN 이 없습니다. 종료.");
    process.exit(1);
  }
  try {
    const cur = await getContent("data/command.json");
    lastProcessedAt = cur?.content?.requestedAt ?? null;
  } catch {}

  console.log(`[daemon] 시작. repo=${REPO}, owner=${OWNER || "(token owner)"}, job=${JOB_DIR}, poll=${POLL_MS}ms`);
  await seedCalendar().catch((e) => console.error("[calendar] 시드 실패:", e));

  setInterval(tick, POLL_MS);
}

async function tick() {
  if (!TOKEN) return;

  // 매일 20:30(KST) 자동 주간 정리 (그날 아직 미생성일 때만)
  try {
    const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
    const todayISO = kstNow.toISOString().slice(0, 10);
    const hhmm = kstNow.toISOString().slice(11, 16);
    if (hhmm >= "20:30" && autoGenDay !== todayISO) {
      const m = (await getContent("data/meta.json"))?.content ?? {};
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

  const cmd = await getContent("data/command.json");
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
}

main();
