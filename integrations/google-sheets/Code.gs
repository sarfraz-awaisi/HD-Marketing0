/**
 * HD Marketing CRM: Google Sheets lead sync (Google Apps Script).
 *
 * Reads the Meta Lead Ads Sheets that are turned on in the CRM (Administration
 * > Integrations > Google Sheets) and sends their new rows to the CRM. Each
 * Sheet goes into its own CRM lead file. Setup and operation:
 * docs/GOOGLE_SHEETS_IMPORT.md.
 *
 * Script Properties (Project Settings > Script properties), never in code:
 *   CRM_BASE_URL    the CRM's https:// address, such as https://hdmarketing.tech
 *   CRM_SHEETS_KEY  the integration key the CRM showed once (hdcrm_sheets_...)
 *
 * Functions to run from the editor:
 *   checkSetup      reads the settings and every Sheet, imports nothing
 *   syncLeads       one sync; the first one is the historical import
 *   installTrigger  runs syncLeads every five minutes (replaces older ones)
 *   removeTrigger   stops the automatic runs
 *
 * How a run works: the CRM decides what is new. For each Sheet the script
 * sends the Meta lead IDs, the CRM answers with the ones it has not imported,
 * and only those rows are sent, 100 at a time. The CRM has a row once it has
 * answered for it, so a failed, interrupted or overlapping run never loses or
 * doubles a lead: the next run continues from what the CRM has. Rejected rows
 * are sent again on later runs, so fixing a row in the Sheet imports it. The
 * Sheet itself is never changed.
 *
 * Logs show Sheet names, counts and row numbers only: never customer names,
 * phone numbers, emails or the key.
 */
var SYNC = {
  path: "/api/integrations/sheets-sync",
  rowsPerRequest: 100,
  idsPerRequest: 5000,
  maxRows: 50000,
  maxColumns: 100,
  // A cell longer than this is rejected by the CRM; it is cut just past the
  // limit so the request stays small and the row is rejected on its own.
  maxCell: 5001,
  // Apps Script stops a run at 6 minutes; no new request starts after this.
  timeBudgetMs: 4.5 * 60 * 1000,
  attempts: 4,
  everyMinutes: 5,
};

function syncLeads() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.log("Another sync is still running; this run was skipped.");
    return;
  }
  try {
    runSync_(Date.now());
  } finally {
    lock.releaseLock();
  }
}

function checkSetup() {
  var crm = crmClient_();
  var config = crm.call("get", "/sources");
  console.log(
    "The CRM accepted the key. Sheets turned on: " + config.sources.length,
  );
  config.sources.forEach(function (source) {
    var sheet = openSheet_(null, source);
    if (!sheet) return;
    var values = sheet.getDataRange().getValues();
    var headings = headings_(values[0] || []);
    var missing = missingHeadings_(headings);
    console.log(
      '"' +
        source.name +
        '": ' +
        Math.max(values.length - 1, 0) +
        " rows; " +
        (missing.length
          ? "missing columns: " + missing.join(", ")
          : "the columns the CRM needs are there"),
    );
  });
}

function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger("syncLeads")
    .timeBased()
    .everyMinutes(SYNC.everyMinutes)
    .create();
  console.log("syncLeads now runs every " + SYNC.everyMinutes + " minutes.");
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "syncLeads")
      ScriptApp.deleteTrigger(trigger);
  });
}

// ------------------------------------------------------------ a run
function runSync_(started) {
  var crm = crmClient_();
  var config;
  try {
    config = crm.call("get", "/sources");
  } catch (error) {
    console.error("Sync stopped: " + describe_(error));
    return;
  }
  if (!config.sources.length) {
    console.log("No Sheets are turned on in the CRM.");
    return;
  }
  var totals = counts_();
  for (var i = 0; i < config.sources.length; i++) {
    var source = config.sources[i];
    if (outOfTime_(started)) {
      console.log(
        "Time limit reached; the remaining Sheets continue on the next run.",
      );
      break;
    }
    try {
      add_(totals, syncSource_(crm, source, config.now, started));
    } catch (error) {
      console.error('"' + source.name + '": ' + describe_(error));
      // A refused key or account stops every Sheet, not just this one.
      if (error.stopRun) break;
    }
  }
  console.log(
    "Sync finished in " +
      Math.round((Date.now() - started) / 1000) +
      " s: " +
      countsText_(totals),
  );
}

function syncSource_(crm, source, since, started) {
  var counts = counts_();
  var sheet = openSheet_(crm, source);
  if (!sheet) return counts;
  var values;
  try {
    values = sheet.getDataRange().getValues();
  } catch (error) {
    report_(crm, source, { ok: false, error: "read_failed" });
    console.error('"' + source.name + '": the Sheet could not be read.');
    return counts;
  }
  var total = Math.max(values.length - 1, 0);
  if (total > SYNC.maxRows) {
    report_(crm, source, { ok: false, error: "too_many_rows", rows: total });
    console.error(
      '"' +
        source.name +
        '": more than ' +
        SYNC.maxRows +
        " rows; move older rows to another tab.",
    );
    return counts;
  }
  var headings = headings_(values[0] || []);
  if (missingHeadings_(headings).length) {
    report_(crm, source, { ok: false, error: "headers_missing", rows: total });
    console.error(
      '"' +
        source.name +
        '": the first row needs the columns ' +
        missingHeadings_(headings).join(", ") +
        ".",
    );
    return counts;
  }
  var idColumn = column_(headings, ["id", "lead_id"]);
  var timeColumn = column_(headings, ["created_time"]);
  var from = source.import_from ? new Date(source.import_from).getTime() : null;
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var cells = values[r];
    if (cells.every(blank_)) continue;
    // Before the Sheet's start date: not sent (the CRM checks again).
    if (from !== null && timeColumn >= 0) {
      var time = submittedTime_(cells[timeColumn]);
      if (time !== null && time < from) continue;
    }
    var record = {};
    for (var c = 0; c < headings.length; c++)
      if (headings[c]) record[headings[c]] = cellText_(cells[c]);
    rows.push({ row: r + 1, id: cellText_(cells[idColumn]), values: record });
  }
  // Which rows the CRM has not imported.
  var pending = [];
  for (var start = 0; start < rows.length; start += SYNC.idsPerRequest) {
    var chunk = rows.slice(start, start + SYNC.idsPerRequest);
    var answer = crm.call("post", "/sources/" + source.id + "/pending", {
      ids: chunk.map(function (row) {
        return row.id;
      }),
    });
    answer.pending.forEach(function (position) {
      pending.push(chunk[position]);
    });
  }
  var complete = true;
  var rejected = [];
  for (var b = 0; b < pending.length; b += SYNC.rowsPerRequest) {
    if (outOfTime_(started)) {
      complete = false;
      break;
    }
    sendRows_(crm, source, pending.slice(b, b + SYNC.rowsPerRequest)).forEach(
      function (result) {
        counts[result.status] = (counts[result.status] || 0) + 1;
        if (result.status === "rejected")
          rejected.push(result.row + " (" + result.reason + ")");
      },
    );
  }
  report_(
    crm,
    source,
    counts.failed
      ? { ok: false, error: "rows_failed", rows: total }
      : { ok: true, complete: complete, rows: total, since: since },
  );
  console.log(
    '"' +
      source.name +
      '": ' +
      total +
      " rows, " +
      pending.length +
      " sent: " +
      countsText_(counts) +
      (complete ? "" : "; continues on the next run"),
  );
  if (rejected.length)
    console.log(
      '"' +
        source.name +
        '": rejected rows ' +
        rejected.slice(0, 20).join(", ") +
        (rejected.length > 20
          ? " and " + (rejected.length - 20) + " more (see the CRM)"
          : ""),
    );
  return counts;
}

// One batch; a batch too large for one request is sent in halves.
function sendRows_(crm, source, batch) {
  try {
    return crm.call("post", "/sources/" + source.id + "/rows", {
      rows: batch.map(function (row) {
        return { row: row.row, values: row.values };
      }),
    }).rows;
  } catch (error) {
    if (error.status === 413 && batch.length > 1) {
      var half = Math.ceil(batch.length / 2);
      return sendRows_(crm, source, batch.slice(0, half)).concat(
        sendRows_(crm, source, batch.slice(half)),
      );
    }
    throw error;
  }
}

function openSheet_(crm, source) {
  var spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(source.spreadsheet_id);
  } catch (error) {
    if (crm)
      report_(crm, source, { ok: false, error: "spreadsheet_unavailable" });
    console.error(
      '"' +
        source.name +
        '": the spreadsheet could not be opened. Share it with the Google account that runs this script (Viewer is enough).',
    );
    return null;
  }
  var sheet = spreadsheet.getSheetByName(source.worksheet);
  if (!sheet) {
    if (crm) report_(crm, source, { ok: false, error: "worksheet_missing" });
    console.error(
      '"' +
        source.name +
        '": the spreadsheet has no tab named "' +
        source.worksheet +
        '". Correct the tab name in the CRM.',
    );
    return null;
  }
  return sheet;
}

// The script's account of the pass, for the CRM's Google Sheets page. A
// report that fails is only logged: the rows are already safe in the CRM.
function report_(crm, source, report) {
  try {
    crm.call("post", "/sources/" + source.id + "/report", report);
  } catch (error) {
    console.error(
      '"' + source.name + '": status not recorded: ' + describe_(error),
    );
  }
}

// ------------------------------------------------------------ the CRM
function crmClient_() {
  var properties = PropertiesService.getScriptProperties();
  var base = String(properties.getProperty("CRM_BASE_URL") || "")
    .trim()
    .replace(/\/+$/, "");
  var key = String(properties.getProperty("CRM_SHEETS_KEY") || "").trim();
  // HTTPS only, so the key is never sent in the clear.
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(base))
    throw setupError_(
      "Set the Script Property CRM_BASE_URL to the CRM's https:// address, such as https://hdmarketing.tech.",
    );
  if (!/^hdcrm_sheets_[A-Za-z0-9_-]{43}$/.test(key))
    throw setupError_(
      "Set the Script Property CRM_SHEETS_KEY to the key created in the CRM.",
    );
  return {
    call: function (method, path, body) {
      return request_(base + SYNC.path + path, key, method, body);
    },
  };
}

// Retries a refused-for-now request (no connection, 429, 5xx) with a growing
// wait, or the wait the CRM asks for. Sending rows again is safe: the CRM
// answers "duplicate" for rows it already has.
function request_(url, key, method, body) {
  var lastError;
  for (var attempt = 1; attempt <= SYNC.attempts; attempt++) {
    var options = {
      method: method,
      headers: { Authorization: "Bearer " + key },
      muteHttpExceptions: true,
      followRedirects: false,
      validateHttpsCertificates: true,
    };
    if (body !== undefined) {
      options.contentType = "application/json";
      options.payload = JSON.stringify(body);
    }
    var response;
    try {
      response = UrlFetchApp.fetch(url, options);
    } catch (error) {
      lastError = crmError_(0, "The CRM could not be reached.", null, true);
      if (attempt < SYNC.attempts) wait_(attempt, null);
      continue;
    }
    var status = response.getResponseCode();
    var data = {};
    try {
      data = JSON.parse(response.getContentText() || "{}");
    } catch (error) {
      data = {};
    }
    if (status >= 200 && status < 300) return data;
    var retry = status === 429 || status >= 500;
    lastError = crmError_(
      status,
      data.error || "The CRM answered " + status + ".",
      data.code,
      retry,
    );
    if (!retry) throw lastError;
    if (attempt < SYNC.attempts) {
      var headers = response.getHeaders() || {};
      wait_(attempt, headers["Retry-After"] || headers["retry-after"]);
    }
  }
  throw lastError;
}

function wait_(attempt, retryAfter) {
  var seconds = Number(retryAfter);
  var ms =
    seconds > 0
      ? Math.min(seconds, 30) * 1000
      : Math.min(Math.pow(2, attempt) * 1000, 20000);
  Utilities.sleep(ms + Math.floor(Math.random() * 1000));
}

function crmError_(status, message, code, retry) {
  var error = new Error(message);
  error.status = status;
  error.code = code || null;
  error.retry = retry;
  // The key, its administrator or HTTPS was refused: no Sheet can sync.
  error.stopRun =
    status === 401 ||
    code === "SHEETS_KEY_OWNER_INACTIVE" ||
    code === "SHEETS_HTTPS_REQUIRED";
  return error;
}

function setupError_(message) {
  var error = new Error(message);
  error.stopRun = true;
  return error;
}

function describe_(error) {
  return (
    String((error && error.message) || error) +
    (error && error.status ? " (HTTP " + error.status + ")" : "")
  );
}

// ------------------------------------------------------------ the Sheet
// Headings as written, trimmed; a repeated heading gets " (2)", " (3)".
function headings_(row) {
  var seen = {};
  var kept = 0;
  return row.map(function (cell) {
    var heading = cellText_(cell).slice(0, 200);
    if (!heading || kept >= SYNC.maxColumns) return "";
    kept++;
    var key = heading.toLowerCase();
    seen[key] = (seen[key] || 0) + 1;
    return seen[key] > 1 ? heading + " (" + seen[key] + ")" : heading;
  });
}

// As the CRM compares headings: case and spacing ignored.
function headingKey_(heading) {
  return String(heading).trim().toLowerCase().replace(/\s+/g, "_");
}

function column_(headings, names) {
  for (var n = 0; n < names.length; n++)
    for (var c = 0; c < headings.length; c++)
      if (headings[c] && headingKey_(headings[c]) === names[n]) return c;
  return -1;
}

function missingHeadings_(headings) {
  var missing = [];
  if (column_(headings, ["id", "lead_id"]) < 0) missing.push("id");
  if (column_(headings, ["phone_number", "phone"]) < 0)
    missing.push("phone_number");
  if (column_(headings, ["full_name", "name", "first_name"]) < 0)
    missing.push("full_name");
  return missing;
}

// Cells as text: dates as ISO time, whole numbers without exponent or
// decimals (a phone number typed as a number stays a phone number).
function cellText_(value) {
  if (value === null || value === undefined) return "";
  if (Object.prototype.toString.call(value) === "[object Date]")
    return isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "number")
    return Number.isInteger(value) && Math.abs(value) < 1e21
      ? value.toFixed(0)
      : String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value).trim().slice(0, SYNC.maxCell);
}

function blank_(value) {
  return value === "" || value === null || value === undefined;
}

// Meta's created_time (2026-11-01T10:15:30+0500) or a date cell; a time
// without a zone is Pakistan time. Null when unreadable.
function submittedTime_(value) {
  if (Object.prototype.toString.call(value) === "[object Date]")
    return isNaN(value.getTime()) ? null : value.getTime();
  var m =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      String(value || "").trim(),
    );
  if (!m) return null;
  var zone = !m[3]
    ? "+05:00"
    : m[3].toUpperCase() === "Z"
      ? "Z"
      : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  var time = new Date(
    m[1] + "T" + m[2].replace(/(\.\d{3})\d+$/, "$1") + zone,
  ).getTime();
  return isNaN(time) ? null : time;
}

function outOfTime_(started) {
  return Date.now() - started > SYNC.timeBudgetMs;
}

// ------------------------------------------------------------ counts
function counts_() {
  return {
    inserted: 0,
    existing: 0,
    duplicate: 0,
    skipped: 0,
    rejected: 0,
    failed: 0,
  };
}

function add_(totals, counts) {
  Object.keys(counts).forEach(function (key) {
    totals[key] = (totals[key] || 0) + counts[key];
  });
}

function countsText_(counts) {
  return (
    counts.inserted +
    " new leads, " +
    counts.existing +
    " repeat inquiries, " +
    counts.rejected +
    " rejected, " +
    counts.failed +
    " failed" +
    (counts.duplicate ? ", " + counts.duplicate + " already imported" : "") +
    (counts.skipped ? ", " + counts.skipped + " before the start date" : "")
  );
}
