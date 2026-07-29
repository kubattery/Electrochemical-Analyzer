# HC-Analyzer — 소스 구조 안내 (개발자용)

하드카본 전기화학 데이터 분석기. 기존 단일 파일 `app.js`(약 5,300줄)를 **기능별 모듈**로 분리했습니다.
빌드 도구 없이 브라우저에서 바로 동작하는 **클래식 스크립트** 방식이며, `index.html`에 나열된
`<script>` **로딩 순서를 그대로 유지**해야 합니다. 모든 모듈은 하나의 전역(window) 스코프를
공유하므로 순서를 바꾸면 동작이 깨질 수 있습니다.

## 폴더 구조

```
index.html            진입점 (js/01~15 순서대로 로드)
style.css             전체 다크 UI 스타일
gitt.html, gitt.js    GITT 모듈 (Coming Soon, 미연결 보관)
spec_명세서.md         기능 규격서
js/                   기능별 분리 모듈 (아래 표)
```

## 모듈 맵 (로딩 순서 = 파일 번호)

| 파일 | 역할 |
| :--- | :--- |
| `js/01-core.js` | 전역 상태·유틸리티·DOM 참조, 앱 부트스트랩(DOMContentLoaded), 탭 전환 |
| `js/02-file-upload.js` | 파일 업로드(드래그&드롭/선택), 다중 파일 큐 파싱 헬퍼 |
| `js/03-analysis-controls.js` | 분석 컨트롤 패널 이벤트 바인딩, C-rate 모드 토글 |
| `js/04-database.js` | IndexedDB 데이터셋 영속화(저장/삭제/수정/로드) |
| `js/05-dataset-helpers.js` | 데이터셋 이름·색상·정규화 헬퍼, 인라인 편집/이름변경 |
| `js/06-demo-update.js` | 데모 데이터 생성, 데이터 업데이트/실패 시뮬레이션 |
| `js/07-projects.js` | 프로젝트 관리(추가/수정/전환) |
| `js/08-library-table.js` | 라이브러리 테이블 렌더링, 컨텍스트 메뉴, 필터 칩 |
| `js/09-dataset-library.js` | 데이터셋 라이브러리(이름 모달/활성 전환/삭제/사이드바 렌더) |
| `js/10-data-processing.js` | 원시 데이터 파싱(Excel/텍스트), 사이클 분리, `processData` |
| `js/11-analysis-metrics.js` | 핵심 분석 연산 — ICE·Slope/Plateau·Rate 지표 테이블 |
| `js/12-dqdv.js` | dQ/dV 미분용량 분석, 차트, 사이클 선택 |
| `js/13-charts.js` | 차트 렌더링(전압 프로파일 / Slope-Plateau / Rate) |
| `js/14-export.js` | 이미지(PNG)·Excel/CSV 내보내기 |
| `js/15-profile-cycles.js` | 분석 모드 설정, 전압 프로파일 사이클 다중 선택 UI |

## 협업 시 주의사항

1. **로딩 순서 고정**: 새 모듈을 추가할 때는 `index.html`의 `<script>` 목록에도 순서를 지켜 추가하세요.
2. **전역 공유**: 함수·전역 변수 이름이 모듈 간에 겹치지 않도록 하세요(같은 전역 스코프 공유).
3. **한 파일 = 한 기능**: 되도록 담당 기능 파일 안에서만 작업하면 충돌(merge conflict)이 줄어듭니다.
4. `app.js`(원본)는 백업용으로 남겨둘 수 있으나, 현재 `index.html`은 참조하지 않습니다.
   분리 버전이 정상 동작하는 것을 확인한 뒤 삭제해도 됩니다.

> 분리 방식은 원본 코드를 순서 그대로 잘라 재배치했을 뿐이라, 15개 파일을 순서대로 합치면
> 원본 `app.js`와 바이트 단위로 완전히 동일합니다(동작 변화 없음).
