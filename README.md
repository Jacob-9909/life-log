# life-log — 주간 업무 정리 대시보드

`~/Develop` 아래 로컬 git 저장소들의 이번 주 커밋을 수집하고, 채팅형 업무 메모와 합쳐
`~/job/docs/10_주간정리/YYYY-WW.md` 로 저장하는 개인 대시보드. (Vercel + private GitHub repo + 로컬 데몬)

## 구조

```
브라우저 (Vercel)
  ├─ 좌측: repo 체크리스트 — Fetch 실행 버튼 → repo마다 순차적으로 ✓ 초록 체크
  │        └ 월간 달력: 그날 업무 정리를 했는지 하루하루 체크 (기록 없는 날 = 회색)
  ├─ 중앙: 채팅형 업무 메모 입력
  └─ 우측: 이번 주 Git 커밋 요약
        │
        ▼ GitHub API (data/*.json)
private repo (명령/상태/메모/달력 버스)
        │
로컬 데몬 (launchd, 15초 폴링)
  ├─ action=fetch          → ~/Develop 전체 git fetch --all + 커밋 수집 → status.json 순차 push
  ├─ action=generate-weekly → 커밋+메모 합쳐 ~/job/docs/10_주간정리/ 에 .md 생성
  └─ 시작 시               → 기존 docs/09_업무일지 파일을 읽어 달력 과거 기록 시드
```

## 배포 순서

1. **GitHub private repo 생성 & push**
   ```bash
   cd ~/Develop/life-log
   gh repo create life-log --private --source=. --push
   ```

2. **Fine-grained 토큰 발급** (https://github.com/settings/personal-access-tokens)
   - 권한: `life-log` repo에 대해 Contents: Read and write

3. **Vercel 배포** (https://vercel.com/new → repo import)
   환경변수:
   | 변수 | 값 |
   |---|---|
   | `GITHUB_REPO` | `Jacob-9909/life-log` |
   | `GITHUB_TOKEN` | 위에서 발급한 토큰 |
   | `ACCESS_CODE` | 페이지 접속용 비밀 코드 (아무 문자열) |

4. **로컬 데몬 설치**
   ```bash
   cd ~/Develop/life-log
   ./scripts/install-daemon.sh Jacob-9909/life-log
   ```
   - 토큰은 생략하면 `gh auth token`을 사용
   - 중지: `launchctl unload ~/Library/LaunchAgents/com.jacob.life-log.daemon.plist`
   - 로그: `daemon/logs/`

## 사용 흐름

1. 대시보드 접속 → 접근 코드 입력 (localStorage 저장, 이후 자동)
2. **Fetch 실행** 클릭 → 데몬이 18개 repo를 순서대로 fetch → 왼쪽 체크가 하나씩 초록으로
3. 가운데 채팅창에 이번 주에 한 일을 적으면 저장되고, 그날 날짜가 달력에 자동 체크
4. **주간 정리 생성** 클릭 → 데몬이 메모+커밋을 합쳐 `~/job/docs/10_주간정리/2026-W34.md` 생성

## 데이터 파일 (repo의 data/ 디렉터리)

| 파일 | 역할 |
|---|---|
| `command.json` | 웹 → 데몬 명령 (`fetch` / `generate-weekly`) |
| `status.json` | 데몬 → 웹 스캔 상태 (repo별 state + 커밋 목록) |
| `notes/<week>.json` | 채팅 업무 메모 |
| `calendar.json` | 날짜별 업무 정리 완료 체크 |
