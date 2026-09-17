# Claude 중계 서버 배포 안내

AI 소재 해석 창의 대화 기능은 이 서버를 거쳐 Claude 를 호출합니다.
API 키는 이 서버에만 두고, 브라우저에는 서버 주소만 넣습니다.
연구실 구성원은 각자 키를 발급받을 필요가 없습니다.

## 준비

1. Cloudflare 계정 (무료 플랜으로 충분합니다)
2. Anthropic API 키 — https://console.anthropic.com 에서 발급하고 크레딧을 충전합니다.
   ChatGPT 나 Claude 구독과는 별개 상품이며, 구독만으로는 API 를 호출할 수 없습니다.
3. Node.js (이미 설치되어 있습니다)

## 배포

```bash
cd server
npm install @anthropic-ai/sdk
npm install --save-dev wrangler

npx wrangler login              # 브라우저가 열리면 Cloudflare 로 로그인
npx wrangler secret put ANTHROPIC_API_KEY   # 키를 붙여넣습니다. 화면에 저장되지 않습니다.
npx wrangler deploy
```

배포가 끝나면 `https://esmpl-claude-proxy.<계정이름>.workers.dev` 같은 주소가 출력됩니다.
이 주소를 AI 소재 해석 창의 **서버 주소** 칸에 넣으면 대화가 동작합니다.

## 접근 제한

`wrangler.toml` 의 `ALLOWED_ORIGINS` 에 적힌 주소에서만 호출을 받습니다.
기본값은 `https://kubattery.github.io` 입니다. 배포 주소가 바뀌거나 로컬에서
시험할 주소를 추가하려면 쉼표로 이어 적고 다시 배포하십시오.

```toml
ALLOWED_ORIGINS = "https://kubattery.github.io,http://localhost:8080"
```

이 제한이 없으면 서버 주소를 아는 누구나 이 키로 비용을 쓸 수 있습니다.
주소를 외부에 공개하지 마십시오.

## 비용

요청마다 사용량이 응답에 함께 돌아오며, 해석 창 하단에 표시됩니다.
Cloudflare 무료 플랜은 하루 10만 요청까지 처리하므로 연구실 규모에서는
Worker 자체 비용은 들지 않습니다. 비용은 Anthropic API 사용량에서만 발생합니다.
사용량과 한도는 https://console.anthropic.com 의 Usage 에서 확인하십시오.

## 모델 변경

`wrangler.toml` 의 `MODEL` 주석을 풀고 값을 넣은 뒤 다시 배포하면 됩니다.
비우면 `worker.js` 의 기본값(`claude-opus-5`)을 씁니다.

## 점검

```bash
curl -X POST https://<배포주소> \
  -H "Content-Type: application/json" \
  -H "Origin: https://kubattery.github.io" \
  -d '{"system":"한국어로 한 문장만 답하십시오.","messages":[{"role":"user","content":"연결 확인"}]}'
```

`text` 필드가 담긴 JSON 이 돌아오면 정상입니다.
`403` 이면 Origin 이 허용 목록에 없는 것이고, `500` 이면 키가 설정되지 않은 것입니다.
