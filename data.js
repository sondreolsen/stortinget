"use strict";
/* Datatilgang mot Stortingets åpne API (https://data.stortinget.no), direkte fra nettleseren.
   Alt hentes live ved bruk; svar holdes i minnet så lenge siden er åpen. */

const ST = (() => {
  const BASE = "https://data.stortinget.no/eksport/";
  const QTYPES = {
    skriftlige: { endpoint: "skriftligesporsmal", navn: "Skriftlig spørsmål", flertall: "Skriftlige spørsmål" },
    sporretime: { endpoint: "sporretimesporsmal", navn: "Spørretimespørsmål", flertall: "Spørretimespørsmål" },
    interpellasjoner: { endpoint: "interpellasjoner", navn: "Interpellasjon", flertall: "Interpellasjoner" },
  };
  // stortinget.no viser alle spørsmålstyper på samme side
  const qUrl = (id) => `https://www.stortinget.no/no/Saker-og-publikasjoner/Sporsmal/Skriftlige-sporsmal-og-svar/Skriftlig-sporsmal/?qnid=${id}`;

  const cache = new Map();
  function fetchJSON(endpoint, params = {}) {
    const qs = new URLSearchParams({ ...params, format: "json" });
    const url = BASE + endpoint + "?" + qs;
    if (!cache.has(url)) {
      const p = fetch(url).then(async (r) => {
        if (!r.ok) throw new Error(`Stortinget svarte ${r.status} for ${endpoint}`);
        const d = await r.json();
        if (d && d.feilmelding) throw new Error("Stortinget-API: " + d.feilmelding);
        return d;
      });
      p.catch(() => cache.delete(url));
      cache.set(url, p);
    }
    return cache.get(url);
  }

  /* "/Date(1790773419482+0200)/" -> "2026-10-01" (lokal dato) */
  function isoDate(s) {
    const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(s || "");
    if (!m) return null;
    const off = m[2] || "+0000";
    const mins = (off[0] === "-" ? -1 : 1) * (parseInt(off.slice(1, 3)) * 60 + parseInt(off.slice(3)));
    return new Date(Number(m[1]) + mins * 60000).toISOString().slice(0, 10);
  }
  const todayISO = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };

  /* ---------- sesjoner ---------- */
  async function sessions() {
    const d = await fetchJSON("sesjoner");
    return {
      innevaerende: d.innevaerende_sesjon.id,
      sesjoner: d.sesjoner_liste.map((s) => ({ id: s.id, fra: isoDate(s.fra), til: isoDate(s.til) })),
    };
  }
  async function sessionsBetween(fra, til) {
    const today = todayISO();
    return (await sessions()).sesjoner
      .filter((s) => s.fra <= til && s.til >= fra && s.fra <= today)
      .map((s) => s.id).sort();
  }

  /* ---------- spørsmål ---------- */
  function person(p) {
    if (!p) return {};
    const o = { id: p.id, navn: `${p.fornavn || ""} ${p.etternavn || ""}`.trim() };
    if (p.parti) { o.parti = p.parti.id; o.parti_navn = p.parti.navn; }
    if (p.fylke) o.fylke = p.fylke.navn;
    if (p.vara_representant) o.vara = true;
    return o;
  }
  function normQuestion(q, type) {
    return {
      id: q.id, type, type_navn: QTYPES[type].navn, sesjon: q.sesjon_id, nummer: q.sporsmal_nummer,
      tittel: (q.tittel || "").trim(),
      dato: isoDate(q.datert_dato) || isoDate(q.sendt_dato),
      besvart_dato: isoDate(q.besvart_dato), besvart: !!q.besvart_dato,
      fra: person(q.sporsmal_fra),
      til: q.sporsmal_til_minister_tittel, til_person: person(q.sporsmal_til).navn,
      besvart_av: q.besvart_av_minister_tittel,
      emner: (q.emne_liste || []).map((e) => e.navn).filter(Boolean),
      url: qUrl(q.id),
    };
  }
  async function questionsForSession(type, sesjon) {
    const d = await fetchJSON(QTYPES[type].endpoint, { sesjonid: sesjon });
    return (d.sporsmal_liste || []).map((q) => normQuestion(q, type));
  }

  /* Periode: {ar} | {fra, til} | {sesjon}. Uten noe: 1. januar i år til i dag. */
  async function resolvePeriod({ ar, fra, til, sesjon } = {}) {
    if (sesjon) return { sesjoner: [sesjon], fra: null, til: null };
    const today = todayISO();
    if (ar) { fra = `${ar}-01-01`; til = `${ar}-12-31`; }
    fra = fra || today.slice(0, 4) + "-01-01";
    til = til || today;
    return { sesjoner: await sessionsBetween(fra, til), fra, til };
  }

  const norm = (s) => String(s || "").toLowerCase().replace(/-/g, " ");
  const matchName = (value, wanted) => !wanted || (value && norm(value).includes(norm(wanted)));
  const asList = (v) => (v == null || v === "" ? [] : Array.isArray(v) ? v : [v]);

  /* Søketekst: alle ord må finnes; " OR " / " ELLER " / "|" skiller alternativer. */
  function parseSearch(sok) {
    if (!sok) return null;
    return sok.split(/\s+(?:OR|ELLER)\s+|\s*\|\s*/).map((a) => a.trim()).filter(Boolean)
      .map((a) => a.split(/\s+/).map(norm));
  }

  async function getQuestions(f = {}) {
    const typer = asList(f.typer).length ? asList(f.typer) : ["skriftlige"];
    const per = await resolvePeriod(f);
    const lists = await Promise.all(typer.flatMap((t) => per.sesjoner.map((s) => questionsForSession(t, s))));
    const terms = parseSearch(f.sok);
    const fylker = asList(f.fylke), partier = asList(f.parti);
    const res = lists.flat().filter((q) => {
      if (per.fra && (!q.dato || q.dato < per.fra)) return false;
      if (per.til && q.dato && q.dato > per.til) return false;
      if (fylker.length && !fylker.some((fy) => matchName(q.fra.fylke, fy))) return false;
      if (partier.length && !partier.some((p) => norm(q.fra.parti) === norm(p) || matchName(q.fra.parti_navn, p))) return false;
      if (f.representant && !(norm(q.fra.id) === norm(f.representant) || matchName(q.fra.navn, f.representant))) return false;
      if (f.minister && !(matchName(q.til, f.minister) || matchName(q.besvart_av, f.minister) || matchName(q.til_person, f.minister))) return false;
      if (terms) {
        const hay = norm(q.tittel + " " + q.emner.join(" "));
        if (!terms.some((alt) => alt.every((w) => hay.includes(w)))) return false;
      }
      return true;
    });
    res.sort((a, b) => (b.dato || "").localeCompare(a.dato || ""));
    return { treff: res, meta: { ...per, typer, antall: res.length } };
  }

  const GROUP_KEYS = {
    representant: (q) => q.fra.id || q.fra.navn,
    fylke: (q) => q.fra.fylke || "Ukjent",
    parti: (q) => q.fra.parti || "Ukjent",
    minister: (q) => q.til || "Ukjent",
    maaned: (q) => (q.dato || "").slice(0, 7),
    sesjon: (q) => q.sesjon,
    type: (q) => q.type_navn,
  };
  function countQuestions(qs, grupper = "representant", delOpp = null, topp = null) {
    const key = GROUP_KEYS[grupper], info = new Map();
    for (const q of qs) {
      const k = key(q);
      if (info.has(k)) continue;
      if (grupper === "representant") info.set(k, { id: q.fra.id, navn: q.fra.navn, parti: q.fra.parti, fylke: q.fra.fylke });
      else if (grupper === "parti") info.set(k, { navn: k, parti_navn: q.fra.parti_navn });
      else info.set(k, { navn: k });
    }
    const ranked = (list) => {
      const c = new Map();
      for (const q of list) c.set(key(q), (c.get(key(q)) || 0) + 1);
      let rows = [...c].map(([k, n]) => ({ ...info.get(k), antall: n }));
      if (grupper === "maaned" || grupper === "sesjon") rows.sort((a, b) => a.navn.localeCompare(b.navn));
      else rows.sort((a, b) => b.antall - a.antall || String(a.navn).localeCompare(String(b.navn), "nb"));
      return topp ? rows.slice(0, topp) : rows;
    };
    if (delOpp) {
      const split = GROUP_KEYS[delOpp], groups = new Map();
      for (const q of qs) { const g = split(q); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(q); }
      return {
        totalt: qs.length,
        grupper: [...groups].sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0]), "nb"))
          .map(([g, list]) => ({ gruppe: g, antall: list.length, rader: ranked(list) })),
      };
    }
    return { totalt: qs.length, rader: ranked(qs) };
  }

  async function questionDetails(id) {
    const d = await fetchJSON("enkeltsporsmal", { NSporsmalId: id });
    const clean = (s) => String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    return {
      id: d.id, tittel: d.tittel, sporsmal: clean(d.sporsmal), begrunnelse: clean(d.begrunnelse), svar: clean(d.svar),
      fra: person(d.sporsmal_fra), til: d.sporsmal_til_minister_tittel,
      besvart_av: person(d.besvart_av).navn, besvart_av_tittel: d.besvart_av_minister_tittel,
      datert: isoDate(d.datert_dato), besvart_dato: isoDate(d.besvart_dato), url: qUrl(d.id),
    };
  }

  /* ---------- representanter, komiteer, partier, valgkretser ---------- */
  async function currentReps() {
    const d = await fetchJSON("dagensrepresentanter");
    return d.dagensrepresentanter_liste.map((p) => ({
      ...person(p),
      fornavn: p.fornavn, etternavn: p.etternavn,
      kjoenn: p.kjoenn === 1 ? "kvinne" : "mann",
      epost: p.epost, fodt: isoDate(p.foedselsdato),
      komiteer: (p.komiteer_liste || []).map((k) => ({ id: k.id, navn: k.navn })),
      vara: !!p.vara_representant,
      moter_for: p.vara_for ? person(p.vara_for).navn : null,
    })).sort((a, b) => (a.fylke || "").localeCompare(b.fylke || "", "nb") || a.navn.localeCompare(b.navn, "nb"));
  }
  async function representatives(f = {}) {
    const reps = await currentReps();
    const fylker = asList(f.fylke), partier = asList(f.parti), komiteer = asList(f.komite);
    return reps.filter((r) => {
      if (komiteer.length && !komiteer.some((k) => r.komiteer.some((rk) => norm(rk.id) === norm(k) || matchName(rk.navn, k)))) return false;
      if (fylker.length && !fylker.some((fy) => matchName(r.fylke, fy))) return false;
      if (partier.length && !partier.some((p) => norm(r.parti) === norm(p) || matchName(r.parti_navn, p))) return false;
      if (f.navn && !matchName(r.navn, f.navn)) return false;
      if (f.inkluderVara === false && r.vara) return false;
      if (f.kunVara && !r.vara) return false;
      if (f.kjoenn && r.kjoenn !== f.kjoenn) return false;
      return true;
    });
  }
  async function committees() {
    const { innevaerende } = await sessions();
    const [d, reps] = await Promise.all([fetchJSON("komiteer", { sesjonid: innevaerende }), currentReps()]);
    const members = new Map();
    for (const r of reps) for (const k of r.komiteer) {
      if (!members.has(k.id)) members.set(k.id, []);
      members.get(k.id).push({ id: r.id, navn: r.navn, parti: r.parti, fylke: r.fylke, vara: r.vara, moter_for: r.moter_for });
    }
    // API-et lister også nedlagte særkomiteer; vis bare komiteer med medlemmer
    return d.komiteer_liste.filter((k) => members.has(k.id)).map((k) => ({
      id: k.id, navn: k.navn, antall: members.get(k.id).length,
      medlemmer: members.get(k.id).sort((a, b) => (a.parti || "").localeCompare(b.parti || "") || a.navn.localeCompare(b.navn, "nb")),
    }));
  }
  async function parties() {
    const { innevaerende } = await sessions();
    const [d, reps] = await Promise.all([fetchJSON("partier", { sesjonid: innevaerende }), currentReps()]);
    const seats = {};
    for (const r of reps) seats[r.parti] = (seats[r.parti] || 0) + 1;
    return d.partier_liste.map((p) => ({ id: p.id, navn: p.navn, mandater_na: seats[p.id] || 0 }));
  }
  async function districts() {
    const [d, reps] = await Promise.all([fetchJSON("fylker"), currentReps()]);
    return d.fylker_liste.filter((f) => !f.historisk_fylke).map((f) => {
      const rr = reps.filter((r) => r.fylke === f.navn);
      const partier = {};
      for (const r of rr) partier[r.parti] = (partier[r.parti] || 0) + 1;
      return { id: f.id, navn: f.navn, antall: rr.length, partier, representanter: rr };
    });
  }

  return { QTYPES, GROUP_KEYS, fetchJSON, isoDate, todayISO, sessions, getQuestions, countQuestions, questionDetails,
           currentReps, representatives, committees, parties, districts };
})();
