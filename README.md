# ESMPL-Analyzer — 이차전지 소재 전기화학 데이터 분석 웹앱

충·방전 데이터와 CV(순환전압전류법) 데이터를 브라우저에서 즉시 파싱·연산·시각화하는 **클라이언트 사이드 정적 웹 애플리케이션**입니다. 서버 통신 없이 브라우저 메모리에서만 동작하므로 연구 데이터가 외부로 나가지 않습니다.

라이브: `https://kubattery.github.io/Electrochemical-Analyzer/`

주요 분석: 초기 용량·ICE, Slope/Plateau 분율, Rate Capability(율속), dQ/dV, 그리고 CV(I–V 곡선·산화/환원 피크). Chart.js 기반 시각화에 확대(줌) 기능을 지원합니다.

## 아키텍처

빌드 도구 없이 브라우저에서 바로 도는 **클래식 스크립트** 방식입니다. 원래 한 파일이던 `app.js`(약 5,300줄)를 기능별로 나눴으며, 모든 모듈은 하나의 전역(window) 스코프를 공유합니다. 따라서 `index.html`에 나열된 `<script>` **로딩 순서(01 → 20)를 반드시 유지**해야 하며, 순서를 바꾸면 동작이 깨질 수 있습니다.

대용량 엑셀 파싱은 별도의 **Web Worker**(`js/xlsx-worker.js`)에서 백그라운드로 수행해, 수십만 행짜리 파일을 여러 개 올려도 화면이 멈추거나 "응답 없음"으로 강제 종료되지 않습니다.

## 폴더 구조

```
index.html            진입점. js/01~20을 순서대로 로드하고 차트 줌을 전역 설정
style.css             전체 다크 UI 스타일
ai-report.html        AI 소재 해석 팝업 창 (독립 페이지 · Claude API를 브라우저에서 직접 호출)
gitt.html, gitt.js    GITT 분석 모듈 (Coming Soon · 미연결 보관)
spec_명세서.md         기능 규격서 (분석 로직·계산식 정의)
js/                   기능별 분리 모듈 + 백그라운드 워커 (아래 표)
```

## 모듈 맵 (로딩 순서 = 파일 번호)

| 파일 | 역할 |
| :--- | :--- |
| `js/01-core.js` | 전역 상태·유틸리티·DOM 참조, 앱 부트스트랩(DOMContentLoaded), 탭 전환 |
| `js/02-file-upload.js` | 파일 업로드(드래그&드롭/선택), 다중 파일 큐. 엑셀은 Web Worker로 파싱(실패 시 메인 스레드 폴백), 텍스트(csv/txt) 파싱 |
| `js/03-analysis-controls.js` | 분석 컨트롤 패널 이벤트 바인딩, C-rate(율속) 모드 토글 |
| `js/04-database.js` | IndexedDB 기반 데이터셋 영속화(저장/삭제/수정/로드) |
| `js/05-dataset-helpers.js` | 데이터셋 이름·색상·정규화 헬퍼, 인라인 편집/이름 변경 |
| `js/06-demo-update.js` | 데모 데이터 생성, 데이터 업데이트/실패 시뮬레이션 |
| `js/07-projects.js` | 프로젝트 관리(추가/수정/전환) |
| `js/08-library-table.js` | 라이브러리 테이블 렌더링, 컨텍스트 메뉴, 필터 칩 |
| `js/09-dataset-library.js` | 데이터셋 라이브러리(이름 모달/활성 전환/삭제/사이드바 렌더) |
| `js/10-data-processing.js` | 원시 데이터 파싱(Excel/텍스트)·사이클 자동 분리·`processData`. 초대용량 파일의 포인트를 조기·저장 단계에서 축소해 Out-of-memory 방지 |
| `js/11-analysis-metrics.js` | 핵심 분석 연산 — ICE, Slope/Plateau 분율, Rate 지표 및 결과 테이블 |
| `js/12-dqdv.js` | dQ/dV(미분 용량) 분석·차트·사이클 선택 |
| `js/13-charts.js` | 차트 렌더링(전압 프로파일 / Slope-Plateau / Rate) 및 대용량 다운샘플링 |
| `js/14-export.js` | 이미지(PNG)·Excel/CSV 내보내기 |
| `js/15-profile-cycles.js` | 분석 모드 설정, 전압 프로파일 사이클 다중 선택 UI |
| `js/16-combined-view.js` | **그래프 한눈에 보기(통합 뷰)** — 전압 프로파일·Slope-Plateau·Rate·dQ/dV 등 여러 분석 차트를 체크박스로 골라 한 화면에 모아 표시. 개별 탭 차트와 충돌하지 않도록 별도 Chart 인스턴스 관리(체크 해제 시 해당 차트 제거) |
| `js/17-cv.js` | **CV(순환전압전류법) 분석** — CV 탭 전용 업로드, 전압 스윕 기반 사이클 분리, I-V 곡선 렌더, 산화/환원 피크 전압 자동 검출 (기존 충방전 코드와 독립) |
| `js/18-cyclability.js` | **Cyclability(장기 수명) 탭** — 사이클 경과에 따른 가역 용량·쿨롱 효율 추이 |
| `js/19-experiment-detector.js` | 실험 종류(rate / cycle) 자동 판별 — 전류 레벨 감지 기반. **13, 18보다 먼저 로드해야 함** (index.html에서 12 다음에 위치) |
| `js/20-ai-report.js` | **AI 소재 해석 연동** — 현재 분석 결과 스냅샷을 만들어 팝업 창 `ai-report.html`로 postMessage 전달. API 호출은 하지 않음 |
| `js/xlsx-worker.js` | **백그라운드 Web Worker** — 엑셀(XLSX) 파싱을 별도 스레드에서 수행하여 대용량 파일의 처리 지연·메모리 부족·"Script timeout"을 방지. `<script>`로 로드하지 않고 코드에서 `new Worker(...)`로 실행됨 |

`index.html`은 위 모듈 로딩에 더해, 모든 Chart.js 차트에 **확대(줌) 기능**(마우스 휠 확대/축소 · 드래그 이동 · 더블클릭 원복)을 전역으로 적용하는 스크립트를 포함합니다.

## 핵심 기능 요약

- **다중 파일 업로드 & 라이브러리**: 여러 파일을 한 번에 올려 파싱하고, IndexedDB에 데이터셋으로 저장·관리(프로젝트·샘플·실험 타입별 분류, 검색·필터).
- **충방전 분석**: 초기 용량·ICE, Slope/Plateau 분율, Rate Capability, dQ/dV를 자동 계산하고 개요·전압 프로파일 등 탭으로 시각화. 여러 데이터셋 겹쳐 비교 지원.
- **그래프 한눈에 보기(통합 뷰)**: 전압 프로파일·Slope-Plateau·Rate·dQ/dV를 체크박스로 골라 한 화면에 나란히 모아 봅니다.
- **CV 분석**: 전압/전류 CV 파일을 업로드하면 스윕을 사이클로 나눠 I-V 루프를 그리고, 사이클 드롭다운으로 선택, 산화(anodic)·환원(cathodic) 피크 전압을 자동 표기(민감도 조절 가능).
- **차트 확대**: 모든 그래프에서 휠 확대/축소, 드래그 이동, 더블클릭 원복.
- **내보내기**: 차트 PNG, 요약 수치 CSV/Excel.
- **성능**: 수십만 행 대용량 엑셀도 백그라운드 워커 + 포인트 축소로 안정 처리.

## 배포 (GitHub Pages)

`index.html`이 저장소 루트에 있고, Settings → Pages에서 `main` 브랜치 / 루트로 배포합니다.

**캐시 주의**: 코드를 수정한 뒤에는 브라우저·CDN 캐시 때문에 예전 파일이 보일 수 있습니다. `index.html`의 `<script src="js/NN.js?v=버전">`에서 **버전 숫자를 올려** 새로 받게 하고, 확인 시 **Ctrl+Shift+R**(강력 새로고침)을 사용하세요.

## 협업 시 주의사항

1. **로딩 순서 고정**: 새 모듈을 추가하면 `index.html`의 `<script>` 목록에도 순서를 지켜 넣습니다.
2. **전역 공유**: 함수·전역 변수 이름이 모듈 간에 겹치지 않도록 합니다(같은 전역 스코프 공유).
3. **한 파일 = 한 기능**: 담당 기능 파일 안에서만 작업하면 병합 충돌이 줄어듭니다.
4. **캐시 버전 갱신**: 파일을 바꿀 때마다 `index.html`의 해당 `?v=` 버전을 올립니다. 워커(`xlsx-worker.js`)를 바꾼 경우, 코드 안의 `new Worker('js/xlsx-worker.js?v=...')` 버전도 함께 올려야 새 워커가 로드됩니다.
