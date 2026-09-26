"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function authHeaders(code) {
  return { "Content-Type": "application/json", "x-access-code": code };
}

// 숫자가 스프링처럼 카운트업되는 훅
function useCountUp(value) {
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);
  useEffect(() => {
    const from = prevRef.current;
    prevRef.current = value;
    if (from === value) return;
    const start = performance.now();
    const dur = 600;
    let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return display;
}

const MILESTONES = [7, 14, 30, 50, 100];

// 애니메이션 숫자 카운터
function Stat({ value }) {
  const n = useCountUp(value);
  return <>{n}</>;
}

function fireConfetti() {
  import("canvas-confetti").then(({ default: confetti }) => {
    confetti({ particleCount: 120, spread: 75, origin: { y: 0.7 }, colors: ["#ffd166", "#34d399", "#a78bfa", "#22d3ee"] });
    setTimeout(() => confetti({ particleCount: 80, angle: 60, spread: 60, origin: { x: 0 } }), 200);
    setTimeout(() => confetti({ particleCount: 80, angle: 120, spread: 60, origin: { x: 1 } }), 350);
  });
}

export default function Home() {
  const [code, setCode] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [gateError, setGateError] = useState("");

  const [repos, setRepos] = useState([]);
  const [status, setStatus] = useState({
    repos: [],
    finishedAt: null,
    running: false,
    week: "",
    period: null as { start: string; end: string } | null,
    weekly: null as { running?: boolean; stage?: string | null; startedAt?: string; finishedAt?: string; file?: string; error?: string | null } | null,
  });
  const [notes, setNotes] = useState([]);
  const [calendar, setCalendar] = useState({});
  const [monthOffset, setMonthOffset] = useState(0);
  const [expandedRepo, setExpandedRepo] = useState(null);
  const [milestone, setMilestone] = useState(null);
  const [levelUp, setLevelUp] = useState(null);
  const [meta, setMeta] = useState({ lastGeneratedAt: null });
  const [toast, setToast] = useState(null);
  const [weeklyOpen, setWeeklyOpen] = useState(false);
  const [weeklyList, setWeeklyList] = useState([]);
  const [weeklyMd, setWeeklyMd] = useState(null);
  const [editingAt, setEditingAt] = useState(null);
  const [editText, setEditText] = useState("");
  const [weeklyPending, setWeeklyPending] = useState(false);
  const wasRunningRef = useRef(false);
  const cal = calendarGrid();
  const todayIso = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const doneDays = Object.keys(calendar).filter((k) => calendar[k]).length;
  const monthDone = cal.cells.filter((c) => c && calendar[c.iso]).length;
  // 레벨 시스템: 기록 5일당 1레벨
  const level = Math.floor(doneDays / 5) + 1;
  const xpPercent = ((doneDays % 5) / 5) * 100;
  const xpToNext = 5 - (doneDays % 5);

  // 오늘부터 거꾸로 연속 기록일 수 (스트릭)
  const streak = (() => {
    let n = 0;
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    for (;;) {
      const iso = d.toISOString().slice(0, 10);
      if (!calendar[iso]) break;
      n++;
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return n;
  })();

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => {
    const saved = localStorage.getItem("life-log-code");
    if (saved) setCode(saved);
  }, []);

  const loadStatus = useCallback(async () => {
    const res = await fetch("/api/status");
    const data = await res.json();
    if (data.repos?.length) {
      setStatus(data);
      setRepos(data.repos.map((r) => r.name));
    }
  }, []);

  const loadNotes = useCallback(async (c) => {
    const res = await fetch("/api/notes", { headers: authHeaders(c) });
    if (res.ok) {
      const data = await res.json();
      setNotes(data.notes || []);
    }
  }, []);

  const loadCalendar = useCallback(async () => {
    const res = await fetch("/api/calendar");
    if (res.ok) setCalendar(await res.json());
  }, []);

  useEffect(() => {
    if (!code) return;
    loadStatus();
    loadNotes(code);
    loadCalendar();
    fetch("/api/meta")
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => {});
    const t = setInterval(loadStatus, 3000);
    return () => clearInterval(t);
  }, [code, loadStatus, loadNotes, loadCalendar]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [notes.length]);

  // Fetch 전체 완료 시 던전 클리어 컨페티
  useEffect(() => {
    if (wasRunningRef.current && !status.running && status.repos.length > 0) {
      setTimeout(fireConfetti, 300);
    }
    wasRunningRef.current = !!status.running;
  }, [status.running, status.repos.length]);

  // 주간 정리 생성 완료/실패 감지 → 토스트
  const weeklyRunning = !!status.weekly?.running;
  const wasWeeklyRunningRef = useRef(false);
  useEffect(() => {
    if (weeklyRunning) {
      setWeeklyPending(false);
      wasWeeklyRunningRef.current = true;
    } else if (wasWeeklyRunningRef.current && status.weekly?.startedAt) {
      wasWeeklyRunningRef.current = false;
      setToast(
        status.weekly.error
          ? { icon: "⚠️", name: "주간 정리 실패", desc: status.weekly.error }
          : { icon: "📝", name: "주간 정리 완료!", desc: "📚 지난 정리에서 확인하세요" }
      );
      if (!status.weekly.error) {
        fireConfetti();
        fetch("/api/meta").then((r) => r.json()).then(setMeta).catch(() => {});
      }
      setTimeout(() => setToast(null), 6000);
    }
  }, [weeklyRunning, status.weekly?.startedAt]);

  // 레벨업 감지 → 모달 + 컨페티
  const prevLevelRef = useRef(level);
  useEffect(() => {
    if (level > prevLevelRef.current && prevLevelRef.current > 0) {
      sessionStorage.setItem(`lv-${level}`, "1");
      setLevelUp(level);
      fireConfetti();
    }
    prevLevelRef.current = level;
  }, [level]);

  // 업적 정의 (전부 클라이언트 계산, 서버 데이터 기반 — 기기 무관)
  const commitTotal = status.repos.reduce((s, r) => s + (r.commits?.length || 0), 0);
  const hasFullScan = !!status.finishedAt && status.repos.length > 0;
  const achievements = [
    { icon: "👣", name: "첫걸음", desc: "첫 업무 기록", ok: doneDays >= 1 },
    { icon: "🔥", name: "일주일 개근", desc: "7일 연속 기록", ok: streak >= 7 },
    { icon: "🌋", name: "한 달 개근", desc: "30일 연속 기록", ok: streak >= 30 },
    { icon: "💯", name: "백전백승", desc: "누적 100일", ok: doneDays >= 100 },
    { icon: "🏆", name: "던전 클리어", desc: "Fetch 전체 완료", ok: hasFullScan },
    { icon: "📜", name: "첫 주간 정리", desc: "정리 생성 1회", ok: !!meta.lastGeneratedAt },
    { icon: "⚔️", name: "커밋 헌터", desc: "기간 내 커밋 50+", ok: commitTotal >= 50 },
    { icon: "🌙", name: "야행성", desc: "이번 달 기록 15+", ok: monthDone >= 15 },
  ];
  const unlockedCount = achievements.filter((a) => a.ok).length;

  // 업적 해금 시 토스트 (세션당 1회)
  const prevAchRef = useRef(null);
  useEffect(() => {
    const nowUnlocked = achievements.filter((a) => a.ok);
    const prev = prevAchRef.current;
    if (prev && nowUnlocked.length > prev.length) {
      const fresh = nowUnlocked[nowUnlocked.length - 1];
      setToast(fresh);
      fireConfetti();
      setTimeout(() => setToast(null), 5000);
    }
    prevAchRef.current = nowUnlocked;
  }, [achievements.map((a) => a.ok).join(",")]);

  // 스트릭 마일스톤 도달 시 축하 배너 (세션당 1회)
  useEffect(() => {
    if (streak && MILESTONES.includes(streak)) {
      const key = `milestone-${streak}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, "1");
        setMilestone(streak);
        fireConfetti();
      }
    }
  }, [streak]);

  async function handleGate(e) {
    e.preventDefault();
    const res = await fetch("/api/notes", { headers: authHeaders(codeInput) });
    if (res.ok) {
      localStorage.setItem("life-log-code", codeInput);
      setCode(codeInput);
      setGateError("");
    } else {
      setGateError("접근 코드가 올바르지 않습니다");
    }
  }

  async function trigger(action) {
    setBusy(true);
    try {
      const res = await fetch("/api/trigger", {
        method: "POST",
        headers: authHeaders(code),
        body: JSON.stringify({ action }),
      });
      if (res.ok && action === "generate-weekly") {
        setWeeklyPending(true);
        fetch("/api/meta").then((r) => r.json()).then(setMeta).catch(() => {});
      }
      if (res.ok && action === "fetch") setTimeout(loadStatus, 1500);
    } finally {
      setBusy(false);
    }
  }

  async function sendNote() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: authHeaders(code),
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      const data = await res.json();
      setNotes(data.notes || []);
      loadCalendar();
    }
  }

  async function openWeekly() {
    setWeeklyOpen(true);
    setWeeklyMd(null);
    const res = await fetch("/api/weekly", { headers: authHeaders(code) });
    if (res.ok) {
      const data = await res.json();
      setWeeklyList(data.files || []);
    }
  }

  async function loadWeekly(file) {
    const res = await fetch(`/api/weekly?file=${encodeURIComponent(file)}.md.json`, { headers: authHeaders(code) });
    if (res.ok) {
      const data = await res.json();
      setWeeklyMd({ file, markdown: data.markdown });
    }
  }

  function startEdit(n) {
    setEditingAt(n.at);
    setEditText(n.text);
  }

  async function saveEdit() {
    const res = await fetch("/api/notes", {
      method: "PATCH",
      headers: authHeaders(code),
      body: JSON.stringify({ at: editingAt, text: editText }),
    });
    if (res.ok) {
      const data = await res.json();
      setNotes(data.notes || []);
      setEditingAt(null);
    }
  }

  async function deleteNote(at) {
    const res = await fetch(`/api/notes?at=${encodeURIComponent(at)}`, {
      method: "DELETE",
      headers: authHeaders(code),
    });
    if (res.ok) {
      const data = await res.json();
      setNotes(data.notes || []);
    }
  }

  // 달력 렌더링용: 현재 표시 중인 월의 날짜 그리드 (월요일 시작)
  function calendarGrid() {
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const year = base.getFullYear();
    const month = base.getMonth();
    const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // 월=0
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      cells.push({ day: d, iso });
    }
    return { cells, label: `${year}년 ${month + 1}월` };
  }
  // 게이트: 접근 코드
  if (!code) {
    return (
      <form className="gate" onSubmit={handleGate}>
        <h1 style={{ fontSize: 22 }}>Life Log</h1>
        <p className="hint">이 대시보드는 비공개입니다. 접근 코드를 입력하세요.</p>
        <input
          type="password"
          value={codeInput}
          onChange={(e) => setCodeInput(e.target.value)}
          placeholder="access code"
          autoFocus
        />
        <button className="btn" type="submit">열기</button>
        {gateError && <div className="error-msg">{gateError}</div>}
      </form>
    );
  }

  const doneCount = status.repos?.filter((r) => r.state === "done").length ?? 0;
  const totalCount = status.repos?.length ?? 0;
  const running = !!status.running;
  const week = status.week || "";
  const commitGroups =
    status.repos?.filter((r) => r.state === "done" && r.commits?.length > 0) ?? [];

  // 저녁 6시 이후 오늘 기록 없으면 스트릭 위험 경보
  const streakDanger = !calendar[todayIso] && new Date(Date.now() + 9 * 3600 * 1000).getUTCHours() >= 18;

  // 칭호 시스템
  const TIERS = [
    [1, "잡몹 사냥꾼"], [5, "모험가"], [10, "기사단원"], [15, "대마법사"], [20, "전설"],
  ];
  const tier = [...TIERS].reverse().find(([lv]) => level >= Number(lv))[1];
  const nextTier = [...TIERS].find(([lv]) => level < Number(lv)) || null;


  // 히트맵 농도: 날짜별 메모 개수
  const notesByDay = {};
  for (const n of notes) {
    const d = new Date(n.at).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
    notesByDay[d] = (notesByDay[d] || 0) + 1;
  }

  return (
    <div className="app">
      <div className="crt-overlay" aria-hidden />
      {toast && (
        <div className="ach-toast">
          <span className="ach-toast-icon">{toast.icon}</span>
          <div>
            <div className="ach-toast-title">업적 달성!</div>
            <div className="ach-toast-name">{toast.name} — {toast.desc}</div>
          </div>
        </div>
      )}
      {weeklyOpen && (
        <div className="levelup-modal" onClick={() => setWeeklyOpen(false)}>
          <div className="weekly-box" onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <h2>📚 지난 주간 정리</h2>
              <button className="btn secondary small" onClick={() => setWeeklyOpen(false)}>닫기</button>
            </div>
            <div className="weekly-body">
              <ul className="weekly-list">
                {!weeklyList.length && <li className="hint">아직 생성된 정리가 없습니다.</li>}
                {weeklyList.map((f) => (
                  <li key={f}>
                    <button
                      className={`weekly-item ${weeklyMd?.file === f ? "active" : ""}`}
                      onClick={() => loadWeekly(f)}
                    >📄 {f}</button>
                  </li>
                ))}
              </ul>
              {weeklyMd && <pre className="md-view">{weeklyMd.markdown}</pre>}
              {!weeklyMd && weeklyList.length > 0 && (
                <div className="hint" style={{ margin: "auto" }}>왼쪽에서 볼 정리를 선택하세요</div>
              )}
            </div>
          </div>
        </div>
      )}
      {milestone && (
        <div className="milestone-banner" onClick={() => setMilestone(null)}>
          🏅 <b>{milestone}일 연속</b> 스트릭 달성! 자소서 소재가 쌓이고 있어요 (클릭해서 닫기)
        </div>
      )}
      {levelUp && (
        <div className="levelup-modal" onClick={() => setLevelUp(null)}>
          <div className="levelup-box">
            <div className="levelup-text">LEVEL UP!</div>
            <div className="levelup-tier">
              Lv.{levelUp} · {tier}
            </div>
            <div className="hint">클릭해서 닫기</div>
          </div>
        </div>
      )}
      <aside className="sidebar">
        <div className="hud-top">
          <h1>⚔️ LIFE LOG</h1>
          <span className="level-chip">Lv.{level}</span>
        </div>
        <div className="xp-bar" title={`다음 레벨까지 ${xpToNext}일`}>
          <div className="xp-fill" style={{ width: `${xpPercent}%` }} />
        </div>
        <div className="tier-label">
          🏅 {tier}
          {nextTier && (
            <span className="tier-next">
              {" "}→ 다음 칭호 <b>{nextTier[1]}</b> (Lv.{nextTier[0]} · {(Number(nextTier[0]) - level) * 5}일 남음)
            </span>
          )}
        </div>
        <div className="week-label">{week ? `${week} · 수집 기간` : "작업 현황"}</div>
        <button className="btn" disabled={busy || running} onClick={() => trigger("fetch")}>
          {running ? "스캔 중..." : "▶ Fetch 실행"}
        </button>
        <div className={`progress-bar ${running ? "boss-active" : ""}`}>
          <div
            className="progress-fill"
            style={{ width: totalCount ? `${(doneCount / totalCount) * 100}%` : "0%" }}
          />
        </div>
        {totalCount > 0 && (
          <div className={`quest-label ${running ? "" : "clear"}`}>
            {running ? `⚔️ 던전 공략 중... ${doneCount}/${totalCount}` : doneCount === totalCount && doneCount > 0 ? "🏆 던전 클리어!" : ""}
          </div>
        )}
        <ul className="repo-list">
          {(status.repos.length ? status.repos : [])
            .slice()
            .sort((a, b) => {
              // 커밋 잡힌 repo(초록 ✓)를 맨 위로
              const score = (r) =>
                r.state === "done" && r.commits?.length > 0 ? 0 : r.state === "running" ? 1 : 2;
              return score(a) - score(b) || a.name.localeCompare(b.name);
            })
            .map((r) => (
            <li key={r.name} className="repo-item" title={r.error || ""}>
              <span className={`check ${r.state} ${r.commits?.length ? "" : "empty"}`}>
                {r.state === "done" ? "✓" : ""}
              </span>
              <span>{r.name}</span>
              <span className="commit-count">{r.commits?.length ? `${r.commits.length}` : ""}</span>
            </li>
          ))}
          {!status.repos.length && (
            <li className="hint">아직 스캔 기록이 없습니다. Fetch 실행을 눌러주세요.</li>
          )}
        </ul>

        <div className="ach-box">
          <div className="ach-head">🏆 업적 {unlockedCount}/{achievements.length}</div>
          <div className="ach-grid">
            {achievements.map((a) => (
              <span
                key={a.name}
                className={`ach-tile ${a.ok ? "unlocked" : ""}`}
                title={a.ok ? `${a.name} — ${a.desc}` : "잠금 중 — ???"}
              >
                {a.ok ? a.icon : "🔒"}
              </span>
            ))}
          </div>
        </div>
      </aside>

      <main className="main">
        <section className="calendar-section">
          <div className="calendar-box">
            <div className="calendar-head">
              <button
                className="cal-nav"
                onClick={() => setMonthOffset(monthOffset - 1)}
                aria-label="이전 달"
              >‹</button>
              <span className="cal-label">{cal.label} 업무 기록</span>
              <button
                className="cal-nav"
                onClick={() => setMonthOffset(Math.min(0, monthOffset + 1))}
                disabled={monthOffset >= 0}
                aria-label="다음 달"
              >›</button>
            </div>
            <div className="cal-grid cal-dow">
              {["월", "화", "수", "목", "금", "토", "일"].map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            <div className="cal-grid">
              {cal.cells.map((c, i) =>
                c ? (
                  <span
                    key={i}
                    className={`cal-day ${calendar[c.iso] ? `done cal-l${Math.min(4, Math.max(1, notesByDay[c.iso] || 1))}` : ""} ${c.iso === todayIso ? "today" : ""}`}
                  title={`${c.iso}${calendar[c.iso] ? ` · 메모 ${notesByDay[c.iso] || 1}건` : ""}`}
                  >
                    {c.day}
                  </span>
                ) : (
                  <span key={i} />
                )
              )}
            </div>
          </div>
          <div className="cal-stats">
            <div className="stat-item">
              <div className="stat-num"><Stat value={monthDone} /></div>
              <div className="stat-label">이번 달 기록</div>
            </div>
            <div className={`stat-item ${streakDanger ? "danger" : ""}`}>
              <div className="stat-num"><Stat value={streak} /></div>
              <div className="stat-label">{streakDanger ? "⚠️ 오늘 기록 없음!" : "연속 스트릭 🔥"}</div>
            </div>
            <div className="stat-item">
              <div className="stat-num"><Stat value={doneDays} /></div>
              <div className="stat-label">전체 누적</div>
            </div>
          </div>
        </section>

        <section className="summary-card">
          <div className="card-head">
            <h2>📝 주간 정리 생성</h2>
            <div className="head-actions">
              <button className="btn secondary small" onClick={openWeekly}>📚 지난 정리</button>
              <span className="period-chip">
              {status.period
                ? `${status.period.start.slice(5)} ~ ${status.period.end.slice(5)}`
                : "Fetch 실행 후 기간 표시"}
            </span>
            </div>
          </div>
          <p className="card-desc">
            <b>보충 메모</b>는 "오늘 뭘 왜 고치려 했는지 + 어떤 기술을 어떻게 적용했는지"를 적는 곳입니다.
            커밋은 <code>활동 근거</code>, 메모는 <code>목적·기술</code>로 LLM에 함께 전달돼요.
            생성 결과는 <code>job repo의 docs/10_주간정리/</code>에 .md로 저장·커밋돼요.
          </p>

          <ul className="memo-list">
            {!notes.length && (
              <li className="hint" style={{ listStyle: "none", marginLeft: -20 }}>
                아직 보충 메모가 없습니다. 커밋으로 안 담기는 내용(미팅·학습·의사결정)을 추가해보세요.
              </li>
            )}
            {notes.map((n, i) => (
              <li key={i} className="memo-item">
                <span className="log-time">
                  {new Date(n.at).toLocaleString("ko-KR", {
                    timeZone: "Asia/Seoul",
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                {editingAt === n.at ? (
                  <span className="memo-edit">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={2}
                      autoFocus
                    />
                    <span className="memo-edit-actions">
                      <button className="btn secondary small" onClick={() => setEditingAt(null)}>취소</button>
                      <button className="btn small" onClick={saveEdit}>저장</button>
                    </span>
                  </span>
                ) : (
                  <>
                    <span className="log-text">{n.text}</span>
                    <button className="memo-delete" onClick={() => startEdit(n)} aria-label="메모 수정">✏️</button>
                    <button
                      className="memo-delete"
                      onClick={() => deleteNote(n.at)}
                      aria-label="메모 삭제"
                    >✕</button>
                  </>
                )}
              </li>
            ))}
          </ul>

          <div className="chat-input-row" style={{ marginTop: 12 }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendNote();
                }
              }}
              placeholder="예) 랜딩이 밋밋해서 gsap 도입 — reactbits 패턴 참고해 전역 커서·히어로 그라디언트에 적용 (Enter 추가)"
              rows={2}
            />
            <button className="btn secondary" onClick={sendNote}>+ 메모 추가</button>
          </div>

          <button
            className="btn generate"
            disabled={busy || weeklyPending || weeklyRunning}
            onClick={() => trigger("generate-weekly")}
            title="마지막 정리 이후 커밋 + 위 보충 메모로 NIM이 주간 정리를 작성합니다"
          >
            {weeklyRunning
              ? `⏳ ${status.weekly.stage || "생성 중"}...`
              : weeklyPending
                ? "📡 데몬에 명령 전달됨 (최대 15초 내 시작)"
                : "이 기간 내용으로 주간 정리 생성하기 →"}
          </button>
          {(weeklyRunning || weeklyPending) && (
            <div className="hint" style={{ marginTop: 8 }}>
              데몬이 처리 중입니다. 창을 닫아도 계속 진행돼요.
            </div>
          )}
          {status.weekly?.error && !weeklyRunning && (
            <div className="error-msg" style={{ marginTop: 8 }}>생성 실패: {status.weekly.error}</div>
          )}
        </section>
      </main>

      <aside className="commits-panel">
        <h2>Git 커밋 요약</h2>
        {!commitGroups.length && <div className="hint">Fetch 실행 후 커밋 내역이 표시됩니다.</div>}
        {commitGroups.map((r) => {
          const subjects = r.commits.map((c) => c.split("|").pop());
          // conventional commit 접두어별 집계
          const types = {};
          for (const s of subjects) {
            const m = s.match(/^(feat|fix|refactor|chore|docs|test|merge|style|perf|ci)\b/i);
            const t = m ? m[1].toLowerCase() : "etc";
            types[t] = (types[t] || 0) + 1;
          }
          const summary = Object.entries(types)
            .sort((a, b) => (b[1] as number) - (a[1] as number))
            .map(([t, n]) => `${t} ${n}`)
            .join(" · ");
          const expanded = expandedRepo === r.name;
          return (
            <div key={r.name} className="commit-group">
              <button
                className="repo-summary-btn"
                onClick={() => setExpandedRepo(expanded ? null : r.name)}
              >
                <span className="repo-summary-name">
                  {expanded ? "▾" : "▸"} {r.name}
                </span>
                <span className="repo-summary-count">
                  {r.commits.length}건 · {summary}
                </span>
              </button>
              {expanded && (
                <ul>
                  {subjects.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                  <li className="more-link" onClick={() => setExpandedRepo(null)}>
                    접기
                  </li>
                </ul>
              )}
            </div>
          );
        })}
      </aside>
    </div>
  );
}
