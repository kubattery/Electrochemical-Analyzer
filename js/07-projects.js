/* ============================================================================
 * HC-Analyzer  ·  07-projects.js
 * 역할: 프로젝트 관리(추가/수정/전환)
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 07/15  (이전: js/06-demo-update.js → 다음: js/08-library-table.js)
 * ============================================================================ */
/**
 * 프로젝트 관리 select 옵션 동적 구성 및 관리
 * (사이드바의 프로젝트 선택 UI는 제거되었고, 라이브러리 탭의 프로젝트 필터만 유지)
 */
function initProjectManagement() {
    const filterSelect = document.getElementById('libTabProjectFilter');
    if (!filterSelect) return;

    filterSelect.innerHTML = '<option value="all">모든 프로젝트</option>';
    projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        filterSelect.appendChild(opt);
    });
}

