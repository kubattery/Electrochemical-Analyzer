/* ============================================================================
 * HC-Analyzer  ·  04-database.js
 * 역할: IndexedDB 데이터셋 영속화(저장/삭제/수정/로드)
 *
 * [주의] 클래식 스크립트 방식입니다. 모든 모듈이 하나의 전역(window) 스코프를
 *        공유하므로 index.html에 명시된 <script> 로딩 순서를 반드시 유지하세요.
 *        로딩 순서: 04/15  (이전: js/03-analysis-controls.js → 다음: js/05-dataset-helpers.js)
 * ============================================================================ */
// ============================================================
// IndexedDB 데이터 영속성 관리
// ============================================================
const DB_NAME = 'HCAnalyzerDB';
const DB_VERSION = 1;
const STORE_NAME = 'datasets';

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        
        request.onsuccess = (e) => {
            resolve(e.target.result);
        };
        
        request.onerror = (e) => {
            console.error('IndexedDB open error:', e.target.error);
            reject(e.target.error);
        };
    });
}

async function saveDatasetToDB(dataset) {
    try {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.put(dataset);
            
            request.onsuccess = () => resolve(true);
            request.onerror = (e) => reject(e.target.error);
        });
    } catch (err) {
        console.error('DB Save failed:', err);
    }
}

async function deleteDatasetFromDB(id) {
    try {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.delete(id);
            
            request.onsuccess = () => resolve(true);
            request.onerror = (e) => reject(e.target.error);
        });
    } catch (err) {
        console.error('DB Delete failed:', err);
    }
}

async function updateDatasetInDB(dataset) {
    return saveDatasetToDB(dataset);
}

async function loadDatasetsFromDB() {
    try {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.getAll();
            
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (e) => reject(e.target.error);
        });
    } catch (err) {
        console.error('DB Load failed:', err);
        return [];
    }
}

