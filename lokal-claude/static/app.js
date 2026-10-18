"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("nb-NO");
let META = null;

async function getJSON(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  const r = await fetch(`/api/${path}?${qs}`);
  const d = await r.json();
  if (!r.ok) throw new Error(d.feil || r.statusText);
  return d;
}
const loading = (el, txt = "Henter data fra Stortinget …") => (el.innerHTML = `<p class="muted"><span class="spinner"></span>${txt}</p>`);
const fail = (el, e) => (el.innerHTML = `<div class="notice">Feil: ${esc(e.message)}</div>`);

/* ---------- Faner ---------- */
const loaded = {};
function showTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  try { localStorage.setItem("tab", name); } catch {}
  if (!loaded[name]) { loaded[name] = true; ({ kom: loadKom, parti: loadParti, rep: () => $("#repform").requestSubmit(), stat: () => $("#statform").requestSubmit() })[name]?.(); }
}
$$("#tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

/* ---------- Periodevelger og typer ---------- */
function periodOptions(defaultKey) {
  const y = new Date().getFullYear();
  const iso = (d) => d.toISOString().slice(0, 10);
  const ago = (years) => { const d = new Date(); d.setFullYear(d.getFullYear() - years); return iso(d); };
  const opts = [
    ["iar", `I år (${y})`, { ar: y }],
    ["12m", "Siste 12 måneder", { fra: ago(1) }],
    ["3ar", "Siste 3 år", { fra: ago(3) }],
    ["5ar", "Siste 5 år", { fra: ago(5) }],
    ["10ar", "Siste 10 år", { fra: ago(10) }],
  ];
  for (let a = y - 1; a >= 2010; a--) opts.push(["y" + a, `År ${a}`, { ar: a }]);
  const today = iso(new Date());
  for (const s of META.sesjoner.sesjoner) if (s.fra <= today && s.id >= "2010-2011") opts.push(["s" + s.id, `Sesjon ${s.id}`, { sesjon: s.id }]);
  opts.push(["egen", "Egendefinert …", null]);
  return { opts, defaultKey };
}
function buildPeriod(container, defaultKey) {
  const { opts } = periodOptions(defaultKey);
  container.innerHTML = `<label>Periode <select name="_periode">${opts.map(([k, l]) => `<option value="${k}" ${k === defaultKey ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
    <label class="custom hidden">Fra <input type="date" name="fra"></label><label class="custom hidden">Til <input type="date" name="til"></label>`;
  const sel = $("select", container);
  sel.addEventListener("change", () => $$(".custom", container).forEach((l) => l.classList.toggle("hidden", sel.value !== "egen")));
  container._opts = Object.fromEntries(opts.map(([k, , p]) => [k, p]));
}
function periodParams(form) {
  const c = $(".period", form), k = $("select[name=_periode]", c).value;
  if (k === "egen") return { fra: form.fra.value, til: form.til.value };
  return c._opts[k];
}
function periodLabel(m) {
  if (m.fra || m.til) return `${m.fra ?? "…"} – ${m.til ?? "…"}`;
  return `sesjon ${m.sesjoner.join(", ")}`;
}
function buildTypes(container) {
  const label = { skriftlige: "Skriftlige", sporretime: "Spørretime", interpellasjoner: "Interpellasjoner" };
  container.innerHTML = Object.keys(META.typer).map((k) => `<label><input type="checkbox" value="${k}" ${k === "skriftlige" ? "checked" : ""}> ${label[k] || k}</label>`).join("");
}
const typesParam = (form) => $$(".types input:checked", form).map((i) => i.value).join(",") || "skriftlige";
function formParams(form, keys) {
  const p = {};
  for (const k of keys) if (form[k] && form[k].value) p[k] = form[k].value;
  return p;
}

/* ---------- Tabeller og CSV ---------- */
function table(cols, rows, { bar } = {}) {
  const max = bar ? Math.max(1, ...rows.map((r) => r[bar])) : 0;
  return `<div class="table-scroll"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`).join("")}${bar ? "<th class=barcell></th>" : ""}</tr></thead><tbody>
  ${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.html ? c.html(r) : esc(c.num ? nf.format(r[c.key]) : r[c.key])}</td>`).join("")}${bar ? `<td class=barcell><div class=bar style="width:${(100 * r[bar]) / max}%"></div></td>` : ""}</tr>`).join("")}
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

/* ---------- Statistikk ---------- */
const GROUP_LABEL = { representant: "Representant", fylke: "Fylke", parti: "Parti", minister: "Statsråd", maaned: "Måned", sesjon: "Sesjon", type: "Type" };
function statCols(g) {
  const cols = [{ label: "#", key: "_rank", num: true }];
  if (g === "representant") cols.push(
    { label: "Representant", key: "navn", html: (r) => `<a href="#" data-rep="${esc(r.navn)}">${esc(r.navn)}</a>` },
    { label: "Parti", key: "parti" }, { label: "Fylke", key: "fylke" });
  else if (g === "parti") cols.push({ label: "Parti", key: "navn", html: (r) => `${esc(r.parti_navn || r.navn)} <span class=muted>(${esc(r.navn)})</span>` });
  else cols.push({ label: GROUP_LABEL[g], key: "navn" });
  cols.push({ label: "Antall", key: "antall", num: true });
  return cols;
}
const ranked = (rows) => rows.map((r, i) => ({ ...r, _rank: i + 1 }));

$("#statform").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target, out = $("#statout");
  const p = { ...periodParams(f), typer: typesParam(f), ...formParams(f, ["grupper_etter", "del_opp_etter", "topp", "fylke", "parti"]) };
  loading(out);
  try {
    const d = await getJSON("statistikk", p);
    const g = p.grupper_etter || "representant", cols = statCols(g);
    out.innerHTML = `<div class="summary"><span><b>${nf.format(d.totalt)}</b> spørsmål · ${esc(periodLabel(d))} · ${esc(d.typer.map((t) => META.typer[t]).join(", "))}</span></div>`;
    const summary = $(".summary", out);
    if (d.grupper) {
      const all = [];
      out.insertAdjacentHTML("beforeend", d.grupper.map((gr) => {
        const rows = ranked(gr.rader); rows.forEach((r) => all.push({ gruppe: gr.gruppe, ...r }));
        return `<div class="group"><h3>${esc(gr.gruppe)} <span>· ${nf.format(gr.antall)} spørsmål</span></h3>${table(cols, rows, { bar: "antall" })}</div>`;
      }).join(""));
      summary.append(csvButton("sporsmal-statistikk", [{ label: GROUP_LABEL[p.del_opp_etter], key: "gruppe" }, ...cols], all));
    } else {
      const rows = ranked(d.rader);
      out.insertAdjacentHTML("beforeend", table(cols, rows, { bar: "antall" }));
      summary.append(csvButton("sporsmal-statistikk", cols, rows));
    }
    $$("a[data-rep]", out).forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      const sf = $("#sokform");
      sf.sok.value = ""; sf.representant.value = a.dataset.rep;
      const ps = $("select[name=_periode]", sf); ps.value = $("select[name=_periode]", f).value; ps.dispatchEvent(new Event("change"));
      sf.fra.value = f.fra.value; sf.til.value = f.til.value;
      $$(".types input", sf).forEach((i) => (i.checked = typesParam(f).split(",").includes(i.value)));
      showTab("sok"); sf.requestSubmit();
    }));
  } catch (e) { fail(out, e); }
});

/* ---------- Søk ---------- */
$("#sokform").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target, out = $("#sokout");
  const p = { ...periodParams(f), typer: typesParam(f), ...formParams(f, ["sok", "representant", "minister", "fylke", "parti"]) };
  loading(out);
  try {
    const d = await getJSON("sporsmal", p);
    const shown = d.treff.length;
    out.innerHTML = `<div class="summary"><span><b>${nf.format(d.antall)}</b> treff · ${esc(periodLabel(d))}${shown < d.antall ? ` · viser de ${shown} nyeste` : ""}</span></div>
      <ul class="qlist">${d.treff.map((q) => `<li>
        <div class="meta">${esc(q.dato)} · ${esc(q.type_navn)} · <b>${esc(q.fra.navn)}</b> (${esc(q.fra.parti)}, ${esc(q.fra.fylke)}) → ${esc(q.til)}${q.besvart ? "" : ' <span class="tag">ubesvart</span>'}</div>
        <div>${esc(q.tittel)}</div>
        <div class="meta" style="margin-top:4px"><a href="#" data-id="${q.id}">Vis svar</a> · <a href="${esc(q.url)}" target="_blank" rel="noopener">stortinget.no</a></div>
      </li>`).join("")}</ul>`;
    const cols = [{ label: "Dato", key: "dato" }, { label: "Type", key: "type_navn" }, { label: "Fra", key: "_fra" }, { label: "Parti", key: "_parti" }, { label: "Fylke", key: "_fylke" }, { label: "Til", key: "til" }, { label: "Spørsmål", key: "tittel" }, { label: "Lenke", key: "url" }];
    $(".summary", out).append(csvButton("sporsmal", cols, d.treff.map((q) => ({ ...q, _fra: q.fra.navn, _parti: q.fra.parti, _fylke: q.fra.fylke }))));
    $$("a[data-id]", out).forEach((a) => a.addEventListener("click", async (e) => {
      e.preventDefault();
      const li = a.closest("li"); let det = $(".detail", li);
      if (det) { det.remove(); a.textContent = "Vis svar"; return; }
      det = document.createElement("div"); det.className = "detail"; li.append(det); loading(det, "Henter svar …");
      try {
        const q = await getJSON("sporsmal/detaljer", { id: a.dataset.id });
        det.innerHTML = (q.begrunnelse ? `<h4>Begrunnelse</h4>${esc(q.begrunnelse)}` : "") +
          `<h4>Svar${q.besvart_av ? ` fra ${esc(q.besvart_av)} (${esc(q.besvart_av_tittel)}), ${esc(q.besvart_dato)}` : ""}</h4>${esc(q.svar || "Ikke besvart ennå.")}`;
        a.textContent = "Skjul svar";
      } catch (err) { fail(det, err); }
    }));
  } catch (e) { fail(out, e); }
});

/* ---------- Representanter ---------- */
$("#repform").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target, out = $("#repout");
  const p = { ...formParams(f, ["navn", "komite", "fylke", "parti"]), vara: f.vara.checked ? "false" : "" };
  loading(out);
  try {
    const d = await getJSON("representanter", p);
    const cols = [
      { label: "Navn", key: "navn", html: (r) => `${esc(r.navn)}${r.vara ? ` <span class="tag" title="Møter for ${esc(r.moter_for || "")}">vara${r.moter_for ? " for " + esc(r.moter_for) : ""}</span>` : ""}` },
      { label: "Parti", key: "parti" }, { label: "Fylke", key: "fylke" },
      { label: "Komiteer", key: "_kom", html: (r) => esc(r._kom) }, { label: "E-post", key: "epost", html: (r) => r.epost ? `<a href="mailto:${esc(r.epost)}">${esc(r.epost)}</a>` : "" }];
    const rows = d.map((r) => ({ ...r, _kom: r.komiteer.map((k) => k.navn).join(", ") }));
    out.innerHTML = `<div class="summary"><span><b>${rows.length}</b> representanter (dagens sammensetning)</span></div>${table(cols, rows)}`;
    $(".summary", out).append(csvButton("representanter", cols, rows));
  } catch (e) { fail(out, e); }
});

/* ---------- Komiteer ---------- */
async function loadKom() {
  const out = $("#komout"); loading(out);
  try {
    const d = await getJSON("komiteer");
    out.innerHTML = `<div class="cards">${d.map((k) => `<div class="card"><h3>${esc(k.navn)} <span class="muted">(${k.antall})</span></h3><ul>${k.medlemmer.map((m) =>
      `<li>${esc(m.navn)} <span class="muted">${esc(m.parti)}, ${esc(m.fylke)}</span>${m.vara ? ` <span class="tag">vara${m.moter_for ? " for " + esc(m.moter_for) : ""}</span>` : ""}</li>`).join("")}</ul></div>`).join("")}</div>`;
  } catch (e) { fail(out, e); }
}

/* ---------- Partier og valgkretser ---------- */
async function loadParti() {
  const out = $("#partiout"); loading(out);
  try {
    const [partier, kretser] = await Promise.all([getJSON("partier"), getJSON("valgkretser")]);
    const pr = partier.sort((a, b) => b.mandater_na - a.mandater_na);
    const kr = kretser.sort((a, b) => b.antall - a.antall).map((k) => ({ ...k, _p: Object.entries(k.partier).map(([p, n]) => `${p} ${n}`).join(", ") }));
    out.innerHTML = `<h2>Partier</h2>${table([{ label: "Parti", key: "navn" }, { label: "Kode", key: "id" }, { label: "Representanter nå", key: "mandater_na", num: true }], pr, { bar: "mandater_na" })}
      <h2 style="margin-top:28px">Valgkretser</h2>${table([{ label: "Valgkrets", key: "navn" }, { label: "Representanter nå", key: "antall", num: true }, { label: "Partifordeling", key: "_p" }], kr)}`;
  } catch (e) { fail(out, e); }
}

/* ---------- Fritekst (Claude) ---------- */
const history = [];
function addMsg(q) {
  const div = document.createElement("div"); div.className = "msg";
  div.innerHTML = `<div class="q">${esc(q)}</div><div class="a"><p class="muted"><span class="spinner"></span>Slår opp i Stortingets data …</p></div>`;
  $("#chat").append(div); div.scrollIntoView({ behavior: "smooth", block: "end" });
  return $(".a", div);
}
async function ask(q) {
  if (!q.trim()) return;
  const btn = $("#askform button"); btn.disabled = true;
  $("#askinput").value = "";
  const a = addMsg(q);
  try {
    const r = await fetch("/api/spor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sporsmal: q, historikk: history }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.feil || r.statusText);
    a.innerHTML = DOMPurify.sanitize(marked.parse(d.svar));
    $$("a", a).forEach((l) => { l.target = "_blank"; l.rel = "noopener"; });
    if (d.kall?.length) a.insertAdjacentHTML("afterend", `<details><summary>${d.kall.length} oppslag mot Stortingets API</summary><pre>${esc(d.kall.map((c) => `${c.verktoy} ${JSON.stringify(c.input)}`).join("\n"))}</pre></details>`);
    history.push({ q, a: d.svar });
  } catch (e) { fail(a, e); }
  btn.disabled = false;
}
$("#askform").addEventListener("submit", (e) => { e.preventDefault(); ask($("#askinput").value); });
$("#askinput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(e.target.value); } });
$$(".examples button").forEach((b) => b.addEventListener("click", () => ask(b.textContent)));

/* ---------- Oppstart ---------- */
(async function init() {
  try {
    META = await getJSON("meta");
  } catch (e) { fail($("main"), e); return; }
  if (!META.claude) $("#nokey").classList.remove("hidden");
  buildPeriod($("#statform .period"), "iar");
  buildPeriod($("#sokform .period"), "5ar");
  $$(".types").forEach(buildTypes);
  const [partier, kretser, komiteer] = await Promise.all([getJSON("partier"), getJSON("valgkretser"), getJSON("komiteer")]);
  $$(".partisel").forEach((s) => s.insertAdjacentHTML("beforeend", partier.map((p) => `<option value="${esc(p.id)}">${esc(p.navn)}</option>`).join("")));
  $$(".fylkesel").forEach((s) => s.insertAdjacentHTML("beforeend", kretser.map((k) => k.navn).sort((a, b) => a.localeCompare(b, "nb")).map((n) => `<option>${esc(n)}</option>`).join("")));
  $("#komsel").insertAdjacentHTML("beforeend", komiteer.map((k) => `<option value="${esc(k.id)}">${esc(k.navn)}</option>`).join(""));
  let start = "spor";
  try { start = localStorage.getItem("tab") || (META.claude ? "spor" : "stat"); } catch {}
  showTab(start);
})();
