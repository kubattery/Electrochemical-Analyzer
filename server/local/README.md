# 연구실 내부 서버

웹사이트와 AI 중계를 **한 서버에서** 돌립니다.

```
http://<서버주소>:8080/          분석기 웹사이트
http://<서버주소>:8080/api/ai    AI 중계 (해석 창이 부르는 곳)
```

## 왜 이 구성인가

- **같은 출처**에서 서비스되므로 CORS·오리진 설정으로 씨름할 일이 없습니다.
- **실행 지역이 연구실 네트워크**입니다. Cloudflare 가 홍콩에서 실행해 Gemini 가
  지역 제한으로 거부하던 문제가 사라집니다. 한국에서는 Gemini 무료 등급을 쓸 수 있습니다.
- 키는 **서버 환경변수에만** 둡니다. 연구실 구성원은 주소만 알면 됩니다.
- 분석 데이터가 외부로 나가는 경로는 AI 호출 하나뿐이고, 그 내용은 해석 창의
  전송 내용 미리보기에서 그대로 확인할 수 있습니다.

## 구독 계정은 쓸 수 없습니다

Codex CLI 나 Claude Code 를 이 서버에 로그인해 두고 호출을 대신 시키는 구성은
만들지 않았습니다. 구독은 본인이 대화형으로 쓰라고 주는 좌석이고, 그것을 여러
사람의 요청을 처리하는 백엔드로 돌리면 API 과금을 우회하는 형태가 됩니다.
계정 제한을 받을 수 있고, CLI 업데이트나 인증 만료 때마다 끊깁니다.

아래 제공자 중 하나의 **API 키**를 씁니다. Gemini 는 무료 등급이 있습니다.

| 제공자 | 환경변수 | 비용 |
| --- | --- | --- |
| Google Gemini | `GEMINI_API_KEY` | **무료 등급 있음** (카드 등록 불필요) |
| OpenAI | `OPENAI_API_KEY` | 유료 |
| Anthropic | `ANTHROPIC_API_KEY` | 유료 |

## 실행

Node.js 만 있으면 됩니다. 설치할 패키지가 없습니다.

```powershell
# Windows PowerShell
cd $env:USERPROFILE\Documents\Electrochemical-Analyzer
$env:GEMINI_API_KEY="여기에 키"
node server/local/server.js
```

```bash
# Linux / Mac
cd ~/Electrochemical-Analyzer
GEMINI_API_KEY="여기에 키" node server/local/server.js
```

뜨는 주소로 접속하면 됩니다. 포트를 바꾸려면 `PORT=9000` 을 함께 지정합니다.

## 해석 창 설정

웹사이트를 이 서버에서 열었다면 **서버 설정**에 짧게 적어도 됩니다.

```
/api/ai
```

GitHub Pages 에서 열었다면 전체 주소를 적습니다.

```
http://<서버IP>:8080/api/ai
```

> 이때는 서로 다른 출처라 브라우저가 막을 수 있습니다. 같은 서버에서 웹사이트를
> 함께 여는 쪽을 권합니다.

## 다른 PC 에서 접속

같은 연구실 네트워크 안에서는 서버의 IP 로 접속하면 됩니다.

```powershell
ipconfig    # IPv4 주소 확인
```

방화벽에서 해당 포트를 열어야 할 수 있습니다. **외부 인터넷에 직접 노출하지 마십시오.**
이 서버에는 인증이 없어서 주소를 아는 누구나 연구실 키로 비용을 쓸 수 있습니다.

## 항상 켜 두려면

Windows 작업 스케줄러나 Linux systemd 로 등록하면 재부팅 후에도 자동으로 뜹니다.
필요하시면 설정 파일을 만들어 드리겠습니다.

## 점검

```bash
curl -X POST http://localhost:8080/api/ai \
  -H "Content-Type: application/json" \
  -d "{\"system\":\"한 문장만 답하십시오.\",\"messages\":[{\"role\":\"user\",\"content\":\"연결 확인\"}]}"
```

`text` 와 `provider` 가 담긴 JSON 이 돌아오면 정상입니다.

| 응답 | 뜻 |
| --- | --- |
| 500 | 키가 환경변수에 없습니다 |
| 502 | 제공자 API 가 오류를 돌려주었습니다. 메시지에 사유가 담깁니다 |
| 403 | 저장소 밖 파일을 요청했습니다 |
