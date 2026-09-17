# AI 중계 서버 배포 안내

AI 소재 해석 창의 대화 기능은 이 서버를 거쳐 AI 를 호출합니다.
API 키는 이 서버에만 두고, 브라우저에는 서버 주소만 넣습니다.
연구실 구성원은 각자 키를 발급받을 필요가 없습니다.

## 먼저 알아 둘 것

**구독과 API 는 별개 상품입니다.** Claude Pro 나 ChatGPT Plus 를 결제하고 있어도
프로그램이 호출할 수 있는 창구는 포함되지 않습니다. 아래 셋 중 하나의 API 키가 필요합니다.

| 제공자 | 환경변수 | 비용 | 비고 |
| --- | --- | --- | --- |
| Google Gemini | `GEMINI_API_KEY` | **무료 등급 있음** | 카드 등록 없이 발급. 호출 횟수 제한이 있습니다. |
| Anthropic Claude | `ANTHROPIC_API_KEY` | 유료 | 신규 계정에 무료 크레딧이 있을 수 있습니다. |
| OpenAI GPT | `OPENAI_API_KEY` | 유료 | ChatGPT 구독과 별개로 크레딧을 충전해야 합니다. |

키를 하나만 넣으면 그 제공자로 동작합니다. 여러 개를 넣었다면 위 표의 순서가 아니라
`ANTHROPIC` → `GEMINI` → `OPENAI` 순으로 찾으며, `PROVIDER` 변수로 직접 지정할 수 있습니다.

## 키 발급

**Gemini (무료로 시작하려면 이쪽)**
1. https://aistudio.google.com/apikey 접속
2. Google 계정으로 로그인 후 `Create API key`
3. 카드 등록 없이 키가 바로 나옵니다

**Claude** — https://console.anthropic.com → API keys (크레딧 충전 필요)
**GPT** — https://platform.openai.com → API keys (크레딧 충전 필요)

## 배포

```bash
cd server
npm install @anthropic-ai/sdk
npm install --save-dev wrangler

npx wrangler login                        # 브라우저에서 Cloudflare 로그인
npx wrangler secret put GEMINI_API_KEY    # 쓰려는 제공자의 키 하나만 넣습니다
npx wrangler deploy
```

배포가 끝나면 `https://esmpl-ai-proxy.<계정이름>.workers.dev` 같은 주소가 출력됩니다.
이 주소를 AI 소재 해석 창의 **서버 설정** 칸에 넣고 **연결 확인**을 누르면 됩니다.

> `@anthropic-ai/sdk` 는 Gemini 나 GPT 만 쓸 때도 설치해야 합니다.
> worker.js 가 Anthropic 오류 형을 판별하는 데 쓰기 때문입니다.

## 모델 바꾸기

`wrangler.toml` 의 `MODEL` 주석을 풀고 값을 넣은 뒤 다시 배포합니다.
비우면 제공자별 기본값을 씁니다.

| 제공자 | 기본 모델 | 값싼 대안 |
| --- | --- | --- |
| Gemini | `gemini-flash-latest` | (무료 등급 내에서 사용) |
| Claude | `claude-opus-5` | `claude-sonnet-5`, `claude-haiku-4-5` |
| OpenAI | `gpt-4o` | `gpt-4o-mini` |

## 접근 제한

`wrangler.toml` 의 `ALLOWED_ORIGINS` 에 적힌 주소에서만 호출을 받습니다.
기본값은 `https://kubattery.github.io` 입니다. 주소가 바뀌거나 로컬에서 시험할
주소를 추가하려면 쉼표로 이어 적고 다시 배포하십시오.

```toml
ALLOWED_ORIGINS = "https://kubattery.github.io,http://localhost:8080"
```

이 제한이 없으면 서버 주소를 아는 누구나 이 키로 비용을 쓸 수 있습니다.
주소를 외부에 공개하지 마십시오.

## 점검

```bash
curl -X POST https://<배포주소> \
  -H "Content-Type: application/json" \
  -H "Origin: https://kubattery.github.io" \
  -d "{\"system\":\"한국어로 한 문장만 답하십시오.\",\"messages\":[{\"role\":\"user\",\"content\":\"연결 확인\"}]}"
```

`text` 와 `provider` 가 담긴 JSON 이 돌아오면 정상입니다.

| 응답 | 뜻 |
| --- | --- |
| 403 | Origin 이 허용 목록에 없습니다 |
| 500 | 키가 설정되지 않았습니다 |
| 429 | 호출 한도에 걸렸습니다 (Gemini 무료 등급에서 자주 만납니다) |
| 502 | 제공자 API 가 오류를 돌려주었습니다. 메시지에 사유가 담깁니다 |

## 비용

요청마다 사용량이 응답에 함께 돌아오며 해석 창 하단에 표시됩니다.
Cloudflare 무료 플랜은 하루 10만 요청까지 처리하므로 Worker 자체 비용은 들지 않습니다.
비용은 제공자 API 사용량에서만 발생하며, Gemini 무료 등급을 쓰면 0 원입니다.
