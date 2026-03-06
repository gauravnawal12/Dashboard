// ================================================================
// HELIX INDUSTRIES — Google Apps Script Bridge v6
// ================================================================
//
// ╔══════════════════════════════════════════════════════════════╗
// ║  ⚠️  IMPORTANT: YOU MUST CREATE A NEW DEPLOYMENT EVERY TIME ║
// ║  YOU EDIT THIS SCRIPT. "Manage deployments" → editing an    ║
// ║  existing one does NOT update the /exec URL behaviour.      ║
// ║  Always use Deploy → New deployment → Web app.              ║
// ╚══════════════════════════════════════════════════════════════╝
//
// TIME FIX (v6): Time cells in Google Sheets are stored as Date
// objects with year 1899 (the spreadsheet epoch). We detect this
// by checking getFullYear() <= 1900, then format using getHours()
// and getMinutes() directly — NO Utilities.formatDate() for time.
// This avoids all timezone/format ambiguity.
//
// Real date cells (year > 1900) are formatted as "dd MMM yyyy".
//
// SETUP:
//   script.google.com → New project → paste this → fill Sheet IDs
//   Deploy → New deployment → Web app
//   Execute as: Me | Who has access: Anyone → Deploy → Authorise
//   Copy the /exec URL → paste in dashboard Connect dialog
// ================================================================

// STEP A: PASTE YOUR SPREADSHEET IDs HERE
var INWARD_SHEET_ID     = "PASTE_INWARD_SPREADSHEET_ID_HERE";
var DISPATCH_SHEET_ID   = "PASTE_DISPATCH_SPREADSHEET_ID_HERE";
var PRODUCTION_SHEET_ID = "PASTE_PRODUCTION_SPREADSHEET_ID_HERE";

/**
 * Entry point — called by Google when the /exec URL is fetched.
 * Supports JSONP via ?callback= parameter for browser usage.
 */
function doGet(e) {
  var param    = (e && e.parameter) ? e.parameter : {};
  var register = String(param.register || "").trim();
  var tabName  = String(param.tab      || "").trim();
  var callback = String(param.callback || "").trim();
  var result   = run(register, tabName);
  var json     = JSON.stringify(result);
  // Return JSONP if a callback name was supplied, plain JSON otherwise
  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + json + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Main dispatcher — routes to the correct sheet reader.
 * @param {string} register  "inward" | "dispatch" | "production" | "__ping__"
 * @param {string} tabName   Exact sheet tab name e.g. "Inward", "Mar-26"
 */
function run(register, tabName) {
  // Ping — used by the dashboard to test the connection
  if (register === "__ping__") return { ok: true, msg: "Connected!" };

  try {
    var sheetId =
      register === "inward"     ? INWARD_SHEET_ID :
      register === "dispatch"   ? DISPATCH_SHEET_ID :
      register === "production" ? PRODUCTION_SHEET_ID : null;

    if (!sheetId) return { error: "Unknown register: " + register };

    var ss    = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      var avail = ss.getSheets().map(function(s) { return s.getName(); }).join(", ");
      return { error: "Tab [" + tabName + "] not found. Available: " + avail };
    }

    // Production sheet has a special multi-date-column structure
    if (register === "production") return readProductionSheet(sheet, tabName);

    // Standard flat sheet (Inward / Dispatch)
    return readFlatSheet(sheet, tabName);

  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Read a standard flat sheet where row 0 = headers, rows 1+ = data.
 *
 * TIME FIX: For each cell that is a Date object, we check the column
 * header name. If the header is "Time" (case-insensitive) we format
 * the value as "HH:mm". Otherwise we format it as "dd MMM yyyy".
 * This correctly handles both time-only cells (epoch date + time) and
 * proper date cells (real date + midnight time).
 */
function readFlatSheet(sheet, tabName) {
  var rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return { data: [], tab: tabName, count: 0 };

  var tz      = Session.getScriptTimeZone();
  var headers = rows[0].map(function(h) { return String(h || "").trim(); });
  var data    = [];

  for (var i = 1; i < rows.length; i++) {
    var row     = rows[i];
    // Skip completely empty rows
    var hasData = row.some(function(c) { return c !== "" && c !== null && c !== undefined; });
    if (!hasData) continue;

    var obj = {};
    for (var k = 0; k < headers.length; k++) {
      if (!headers[k]) continue;
      var val = row[k];

      if (val instanceof Date) {
        // ── DEFINITIVE TIME FIX ───────────────────────────────────────────────────
        // Detect time-only cells by checking the year of the Date object.
        // In Google Sheets, time-only values use the spreadsheet epoch:
        //   30 December 1899 (year = 1899 or 1900 depending on GAS version).
        // Regular date cells have year >= 1900 (usually 2000s).
        //
        // We do NOT rely on the column header name ("Time") because:
        //   - Column names may vary (e.g. "Entry Time", "TIME", etc.)
        //   - It is fragile and was the cause of previous bugs.
        //
        // Instead: year <= 1900 => time-only cell => format as "HH:mm"
        //           year >  1900 => real date cell  => format as "dd MMM yyyy"
        //
        // We use getHours()/getMinutes() directly on the GAS Date object
        // rather than Utilities.formatDate() to avoid timezone conversion
        // issues. GAS Date methods return values in the script timezone.
        // ────────────────────────────────────────────────────────────────────────
        if (val.getFullYear() <= 1900) {
          // Time-only cell (spreadsheet epoch date)
          var hh = String(val.getHours()).padStart ? String(val.getHours()) : ("0"+val.getHours()).slice(-2);
          var mm = val.getMinutes() < 10 ? "0"+val.getMinutes() : ""+val.getMinutes();
          if (hh.length < 2) hh = "0" + hh;
          val = hh + ":" + mm;
        } else {
          // Real date cell
          val = Utilities.formatDate(val, tz, "dd MMM yyyy");
        }
        // ────────────────────────────────────────────────────────────────────────
      }

      obj[headers[k]] = (val === null || val === undefined) ? "" : val;
    }
    data.push(obj);
  }

  return { data: data, tab: tabName, count: data.length };
}

/**
 * Read the Production sheet which has a special structure:
 *   Row 1 : date headers (sparse — one Date per Prod/Disp column pair)
 *   Row 2 : fixed column headers (Machine Name, Product, etc.)
 *   Row 3+: data rows
 *
 * Finds yesterdays date column, filters rows where Prod > 0.
 */
function readProductionSheet(sheet, tabName) {
  var tz   = Session.getScriptTimeZone();
  var vals = sheet.getDataRange().getValues();
  if (vals.length < 3) return { data: [], tab: tabName, count: 0 };

  var dateRow   = vals[0];
  var headerRow = vals[1];

  // Build a midnight-only Date for yesterday for comparison
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var yDate = new Date(
    yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()
  );

  // Scan Row 1 for a date cell that matches yesterday
  var prodColIdx = -1, dispColIdx = -1;
  for (var c = 0; c < dateRow.length; c++) {
    if (dateRow[c] instanceof Date) {
      var cd = new Date(
        dateRow[c].getFullYear(), dateRow[c].getMonth(), dateRow[c].getDate()
      );
      if (cd.getTime() === yDate.getTime()) {
        prodColIdx = c;
        dispColIdx = c + 1;
        break;
      }
    }
  }

  // Map fixed column positions from Row 2 headers
  var fc = { machine:-1, product:-1, thickness:-1, grade:-1, colour:-1,
             opening:-1, tp:-1, td:-1, closing:-1 };
  for (var h = 0; h < headerRow.length; h++) {
    var hdr = String(headerRow[h] || "").trim().toLowerCase();
    if (hdr === "machine name") fc.machine   = h;
    if (hdr === "product")      fc.product   = h;
    if (hdr === "thickness")    fc.thickness = h;
    if (hdr === "grade")        fc.grade     = h;
    if (hdr === "colour")       fc.colour    = h;
    if (hdr === "opening")      fc.opening   = h;
    if (hdr === "tp")           fc.tp        = h;
    if (hdr === "td")           fc.td        = h;
    if (hdr === "closing")      fc.closing   = h;
  }

  var yestStr = Utilities.formatDate(yesterday, tz, "dd MMM yyyy");
  var data    = [];

  for (var r = 2; r < vals.length; r++) {
    var row     = vals[r];
    var hasData = row.some(function(c) { return c !== "" && c !== null && c !== undefined; });
    if (!hasData) continue;

    var prodVal = (prodColIdx >= 0) ? (parseFloat(row[prodColIdx]) || 0) : 0;
    if (prodVal === 0) continue; // Skip rows with no production yesterday

    var dispVal = (dispColIdx >= 0) ? (parseFloat(row[dispColIdx]) || 0) : 0;
    var col     = function(idx) { return idx < 0 ? "" : (row[idx] === null ? "" : row[idx]); };

    data.push({
      "date":         yestStr,
      "Machine Name": col(fc.machine),
      "Product":      col(fc.product),
      "Thickness":    col(fc.thickness),
      "Grade":        col(fc.grade),
      "Colour":       col(fc.colour),
      "Opening":      parseFloat(col(fc.opening)) || 0,
      "Prod":         prodVal,
      "Disp":         dispVal,
      "TP":           parseFloat(col(fc.tp))      || 0,
      "TD":           parseFloat(col(fc.td))      || 0,
      "Closing":      parseFloat(col(fc.closing)) || 0
    });
  }

  // If yesterday was not found, return helpful debug info
  if (prodColIdx < 0) {
    var availDates = dateRow
      .filter(function(c) { return c instanceof Date; })
      .map(function(c) { return Utilities.formatDate(c, tz, "dd MMM yyyy"); });
    return {
      data:  [],
      tab:   tabName,
      count: 0,
      debug: "Yesterday (" + yestStr + ") not in sheet. Available: " + availDates.join(", ")
    };
  }

  return { data: data, tab: tabName, count: data.length };
}