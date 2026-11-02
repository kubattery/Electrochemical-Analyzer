# 연구실 내부 서버

웹사이트와 AI 중계를 **한 서버에서** 돌립니다.

```
http://localhost:8080/          분석기 웹사이트
http://localhost:8080/api/ai    AI 중계 (해석 창이 부르는 곳)
```

## 왜 이 구성인가

- **같은 출처**에서 서비스되므로 CORS·오리진 설정으로 씨름할 일이 없습니다.
- **구독 CLI를 그대로 쓸 수 있습니다.** API 키를 사지 않아도 됩니다.
- 키 방식을 쓸 때도 **실행 지역이 연구실 네트워크**입니다. Cloudflare가 홍콩에서
  실행해 Gemini가 지역 제한으로 거부하던 문제가 사라집니다.
- 분석 데이터가 외부로 나가는 경로는 AI 호출 하나뿐이고, 그 내용은 해석 창의
  전송 내용 미리보기에서 그대로 확인할 수 있습니다.

## AI 방식 두 가지

### (1) 구독 CLI 중계 — 혼자 쓸 때

로컬에 로그인된 CLI에 질문을 넘기고 답을 받아옵니다. **추가 비용이 없습니다.**

```
웹 채팅 → /api/ai → claude -p (또는 codex exec) → 답변 → 웹 채팅
```

두 CLI 모두 비대화형 실행을 공식 기능으로 제공합니다. 본인이 본인 기기에서
본인 구독으로 본인 질문을 넘기는 것이므로 우회가 아니라 설계된 사용법입니다.

**다만 혼자 쓸 때만입니다.** 좌석 하나를 여러 사람의 요청을 받는 공용 중계로
돌리는 것은 구독의 용도가 아닙니다. 그래서 CLI 모드에서는 서버가 `127.0.0.1`에만
붙어 다른 PC에서 닿지 않습니다. 글로만 적지 않고 동작으로 묶어 둔 것입니다.
`ALLOW_LAN=1`로 풀 수는 있게 두었지만 그때는 본인 판단입니다.

| | 설치 | 로그인 | 환경변수 |
| --- | --- | --- | --- |
| Claude | `npm i -g @anthropic-ai/claude-code` | `claude` 실행 후 안내대로 | `AI_CLI=claude` |
| Codex | `npm i -g @openai/codex` | `codex login` | `AI_CLI=codex` |

### (2) API 키 — 여러 사람이 쓰거나 상시 열어 둘 때

| 제공자 | 환경변수 | 비용 |
| --- | --- | --- |
| Google Gemini | `GEMINI_API_KEY` | **무료 등급 있음** (카드 등록 불필요) |
| OpenAI | `OPENAI_API_KEY` | 유료 |
| Anthropic | `ANTHROPIC_API_KEY` | 유료 |

키 모드는 `0.0.0.0`에 붙어 같은 네트워크의 다른 PC에서도 접속됩니다.

## 실행

Node.js만 있으면 됩니다. 설치할 패키지가 없습니다.

```powershell
# Windows PowerShell — 구독 CLI
cd $env:USERPROFILE\Documents\Electrochemical-Analyzer
$env:AI_CLI="claude"
node server/local/server.js
```

```powershell
# Windows PowerShell — API 키
$env:GEMINI_API_KEY="여기에 키"
node server/local/server.js
```

```bash
# Linux / Mac
AI_CLI=claude node server/local/server.js
```

뜨는 주소로 접속하면 됩니다. 시작 배너가 어떤 방식으로 동작 중인지, 어느 PC에서
접속되는지 알려 줍니다.

## 해석 창 설정

이 서버에서 웹사이트를 열었다면 **서버 설정**에 짧게 적습니다.

```
/api/ai
```

GitHub Pages에서 열었다면 전체 주소가 필요합니다. 다만 CLI 모드는 `127.0.0.1`에만
붙어 있어 이 조합이 되지 않습니다. **이 서버에서 웹사이트를 함께 여십시오.**

## 설정값

| 환경변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `AI_CLI` | (없음) | `claude` 또는 `codex`. 지정하면 CLI 중계를 씁니다 |
| `AI_CLI_PATH` | PATH에서 찾음 | CLI 실행파일 경로를 직접 지정 |
| `AI_CLI_ARGS` | CLI별 기본값 | CLI 플래그를 덮어씁니다 (아래 참고) |
| `CLI_TIMEOUT_MS` | `180000` | CLI 응답 대기 한도 |
| `PORT` | `8080` | 포트 |
| `ALLOW_LAN` | (없음) | `1`이면 CLI 모드에서도 LAN에 엽니다 |
| `MODEL` | CLI 기본값 | 모델 지정 |

## 문제가 생기면

| 증상 | 원인과 조치 |
| --- | --- |
| 배너에 `준비 안 됨` | CLI가 설치되지 않았거나 PATH에 없습니다. 위 표의 설치 명령을 쓰거나 `AI_CLI_PATH`로 경로를 직접 지정하십시오 |
| `180초 안에 오지 않아 중단` | 로그인이 만료되어 CLI가 입력을 기다리는 중일 수 있습니다. 터미널에서 `claude`(또는 `codex`)를 한 번 실행해 확인하십시오 |
| `빈 답을 돌려주었습니다` | CLI 출력 형식이 바뀐 경우입니다. `AI_CLI_ARGS`로 플래그를 조정할 수 있습니다 |
| 다른 PC에서 접속 안 됨 | CLI 모드는 의도적으로 이 PC에만 열립니다. 여러 사람이 쓰려면 API 키 방식을 쓰십시오 |
| 응답이 느림 | CLI는 API보다 느립니다. 해석 창이 경과 초를 표시하므로 멈춘 것과 구분됩니다 |

CLI 플래그가 업데이트로 바뀌면 코드를 고치지 않고 덮어쓸 수 있습니다.

```powershell
$env:AI_CLI_ARGS="-p --output-format text"
```

## 왜 느린가

CLI는 한 번 부를 때마다 프로세스를 새로 띄우고 인증을 확인합니다. 그래서 질문당
수십 초가 걸립니다. 또 CLI 한 번 실행은 한 번의 질문이라 대화가 이어지지 않으므로,
서버가 지금까지의 대화를 글로 풀어 매번 함께 넘깁니다. 대화가 길어지면 그만큼
넘기는 양도 늘어납니다. 빠른 응답이 필요하면 API 키 방식이 낫습니다.

## 안전장치

- 프롬프트는 **stdin으로만** 넘어갑니다. 명령줄에 닿지 않으므로 `&`, `|`, 따옴표가
  섞인 질문을 해도 명령으로 실행될 여지가 없습니다.
- 명령줄에 실리는 값은 설정에서 온 것뿐이고, 글자 종류를 좁게 검사합니다.
- 응답이 없으면 프로세스를 트리째 정리합니다. 남은 프로세스가 쌓이지 않습니다.
- 동시 호출은 줄을 세워 하나씩 처리합니다.
- 저장소 루트 밖 파일 요청은 403으로 막습니다.

## 점검

```bash
curl -X POST http://localhost:8080/api/ai -H "Content-Type: application/json" -d "{\"system\":\"한 문장만 답하십시오.\",\"messages\":[{\"role\":\"user\",\"content\":\"연결 확인\"}]}"
```

`text`가 담긴 JSON이 돌아오면 정상입니다. 실패하면 `error`에 사유가 담깁니다.

## 항상 켜 두려면

Windows 작업 스케줄러나 Linux systemd로 등록하면 재부팅 후에도 자동으로 뜹니다.
필요하시면 설정 파일을 만들어 드리겠습니다.
