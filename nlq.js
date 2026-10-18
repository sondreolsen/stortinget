"use strict";
/* Tolker norske fritekstspørsmål om Stortinget til en spørreplan uten bruk av AI.
   interpret(tekst, kontekst) -> { kind, params, tolkning: [..] }
   kind: "stats" | "search" | "reps" | "committee" | "committees" | "parties" | "districts" | "help" */

const NLQ = (() => {
  const L = "\\p{L}";
  const word = (re) => new RegExp(`(?<![${L}])(?:${re})(?![${L}])`, "iu");

  const NUM = { en: 1, ett: 1, to: 2, tre: 3, fire: 4, fem: 5, seks: 6, sju: 7, syv: 7, åtte: 8, ni: 9, ti: 10, tolv: 12, femten: 15, tjue: 20 };
  const NUMRE = `\\d+|${Object.keys(NUM).join("|")}`;
  const toNum = (s) => (/^\d+$/.test(s) ? parseInt(s, 10) : NUM[s.toLowerCase()]);

  const PARTIER = [
    ["SV", "sosialistisk venstreparti|sv"],
    ["A", "arbeiderpartiet|arbeiderpartiets|ap|aps"],
    ["FrP", "fremskrittspartiet|fremskrittspartiets|frp|frps"],
    ["H", "høyre|høyres"],
    ["Sp", "senterpartiet|senterpartiets|sp"],
    ["R", "rødt|rødts"],
    ["MDG", "miljøpartiet de grønne|miljøpartiet|de grønne|mdg"],
    ["KrF", "kristelig folkeparti|krf"],
    ["V", "venstre|venstres"],
  ];
  // Nye fylkes-/regionnavn og byer -> Stortingets valgkretser
  const FYLKE_ALIAS = [
    ["vestfold og telemark", ["Vestfold", "Telemark"]],
    ["troms og finnmark", ["Troms", "Finnmark"]],
    ["vestland", ["Hordaland", "Sogn og Fjordane"]],
    ["agder", ["Aust-Agder", "Vest-Agder"]],
    ["innlandet", ["Hedmark", "Oppland"]],
    ["trøndelag", ["Sør-Trøndelag", "Nord-Trøndelag"]],
    ["viken", ["Akershus", "Buskerud", "Østfold"]],
    ["bergen", ["Hordaland"]], ["trondheim", ["Sør-Trøndelag"]], ["stavanger", ["Rogaland"]],
    ["tromsø", ["Troms"]], ["kristiansand", ["Vest-Agder"]], ["drammen", ["Buskerud"]],
  ];
  const STOP = new Set(("hva hvem hvilke hvilken hvilket hvor mange når har er det noen som om i på av til for med fra de den det en et og eller " +
    "spørsmål spurt spør stilt stille skriftlige skriftlig representant representanter stortinget stortingets siste årene år året lag liste " +
    "over vis finn gi meg kan du jeg ønsker alle om ang angående sak saken saker tema temaet blitt vært noe noen nylig").split(" "));

  const today = () => ST.todayISO();
  const yearsAgo = (n) => { const d = new Date(today()); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); };
  const monthsAgo = (n) => { const d = new Date(today()); d.setMonth(d.getMonth() - n); return d.toISOString().slice(0, 10); };
  const fmt = (iso) => iso ? iso.split("-").reverse().join(".") : "";

  /* ---------- delparsere ---------- */
  function parsePeriod(t, ctx) {
    const y = new Date().getFullYear();
    let m;
    if ((m = /fra\s+(20\d\d)\s+(?:til|og ut)\s+(20\d\d)/i.exec(t))) return { p: { fra: `${m[1]}-01-01`, til: `${m[2]}-12-31` }, txt: `${m[1]}–${m[2]}` };
    if ((m = /sesjon(?:en)?\s+(20\d\d)\s*[-–/]\s*(20\d\d)/i.exec(t))) return { p: { sesjon: `${m[1]}-${m[2]}` }, txt: `sesjonen ${m[1]}-${m[2]}` };
    if (/(denne|inneværende|nåværende) sesjon/i.test(t)) return { p: { sesjon: ctx.sesjon }, txt: `sesjonen ${ctx.sesjon}` };
    if (/forrige sesjon/i.test(t)) { const a = parseInt(ctx.sesjon); return { p: { sesjon: `${a - 1}-${a}` }, txt: `sesjonen ${a - 1}-${a}` }; }
    if (/(denne|inneværende|nåværende) (stortings)?periode/i.test(t) && ctx.periodeFra) return { p: { fra: ctx.periodeFra }, txt: `stortingsperioden (fra ${fmt(ctx.periodeFra)})` };
    if ((m = new RegExp(`siste\\s+(${NUMRE})\\s+måned`, "iu").exec(t))) { const n = toNum(m[1]); return { p: { fra: monthsAgo(n) }, txt: `siste ${n} måneder` }; }
    if (/siste (måned|30 dager)/i.test(t)) return { p: { fra: monthsAgo(1) }, txt: "siste måned" };
    if ((m = new RegExp(`siste\\s+(${NUMRE})\\s+år`, "iu").exec(t))) { const n = toNum(m[1]); return { p: { fra: yearsAgo(n) }, txt: `siste ${n} år` }; }
    if (/siste året|siste 12 måneder|det siste år/i.test(t)) return { p: { fra: yearsAgo(1) }, txt: "siste 12 måneder" };
    if (/(de )?siste år(ene)?|de senere år|de siste tida?|i det siste/i.test(t)) return { p: { fra: yearsAgo(5) }, txt: "siste 5 år" };
    if ((m = /siden\s+(20\d\d)/i.exec(t))) return { p: { fra: `${m[1]}-01-01` }, txt: `siden ${m[1]}` };
    if (/hittil i år|i år|dette året|inneværende år/i.test(t)) return { p: { ar: y }, txt: `${y}` };
    if (/i fjor|forrige år/i.test(t)) return { p: { ar: y - 1 }, txt: `${y - 1}` };
    if ((m = /(?:^|\s)(?:i|år|for|under|gjennom)\s+(20\d\d|19\d\d)(?!\s*[-–/]\s*\d)/i.exec(t))) return { p: { ar: +m[1] }, txt: m[1] };
    return null;
  }

  function parseTypes(t) {
    if (/alle (typer )?(spørsmål|spørsmålstyper)/i.test(t)) return ["skriftlige", "sporretime", "interpellasjoner"];
    const out = [];
    if (/skriftlig/i.test(t)) out.push("skriftlige");
    if (/spørretime|muntlig/i.test(t)) out.push("sporretime");
    if (/interpellasjon/i.test(t)) out.push("interpellasjoner");
    return out.length ? out : ["skriftlige"];
  }

  function findParties(t) {
    const out = [];
    let rest = t;
    for (const [id, re] of PARTIER) {
      const r = word(re);
      if (r.test(rest)) { out.push(id); rest = rest.replace(new RegExp(r.source, "giu"), " "); }
    }
    return { partier: out, rest };
  }

  function findFylker(t, fylker) {
    const out = new Set();
    let rest = t;
    for (const [alias, list] of FYLKE_ALIAS) {
      const r = word(alias + "s?");
      if (r.test(rest)) { list.forEach((f) => out.add(f)); rest = rest.replace(new RegExp(r.source, "giu"), " "); }
    }
    for (const f of [...fylker].sort((a, b) => b.length - a.length)) {
      const r = word(f.replace(/-/g, "[- ]?") + "s?");
      if (r.test(rest)) { out.add(f); rest = rest.replace(new RegExp(r.source, "giu"), " "); }
    }
    return { fylker: [...out], rest };
  }

  function findCommittee(t, komiteer) {
    const m = new RegExp(`([${L}]+(?:-\\s*og\\s+[${L}]+)?)-?\\s*komite(?:en|ens|ene)?`, "iu").exec(t);
    if (!m) return null;
    let stem = m[1].toLowerCase().replace(/\s+/g, " ");
    if (stem === "i" || stem === "en" || stem === "den" || stem === "hvilken" || stem === "hvilke") return null;
    const cands = [stem, stem.replace(/s$/, ""), stem.split(/-\s*og\s+/)[0]];
    for (const c of cands) {
      if (c.length < 3) continue;
      const hit = komiteer.find((k) => k.navn.toLowerCase().startsWith(c)) || komiteer.find((k) => k.navn.toLowerCase().includes(c));
      if (hit) return hit;
    }
    return null;
  }

  function findRep(t, original, reps) {
    const lower = t.toLowerCase();
    const full = reps.filter((r) => lower.includes(r.navn.toLowerCase()));
    if (full.length) return full.sort((a, b) => b.navn.length - a.navn.length)[0];
    // Etternavn alene, skrevet med stor forbokstav og unikt blant representantene
    for (const r of reps) {
      const last = r.etternavn?.split(" ").pop();
      if (!last || last.length < 4) continue;
      if (new RegExp(`(?<![${L}])${last}s?(?![${L}])`, "u").test(original) &&
          reps.filter((x) => x.etternavn?.split(" ").pop() === last).length === 1) return r;
    }
    return null;
  }

  function findMinister(t) {
    const m = new RegExp(`([${L}-]*minister(?:en)?|statsministeren)`, "iu").exec(t);
    if (!m || /^minister(en)?$/i.test(m[1])) return null;
    return m[1].toLowerCase().replace(/minister$/, "ministeren");
  }

  function findTopic(t) {
    // Tekst i anførselstegn vinner
    let m = /[«"“']([^»"”']{2,})[»"”']/.exec(t);
    if (m) return m[1].trim();
    m = new RegExp(`(?<![${L}])(?:om|angående|ang\\.|vedrørende|knyttet til|handler om|nevner|nevnt)\\s+(.+)`, "iu").exec(t);
    if (!m) return null;
    let s = m[1];
    const cut = /(?:^|\s+)(?:de siste|siste|i år|i fjor|siden|fra 20|i 20\d\d|for 20\d\d|denne|forrige|hittil|i løpet|til [\p{L}-]*minister|av (?:representant|stortings)|fordelt|per |som (?:ikke|er|har|enno|ennå)|(?:er |har )?ikke (?:er |blitt |fått )?(?:besvart|svar)|ubesvart|uten svar|venter på svar|og hvem|og hvor|\?|$)/iu;
    s = s.split(cut)[0];
    s = s.replace(/[?.!,]+$/g, "").replace(/^(temaet|saken|tema|prosjektet)\s+/i, "").trim();
    if (!s || STOP.has(s.toLowerCase())) return null;
    return s;
  }

  function parseTop(t) {
    let m = new RegExp(`topp\\s*-?\\s*(${NUMRE})|(?:de|den)\\s+(${NUMRE})\\s+(?:som|med|representant|mest|flittig)|(${NUMRE})\\s+(?:på topp|flest|mest)`, "iu").exec(t);
    if (m) return toNum(m[1] || m[2] || m[3]);
    if (/(?:hvem|hvilken representant) (?:har )?(?:stilt|spurt) (?:flest|mest)/i.test(t)) return 10;
    return null;
  }

  const GROUP_WORDS = [
    ["fylke", "fylke|fylker|fylkene|valgkrets|valgkretser|valgkretsene|stortingskrets"],
    ["parti", "parti|partier|partiene"],
    ["minister", "statsråd|statsråder|statsrådene|minister|ministre|ministrene|departement|departementene"],
    ["maaned", "måned|måneder|månedene"],
    ["sesjon", "sesjon|sesjoner|sesjonene"],
  ];
  function parseGrouping(t) {
    const repish = /representant|hvem|som har stilt|som har spurt|personer|politikere|flittigst|(?:de|den)\s+(?:\d+|ti|fem|tjue)\s+som/i.test(t);
    let split = null, group = null;
    for (const [g, re] of GROUP_WORDS) {
      const by = new RegExp(`(?:fordelt\\s+på|per|pr\\.?|for\\s+hver(?:t)?|i\\s+hver(?:t)?|etter|innen\\s+hver(?:t)?|innenfor\\s+hver(?:t)?)\\s+(?:${re})`, "iu");
      const which = new RegExp(`(?:hvilke|hvilket|hvilken|hver|hvert|alle)\\s+(?:${re})`, "iu");
      if (by.test(t)) { if (repish) split = g; else group = g; break; }
      if (which.test(t) && !repish) { group = g; break; }
    }
    if (!group) group = "representant";
    if (split === group) split = null;
    return { group, split };
  }

  /* ---------- hovedtolker ---------- */
  function interpret(text, ctx) {
    const original = text.trim();
    const t = original.replace(/\s+/g, " ");
    const lower = t.toLowerCase();
    const tolkning = [];

    const period = parsePeriod(t, ctx);
    const { partier, rest: r1 } = findParties(t);
    const { fylker, rest: r2 } = findFylker(r1, ctx.fylker);
    const komite = findCommittee(t, ctx.komiteer);
    const rep = findRep(r2, original, ctx.reps);
    const minister = findMinister(t);
    const types = parseTypes(t);

    const filters = {};
    const partiNavn = (id) => ctx.partier?.find((p) => p.id === id)?.navn || id;
    if (partier.length) { filters.parti = partier; tolkning.push("parti: " + partier.map(partiNavn).join(", ")); }
    if (fylker.length) { filters.fylke = fylker; tolkning.push("valgkrets: " + fylker.join(", ")); }

    const aboutQuestions = /spørsmål|spurt|spør |spørre|interpellasj|spørretime|stilt flest|stilt mest/i.test(lower);

    if (aboutQuestions || (rep && /spurt|spør/i.test(lower))) {
      const topic = findTopic(t);
      if (rep) { filters.representant = rep.navn; tolkning.unshift("representant: " + rep.navn); }
      if (minister) { filters.minister = minister; tolkning.push("til: " + minister); }
      if (/ubesvart|ikke (er )?(blitt )?besvart|ikke (har )?fått svar|uten svar|venter på svar/i.test(lower)) { filters.besvart = false; tolkning.push("bare ubesvarte"); }
      else if (/(?<![\p{L}])besvarte(?![\p{L}])|som er besvart|har fått svar/iu.test(lower)) { filters.besvart = true; tolkning.push("bare besvarte"); }
      if (topic) { filters.sok = topic; tolkning.unshift(`tema: «${topic}»`); }
      const counting = /hvor mange|flest|færrest|mest|minst|topp|rangering|rangér|liste over|oversikt|antall|statistikk|fordelt|(?<![\p{L}])per(?![\p{L}])|hver(t)? |hvilke (parti|fylke|valgkrets|statsråd|minister)/iu.test(lower);
      let p = period?.p, ptxt = period?.txt;
      if (!p) {
        if (topic) { p = { fra: yearsAgo(5) }; ptxt = "siste 5 år (standard for temasøk)"; }
        else { p = { ar: new Date().getFullYear() }; ptxt = `${new Date().getFullYear()} (standard)`; }
      }
      tolkning.unshift(types.map((x) => ST.QTYPES[x].flertall).join(" + "), "periode: " + ptxt);
      const params = { ...filters, ...p, typer: types };
      if (counting && !(rep && !/fordelt|per |hver/i.test(lower))) {
        const { group, split } = parseGrouping(t);
        const topp = parseTop(t);
        tolkning.push("gruppert per " + groupName(group) + (split ? `, én liste per ${groupName(split)}` : "") + (topp ? `, topp ${topp}` : ""));
        return { kind: "stats", params: { ...params, grupper: group, delOpp: split, topp }, tolkning, visListe: !!topic };
      }
      return { kind: "search", params, tolkning };
    }

    if (/komite/i.test(lower)) {
      if (komite) {
        tolkning.unshift("komité: " + komite.navn);
        return { kind: "reps", params: { ...filters, komite: komite.id }, tolkning, tittel: komite.navn };
      }
      if (partier.length || fylker.length) return { kind: "reps", params: filters, tolkning };
      return { kind: "committees", params: {}, tolkning: ["alle komiteer"] };
    }

    if (/valgkrets|stortingskrets|fylkene/i.test(lower) && !fylker.length) return { kind: "districts", params: {}, tolkning: ["alle valgkretser"] };
    if (/partiene|hvilke partier|partier på stortinget|mandat|størrelse/i.test(lower) && !fylker.length && !partier.length) return { kind: "parties", params: {}, tolkning: ["alle partier"] };

    if (/kvinne|kvinnelig/i.test(lower)) { filters.kjoenn = "kvinne"; tolkning.push("kvinner"); }
    else if (/(?<![\p{L}])menn(?![\p{L}])|mannlig/iu.test(lower)) { filters.kjoenn = "mann"; tolkning.push("menn"); }
    if (/vara/i.test(lower)) { filters.kunVara = true; tolkning.push("vararepresentanter som møter"); }

    if (rep) { tolkning.unshift("representant: " + rep.navn); return { kind: "reps", params: { ...filters, navn: rep.navn }, tolkning }; }
    if (partier.length || fylker.length || filters.kjoenn || filters.kunVara || /representant|hvem sitter|hvem er|innvalgt|stortinget nå|politikere/i.test(lower)) {
      return { kind: "reps", params: filters, tolkning: tolkning.length ? tolkning : ["alle representanter"] };
    }

    // Ukjent formulering: fritekstsøk i spørsmål på de meningsbærende ordene
    const words = t.replace(/[?.!,]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase()) && w.length > 2);
    if (words.length && words.length <= 4) {
      const p = period?.p || { fra: yearsAgo(5) };
      return { kind: "search", params: { ...p, sok: words.join(" "), typer: types },
        tolkning: [`fritekstsøk etter «${words.join(" ")}» i ${types.map((x) => ST.QTYPES[x].flertall.toLowerCase()).join(" + ")}`, "periode: " + (period?.txt || "siste 5 år")] };
    }
    return { kind: "help", params: {}, tolkning: [] };
  }

  const groupName = (g) => ({ representant: "representant", fylke: "valgkrets", parti: "parti", minister: "statsråd", maaned: "måned", sesjon: "sesjon", type: "type" }[g]);

  return { interpret };
})();
