// KST 기준 이번 주(월요일 시작)의 키와 시작 시각을 계산
export function weekKeyKST(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = kst.getUTCDay(); // 0=일
  const monday = new Date(kst);
  monday.setUTCDate(kst.getUTCDate() - ((day + 6) % 7));
  const y = monday.getUTCFullYear();
  const onejan = new Date(Date.UTC(y, 0, 1));
  const week = Math.ceil(((Number(monday) - Number(onejan)) / 86400000 + onejan.getUTCDay() + 1) / 7);
  const ww = String(week).padStart(2, "0");
  return { key: `${y}-W${ww}`, mondayISO: `${y}-${String(monday.getUTCMonth() + 1).padStart(2, "0")}-${String(monday.getUTCDate()).padStart(2, "0")}` };
}

// 오늘 날짜(KST)를 YYYY-MM-DD로 반환
export function todayKST(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
