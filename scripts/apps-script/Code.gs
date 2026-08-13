/**
 * Seoul RAIM (EN) — 예약 신청 → Google 시트 미러
 *
 * raim-en이 신청·상태 변경 시 이 웹앱으로 POST하면 신청코드 기준으로 행을 upsert 하고,
 * 보존기한이 지난 건은 삭제합니다. 시트는 "보는 용도"이고 원본은 raim-en의 DB입니다 —
 * 시트에서 값을 고쳐도 raim-en으로 돌아가지 않습니다.
 *
 * ── 설치 방법 ──────────────────────────────────────────────
 * 1. 대상 시트를 연다 → 확장 프로그램 > Apps Script
 * 2. 이 파일 내용을 전부 붙여넣고 저장
 * 3. 좌측 ⚙ 프로젝트 설정 > 스크립트 속성 > 속성 추가
 *      속성: SHEETS_WEBHOOK_SECRET
 *      값  : 서버 .env의 SHEETS_WEBHOOK_SECRET과 똑같은 값
 *    (생성: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
 *    ※ 비밀값을 이 파일 안에 적지 마세요. 이 파일은 git에 그대로 올라갑니다.
 * 4. 배포 > 새 배포 > 유형: 웹 앱
 *      - 실행 계정: 나
 *      - 액세스 권한: 모든 사용자          ← raim-en 서버가 호출해야 하므로 필요
 * 5. 발급된 웹앱 URL을 서버 .env의 SHEETS_WEBHOOK_URL에 넣는다
 *
 * "모든 사용자" 이므로 URL을 아는 사람은 누구나 호출할 수 있고, 위 비밀값 검사가
 * 유일한 방어선입니다. URL과 비밀값 모두 외부에 노출하지 마세요.
 * 코드를 수정하면 반드시 "배포 관리 > 편집 > 새 버전"으로 다시 배포해야 반영됩니다.
 *
 * ── 개인정보 주의 ──────────────────────────────────────────
 * 이 시트에는 방문객의 이름·국가·이메일이 들어갑니다. 요청사항(자유입력)은 보내지
 * 않으며 상세는 raim-en 관리자 페이지에서 확인합니다 — 자유입력에 건강 관련 정보가
 * 섞이면 민감정보가 되어 규제 수준이 올라가기 때문입니다.
 * 시트는 링크 공유하지 말고 담당자 계정에만 개별 공유하세요.
 */

var SHEET_NAME = '예약신청';

var HEADERS = [
  '신청코드', '상태', '방문일', '이름', '국가', '전시', '회차', '시간', '예약 인원', '이메일',
  '신청일시', '처리일시', '처리자', '거절사유', '최종동기화',
];
var KEY_HEADER = '신청코드';

function secret_() {
  return PropertiesService.getScriptProperties().getProperty('SHEETS_WEBHOOK_SECRET') || '';
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

      // 신규 행은 모아서 한 번에 쓴다. 행마다 setValues를 부르면 호출당 서버 왕복이라
      // 실측 기준 행당 약 7초가 걸려, 수십 건 배치가 실행 시간 제한을 넘긴다.
      var pendingAppends = [];
      for (var i = 0; i < rows.length; i++) {
        try {
          upsertRow_(sheet, col, index, rows[i], result, pendingAppends);
        } catch (rowErr) {
          // 한 행이 실패해도 배치 전체를 막지 않는다 — 서버가 그 코드만 재시도한다.
          result.failed.push(String(rows[i] && rows[i].code || '?'));
        }
      }
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
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// 헤더만 있고 데이터가 없는 시트를 현재 컬럼 구성으로 다시 깐다.
// 이전 버전이 남긴 옛 헤더를 지우기 위해 기존 폭까지 비운 뒤 새로 쓴다.
function resetHeader_(sheet) {
  var oldWidth = Math.max(sheet.getLastColumn(), HEADERS.length);
  sheet.getRange(1, 1, 1, oldWidth).clearContent();
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
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

function upsertRow_(sheet, col, index, row, result, pendingAppends) {
  var code = String(row.code || '');
  if (!code) throw new Error('missing code');
  var values = toValues_(row);
  var at = index[code];

  // 쓰기 직전에 그 줄이 정말 이 코드인지 확인한다. 배치 처리 중 직원이 행을
  // 지우거나 정렬하면 인덱스가 어긋나 남의 예약을 덮어쓸 수 있다.
  if (at) {
    var actual = String(sheet.getRange(at, col.key).getValue() || '');
    if (actual !== code) {
      index = readKeyColumn_(sheet, col.key);
      at = index[code];
    }
  }

  if (at) {
    writeRow_(sheet, col, at, values, false);
    result.updated++;
  } else {
    // 같은 배치에 같은 코드가 두 번 오면 뒤엣것으로 덮어써 중복 행을 막는다.
    for (var p = 0; p < pendingAppends.length; p++) {
      if (pendingAppends[p].code === code) { pendingAppends[p].values = values; return; }
    }
    pendingAppends.push({ code: code, values: values });
  }
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

// 한 줄을 setValues 한 번으로 쓴다. 셀마다 setValue를 부르면 호출당 서버 왕복이라
// 16배 느려지고, 50건 배치에서는 실행 시간 제한에 걸린다.
// 우리 열이 연속이 아닐 수 있으므로(직원이 중간에 열을 끼워 넣은 경우) 최소~최대
// 열 구간을 통째로 다루되, 갱신 시에는 기존 값을 먼저 읽어 우리 것이 아닌 칸을
// 덮어쓰지 않는다.
function writeRow_(sheet, col, rowNum, values, isNew) {
  var span = colSpan_(col);
  var line = isNew
    ? blankLine_(span.width)
    : sheet.getRange(rowNum, span.min, 1, span.width).getValues()[0];
  sheet.getRange(rowNum, span.min, 1, span.width)
    .setValues([fillLine_(col, span, line, values)]);
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
