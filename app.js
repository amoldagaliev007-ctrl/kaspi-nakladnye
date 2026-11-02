/* Сборщик накладных Kaspi — всё работает в браузере, без сервера.
   Порт invoice_merger/core.py + layouts.py. ES2019, без Iterator helpers / findLast / at(). */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var ALL = "__all__";
  var MM = 72 / 25.4;
  var A4 = [595.276, 841.89];
  var FORMATS = {
    a4: { suffix: "A4" }, a4_nup: { suffix: "A4x{n}" },
    thermal_100x150: { suffix: "100x150", size: [100 * MM, 150 * MM] },
    thermal_75x120: { suffix: "75x120", size: [75 * MM, 120 * MM] }
  };
  var NUP_GRID = { 2: [1, 2], 4: [2, 2], 6: [2, 3], 8: [2, 4], 16: [4, 4] };
  var HIST_KEY = "kaspiHistory", POINTS_KEY = "kaspiPoints", FMT_KEY = "kaspiFormat";

  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  var PDFJS_OPTS = { cMapUrl: new URL("vendor/cmaps/", location.href).href, cMapPacked: true, standardFontDataUrl: new URL("vendor/standard_fonts/", location.href).href,
    isEvalSupported: false, disableFontFace: false, useSystemFonts: false };

  var state = { format: "a4", perSheet: 4, files: [], docs: [], sourceName: "", points: [], selected: [ALL],
    last: null /* {base, source(Uint8Array), outName, outBytes} */ };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function showError(msg) { $("error").textContent = msg || ""; $("error").classList.toggle("hidden", !msg); }
  function busy(on, text) { $("progress").classList.toggle("hidden", !on); if (text) $("progressText").textContent = text; }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function todayKey() { var d = new Date(); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function nowHM() { var d = new Date(); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  function cmpRu(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase(), "ru"); }
  function uniq(arr) { var o = []; arr.forEach(function (x) { if (o.indexOf(x) < 0) o.push(x); }); return o; }

  // ---------- извлечение полей (порт core.py) ----------
  var L = "A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі";
  var CITY = "[" + L + "][" + L + " .\\-]*?";
  var PICKUP_LINE_RE = new RegExp("^\\s*(" + CITY + ")\\s+[-–—−]\\s+([A-Za-z0-9_]{2,})\\s*(?:\\(([^)]*)\\))?\\s*$");
  var ITEM_LINE_RE = /^\s*\d{1,2}\.\s+\S/;
  var LABEL_RE = new RegExp("(?:пункт\\s+(?:выдачи|приема|приёма)|склад|ПВЗ)\\s*[:\\-]?\\s*(" + CITY + ")\\s+[-–—−]\\s+([A-Za-z0-9_]{2,})", "i");
  var ORDER_PATTERNS = [
    /^\s*(\d[\d ]{6,}\d-\d+)\s*$/im,
    /номер\s+заказа\s*[:№#]?\s*([A-ZА-Я0-9\-]{5,})/im,
    /заказ\s*[№#:]\s*([A-ZА-Я0-9\-]{5,})/im,
    /накладн[A-Za-zА-Яа-яЁё0-9_]*\s*[№#:]\s*([A-ZА-Я0-9\-]{5,})/im,
    /order\s*(?:no\.?|number|#)?\s*[:.]?\s*([A-Z0-9\-]{5,})/im
  ];

  function niceCity(c) { return c.split(/\s+/).filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }).join(" "); }
  function makePoint(city, code) {
    city = city.replace(/\s+/g, " ").trim(); code = code.trim().toUpperCase();
    return { key: city.toLowerCase() + "|" + code, city: niceCity(city), code: code, display: niceCity(city) + " - " + code };
  }
  function extractPickupPoint(text) {
    var lines = text.split("\n"), i, m, itemIdx = -1;
    for (i = 0; i < lines.length; i++) if (ITEM_LINE_RE.test(lines[i])) { itemIdx = i; break; }
    if (itemIdx >= 0) {
      for (i = itemIdx - 1; i >= Math.max(0, itemIdx - 3); i--) {
        m = PICKUP_LINE_RE.exec(lines[i]); if (m) return makePoint(m[1], m[2]);
      }
    }
    for (i = 0; i < lines.length; i++) { m = PICKUP_LINE_RE.exec(lines[i]); if (m && m[3] !== undefined) return makePoint(m[1], m[2]); }
    m = LABEL_RE.exec(text); if (m) return makePoint(m[1], m[2]);
    return null;
  }
  function extractOrderId(text) {
    for (var i = 0; i < ORDER_PATTERNS.length; i++) { var m = ORDER_PATTERNS[i].exec(text); if (m) return m[1].replace(/\s+/g, "").toUpperCase(); }
    return null;
  }
  function cleanProduct(name) {
    name = name.replace(/\s*\d+\s*шт\.?\s*$/i, "").replace(/(?:\s*\.){2,}\s*$/, "").replace(/\s*\d+[.,]\d+\s*$/, "");
    return name.replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "");
  }
  function extractProductName(text, fallback) {
    var lines = text.split("\n"), i, m, n;
    for (i = 0; i < lines.length; i++) { m = /^\s*1\.\s*(.+)$/.exec(lines[i]); if (m) { n = cleanProduct(m[1]); if (n.length > 1) return n; } }
    for (i = 0; i < lines.length; i++) { var k = lines[i].indexOf("1."); if (k >= 0) { n = cleanProduct(lines[i].slice(k + 2)); if (n.length > 1) return n; } }
    return "Документ_" + fallback.replace(/\.[^.]*$/, "");
  }

  // Текст страницы по позициям (как pdfplumber): элементы режутся на символы, строки группируются
  // по верхнему краю (top) с допуском 4pt, внутри строки — по x; пробел, если зазор > 0.12 кегля.
  function pageText(content) {
    var chars = [];
    content.items.forEach(function (it) {
      if (!it.str) return;
      var size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      var n = it.str.length, cw = n ? (it.width || 0) / n : 0, x0 = it.transform[4], y = it.transform[5];
      for (var i = 0; i < n; i++) chars.push({ c: it.str.charAt(i), x: x0 + i * cw, w: cw, top: y + 0.8 * size, size: size });
    });
    chars = chars.filter(function (c) { return c.c.trim(); }).sort(function (a, b) { return b.top - a.top || a.x - b.x; });
    var lines = [];
    chars.forEach(function (ch) {
      var line = null;
      for (var i = 0; i < lines.length; i++) if (Math.abs(lines[i].top - ch.top) <= 4) { line = lines[i]; break; }
      if (!line) { line = { top: ch.top, chars: [] }; lines.push(line); }
      line.chars.push(ch);
    });
    lines.sort(function (a, b) { return b.top - a.top; });
    return lines.map(function (l) {
      l.chars.sort(function (a, b) { return a.x - b.x; });
      var out = "", end = null;
      l.chars.forEach(function (ch) {
        if (end !== null && ch.x - end > Math.max(1, 0.12 * ch.size)) out += " ";
        out += ch.c; end = ch.x + ch.w;
      });
      return out.replace(/(\d)\s*-\s*(\d)/g, "$1-$2").replace(/\s+/g, " ").trim();
    }).join("\n");
  }

  async function extractText(bytes) {
    var pdf = await pdfjsLib.getDocument(Object.assign({ data: bytes.slice() }, PDFJS_OPTS)).promise;
    var parts = [];
    try {
      for (var p = 1; p <= pdf.numPages; p++) { var page = await pdf.getPage(p); var t = pageText(await page.getTextContent()); if (t) parts.push(t); }
    } finally { pdf.destroy(); }
    return parts.join("\n");
  }

  async function sha256(bytes) {
    if (window.crypto && crypto.subtle) {
      var h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return Array.prototype.map.call(h, function (b) { return (b < 16 ? "0" : "") + b.toString(16); }).join("");
    }
    var h1 = 0x811c9dc5, h2 = 0x01000193; // запасной вариант без secure context
    for (var i = 0; i < bytes.length; i++) { h1 = Math.imul(h1 ^ bytes[i], 16777619); h2 = Math.imul(h2 ^ bytes[i], 2246822519); }
    return "fnv" + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + bytes.length;
  }

  // ---------- чтение файлов ----------
  function decodeName(bytes) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { }
    try { return new TextDecoder("ibm866").decode(bytes); } catch (e) { }
    return Array.prototype.map.call(bytes, function (b) { return String.fromCharCode(b); }).join("");
  }
  function baseName(p) { return p.split(/[\\/]/).pop(); }

  async function collectPdfs(files) {
    var out = [];
    for (var f = 0; f < files.length; f++) {
      var file = files[f], lower = file.name.toLowerCase();
      if (lower.endsWith(".pdf")) out.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      else if (lower.endsWith(".zip")) {
        busy(true, "Распаковываю «" + file.name + "»…");
        var zip = await JSZip.loadAsync(await file.arrayBuffer(), { decodeFileName: decodeName });
        var entries = [];
        zip.forEach(function (path, entry) { if (!entry.dir && path.toLowerCase().endsWith(".pdf") && path.indexOf("__MACOSX") < 0) entries.push(entry); });
        for (var i = 0; i < entries.length; i++) out.push({ name: baseName(entries[i].name), bytes: await entries[i].async("uint8array") });
      }
    }
    return out;
  }

  async function inspectAll(pdfs) {
    var docs = [];
    for (var i = 0; i < pdfs.length; i++) {
      if (i === 0 || i === pdfs.length - 1 || i % 5 === 0) busy(true, "Читаю накладные " + (i + 1) + "/" + pdfs.length + "…");
      try {
        var text = await extractText(pdfs[i].bytes), pt = extractPickupPoint(text);
        docs.push({ bytes: pdfs[i].bytes, inv: { filename: pdfs[i].name, product_name: extractProductName(text, pdfs[i].name),
          content_hash: await sha256(pdfs[i].bytes), order_id: extractOrderId(text), is_new: true, processed_at: null,
          pickup_key: pt ? pt.key : null, pickup: pt ? pt.display : null, scope: "point" } });
      } catch (e) { console.warn("Не читается", pdfs[i].name, e); }
    }
    return docs;
  }

  // ---------- история за день (как DailyHistory) ----------
  function loadHist() { try { var h = JSON.parse(localStorage.getItem(HIST_KEY) || "{}"); return h && typeof h === "object" ? h : {}; } catch (e) { return {}; } }
  function dayState() { var d = loadHist()[todayKey()] || {}; return { invoices: d.invoices || [], batches: d.batches || [] }; }
  function saveDay(st) {
    var h = loadHist(), today = todayKey(), keep = {};
    Object.keys(h).sort().slice(-6).forEach(function (k) { keep[k] = h[k]; }); // храним неделю
    keep[today] = st; localStorage.setItem(HIST_KEY, JSON.stringify(keep));
  }
  function identityKeys(inv) { var k = ["hash:" + inv.content_hash]; if (inv.order_id) k.push("order:" + inv.order_id); return k; }
  function seenKeys(st, onlyPoint) {
    var s = {}; st.invoices.forEach(function (inv) {
      if (onlyPoint && (inv.scope || "point") !== "point") return;
      identityKeys(inv).forEach(function (k) { s[k] = 1; });
    }); return s;
  }

  // ---------- форматы (порт layouts.py) ----------
  function normalizeFormat(fmt, n) {
    fmt = FORMATS[fmt] ? fmt : "a4"; n = parseInt(n || 4, 10); if (!NUP_GRID[n]) n = 4;
    return [fmt, fmt === "a4_nup" ? n : 1];
  }
  function formatSuffix(fmt, n) { return FORMATS[fmt].suffix.replace("{n}", n); }

  // Рамка содержимого по пикселям (рендер pdf.js), в координатах PDF; null — обрезать не нужно.
  async function contentBoxes(bytes, padPt) {
    padPt = padPt || 6;
    var pdf = await pdfjsLib.getDocument(Object.assign({ data: bytes.slice() }, PDFJS_OPTS)).promise, boxes = [];
    try {
      for (var p = 1; p <= pdf.numPages; p++) {
        var page = await pdf.getPage(p);
        if (page.rotate) { boxes.push(null); continue; }
        var scale = 1, vp = page.getViewport({ scale: scale, rotation: 0 });
        var cv = document.createElement("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
        var ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        var d = ctx.getImageData(0, 0, cv.width, cv.height).data, W = cv.width, H = cv.height;
        var x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
          var o = (y * W + x) * 4; if (d[o] < 245 || d[o + 1] < 245 || d[o + 2] < 245) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        cv.width = cv.height = 0;
        if (x1 < 0) { boxes.push(null); continue; }
        var pw = W / scale, ph = H / scale;
        var bx0 = Math.max(x0 / scale - padPt, 0), bx1 = Math.min((x1 + 1) / scale + padPt, pw);
        var top = Math.max(y0 / scale - padPt, 0), bottom = Math.min((y1 + 1) / scale + padPt, ph);
        if ((bx1 - bx0) * (bottom - top) > 0.6 * pw * ph) { boxes.push(null); continue; }
        var v = page.view; // [x0, y0, x1, y1] страницы
        boxes.push({ left: v[0] + bx0, bottom: v[1] + ph - bottom, right: v[0] + bx1, top: v[1] + ph - top });
      }
    } finally { pdf.destroy(); }
    return boxes;
  }

  async function renderLayout(sourceBytes, fmt, n) {
    var nf = normalizeFormat(fmt, n); fmt = nf[0]; n = nf[1];
    var PDFLib = window.PDFLib, src = await PDFLib.PDFDocument.load(sourceBytes, { ignoreEncryption: true });
    var out = await PDFLib.PDFDocument.create(), pages = src.getPages();
    if (fmt === "a4") {
      (await out.copyPages(src, src.getPageIndices())).forEach(function (pg) { out.addPage(pg); });
      return out.save();
    }
    var crops = await contentBoxes(sourceBytes);
    async function embed(i) {
      var pg = pages[i], mb = pg.getMediaBox(), c = crops[i];
      var box = c || { left: mb.x, bottom: mb.y, right: mb.x + mb.width, top: mb.y + mb.height };
      var e = await out.embedPage(pg, box);
      return { e: e, w: box.right - box.left, h: box.top - box.bottom };
    }
    function place(sheet, em, x, y, w, h, margin) {
      var aw = w - 2 * margin, ah = h - 2 * margin, s = Math.min(aw / em.w, ah / em.h);
      sheet.drawPage(em.e, { x: x + margin + (aw - em.w * s) / 2, y: y + margin + (ah - em.h * s) / 2, xScale: s, yScale: s });
    }
    var i;
    if (fmt === "a4_nup") {
      var g = NUP_GRID[n], cols = g[0], rows = g[1], cw = A4[0] / cols, ch = A4[1] / rows;
      for (var start = 0; start < pages.length; start += n) {
        var sheet = out.addPage([A4[0], A4[1]]);
        for (i = start; i < Math.min(start + n, pages.length); i++) {
          var k = i - start, col = k % cols, row = Math.floor(k / cols);
          place(sheet, await embed(i), col * cw, A4[1] - (row + 1) * ch, cw, ch, 4);
        }
      }
    } else {
      var sz = FORMATS[fmt].size;
      for (i = 0; i < pages.length; i++) place(out.addPage([sz[0], sz[1]]), await embed(i), 0, 0, sz[0], sz[1], 2 * MM);
    }
    return out.save();
  }

  async function mergePdfs(list) {
    var out = await PDFLib.PDFDocument.create();
    for (var i = 0; i < list.length; i++) {
      var d = await PDFLib.PDFDocument.load(list[i], { ignoreEncryption: true });
      (await out.copyPages(d, d.getPageIndices())).forEach(function (pg) { out.addPage(pg); });
    }
    return out.save();
  }

  function pointsLabel(codes, allSel) {
    if (allSel && codes.length !== 1) return "ALL";
    return codes.slice(0, 4).map(function (c) { return c.replace(/[^A-Za-z0-9_]/g, ""); }).join("+") || "ALL";
  }

  // ---------- сборка (порт process_zip) ----------
  async function processDocs(points, fmt, n) {
    var wanted = points.filter(function (p) { return p && p !== ALL; }).map(function (p) { return p.toLowerCase(); });
    var allSel = wanted.length === 0, st = dayState(), seen = seenKeys(st, !allSel), batchNo = st.batches.length + 1;
    var total = state.totalPdfs;
    var matched = state.docs.filter(function (d) { return d.inv.pickup_key && (allSel || wanted.indexOf(d.inv.pickup_key.toLowerCase()) >= 0); })
      .map(function (d) { return { bytes: d.bytes, inv: Object.assign({}, d.inv) }; });
    var names = uniq(matched.map(function (d) { return d.inv.pickup; })).sort(cmpRu);
    var codes = uniq(matched.map(function (d) { return d.inv.pickup_key.split("|")[1]; })).sort();
    var label = names.length ? names.join(", ") : "выбранного пункта";
    var fresh = [], dups = [];
    matched.forEach(function (d) {
      var keys = identityKeys(d.inv);
      if (keys.some(function (k) { return seen[k]; })) { d.inv.is_new = false; dups.push(d.inv); }
      else { d.inv.is_new = true; d.inv.scope = allSel ? "all" : "point"; fresh.push(d); keys.forEach(function (k) { seen[k] = 1; }); }
    });
    fresh.sort(function (a, b) { return cmpRu(a.inv.product_name, b.inv.product_name); });
    var newInv = fresh.map(function (d) { return d.inv; });
    if (newInv.length) {
      codes = uniq(newInv.map(function (i) { return i.pickup_key.split("|")[1]; })).sort();
      names = uniq(newInv.map(function (i) { return i.pickup; })).sort(cmpRu);
    }
    var res = { total_pdfs: total, matched: matched.length, new_invoices: newInv, duplicates: dups, points: names, output_name: null, message: "" };
    if (fresh.length) {
      busy(true, "Собираю PDF из " + fresh.length + " новых накладных…");
      var nf = normalizeFormat(fmt, n), base = "Накладные_" + pointsLabel(codes, allSel) + "_" + todayKey() + "_партия" + batchNo;
      var source = await mergePdfs(fresh.map(function (d) { return d.bytes; }));
      var outBytes = await renderLayout(source, nf[0], nf[1]);
      res.output_name = base + "_" + formatSuffix(nf[0], nf[1]) + ".pdf";
      state.last = { base: base, source: source, outName: res.output_name, outBytes: outBytes };
      idbPut("last", { base: base, source: source });
      res.message = "Партия " + batchNo + " (" + label + "): файлов " + total + " PDF, выбрано " + matched.length +
        ", новых " + newInv.length + ", уже были сегодня " + dups.length + ".";
      var stamp = nowHM();
      newInv.forEach(function (i) { i.processed_at = i.processed_at || stamp; i.is_new = false; st.invoices.push(i); });
      st.batches.push({ zip_name: state.sourceName, created_at: stamp, new_count: newInv.length, duplicate_count: dups.length, pdf_name: res.output_name, points: names });
      saveDay(st);
    } else if (matched.length) res.message = "Файлов " + total + " PDF, накладных «" + label + "» " + matched.length + ". Все они уже собраны сегодня — печатать нечего.";
    else res.message = "Файлов " + total + " PDF, но накладных выбранного пункта нет.";
    return res;
  }

  // ---------- IndexedDB для пересборки после перезагрузки ----------
  function idb() { return new Promise(function (ok, bad) { var r = indexedDB.open("kaspi_web", 1); r.onupgradeneeded = function () { r.result.createObjectStore("kv"); }; r.onsuccess = function () { ok(r.result); }; r.onerror = function () { bad(r.error); }; }); }
  function idbPut(k, v) { return idb().then(function (db) { return new Promise(function (ok) { var t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = ok; t.onerror = ok; }); }).catch(function () { }); }
  function idbGet(k) { return idb().then(function (db) { return new Promise(function (ok) { var r = db.transaction("kv").objectStore("kv").get(k); r.onsuccess = function () { ok(r.result); }; r.onerror = function () { ok(null); }; }); }).catch(function () { return null; }); }
  function idbClear() { return idb().then(function (db) { db.transaction("kv", "readwrite").objectStore("kv").clear(); }).catch(function () { }); }

  // ---------- UI ----------
  function setActive(group, btn) { document.querySelectorAll(group + " button").forEach(function (x) { x.classList.toggle("active", x === btn); }); }
  function applyFormat() {
    document.querySelectorAll("#formatGroup button").forEach(function (b) { b.classList.toggle("active", b.dataset.format === state.format); });
    document.querySelectorAll("#perSheetGroup button").forEach(function (b) { b.classList.toggle("active", Number(b.dataset.n) === state.perSheet); });
    $("perSheetGroup").classList.toggle("hidden", state.format !== "a4_nup");
    try { localStorage.setItem(FMT_KEY, JSON.stringify([state.format, state.perSheet])); } catch (e) { }
  }
  document.querySelectorAll("#formatGroup button").forEach(function (b) { b.onclick = function () { state.format = b.dataset.format; applyFormat(); }; });
  document.querySelectorAll("#perSheetGroup button").forEach(function (b) { b.onclick = function () { state.perSheet = Number(b.dataset.n); applyFormat(); }; });
  try { var f = JSON.parse(localStorage.getItem(FMT_KEY) || "null"); if (f) { state.format = FORMATS[f[0]] ? f[0] : "a4"; state.perSheet = NUP_GRID[f[1]] ? f[1] : 4; } } catch (e) { }
  applyFormat();

  var dz = $("dropzone");
  ["dragenter", "dragover"].forEach(function (e) { dz.addEventListener(e, function (ev) { ev.preventDefault(); dz.classList.add("drag"); }); });
  ["dragleave", "drop"].forEach(function (e) { dz.addEventListener(e, function (ev) { ev.preventDefault(); dz.classList.remove("drag"); }); });
  dz.addEventListener("drop", function (ev) { var fs = Array.prototype.slice.call(ev.dataTransfer.files); if (fs.length) load(fs); });
  $("fileInput").onchange = function (ev) { var fs = Array.prototype.slice.call(ev.target.files); if (fs.length) load(fs); ev.target.value = ""; };

  function savedPoints() { try { var v = JSON.parse(localStorage.getItem(POINTS_KEY) || "null"); return Array.isArray(v) ? v : null; } catch (e) { return null; } }

  async function load(files) {
    showError("");
    var ok = files.filter(function (f) { return /\.(zip|pdf)$/i.test(f.name); });
    if (!ok.length) return showError("Нужен ZIP-архив или PDF-файлы накладных.");
    try {
      var pdfs = await collectPdfs(ok);
      state.totalPdfs = pdfs.length;
      state.sourceName = ok.length === 1 ? ok[0].name : ok.length + " файлов";
      state.docs = await inspectAll(pdfs);
      var counts = {}, names = {}, unknown = 0;
      state.docs.forEach(function (d) { var k = d.inv.pickup_key; if (k) { counts[k] = (counts[k] || 0) + 1; names[k] = d.inv.pickup; } else unknown++; });
      unknown += pdfs.length - state.docs.length;
      state.points = Object.keys(counts).map(function (k) { return { key: k, display: names[k], code: k.split("|")[1], count: counts[k] }; })
        .sort(function (a, b) { return b.count - a.count || cmpRu(a.display, b.display); });
      var remembered = savedPoints() || [], keys = state.points.map(function (p) { return p.key; });
      var pick = remembered.filter(function (k) { return keys.indexOf(k) >= 0; });
      state.selected = remembered.indexOf(ALL) >= 0 || !pick.length || state.points.length === 1 ? [ALL] : pick;
      $("scanInfo").textContent = "· " + state.sourceName + ": " + pdfs.length + " PDF" + (unknown ? ", без пункта " + unknown : "");
      renderPoints(); $("pointsCard").classList.remove("hidden");
      if (!state.points.length) showError("Не найдено ни одной накладной с пунктом приема.");
    } catch (e) { console.error(e); showError("Не удалось прочитать файлы: " + (e && e.message || e)); }
    finally { busy(false); }
  }

  function renderPoints() {
    var total = state.points.reduce(function (a, p) { return a + p.count; }, 0), all = state.selected.indexOf(ALL) >= 0;
    function pill(key, title, count, on) { return '<button class="point ' + (on ? "active" : "") + '" data-key="' + esc(key) + '"><span>' + esc(title) + "</span><b>" + count + "</b></button>"; }
    $("pointsGroup").innerHTML = pill(ALL, "Все", total, all) + state.points.map(function (p) { return pill(p.key, p.display, p.count, !all && state.selected.indexOf(p.key) >= 0); }).join("");
    $("pointsGroup").querySelectorAll("button").forEach(function (b) { b.onclick = function () { togglePoint(b.dataset.key); }; });
    var n = all ? total : state.points.filter(function (p) { return state.selected.indexOf(p.key) >= 0; }).reduce(function (a, p) { return a + p.count; }, 0);
    $("selInfo").textContent = "Выбрано накладных: " + n; $("build").disabled = n === 0;
  }
  function togglePoint(key) {
    if (key === ALL) state.selected = [ALL];
    else {
      var s = state.selected.filter(function (k) { return k !== ALL; }), i = s.indexOf(key);
      if (i >= 0) s.splice(i, 1); else s.push(key);
      state.selected = !s.length || s.length === state.points.length ? [ALL] : s;
    }
    try { localStorage.setItem(POINTS_KEY, JSON.stringify(state.selected)); } catch (e) { }
    renderPoints();
  }

  $("build").onclick = async function () {
    showError(""); busy(true, "Собираю PDF…");
    try {
      var pts = state.selected.indexOf(ALL) >= 0 ? [] : state.selected.slice();
      try { localStorage.setItem(POINTS_KEY, JSON.stringify(pts.length ? pts : [ALL])); } catch (e) { }
      renderResult(await processDocs(pts, state.format, state.perSheet)); renderStatus();
    } catch (e) { console.error(e); showError("Не удалось собрать PDF: " + (e && e.message || e)); }
    finally { busy(false); }
  };
  $("changeZip").onclick = function () { $("fileInput").click(); };

  function renderResult(d) {
    $("result").classList.remove("hidden"); $("resultMsg").textContent = d.message;
    $("resultActions").classList.toggle("hidden", !d.output_name); $("resultName").textContent = d.output_name || "";
    var rows = d.new_invoices.map(function (i) { return [i, false]; }).concat(d.duplicates.map(function (i) { return [i, true]; }));
    $("resultList").innerHTML = rows.map(function (r) {
      var i = r[0], dup = r[1];
      return "<li><span>" + esc(i.product_name) + ' <span class="muted">' + esc(i.order_id || i.filename) + (i.pickup ? " · " + esc(i.pickup) : "") +
        '</span></span><span class="tag ' + (dup ? "dup" : "") + '">' + (dup ? "уже было" : "новая") + "</span></li>";
    }).join("");
    if (d.output_name) download();
  }
  function renderStatus() {
    var st = dayState();
    $("todayDate").textContent = todayKey(); $("todayCount").textContent = st.invoices.length; $("batchCount").textContent = st.batches.length;
    $("batches").innerHTML = st.batches.slice().reverse().map(function (b) {
      return "<li><span>" + esc(b.created_at) + " · " + esc(b.zip_name) + (b.points && b.points.length ? " · " + esc(b.points.join(", ")) : "") +
        ' <span class="muted">новых ' + b.new_count + ", повторов " + b.duplicate_count + "</span></span>" + (b.pdf_name ? '<span class="tag">' + esc(b.pdf_name.replace(/\.pdf$/, "")) + "</span>" : "") + "</li>";
    }).join("") || '<li><span class="muted">Сегодня ещё ничего не собрано.</span></li>';
  }

  function download() {
    if (!state.last || !state.last.outBytes) return;
    var url = URL.createObjectURL(new Blob([state.last.outBytes], { type: "application/pdf" }));
    var a = document.createElement("a"); a.href = url; a.download = state.last.outName; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  $("download").onclick = download;
  $("rerender").onclick = async function () {
    showError(""); busy(true, "Пересобираю PDF…");
    try {
      var last = state.last && state.last.source ? state.last : await idbGet("last");
      if (!last || !last.source) throw new Error("Нет собранной партии — соберите PDF заново.");
      var nf = normalizeFormat(state.format, state.perSheet);
      var outBytes = await renderLayout(last.source, nf[0], nf[1]);
      state.last = { base: last.base, source: last.source, outName: last.base + "_" + formatSuffix(nf[0], nf[1]) + ".pdf", outBytes: outBytes };
      $("resultName").textContent = state.last.outName; download();
    } catch (e) { showError(e.message || String(e)); } finally { busy(false); }
  };
  $("reset").onclick = function () {
    if (!confirm("Сбросить историю за сегодня? Все накладные снова будут считаться новыми.")) return;
    var h = loadHist(); delete h[todayKey()]; localStorage.setItem(HIST_KEY, JSON.stringify(h)); idbClear(); renderStatus();
  };
  idbGet("last").then(function (l) {
    if (l && l.source && !state.last) {
      state.last = { base: l.base, source: l.source, outName: null, outBytes: null };
      $("result").classList.remove("hidden"); $("resultMsg").textContent = "Последняя партия: " + l.base + " — можно пересобрать в другом формате.";
      $("resultActions").classList.remove("hidden"); $("resultName").textContent = l.base;
    }
  });
  renderStatus();
  // для автотестов
  window.__kaspi = { extractPickupPoint: extractPickupPoint, extractOrderId: extractOrderId, extractProductName: extractProductName, extractText: extractText, state: state };
})();
