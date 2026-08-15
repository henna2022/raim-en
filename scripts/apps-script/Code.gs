/**
 * Seoul RAIM (EN) — 예약 신청 ↔ Google 시트
 *
 * 두 방향으로 붙는다.
 *   ① 앱 → 시트 (doPost): raim-en이 신청·상태 변경 시 이 웹앱으로 POST하면 신청코드
 *      기준으로 행을 upsert 하고, 보존기한이 지난 건은 삭제한다.
 *   ② 시트 → 앱 (onSheetEdit): 직원이 '상태' 열의 드롭다운을 바꾸면 raim-en의
 *      /api/sheet/status로 POST해서 실제 예약 상태를 바꾸고, 신청자에게 확정/거절
 *      메일이 나가게 한다. 처리자에는 그 셀을 고친 사람의 구글 계정이 기록된다.
 *
 * 원본은 여전히 raim-en의 DB다. 시트에서 고칠 수 있는 것은 '상태' 열 하나뿐이고,
 * 나머지 열은 고쳐 봐야 다음 동기화 때 앱의 값으로 되돌아간다.
 *
 * ── 설치 방법 ──────────────────────────────────────────────
 * 1. 대상 시트를 연다 → 확장 프로그램 > Apps Script
 * 2. 이 파일 내용을 전부 붙여넣고 저장
 * 3. 좌측 ⚙ 프로젝트 설정 > 스크립트 속성 > 속성 추가 (3개)
 *      SHEETS_WEBHOOK_SECRET : 서버 .env의 SHEETS_WEBHOOK_SECRET과 똑같은 값  (①용)
 *      APP_STATUS_URL        : https://<사이트 주소>/api/sheet/status          (②용)
 *      APP_STATUS_SECRET     : 서버 .env의 SHEETS_INBOUND_SECRET과 똑같은 값   (②용)
 *    (비밀값 생성: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
 *    ※ 비밀값을 이 파일 안에 적지 마세요. 이 파일은 git에 그대로 올라갑니다.
 * 4. 배포 > 새 배포 > 유형: 웹 앱
 *      - 실행 계정: 나
 *      - 액세스 권한: 모든 사용자          ← raim-en 서버가 호출해야 하므로 필요
 * 5. 발급된 웹앱 URL을 서버 .env의 SHEETS_WEBHOOK_URL에 넣는다
 * 6. 시트를 새로고침하면 상단에 [RAIM 예약] 메뉴가 생긴다. 순서대로 한 번씩 실행:
 *      RAIM 예약 > ① 시트 설정 (드롭다운·체크박스)
 *      RAIM 예약 > ② 상태 변경 자동 반영 켜기     ← 권한 승인 창이 뜨면 허용
 *      RAIM 예약 > ③ 서버 연결 테스트
 *    (④ 앱 기준으로 새로고침 은 평소에 쓸 일이 없습니다. 시트 값이 앱과 어긋났다는
 *     경고를 봤을 때 쓰는 복구 수단입니다.)
 *
 * "모든 사용자" 이므로 URL을 아는 사람은 누구나 호출할 수 있고, 위 비밀값 검사가
 * 유일한 방어선입니다. URL과 비밀값 모두 외부에 노출하지 마세요.
 * 코드를 수정하면 반드시 "배포 관리 > 편집 > 새 버전"으로 다시 배포해야 반영됩니다.
 *
 * ── 처리자(구글 계정) 기록에 대하여 ────────────────────────
 * 상태를 바꾼 사람의 이메일은 편집 이벤트의 e.user에서 읽는다. 구글은 이 값을
 * 시트 소유자와 **같은 Workspace 도메인**의 계정일 때만 내준다. 직원이 개인 gmail
 * 계정으로 시트를 편집하면 이메일을 알 수 없어 '시트(편집자 미확인)'로 기록된다 —
 * 누가 했는지 남겨야 한다면 직원 계정을 조직 도메인 계정으로 공유하세요.
 * 알 수 없을 때 시트 소유자 이메일로 대신 채우지는 않는다. 하지 않은 사람에게
 * 처리 기록이 붙는 쪽이 "미확인"보다 나쁘기 때문.
 *
 * ── 개인정보 주의 ──────────────────────────────────────────
 * 이 시트에는 방문객의 이름·국가·이메일이 들어갑니다. 요청사항(자유입력)은 보내지
 * 않으며 상세는 raim-en 관리자 페이지에서 확인합니다 — 자유입력에 건강 관련 정보가
 * 섞이면 민감정보가 되어 규제 수준이 올라가기 때문입니다.
 * 시트는 링크 공유하지 말고 담당자 계정에만 개별 공유하세요.
 */

var SHEET_NAME = '예약신청';

// 앱이 채우는 열. 이 이름들이 하나라도 없으면 아무것도 쓰지 않는다.
var HEADERS = [
  '신청코드', '상태', '방문일', '이름', '국가', '전시', '회차', '시간', '예약 인원', '이메일',
  '신청일시', '처리일시', '처리자', '거절사유', '최종동기화',
];
var KEY_HEADER = '신청코드';

// 시트에서만 쓰는 체크박스 열. 앱으로 올라가지도, 앱이 덮어쓰지도 않는다.
// 승인은 이 칸이 체크된 행에서만 통한다 — 관리자 페이지의 "yeyak에 좌석을 차단했다"
// 확인 체크박스와 같은 안전장치를 시트에도 거는 것이다. 좌석을 막지 않은 채 확정
// 메일이 나가면 현장에서 자리가 없어 방문객을 돌려보내야 한다.
var YEYAK_HEADER = 'yeyak차단';

// 직원이 '상태' 드롭다운에서 고를 수 있는 값. src/sheets.js의 SHEET_ACTIONS와
// 글자까지 정확히 같아야 한다 — 서버가 이 문자열로 액션을 찾는다.
var STATUS_CHOICES = ['대기(검토중)', '승인', '거절'];

// 시트를 새로 만들 때의 열 순서. yeyak차단을 신청코드 바로 뒤에 끼워 넣는다:
// 직원의 작업 순서가 "코드 확인 → yeyak 좌석 차단 → 상태 승인"이라 셋이 붙어 있어야
// 오른쪽 끝까지 스크롤하지 않는다.
function displayHeaders_() {
  var out = HEADERS.slice();
  out.splice(1, 0, YEYAK_HEADER);
  return out;
}

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function secret_() {
  return prop_('SHEETS_WEBHOOK_SECRET');
}

// 길이까지 본 뒤 전체를 훑는 비교. 조기 반환이 없어 문자 단위 타이밍 차이를 줄인다.
function secretMatches_(given) {
  var expected = secret_();
  if (!expected) return false;
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= (expected.charCodeAt(i) ^ given.charCodeAt(i));
  return diff === 0;
}

// ═══════════════════════════════════════════════════════════
//  ① 앱 → 시트
// ═══════════════════════════════════════════════════════════

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return json_({ ok: false, error: 'no body' });

    var payload = JSON.parse(e.postData.contents);
    if (!secretMatches_(payload.secret)) return json_({ ok: false, error: 'unauthorized' });

    var rows = payload.rows || (payload.row ? [payload.row] : []);
    var deleteCodes = payload.deleteCodes || [];
    if (rows.length === 0 && deleteCodes.length === 0) return json_({ ok: false, error: 'no rows' });

    // 동시 요청이 같은 줄을 덮어쓰지 않도록 문서 잠금. 못 잡으면 서버가 재시도한다.
    var lock = LockService.getDocumentLock();
    if (!lock.tryLock(25000)) return json_({ ok: false, error: 'busy' });
    try {
      var sheet = getSheet_();
      var col = resolveColumns_(sheet);
      if (!col) {
        // 데이터가 한 줄도 없으면 헤더만 남은 상태다(예: 컬럼 구성이 바뀐 새 버전을
        // 처음 배포한 직후). 이때는 안전하게 헤더를 다시 깔고 진행한다.
        // 데이터가 있으면 절대 건드리지 않고 거부한다.
        if (sheet.getLastRow() <= 1) {
          resetHeader_(sheet);
          col = resolveColumns_(sheet);
        }
        if (!col) return json_({ ok: false, error: 'header mismatch — 헤더 행을 원래대로 되돌리세요' });
      }

      var result = { ok: true, appended: 0, updated: 0, deleted: 0, failed: [] };
      var index = readKeyColumn_(sheet, col.key);

      // 갱신도 신규도 각각 모아서 블록으로 쓴다. 행마다 확인·읽기·쓰기를 반복하면
      // 호출당 서버 왕복이라(실측 행당 수 초) 50건 배치가 서버 타임아웃(45초)과
      // 실행 시간 제한을 넘긴다 — 특히 ④ 새로고침 직후에는 배치 전체가 갱신이라
      // 복구 경로가 가장 느려지는 역설이 생긴다.
      var pendingAppends = [];
      var pendingUpdates = [];
      for (var i = 0; i < rows.length; i++) {
        var code = String(rows[i] && rows[i].code || '');
        var values;
        try {
          if (!code) throw new Error('missing code');
          values = toValues_(rows[i]);
        } catch (rowErr) {
          // 한 행이 실패해도 배치 전체를 막지 않는다 — 서버가 그 코드만 재시도한다.
          result.failed.push(code || '?');
          continue;
        }
        // 같은 배치에 같은 코드가 두 번 오면 뒤엣것으로 덮어써 중복 기록을 막는다.
        var bucket = index[code] ? pendingUpdates : pendingAppends;
        var seen = false;
        for (var p = 0; p < bucket.length; p++) {
          if (bucket[p].code === code) { bucket[p].values = values; seen = true; break; }
        }
        if (!seen) bucket.push({ code: code, values: values });
      }
      if (pendingUpdates.length) updateBlock_(sheet, col, pendingUpdates, index, result);
      if (pendingAppends.length) appendBlock_(sheet, col, pendingAppends, index, result);
      if (deleteCodes.length) deleteRows_(sheet, col.key, deleteCodes, result);

      SpreadsheetApp.flush();
      return json_(result);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// 설치 확인용. 쓰기 카운트를 내보내지 않으므로 서버가 이를 성공으로 오인하지 않는다.
function doGet() {
  return json_({ ok: false, service: 'raim-en sheet mirror', configured: !!secret_(), hint: 'POST only' });
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    var head = displayHeaders_();
    sheet.appendRow(head);
    sheet.getRange(1, 1, 1, head.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// 헤더만 있고 데이터가 없는 시트를 현재 컬럼 구성으로 다시 깐다.
// 이전 버전이 남긴 옛 헤더를 지우기 위해 기존 폭까지 비운 뒤 새로 쓴다.
function resetHeader_(sheet) {
  var head = displayHeaders_();
  var oldWidth = Math.max(sheet.getLastColumn(), head.length);
  sheet.getRange(1, 1, 1, oldWidth).clearContent();
  sheet.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

// 헤더 이름으로 열 위치를 찾는다. 직원이 열을 옮기거나 끼워 넣어도 엉뚱한 칸에
// 쓰지 않도록, 위치를 가정하지 않고 매번 헤더에서 해석한다.
function resolveColumns_(sheet) {
  var width = Math.max(sheet.getLastColumn(), HEADERS.length);
  var header = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); });
  var map = {};
  for (var i = 0; i < HEADERS.length; i++) {
    var at = header.indexOf(HEADERS[i]);
    if (at === -1) return null; // 헤더가 훼손됨 — 아무것도 쓰지 않고 거부
    map[HEADERS[i]] = at + 1;
  }
  return { map: map, key: map[KEY_HEADER], width: width };
}

function headerRow_(sheet) {
  var width = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(1, 1, 1, width).getValues()[0];
}

// 이름으로 열 번호 하나 찾기 (없으면 0). yeyak차단처럼 HEADERS에 없는 열용.
// header를 넘기면 그것을 쓴다 — 한 번의 처리에서 헤더를 여러 번 읽지 않기 위해서.
function findHeaderCol_(sheet, name, header) {
  var row = header || headerRow_(sheet);
  for (var i = 0; i < row.length; i++) {
    if (String(row[i]).trim() === name) return i + 1;
  }
  return 0;
}

// 신청코드 → 행 번호.
function readKeyColumn_(sheet, keyCol) {
  var last = sheet.getLastRow();
  var map = {};
  if (last < 2) return map;
  var values = sheet.getRange(2, keyCol, last - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var code = String(values[i][0] || '');
    if (code) map[code] = i + 2;
  }
  return map;
}

// 기존 행들을 연속 구간 단위로 갱신한다 — 구간마다 읽기 1회 + 쓰기 1회.
// 읽은 블록의 신청코드를 그 자리에서 대조한다: 배치 처리 중 직원이 행을 지우거나
// 끼워 넣으면 인덱스가 어긋나 남의 예약을 덮어쓸 수 있다 (문서 잠금은 스크립트끼리만
// 막고 사람 손은 못 막는다). 어긋난 행은 인덱스를 한 번 다시 읽어 제자리를 찾고,
// 그래도 못 찾으면 failed로 알린다 — 서버가 그 코드만 재시도한다.
function updateBlock_(sheet, col, items, index, result) {
  var span = colSpan_(col);
  var keyAt = col.key - span.min;
  var remaining = items;
  for (var attempt = 0; attempt < 2 && remaining.length; attempt++) {
    if (attempt > 0) {
      // 어긋남을 봤다 — 지금 시트 기준으로 인덱스를 다시 만든다. 공유 객체의
      // 내용만 갈아 끼워, 이후에 이 인덱스를 쓰는 appendBlock_도 새 값을 본다.
      var fresh = readKeyColumn_(sheet, col.key);
      for (var k in index) delete index[k];
      for (var f in fresh) index[f] = fresh[f];
    }
    var placed = [];
    var missing = [];
    for (var i = 0; i < remaining.length; i++) {
      var at = index[remaining[i].code];
      if (at) placed.push({ row: at, item: remaining[i] });
      else missing.push(remaining[i]);
    }
    placed.sort(function (a, b) { return a.row - b.row; });

    var mismatched = [];
    var j = 0;
    while (j < placed.length) {
      var runLen = 1;
      while (j + runLen < placed.length && placed[j + runLen].row === placed[j].row + runLen) runLen++;
      var range = sheet.getRange(placed[j].row, span.min, runLen, span.width);
      var block = range.getValues();
      var wrote = 0;
      for (var r = 0; r < runLen; r++) {
        var slot = placed[j + r];
        var actual = String(block[r][keyAt] || '');
        if (actual !== slot.item.code) {
          // 이 줄은 읽은 그대로 되돌려 써서 건드리지 않는다 — 다음 판에서 다시 찾는다.
          mismatched.push(slot.item);
          continue;
        }
        fillLine_(col, span, block[r], slot.item.values);
        wrote++;
      }
      if (wrote) range.setValues(block);
      result.updated += wrote;
      j += runLen;
    }
    remaining = mismatched.concat(missing);
  }
  for (var m = 0; m < remaining.length; m++) result.failed.push(remaining[m].code);
}

// 신규 행 전체를 setValues 한 번으로 붙인다 — 건수와 무관하게 왕복 2회.
function appendBlock_(sheet, col, items, index, result) {
  var span = colSpan_(col);
  var start = sheet.getLastRow() + 1;
  var block = [];
  for (var i = 0; i < items.length; i++) {
    block.push(fillLine_(col, span, blankLine_(span.width), items[i].values));
  }
  sheet.getRange(start, span.min, block.length, span.width).setValues(block);
  for (var j = 0; j < items.length; j++) {
    index[items[j].code] = start + j;
    result.appended++;
  }
  // 새로 붙은 줄에도 드롭다운과 체크박스를 입힌다. 이게 없으면 직원이 새 신청에서만
  // 드롭다운을 못 봐서 상태를 직접 타이핑하게 되고, 그 값은 서버가 알아듣지 못한다.
  applyRowRules_(sheet, start, block.length, true);
}

// 상태 드롭다운 + yeyak 체크박스를 지정한 행 범위에 입힌다.
// resetYeyak=true면 체크박스를 false로 초기화한다(새로 들어온 신청은 아직 좌석을
// 막지 않은 상태이므로). 기존 행에 다시 규칙만 입힐 때는 false로 부른다.
// 서식 실패가 데이터 기록을 막으면 안 되므로 통째로 삼킨다.
function applyRowRules_(sheet, startRow, numRows, resetYeyak) {
  if (numRows <= 0) return;
  try {
    var header = headerRow_(sheet);
    var statusCol = findHeaderCol_(sheet, '상태', header);
    var yeyakCol = findHeaderCol_(sheet, YEYAK_HEADER, header);
    if (statusCol) {
      // allowInvalid: 앱은 대기자·취소·방문완료·노쇼도 이 칸에 쓴다. 목록 밖 값을
      // 거부하도록 걸면 그 쓰기가 통째로 실패해 시트가 조용히 낡는다.
      sheet.getRange(startRow, statusCol, numRows, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(STATUS_CHOICES, true).setAllowInvalid(true).build()
      );
    }
    if (yeyakCol) {
      var range = sheet.getRange(startRow, yeyakCol, numRows, 1);
      range.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
      if (resetYeyak) {
        var blanks = [];
        for (var i = 0; i < numRows; i++) blanks.push([false]);
        range.setValues(blanks);
      }
    }
  } catch (err) {
    // 서식은 못 입혀도 데이터는 들어가 있다. 다음 "① 시트 설정"에서 복구된다.
  }
}

function colSpan_(col) {
  var min = null;
  var max = null;
  for (var i = 0; i < HEADERS.length; i++) {
    var c = col.map[HEADERS[i]];
    if (min === null || c < min) min = c;
    if (max === null || c > max) max = c;
  }
  return { min: min, max: max, width: max - min + 1 };
}

function blankLine_(width) {
  var line = [];
  for (var i = 0; i < width; i++) line.push('');
  return line;
}

function fillLine_(col, span, line, values) {
  for (var i = 0; i < HEADERS.length; i++) line[col.map[HEADERS[i]] - span.min] = values[i];
  return line;
}

// 보존기한이 지나 raim-en에서 삭제된 건을 시트에서도 지운다.
// 행 번호가 밀리지 않도록 큰 번호부터 삭제한다.
function deleteRows_(sheet, keyCol, codes, result) {
  var index = readKeyColumn_(sheet, keyCol);
  var targets = [];
  for (var i = 0; i < codes.length; i++) {
    var at = index[String(codes[i])];
    if (at) targets.push(at);
  }
  targets.sort(function (a, b) { return b - a; });
  // 연속된 행은 deleteRows로 한 번에 지운다. 한 행씩 지우면 삭제 건수만큼
  // 서버 왕복이 발생해 보존기한 정리가 실행 시간 제한에 걸릴 수 있다.
  var j = 0;
  while (j < targets.length) {
    var end = targets[j];       // 가장 아래쪽 행
    var run = 1;
    while (j + run < targets.length && targets[j + run] === end - run) run++;
    var startRow = end - run + 1;
    if (run === 1) sheet.deleteRow(startRow);
    else sheet.deleteRows(startRow, run);
    result.deleted += run;
    j += run;
  }
}

function toValues_(r) {
  return [
    str_(r.code), str_(r.status), str_(r.visit_date), str_(r.name), str_(r.country),
    str_(r.tour_type), str_(r.session), str_(r.time), r.party_size == null ? '' : Number(r.party_size), str_(r.email),
    str_(r.created_at), str_(r.decided_at), str_(r.decided_by), str_(r.decline_reason), new Date(),
  ];
}

// 방문자가 입력한 값이 '=' 로 시작하면 시트가 수식으로 실행한다. 앞에 '를 붙여 무력화.
function str_(v) {
  if (v == null) return '';
  var s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════
//  ② 시트 → 앱 (상태 드롭다운)
// ═══════════════════════════════════════════════════════════

// 한 번의 편집으로 처리할 최대 행 수. 이보다 많으면 통째로 무시한다 — 실수로
// 붙여넣기 한 번에 수십 명에게 확정 메일이 나가는 쪽이 훨씬 큰 사고다.
// 메일 발송은 서버에서 순차 처리라, 크게 잡으면 응답을 기다리다 타임아웃도 난다.
var MAX_EDIT_ROWS = 20;

// 서버가 돌려준 오류 코드를 직원이 읽을 말로.
var ERROR_TEXT = {
  not_found: '이 신청코드가 앱에 없습니다 (보존기한이 지나 파기되었을 수 있음)',
  unknown_status: '상태 값이 올바르지 않습니다 — 드롭다운에서 골라 주세요',
  invalid_transition: '지금 상태에서는 바꿀 수 없습니다 (예: 이미 확정·취소된 건). 관리자 페이지에서 처리하세요',
  raced: '거의 동시에 다른 곳에서 상태가 바뀌었습니다 — 새로 뜬 값을 확인하세요',
  server_error: '서버에서 처리하지 못했습니다',
};

function toast_(message, title) {
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(message, title || 'RAIM 예약', 10);
  } catch (err) { /* 트리거 문맥에 따라 토스트를 못 띄울 수 있다 — 무시 */ }
}

// 상태를 바꾼 사람의 구글 계정. 파일 상단 "처리자 기록에 대하여" 참고 —
// 알 수 없으면 시트 소유자로 대신 채우지 않고 미확인으로 남긴다.
function editorEmail_(e) {
  var email = '';
  try { if (e && e.user && e.user.getEmail) email = e.user.getEmail() || ''; } catch (err) { email = ''; }
  if (!email) {
    try { email = Session.getActiveUser().getEmail() || ''; } catch (err) { email = ''; }
  }
  return email || '시트(편집자 미확인)';
}

function utcStamp_() {
  return Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd HH:mm:ss');
}

/**
 * 설치형 onEdit 트리거의 진입점 ("② 상태 변경 자동 반영 켜기"가 등록한다).
 * 단순 트리거(onEdit)로는 UrlFetchApp을 쓸 수 없어 설치형이어야 한다.
 * 스크립트가 쓴 값에는 트리거가 발화하지 않으므로, 앱→시트 동기화가 이 함수를
 * 다시 부르는 되먹임은 생기지 않는다. 혹시 발화하더라도 서버가 "이미 그 상태"를
 * 무시하므로 메일이 두 번 나가지는 않는다.
 */
function onSheetEdit(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    if (sheet.getName() !== SHEET_NAME) return;

    var col = resolveColumns_(sheet);
    if (!col) {
      // 헤더가 훼손됐다. '상태' 열이 이름으로 찾아지면 거기를 건드렸을 때만 알린다 —
      // 어느 칸을 고치든 경고가 뜨면 소음이 되어 진짜 경고까지 무시하게 된다.
      // 단, '상태' 헤더 자체가 지워졌으면 데이터 행 편집에는 무조건 알린다:
      // 셀의 드롭다운은 멀쩡히 남아 직원이 계속 승인/거절을 고르는데 아무 일도
      // 일어나지 않고, 미러(doPost)도 같은 이유로 거부 중이라 조용히 물러나면
      // "시트는 승인, 앱은 대기"가 아무도 모르게 쌓인다.
      var maybe = findHeaderCol_(sheet, '상태');
      var touched = maybe
        ? maybe >= e.range.getColumn() && maybe <= e.range.getLastColumn()
        : e.range.getLastRow() >= 2;
      if (touched) {
        toast_('헤더 행이 원래 구성과 달라 상태 변경을 반영할 수 없습니다. 헤더를 되돌린 뒤 다시 시도하세요.', '반영 불가');
      }
      return;
    }
    var statusCol = col.map['상태'];

    // 편집 범위가 '상태' 열을 건드렸을 때만 움직인다.
    if (statusCol < e.range.getColumn() || statusCol > e.range.getLastColumn()) return;
    var firstRow = Math.max(2, e.range.getRow());
    var lastRow = e.range.getLastRow();
    if (lastRow < firstRow) return;

    // 한 번에 너무 많은 줄을 바꾸면(대개 실수로 붙여넣기) 아무것도 반영하지 않는다.
    // 수십 건의 확정 메일이 한꺼번에 나가는 사고를 막는 것이 우선이다.
    //
    // 다만 그냥 물러나면 안 된다. 미러는 DB가 실제로 바뀐 행만 다시 쓰는데, 여기서는
    // 아무것도 바꾸지 않았으니 시트에 찍힌 '승인'이 영영 그대로 남는다 — 시트는
    // 승인이라는데 앱은 대기이고 메일도 안 나간 상태가 되어, 가장 위험한 형태의
    // 거짓 표시가 된다. 그래서 앱에 재전송을 요청해 그 줄들을 진짜 값으로 되돌린다.
    if (lastRow - firstRow + 1 > MAX_EDIT_ROWS) {
      // 붙여넣기가 신청코드 열까지 덮었다면 시트의 코드는 더 이상 믿을 수 없다 —
      // 전체 재전송을 요청한다. 아니면 그 줄들의 코드만 다시 요청한다.
      var keyHit = col.key >= e.range.getColumn() && col.key <= e.range.getLastColumn();
      var restored = keyHit
        ? requestRefreshAll_()
        : requestRefresh_(codesInRows_(sheet, col.key, firstRow, lastRow));
      toast_(MAX_EDIT_ROWS + '줄을 넘겨 한 번에 바꿨습니다 — 실수를 막기 위해 아무것도 반영하지 않았습니다.\n'
        + (restored
          ? '값은 잠시 뒤 앱 기준으로 되돌아갑니다. '
          : '⚠ 되돌리기 요청도 실패했습니다. 시트 값이 앱과 다를 수 있으니 [RAIM 예약 > ④ 앱 기준으로 새로고침]을 실행하세요. ')
        + MAX_EDIT_ROWS + '줄 이하로 나눠서 처리하세요.', '반영하지 않음');
      return;
    }

    var yeyakCol = findHeaderCol_(sheet, YEYAK_HEADER);
    var reasonCol = col.map['거절사유'];
    var width = Math.max(sheet.getLastColumn(), col.width);
    var block = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, width).getValues();

    var changes = [];   // 서버로 보낼 것
    var blocked = [];   // yeyak 미차단으로 여기서 막은 것
    for (var i = 0; i < block.length; i++) {
      var line = block[i];
      var code = String(line[col.key - 1] || '').trim();
      var picked = String(line[statusCol - 1] || '').trim();
      if (!code || !picked) continue;

      // 승인은 yeyak 좌석을 막았다고 체크한 행에서만. 열 자체가 없으면 확인할
      // 방법이 없으므로 막는다(fail closed) — 좌석 없이 확정 메일이 나가는 것보다
      // 직원이 한 번 더 손대는 쪽이 낫다.
      if (picked === '승인') {
        var checked = yeyakCol ? line[yeyakCol - 1] === true : false;
        if (!checked) {
          blocked.push({ row: firstRow + i, code: code, noColumn: !yeyakCol });
          continue;
        }
      }
      changes.push({
        row: firstRow + i,
        code: code,
        status: picked,
        reason: reasonCol ? String(line[reasonCol - 1] || '') : '',
      });
    }

    // yeyak 미체크로 막은 행은 서버에 묻지 않고 여기서 되돌린다. 편집 직전 값을
    // 아는 단일 셀 편집이면 그 값으로, 아니면 비워서 다시 고르게 한다.
    for (var b = 0; b < blocked.length; b++) {
      revertCell_(sheet, blocked[b].row, statusCol, changes.length === 0 && blocked.length === 1 ? e.oldValue : null);
    }
    if (blocked.length) {
      toast_(blocked[0].noColumn
        ? '"' + YEYAK_HEADER + '" 열이 없어 승인할 수 없습니다. [RAIM 예약 > ① 시트 설정]을 먼저 실행하세요.'
        : 'yeyak에 좌석을 먼저 차단하고 "' + YEYAK_HEADER + '" 칸을 체크한 뒤 승인해 주세요. (' + blocked.length + '건 되돌림)',
        '승인 취소됨');
    }
    if (changes.length === 0) return;

    var actor = editorEmail_(e);
    var response = postStatus_(changes.map(function (c) {
      return { code: c.code, status: c.status, actor: actor, reason: c.reason };
    }));

    if (!response.ok) {
      if (response.definite) {
        // 서버가 분명히 거절했다 — 반영되지 않았음이 확실하므로 되돌린다.
        for (var r = 0; r < changes.length; r++) revertCell_(sheet, changes[r].row, statusCol, null);
        toast_('앱이 요청을 거절했습니다 (' + (response.error || '알 수 없는 오류') + '). 값을 되돌렸습니다 — 관리자 페이지에서 처리하세요.', '반영 실패');
      } else {
        // 응답을 못 받았을 뿐 서버는 이미 처리했을 수 있다(메일까지 나갔을 수 있다).
        // 이때 되돌리면 "처리 안 됨"으로 오해하게 되므로 손대지 않는다. 대신 재전송을
        // 요청해 앱이 실제로 어떤 상태인지 시트에 다시 찍히게 한다 — 처리됐다면 그
        // 값이, 안 됐다면 원래 값이 돌아온다.
        var codes = [];
        for (var k = 0; k < changes.length; k++) codes.push(changes[k].code);
        var asked = requestRefresh_(codes);
        toast_('서버 응답을 받지 못했습니다 (' + (response.error || '연결 실패') + ').\n'
          + (asked
            ? '반영됐을 수도 있어 값을 그대로 두었습니다 — 잠시 뒤 앱 기준으로 갱신되니 그때 확인하세요.'
            : '⚠ 값을 그대로 두었습니다. 앱과 다를 수 있으니 [RAIM 예약 > ④ 앱 기준으로 새로고침]을 실행해 확인하세요.'),
          '확인 필요');
      }
      return;
    }

    applyResults_(sheet, statusCol, col.map, changes, response.results || [], actor);
  } catch (err) {
    toast_('상태 반영 중 오류: ' + err, '오류');
  }
}

// 서버 응답을 시트에 반영한다. 거부된 행은 서버가 알려준 "진짜 상태"로 되돌린다 —
// 편집 직전 값(e.oldValue)은 그 사이에 이미 낡았을 수 있어 신뢰하지 않는다.
function applyResults_(sheet, statusCol, map, changes, results, actor) {
  var byCode = {};
  for (var i = 0; i < results.length; i++) byCode[String(results[i].code)] = results[i];

  // 서버 왕복은 메일 발송까지 수 초가 걸리고, 그동안 시트는 잠겨 있지 않다 —
  // 보존기한 삭제(doPost)나 직원의 행 삭제·삽입으로 행이 밀리면 편집 시점의 행
  // 번호(c.row)는 이미 남의 예약을 가리킨다. 그대로 쓰면 엉뚱한 줄에 처리자가
  // 찍히고, 되돌리기가 남의 상태를 지운다. 쓰기 직전에 신청코드 열을 다시 읽어
  // 지금 위치를 찾고, 사라진 코드는 건드리지 않는다 — doPost의 갱신 경로가 같은
  // 이유로 같은 확인을 한다.
  var index = readKeyColumn_(sheet, map[KEY_HEADER]);

  var okCount = 0;
  var failures = [];
  var mailFailed = [];
  var outboxCount = 0;
  var stamp = utcStamp_();
  for (var j = 0; j < changes.length; j++) {
    var c = changes[j];
    var res = byCode[c.code];
    if (!res) { failures.push(c.code + ': 응답 없음'); continue; }
    var at = index[c.code];
    if (!at) { failures.push(c.code + ': 행을 찾지 못해 결과를 쓰지 못함 (그사이 시트가 편집됨)'); continue; }
    if (res.ok) {
      if (res.changed) {
        okCount++;
        // 처리자·처리일시를 먼저 채워 직원이 바로 확인할 수 있게 한다. 다음
        // 동기화 때 앱의 값으로 다시 쓰이는데, 같은 내용이라 눈에 띄지 않는다.
        if (map['처리자']) sheet.getRange(at, map['처리자']).setValue(actor);
        if (map['처리일시']) sheet.getRange(at, map['처리일시']).setValue(stamp);
        if (res.mail === 'failed') mailFailed.push(c.code);
        if (res.mail === 'outbox') outboxCount++;
      }
      if (res.label && res.label !== c.status) sheet.getRange(at, statusCol).setValue(res.label);
    } else {
      revertCell_(sheet, at, statusCol, res.label || null);
      failures.push(c.code + ': ' + (ERROR_TEXT[res.error] || res.error || '실패'));
    }
  }

  // 전이 실패와 메일 발송 실패는 한 토스트로 합친다 — 토스트는 서로 덮어쓰므로
  // 나눠 띄우면 앞엣것을 못 본다. 메일 실패는 상태 자체는 반영된 경우다: 셀을
  // 되돌리면 재시도로 메일이 두 번 갈 수 있어 그대로 두고 사람에게만 알린다.
  var warn = [];
  if (failures.length) warn.push(failures.join('\n'));
  if (mailFailed.length) {
    warn.push('⚠ 방문객 메일 발송 실패 ' + mailFailed.length + '건 (' + mailFailed.join(', ')
      + ') — 상태는 반영됐습니다. 관리자 페이지 > Emails에서 확인하세요.');
  }
  if (warn.length) {
    toast_(warn.join('\n'), okCount ? okCount + '건 반영, 확인 필요' : '반영 실패');
  } else if (okCount) {
    // SMTP 미설정(발송함 모드)일 때 "발송됩니다"라고 하면 거짓말이 된다 —
    // 데모나 초기 설정 단계에서 방문객이 메일을 기다리게 만들지 않는다.
    toast_(outboxCount
      ? okCount + '건 반영했습니다. 메일은 실제 발송되지 않고 발송함(Outbox)에 저장됐습니다 — SMTP 미설정 (관리자 > Emails).'
      : okCount + '건 반영했습니다. 신청자에게 안내 메일이 발송됩니다. (처리자: ' + actor + ')', '완료');
  }
}

// 되돌릴 값을 모르면 비운다 — 잘못된 값이 그대로 남아 "반영된 것처럼" 보이는 게
// 가장 나쁘다. 빈 칸이면 직원이 다시 고르게 된다.
function revertCell_(sheet, row, colNum, value) {
  sheet.getRange(row, colNum).setValue(value == null ? '' : value);
}

// 지정한 행 구간의 신청코드 목록 (빈 칸은 건너뛴다).
function codesInRows_(sheet, keyCol, firstRow, lastRow) {
  var values = sheet.getRange(firstRow, keyCol, lastRow - firstRow + 1, 1).getValues();
  var codes = [];
  for (var i = 0; i < values.length; i++) {
    var code = String(values[i][0] || '').trim();
    if (code) codes.push(code);
  }
  return codes;
}

// 서버 /refresh의 한도(MAX_REFRESH_CODES)와 같은 값. 이보다 긴 목록은 서버가
// 잘라내지 않고 통째로 400으로 거절한다 — 조용한 부분 성공이 제일 위험해서다.
// 그래서 여기서 나눠 보낸다.
var REFRESH_CHUNK = 1000;

function refreshUrl_() {
  // 끝 슬래시가 붙어 있으면 /status 치환이 빗나가 refresh 요청이 /status로 간다.
  var url = prop_('APP_STATUS_URL').replace(/\/+$/, '');
  return url ? url.replace(/\/status$/, '/refresh') : '';
}

// /refresh 호출 한 번. HTTP 200이어도 본문의 ok:true까지 봐야 성공이다 —
// 상태 코드만 믿으면 거절 응답까지 성공으로 오인해 "곧 복구됩니다"라는 거짓
// 안내가 나간다.
function postRefresh_(payload) {
  var url = refreshUrl_();
  var secret = prop_('APP_STATUS_SECRET');
  if (!url || !secret) return false;
  payload.secret = secret;
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: true,
    });
    if (res.getResponseCode() !== 200) return false;
    var body = JSON.parse(res.getContentText());
    return !!(body && body.ok === true);
  } catch (err) {
    return false;
  }
}

// 앱에게 "이 줄들을 다시 보내 달라"고 요청한다. 상태는 바꾸지 않는다.
// 시트에 찍힌 값이 앱과 어긋난 채 남는 것을 막는 유일한 수단이므로, 실패하면
// 호출부가 그 사실을 직원에게 알려야 한다. 성공 여부를 boolean으로 돌려준다.
function requestRefresh_(codes) {
  if (!codes || codes.length === 0) return true;
  for (var i = 0; i < codes.length; i += REFRESH_CHUNK) {
    if (!postRefresh_({ codes: codes.slice(i, i + REFRESH_CHUNK) })) return false;
  }
  return true;
}

// 모든 예약을 다시 보내 달라는 요청 — 시트의 코드 목록을 신뢰할 수 없을 때 쓴다
// (신청코드 열까지 덮은 붙여넣기, 통째로 지워진 시트). 망가진 시트에서 읽은 코드로
// 요청하면 그 망가진 코드만 다시 그려질 뿐, 원래 있던 행은 영영 돌아오지 않는다.
function requestRefreshAll_() {
  return postRefresh_({ all: true });
}

// definite: true면 "반영되지 않았음이 확실"하다는 뜻이다. 호출부는 이때만 셀을
// 되돌린다 — 타임아웃처럼 결과를 모르는 경우에 되돌리면, 이미 확정 메일이 나간
// 예약을 "처리 안 됨"으로 보이게 만든다.
function postStatus_(changes) {
  var url = prop_('APP_STATUS_URL');
  var secret = prop_('APP_STATUS_SECRET');
  if (!url || !secret) {
    return { ok: false, definite: true, error: 'APP_STATUS_URL / APP_STATUS_SECRET 스크립트 속성이 비어 있음' };
  }
  var res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ secret: secret, changes: changes }),
      muteHttpExceptions: true,
      followRedirects: true,
    });
  } catch (err) {
    // 연결 실패·타임아웃 — 서버가 받았는지 알 수 없다.
    return { ok: false, definite: false, error: '서버에 연결하지 못함: ' + err };
  }
  var status = res.getResponseCode();
  if (status !== 200) {
    // 4xx는 서버가 요청 자체를 거절한 것(비밀값 불일치 등) — 반영되지 않았다.
    // 5xx는 처리 도중 죽었을 수 있어 결과를 단정할 수 없다.
    return { ok: false, definite: status >= 400 && status < 500, error: 'HTTP ' + status };
  }
  try {
    var body = JSON.parse(res.getContentText());
    if (!body || body.ok !== true) {
      return { ok: false, definite: true, error: (body && body.error) || '서버가 거부함' };
    }
    return body;
  } catch (err) {
    return { ok: false, definite: false, error: '서버 응답을 읽지 못함' };
  }
}

// ═══════════════════════════════════════════════════════════
//  메뉴 / 설치
// ═══════════════════════════════════════════════════════════

function onOpen() {
  SpreadsheetApp.getUi().createMenu('RAIM 예약')
    .addItem('① 시트 설정 (드롭다운·체크박스)', 'setupSheet')
    .addItem('② 상태 변경 자동 반영 켜기', 'installTriggers')
    .addItem('③ 서버 연결 테스트', 'testConnection')
    .addItem('④ 앱 기준으로 새로고침', 'refreshFromApp')
    .addToUi();
}

// 시트 전체를 앱 기준으로 다시 받아온다. 시트 값이 앱과 어긋났다고 의심될 때
// (예: 되돌리기 요청이 실패했다는 경고를 봤을 때) 쓰는 복구 수단이다.
// 시트에서 코드를 읽어 요청하지 않고 전체 재전송(all)을 쓴다 — 이 메뉴를 쓰는
// 상황이 곧 "시트를 믿을 수 없는" 상황이라, 코드 열이 함께 망가졌거나 행이
// 지워졌으면 시트에서 읽은 목록으로는 그 행들을 영영 되살릴 수 없다.
function refreshFromApp() {
  var sheet = getSheet_();
  var ui = SpreadsheetApp.getUi();
  // 헤더가 훼손된 상태면 미러(doPost)가 어차피 쓰기를 거부한다 — 헤더부터 되돌리게
  // 안내한다. 데이터가 없으면 doPost가 헤더를 새로 깔 수 있으므로 그냥 진행한다.
  if (sheet.getLastRow() > 1 && !resolveColumns_(sheet)) {
    ui.alert('헤더 행이 원래 구성과 달라 새로고침할 수 없습니다. 헤더를 먼저 되돌리세요.');
    return;
  }
  ui.alert(requestRefreshAll_()
    ? '앱의 모든 예약을 다시 요청했습니다. 잠시 뒤 시트가 앱 기준으로 갱신됩니다.'
    : '앱에 요청하지 못했습니다. 스크립트 속성(APP_STATUS_URL / APP_STATUS_SECRET)과 서버 상태를 확인하세요.');
}

// yeyak차단 열을 만들고, 상태 드롭다운과 체크박스를 전체 데이터 행에 입힌다.
// 몇 번을 실행해도 안전하다.
function setupSheet() {
  var sheet = getSheet_();
  if (!findHeaderCol_(sheet, YEYAK_HEADER)) {
    var keyCol = findHeaderCol_(sheet, KEY_HEADER) || 1;
    sheet.insertColumnAfter(keyCol);
    sheet.getRange(1, keyCol + 1).setValue(YEYAK_HEADER).setFontWeight('bold');
  }
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) applyRowRules_(sheet, 2, lastRow - 1, false);
  toast_('상태 드롭다운(' + STATUS_CHOICES.join(' / ') + ')과 ' + YEYAK_HEADER + ' 체크박스를 적용했습니다.', '시트 설정 완료');
}

// 설치형 onEdit 트리거 등록. 이미 있으면 지우고 다시 만들어 중복 발화를 막는다.
// 단, getProjectTriggers()는 **실행한 사람의 트리거만** 보여준다 — 다른 직원이
// 이미 켜 두었는지는 목록으로 알 수 없어 스크립트 속성으로 기록한다. 중복으로
// 켜면 같은 편집이 두 번 처리된다(메일은 서버 멱등성이 막지만, 처리자 기록이
// 두 번 쓰이고 실행 시간을 낭비한다).
function installTriggers() {
  var me = '';
  try { me = Session.getEffectiveUser().getEmail() || ''; } catch (err) { me = ''; }
  // 개인 gmail 등 계정을 알 수 없는 환경은 'unknown'으로 남는다. 'unknown'끼리는
  // 재설치를 허용한다 — 잠그면 트리거가 죽었을 때 아무도 못 고친다.
  var mine = me || 'unknown';
  var props = PropertiesService.getScriptProperties();
  var owner = props.getProperty('RAIM_TRIGGER_OWNER') || '';
  if (owner && owner !== mine) {
    SpreadsheetApp.getUi().alert('상태 변경 자동 반영은 이미 ' + owner + ' 계정이 켜 두었습니다.\n'
      + '중복으로 켜면 같은 편집이 두 번 처리되므로 이번 실행은 건너뜁니다.\n'
      + '(다시 설치해야 한다면 그 계정으로 ②를 실행하세요)');
    return;
  }
  var ss = SpreadsheetApp.getActive();
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'onSheetEdit') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  props.setProperty('RAIM_TRIGGER_OWNER', mine);
  toast_('이제 상태 드롭다운을 바꾸면 앱에 자동 반영되고 신청자에게 메일이 나갑니다.', '자동 반영 켜짐');
}

// 서버가 살아 있고 비밀값이 맞는지 확인. 실제 예약은 건드리지 않는다 —
// 존재할 수 없는 코드를 보내 not_found가 돌아오면 인증까지 통과한 것이다.
function testConnection() {
  var res = postStatus_([{ code: 'RAIM-TEST00', status: '거절', actor: 'connection-test', reason: '' }]);
  if (!res.ok) {
    SpreadsheetApp.getUi().alert('연결 실패\n\n' + (res.error || '알 수 없는 오류')
      + '\n\n스크립트 속성 APP_STATUS_URL / APP_STATUS_SECRET과 서버의 SHEETS_INBOUND_SECRET을 확인하세요.');
    return;
  }
  var first = (res.results || [])[0] || {};
  SpreadsheetApp.getUi().alert(first.error === 'not_found'
    ? '연결 정상입니다. (테스트 코드는 앱에 없으므로 not_found가 정상 응답입니다)'
    : '서버에 연결됐지만 예상과 다른 응답입니다: ' + JSON.stringify(first));
}
