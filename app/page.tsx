"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function authHeaders(code) {
  return { "Content-Type": "application/json", "x-access-code": code };
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
  });
  const [notes, setNotes] = useState([]);
  const [calendar, setCalendar] = useState({});
  const [monthOffset, setMonthOffset] = useState(0);
  const [expandedRepo, setExpandedRepo] = useState(null);
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
    const t = setInterval(loadStatus, 3000);
    return () => clearInterval(t);
  }, [code, loadStatus, loadNotes, loadCalendar]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [notes.length]);

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
      await fetch("/api/trigger", {
        method: "POST",
        headers: authHeaders(code),
        body: JSON.stringify({ action }),
      });
      if (action === "fetch") setTimeout(loadStatus, 1500);
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

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="hud-top">
          <h1>⚔️ LIFE LOG</h1>
          <span className="level-chip">Lv.{level}</span>
        </div>
        <div className="xp-bar" title={`다음 레벨까지 ${xpToNext}일`}>
          <div className="xp-fill" style={{ width: `${xpPercent}%` }} />
        </div>
        <div className="week-label">{week ? `${week} · 수집 기간` : "작업 현황"}</div>
        <button className="btn" disabled={busy || running} onClick={() => trigger("fetch")}>
          {running ? "스캔 중..." : "▶ Fetch 실행"}
        </button>
        <div className="progress-bar">
          <div
            className="progress-fill"
            style={{ width: totalCount ? `${(doneCount / totalCount) * 100}%` : "0%" }}
          />
        </div>
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
                    className={`cal-day ${calendar[c.iso] ? "done" : ""} ${c.iso === todayIso ? "today" : ""}`}
                    title={calendar[c.iso] ? "업무 정리 완료 ✓" : "기록 없음"}
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
              <div className="stat-num">{monthDone}</div>
              <div className="stat-label">이번 달 기록</div>
            </div>
            <div className="stat-item">
              <div className="stat-num">{streak}</div>
              <div className="stat-label">연속 스트릭 🔥</div>
            </div>
            <div className="stat-item">
              <div className="stat-num">{doneDays}</div>
              <div className="stat-label">전체 누적</div>
            </div>
          </div>
        </section>

        <section className="summary-card">
          <div className="card-head">
            <h2>📝 주간 정리 생성</h2>
            <span className="period-chip">
              {status.period
                ? `${status.period.start.slice(5)} ~ ${status.period.end.slice(5)}`
                : "Fetch 실행 후 기간 표시"}
            </span>
          </div>
          <p className="card-desc">
            <b>보충 메모</b>는 "오늘 뭘 왜 고치려 했는지 + 어떤 기술을 어떻게 적용했는지"를 적는 곳입니다.
            커밋은 <code>활동 근거</code>, 메모는 <code>목적·기술</code>로 LLM에 함께 전달돼요.
            생성 결과는 <code>~/job/docs/10_주간정리/</code>에 .md로 저장돼요.
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
                <span className="log-text">{n.text}</span>
                <button
                  className="memo-delete"
                  onClick={() => deleteNote(n.at)}
                  aria-label="메모 삭제"
                >✕</button>
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
            disabled={busy}
            onClick={() => trigger("generate-weekly")}
            title="마지막 정리 이후 커밋 + 위 보충 메모로 NIM이 주간 정리를 작성합니다"
          >
            이 기간 내용으로 주간 정리 생성하기 →
          </button>
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
