"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("nb-NO");
const fmtDate = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
let CTX = null; // sesjon, fylker, komiteer, representanter – brukes av fritekst-tolken

/* ---------- Portretter (Stortingets personbilde-API) ---------- */
const IMG = (id, size) => `https://data.stortinget.no/eksport/personbilde?personid=${encodeURIComponent(id)}&storrelse=${size}&erstatningsbilde=true`;
function avatar(p, cls = "") {
  if (!p || !p.id) return "";
  return `<button type="button" class="avatar ${cls}" data-pid="${esc(p.id)}" data-pname="${esc(p.navn)}" aria-label="Vis større bilde av ${esc(p.navn)}">` +
    `<img src="${IMG(p.id, "lite")}" srcset="${IMG(p.id, "lite")} 80w, ${IMG(p.id, "middels")} 158w" sizes="(max-width: 640px) 50px, 56px" alt="" loading="lazy" decoding="async" width="56" height="56"></button>`;
}
/* Navn med portrett og en dempet undertekst (parti · valgkrets) */
function personCell(p, nameHtml, sub, cls = "") {
  return `<div class="person">${avatar(p, cls)}<div class="person-text"><div class="person-name">${nameHtml ?? esc(p.navn)}</div>${sub ? `<div class="person-sub">${sub}</div>` : ""}</div></div>`;
}
const partyPlace = (p) => [p.parti, p.fylke].filter(Boolean).map(esc).join(" · ");

/* Klikk på et portrett viser et stort bilde */
const photoDialog = document.createElement("dialog");
photoDialog.className = "photo";
photoDialog.innerHTML = `<img alt=""><div class="photo-cap"></div>`;
document.body.append(photoDialog);
photoDialog.addEventListener("click", () => photoDialog.close());
document.addEventListener("click", (e) => {
  const b = e.target.closest(".avatar");
  if (!b) return;
  e.preventDefault();
  const img = $("img", photoDialog);
  img.src = IMG(b.dataset.pid, "stort");
  img.alt = b.dataset.pname;
  $(".photo-cap", photoDialog).textContent = b.dataset.pname;
  photoDialog.showModal();
});

const loading = (el, txt = "Henter data fra Stortinget …") => (el.innerHTML = `<p class="muted"><span class="spinner"></span>${txt}</p>`);
const fail = (el, e) => (el.innerHTML = `<div class="notice">Feil: ${esc(e.message)}</div>`);

/* ---------- Faner ---------- */
const loaded = {};
function showTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  try { localStorage.setItem("tab", name); } catch {}
  if (!loaded[name]) {
    loaded[name] = true;
    ({ kom: loadKom, parti: loadParti, rep: () => $("#repform").requestSubmit(), stat: () => $("#statform").requestSubmit() })[name]?.();
  }
}
$$("#tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

/* ---------- Periodevelger og typer ---------- */
function buildPeriod(container, defaultKey, sesjoner) {
  const y = new Date().getFullYear(), today = ST.todayISO();
  const ago = (n) => { const d = new Date(today); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); };
  const opts = [
    ["iar", `I år (${y})`, { ar: y }], ["12m", "Siste 12 måneder", { fra: ago(1) }],
    ["3ar", "Siste 3 år", { fra: ago(3) }], ["5ar", "Siste 5 år", { fra: ago(5) }], ["10ar", "Siste 10 år", { fra: ago(10) }],
  ];
  for (let a = y - 1; a >= 2010; a--) opts.push(["y" + a, `År ${a}`, { ar: a }]);
  for (const s of sesjoner) if (s.fra <= today && s.id >= "2010-2011") opts.push(["s" + s.id, `Sesjon ${s.id}`, { sesjon: s.id }]);
  opts.push(["egen", "Egendefinert …", null]);
  container.innerHTML = `<label>Periode <select name="_periode">${opts.map(([k, l]) => `<option value="${k}" ${k === defaultKey ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
    <label class="custom hidden">Fra <input type="date" name="fra"></label><label class="custom hidden">Til <input type="date" name="til"></label>`;
  const sel = $("select", container);
  sel.addEventListener("change", () => $$(".custom", container).forEach((l) => l.classList.toggle("hidden", sel.value !== "egen")));
  container._opts = Object.fromEntries(opts.map(([k, , p]) => [k, p]));
}
function periodParams(form) {
  const c = $(".period", form), k = $("select[name=_periode]", c).value;
  if (k === "egen") return { fra: form.fra.value || undefined, til: form.til.value || undefined };
  return c._opts[k];
}
const periodLabel = (m) => (m.fra || m.til ? `${fmtDate(m.fra) || "…"} – ${fmtDate(m.til) || "…"}` : `sesjon ${m.sesjoner.join(", ")}`);
function buildTypes(container) {
  const label = { skriftlige: "Skriftlige", sporretime: "Spørretime", interpellasjoner: "Interpellasjoner" };
  container.innerHTML = Object.keys(ST.QTYPES).map((k) => `<label><input type="checkbox" value="${k}" ${k === "skriftlige" ? "checked" : ""}> ${label[k]}</label>`).join("");
}
const typesParam = (form) => { const t = $$(".types input:checked", form).map((i) => i.value); return t.length ? t : ["skriftlige"]; };
function formParams(form, keys) {
  const p = {};
  for (const k of keys) if (form[k] && form[k].value) p[k] = form[k].value;
  return p;
}

/* ---------- Tabeller og CSV ---------- */
/* Kolonner med csvOnly vises ikke, men tas med i CSV-eksporten */
function table(allCols, rows, { bar } = {}) {
  const cols = allCols.filter((c) => !c.csvOnly);
  const max = bar ? Math.max(1, ...rows.map((r) => r[bar])) : 0;
  return `<div class="table-scroll"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? "num" : ""} ${c.cls || ""}">${esc(c.label)}</th>`).join("")}${bar ? "<th class=barcell></th>" : ""}</tr></thead><tbody>
  ${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? "num" : ""} ${c.cls || ""}">${c.html ? c.html(r) : esc(c.num ? nf.format(r[c.key]) : r[c.key])}</td>`).join("")}${bar ? `<td class=barcell><div class=bar style="width:${(100 * r[bar]) / max}%"></div></td>` : ""}</tr>`).join("")}
  </tbody></table></div>`;
}
function csvButton(name, cols, rows) {
  const b = document.createElement("button");
  b.className = "ghost"; b.type = "button"; b.textContent = "Last ned CSV";
  b.onclick = () => {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [cols.map((c) => q(c.label)).join(";"), ...rows.map((r) => cols.map((c) => q(r[c.key])).join(";"))].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = name + ".csv"; a.click();
  };
  return b;
}

/* ---------- Visninger (brukes både av fanene og fritekst) ---------- */
const GROUP_LABEL = { representant: "Representant", fylke: "Valgkrets", parti: "Parti", minister: "Statsråd", maaned: "Måned", sesjon: "Sesjon", type: "Type" };
function statCols(g) {
  const cols = [{ label: "#", key: "_rank", num: true }];
  if (g === "representant") cols.push(
    { label: "Representant", key: "navn", html: (r) => personCell(r, `<a href="#" data-rep="${esc(r.navn)}">${esc(r.navn)}</a>`, partyPlace(r)) },
    { label: "Parti", key: "parti", csvOnly: true }, { label: "Valgkrets", key: "fylke", csvOnly: true });
  else if (g === "parti") cols.push({ label: "Parti", key: "navn", html: (r) => `${esc(r.parti_navn || r.navn)} <span class=muted>(${esc(r.navn)})</span>` });
  else cols.push({ label: GROUP_LABEL[g], key: "navn" });
  cols.push({ label: "Antall", key: "antall", num: true });
  return cols;
}
const ranked = (rows) => rows.map((r, i) => ({ ...r, _rank: i + 1 }));

/* Viser statistikk. params = getQuestions-filtre; grupper/delOpp/topp styrer opptellingen. */
async function renderStats(out, params, grupper, delOpp, topp) {
  const { treff, meta } = await ST.getQuestions(params);
  const d = ST.countQuestions(treff, grupper, delOpp, topp);
  const cols = statCols(grupper);
  out.innerHTML = `<div class="summary"><span><b>${nf.format(d.totalt)}</b> spørsmål · ${esc(periodLabel(meta))} · ${esc(meta.typer.map((t) => ST.QTYPES[t].flertall).join(", "))}</span></div>`;
  const summary = $(".summary", out);
  if (d.grupper) {
    const all = [];
    out.insertAdjacentHTML("beforeend", d.grupper.map((gr) => {
      const rows = ranked(gr.rader); rows.forEach((r) => all.push({ gruppe: gr.gruppe, ...r }));
      return `<div class="group"><h3>${esc(gr.gruppe)} <span>· ${nf.format(gr.antall)} spørsmål</span></h3>${table(cols, rows, { bar: "antall" })}</div>`;
    }).join(""));
    summary.append(csvButton("sporsmal-statistikk", [{ label: GROUP_LABEL[delOpp], key: "gruppe" }, ...cols], all));
  } else {
    const rows = ranked(d.rader);
    out.insertAdjacentHTML("beforeend", rows.length ? table(cols, rows, { bar: "antall" }) : `<p class="muted">Ingen spørsmål funnet.</p>`);
    summary.append(csvButton("sporsmal-statistikk", cols, rows));
  }
  $$("a[data-rep]", out).forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    openSearch({ ...params, representant: a.dataset.rep });
  }));
  return { treff, meta };
}

function renderQuestionList(out, treff, meta, maks = 300) {
  const shown = treff.slice(0, maks);
  out.insertAdjacentHTML("beforeend", `<div class="summary"><span><b>${nf.format(treff.length)}</b> treff · ${esc(periodLabel(meta))}${shown.length < treff.length ? ` · viser de ${shown.length} nyeste` : ""}</span></div>
    <ul class="qlist">${shown.map((q) => `<li>
      <div class="q-head">${personCell(q.fra, null, `${partyPlace(q.fra)} → ${esc(q.til)}`)}
        <div class="q-date">${esc(fmtDate(q.dato))}<br><span>${esc(q.type_navn)}</span>${q.besvart ? "" : `<br><span class="tag">${esc(q.status)}</span>`}</div></div>
      <div class="q-title">${esc(q.tittel)}</div>
      <div class="meta q-links"><a href="#" data-id="${q.id}">Vis svar</a> · <a href="${esc(q.url)}" target="_blank" rel="noopener">stortinget.no</a></div>
    </li>`).join("")}</ul>`);
  const summary = $$(".summary", out).pop();
  const cols = [{ label: "Dato", key: "dato" }, { label: "Type", key: "type_navn" }, { label: "Fra", key: "_fra" }, { label: "Parti", key: "_parti" }, { label: "Valgkrets", key: "_fylke" }, { label: "Til", key: "til" }, { label: "Status", key: "status" }, { label: "Spørsmål", key: "tittel" }, { label: "Lenke", key: "url" }];
  summary.append(csvButton("sporsmal", cols, treff.map((q) => ({ ...q, _fra: q.fra.navn, _parti: q.fra.parti, _fylke: q.fra.fylke }))));
  $$("a[data-id]", out).forEach((a) => a.addEventListener("click", async (e) => {
    e.preventDefault();
    const li = a.closest("li"); let det = $(".detail", li);
    if (det) { det.remove(); a.textContent = "Vis svar"; return; }
    det = document.createElement("div"); det.className = "detail"; li.append(det); loading(det, "Henter svar …");
    try {
      const q = await ST.questionDetails(a.dataset.id);
      det.innerHTML = (q.begrunnelse ? `<h4>Begrunnelse</h4>${esc(q.begrunnelse)}` : "") +
        `<h4>Svar${q.besvart_av ? ` fra ${esc(q.besvart_av)} (${esc(q.besvart_av_tittel)}), ${esc(fmtDate(q.besvart_dato))}` : ""}</h4>${esc(q.svar || "Ikke besvart ennå.")}`;
      a.textContent = "Skjul svar";
    } catch (err) { fail(det, err); }
  }));
}

/* Søketreff med en kort oversikt over hvem som har spurt når det er flere treff */
async function renderSearch(out, params, { hvem = false } = {}) {
  const { treff, meta } = await ST.getQuestions(params);
  out.innerHTML = "";
  if (hvem && treff.length > 1) {
    const rows = ranked(ST.countQuestions(treff, "representant").rader).slice(0, 15);
    out.insertAdjacentHTML("beforeend", `<h3 class="sub-h">Hvem har spurt</h3>${table(statCols("representant"), rows, { bar: "antall" })}<h3 class="sub-h">Spørsmålene</h3>`);
    $$("a[data-rep]", out).forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openSearch({ ...params, representant: a.dataset.rep }); }));
  }
  renderQuestionList(out, treff, meta);
  if (!treff.length) out.insertAdjacentHTML("beforeend", `<p class="muted">Ingen spørsmål funnet. Prøv en lengre periode eller andre søkeord (bruk OR for alternativer).</p>`);
}

function renderReps(out, reps, tittel) {
  const cols = [
    { label: "Representant", key: "navn", html: (r) => personCell(r, `${esc(r.navn)}${r.vara ? ` <span class="tag">vara${r.moter_for ? " for " + esc(r.moter_for) : ""}</span>` : ""}`, partyPlace(r)) },
    { label: "Parti", key: "parti", csvOnly: true }, { label: "Valgkrets", key: "fylke", csvOnly: true },
    { label: "Komiteer", key: "_kom" }, { label: "E-post", key: "epost", cls: "hide-sm", html: (r) => r.epost ? `<a href="mailto:${esc(r.epost)}">${esc(r.epost)}</a>` : "" }];
  const rows = reps.map((r) => ({ ...r, _kom: r.komiteer.map((k) => k.navn).join(", ") }));
  out.innerHTML = `<div class="summary"><span>${tittel ? `<b>${esc(tittel)}</b> · ` : ""}<b>${rows.length}</b> representanter (dagens sammensetning)</span></div>${rows.length ? table(cols, rows) : '<p class="muted">Ingen treff.</p>'}`;
  $(".summary", out).append(csvButton("representanter", cols, rows));
}

function renderCommittees(out, komiteer) {
  out.innerHTML = `<div class="cards">${komiteer.map((k) => `<div class="card"><h3>${esc(k.navn)} <span class="muted">(${k.antall})</span></h3><ul class="people">${k.medlemmer.map((m) =>
    `<li>${personCell(m, `${esc(m.navn)}${m.vara ? ` <span class="tag">vara${m.moter_for ? " for " + esc(m.moter_for) : ""}</span>` : ""}`, partyPlace(m), "sm")}</li>`).join("")}</ul></div>`).join("")}</div>`;
}
function renderParties(out, partier) {
  const pr = [...partier].sort((a, b) => b.mandater_na - a.mandater_na);
  out.innerHTML = table([{ label: "Parti", key: "navn" }, { label: "Kode", key: "id" }, { label: "Representanter nå", key: "mandater_na", num: true }], pr, { bar: "mandater_na" });
}
function renderDistricts(out, kretser) {
  const kr = [...kretser].sort((a, b) => b.antall - a.antall).map((k) => ({ ...k, _p: Object.entries(k.partier).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(", ") }));
  out.innerHTML = table([{ label: "Valgkrets", key: "navn" }, { label: "Representanter nå", key: "antall", num: true }, { label: "Partifordeling", key: "_p" }], kr);
}

/* ---------- Statistikk-fanen ---------- */
$("#statform").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target, out = $("#statout");
  const p = { ...periodParams(f), typer: typesParam(f), ...formParams(f, ["fylke", "parti"]) };
  loading(out);
  try { await renderStats(out, p, f.grupper_etter.value, f.del_opp_etter.value || null, parseInt(f.topp.value) || null); }
  catch (e) { fail(out, e); }
});

/* ---------- Søk-fanen ---------- */
function openSearch(params) {
  const sf = $("#sokform");
  sf.sok.value = params.sok || ""; sf.representant.value = params.representant || ""; sf.minister.value = params.minister || "";
  sf.besvart.value = params.besvart === true ? "ja" : params.besvart === false ? "nei" : "";
  sf.fylke.value = [].concat(params.fylke || [])[0] || ""; sf.parti.value = [].concat(params.parti || [])[0] || "";
  const ps = $("select[name=_periode]", sf);
  ps.value = "egen"; ps.dispatchEvent(new Event("change"));
  if (params.ar) { sf.fra.value = `${params.ar}-01-01`; sf.til.value = `${params.ar}-12-31`; }
  else if (params.sesjon) { ps.value = "s" + params.sesjon; ps.dispatchEvent(new Event("change")); }
  else { sf.fra.value = params.fra || ""; sf.til.value = params.til || ""; }
  $$(".types input", sf).forEach((i) => (i.checked = (params.typer || ["skriftlige"]).includes(i.value)));
  showTab("sok"); sf.requestSubmit();
  window.scrollTo({ top: 0 });
}
$("#sokform").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target, out = $("#sokout");
  const p = { ...periodParams(f), typer: typesParam(f), ...formParams(f, ["sok", "representant", "minister", "fylke", "parti"]) };
  if (f.besvart.value) p.besvart = f.besvart.value === "ja";
  loading(out);
  try { await renderSearch(out, p); } catch (e) { fail(out, e); }
});

/* ---------- Representanter, komiteer, partier ---------- */
$("#repform").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target, out = $("#repout");
  loading(out);
  try { renderReps(out, await ST.representatives({ ...formParams(f, ["navn", "komite", "fylke", "parti"]), inkluderVara: !f.vara.checked })); }
  catch (e) { fail(out, e); }
});
async function loadKom() {
  const out = $("#komout"); loading(out);
  try { renderCommittees(out, await ST.committees()); } catch (e) { fail(out, e); }
}
async function loadParti() {
  const out = $("#partiout"); loading(out);
  try {
    const [partier, kretser] = await Promise.all([ST.parties(), ST.districts()]);
    out.innerHTML = `<h2>Partier</h2><div id="po"></div><h2 style="margin-top:28px">Valgkretser</h2><div id="ko"></div>`;
    renderParties($("#po", out), partier); renderDistricts($("#ko", out), kretser);
  } catch (e) { fail(out, e); }
}

/* ---------- Fritekst ---------- */
const HELP = `<p>Jeg forsto ikke helt spørsmålet. Prøv for eksempel:</p><ul>
  <li>«Hvor mange skriftlige spørsmål har representantene stilt i år?»</li>
  <li>«Topp 10 som har stilt flest spørsmål, fordelt på fylke»</li>
  <li>«Hvem har spurt om Hordfast de siste årene?»</li>
  <li>«Hvor mange spørsmål har hvert parti stilt til samferdselsministeren i 2025?»</li>
  <li>«Hvem sitter i finanskomiteen?» · «Representanter fra Rogaland» · «Høyres representanter fra Akershus»</li></ul>
  <p class="muted">Sett ord i anførselstegn for å søke på en eksakt frase, og bruk OR mellom alternativer.</p>`;

function addMsg(q) {
  const div = document.createElement("div"); div.className = "msg";
  div.innerHTML = `<div class="q">${esc(q)}</div><div class="a"><p class="muted"><span class="spinner"></span>Slår opp i Stortingets data …</p></div>`;
  $("#chat").prepend(div);
  return $(".a", div);
}
async function ask(q) {
  q = q.trim();
  if (!q) return;
  $("#askinput").value = "";
  const a = addMsg(q);
  try {
    await ctxReady;
    const plan = NLQ.interpret(q, CTX);
    a.innerHTML = plan.tolkning.length ? `<div class="interp">Tolket som: ${plan.tolkning.map((t) => `<span class="chip">${esc(t)}</span>`).join(" ")}</div><div class="res"></div>` : `<div class="res"></div>`;
    const res = $(".res", a), p = plan.params;
    loading(res);
    switch (plan.kind) {
      case "stats": {
        const { treff, meta } = await renderStats(res, p, p.grupper, p.delOpp, p.topp);
        if (plan.visListe && treff.length) { res.insertAdjacentHTML("beforeend", `<h3 class="sub-h">Spørsmålene</h3>`); renderQuestionList(res, treff, meta, 100); }
        break;
      }
      case "search": await renderSearch(res, p, { hvem: !p.representant }); break;
      case "reps": renderReps(res, await ST.representatives(p), plan.tittel); break;
      case "committees": renderCommittees(res, await ST.committees()); break;
      case "parties": renderParties(res, await ST.parties()); break;
      case "districts": renderDistricts(res, await ST.districts()); break;
      default: res.innerHTML = HELP;
    }
  } catch (e) { fail(a, e); }
}
$("#askform").addEventListener("submit", (e) => { e.preventDefault(); ask($("#askinput").value); });
$("#askinput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(e.target.value); } });

/* ---------- Oppstart ---------- */
let ctxReady;
(async function init() {
  ctxReady = (async () => {
    const [sesj, perioder, kretser, komiteer, partier, reps] = await Promise.all([
      ST.sessions(), ST.fetchJSON("stortingsperioder"), ST.districts(), ST.committees(), ST.parties(), ST.currentReps()]);
    CTX = { sesjon: sesj.innevaerende, sesjoner: sesj.sesjoner, periodeFra: ST.isoDate(perioder.innevaerende_stortingsperiode.fra),
            fylker: kretser.map((k) => k.navn), komiteer, partier, reps };
  })();
  try { await ctxReady; } catch (e) { fail($("main"), e); return; }
  buildPeriod($("#statform .period"), "iar", CTX.sesjoner);
  buildPeriod($("#sokform .period"), "5ar", CTX.sesjoner);
  $$(".types").forEach(buildTypes);
  $$(".partisel").forEach((s) => s.insertAdjacentHTML("beforeend", CTX.partier.map((p) => `<option value="${esc(p.id)}">${esc(p.navn)}</option>`).join("")));
  $$(".fylkesel").forEach((s) => s.insertAdjacentHTML("beforeend", [...CTX.fylker].sort((a, b) => a.localeCompare(b, "nb")).map((n) => `<option>${esc(n)}</option>`).join("")));
  $("#komsel").insertAdjacentHTML("beforeend", CTX.komiteer.map((k) => `<option value="${esc(k.id)}">${esc(k.navn)}</option>`).join(""));
  let start = "spor";
  try { start = localStorage.getItem("tab") || "spor"; } catch {}
  showTab(start);
  const q = new URLSearchParams(location.search).get("q");
  if (q) { showTab("spor"); ask(q); }
})();
