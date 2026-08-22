// GitHub Contents API 헬퍼 (private repo의 data/ 파일 읽기·쓰기)
const REPO = process.env.GITHUB_REPO; // 예: Jacob-9909/life-log
const TOKEN = process.env.GITHUB_TOKEN;
const BRANCH = process.env.GITHUB_BRANCH || "main";
const API = "https://api.github.com";

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    ...extra,
  };
}

export async function getContent(path) {
  const res = await fetch(`${API}/repos/${REPO}/contents/${path}?ref=${BRANCH}`, {
    headers: headers(),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
  const json = await res.json();
  return { sha: json.sha, content: JSON.parse(Buffer.from(json.content, "base64").toString("utf8")) };
}

export async function putContent(path, content, message) {
  const existing = await getContent(path);
  const body = {
    message,
    branch: BRANCH,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
    ...(existing ? { sha: existing.sha } : {}),
  };
  const res = await fetch(`${API}/repos/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
