"""Datatilgang mot Stortingets åpne API (https://data.stortinget.no).

Henter, cacher og normaliserer data om spørsmål, representanter, komiteer,
partier og valgkretser, og tilbyr filtrering og opptelling.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BASE = "https://data.stortinget.no/eksport/"
CACHE_DIR = Path(__file__).parent / ".cache"
LIVE_TTL = 60 * 30  # data for inneværende sesjon/dagens representanter: 30 min

# stortinget.no viser alle spørsmålstyper på samme side (?qnid=<id>)
QTYPES = {
    "skriftlige": ("skriftligesporsmal", "Skriftlig spørsmål",
                   "https://www.stortinget.no/no/Saker-og-publikasjoner/Sporsmal/Skriftlige-sporsmal-og-svar/Skriftlig-sporsmal/?qnid={id}"),
    "sporretime": ("sporretimesporsmal", "Spørretimespørsmål",
                   "https://www.stortinget.no/no/Saker-og-publikasjoner/Sporsmal/Skriftlige-sporsmal-og-svar/Skriftlig-sporsmal/?qnid={id}"),
    "interpellasjoner": ("interpellasjoner", "Interpellasjon",
                         "https://www.stortinget.no/no/Saker-og-publikasjoner/Sporsmal/Skriftlige-sporsmal-og-svar/Skriftlig-sporsmal/?qnid={id}"),
}

_mem: dict[str, tuple[float, object]] = {}
_lock = threading.Lock()
_url_locks: dict[str, threading.Lock] = defaultdict(threading.Lock)


# ---------------------------------------------------------------- HTTP/cache

def fetch(endpoint: str, params: dict | None = None, ttl: float | None = LIVE_TTL) -> dict:
    """GET mot eksport-API-et. ttl=None betyr permanent (diskcache)."""
    params = dict(params or {})
    params["format"] = "json"
    url = BASE + endpoint + "?" + urllib.parse.urlencode(params)
    with _lock:
        hit = _mem.get(url)
        lock = _url_locks[url]
    if hit and (ttl is None or time.time() - hit[0] < ttl):
        return hit[1]  # type: ignore[return-value]
    with lock:  # unngå parallelle nedlastinger av samme store fil
        with _lock:
            hit = _mem.get(url)
        if hit and (ttl is None or time.time() - hit[0] < ttl):
            return hit[1]  # type: ignore[return-value]
        disk = CACHE_DIR / (re.sub(r"[^\w.-]+", "_", endpoint + "_" + urllib.parse.urlencode(params)) + ".json")
        if ttl is None and disk.exists():
            data = json.loads(disk.read_text(encoding="utf-8"))
        else:
            req = urllib.request.Request(url, headers={"User-Agent": "Stortingsside/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
            if isinstance(data, dict) and data.get("feilmelding"):
                raise RuntimeError(f"Stortinget-API feil: {data.get('feilmelding')}")
            if ttl is None:
                CACHE_DIR.mkdir(exist_ok=True)
                disk.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        with _lock:
            _mem[url] = (time.time(), data)
        return data


_DATE_RE = re.compile(r"/Date\((-?\d+)([+-]\d{4})?\)/")


def parse_date(s: str | None) -> datetime | None:
    if not s:
        return None
    m = _DATE_RE.match(s)
    if not m:
        return None
    ms = int(m.group(1))
    off = m.group(2) or "+0000"
    tz = timezone(timedelta(hours=int(off[:3]), minutes=int(off[0] + off[3:])))
    # fromtimestamp feiler for datoer før 1970 på Windows
    return (datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=ms)).astimezone(tz)


def _iso(s: str | None) -> str | None:
    d = parse_date(s)
    return d.date().isoformat() if d else None


# ---------------------------------------------------------------- sesjoner

def sessions() -> dict:
    d = fetch("sesjoner", ttl=6 * 3600)
    lst = [{"id": s["id"], "fra": _iso(s["fra"]), "til": _iso(s["til"])} for s in d["sesjoner_liste"]]
    return {"innevaerende": d["innevaerende_sesjon"]["id"], "sesjoner": lst}


def periods() -> dict:
    d = fetch("stortingsperioder", ttl=6 * 3600)
    lst = [{"id": s["id"], "fra": _iso(s["fra"]), "til": _iso(s["til"])} for s in d["stortingsperioder_liste"]]
    return {"innevaerende": d["innevaerende_stortingsperiode"]["id"], "perioder": lst}


def _session_ttl(sesjon: str) -> float | None:
    """Avsluttede sesjoner endres i praksis ikke lenger -> permanent cache."""
    s = sessions()
    cur = s["innevaerende"]
    return None if sesjon < _prev_session(cur) else LIVE_TTL


def _prev_session(sid: str) -> str:
    a = int(sid[:4])
    return f"{a - 1}-{a}"


def sessions_between(fra: date, til: date) -> list[str]:
    out = []
    for s in sessions()["sesjoner"]:
        if s["fra"] and s["til"] and date.fromisoformat(s["fra"]) <= til and date.fromisoformat(s["til"]) >= fra:
            if date.fromisoformat(s["fra"]) <= date.today():
                out.append(s["id"])
    return sorted(out)


# ---------------------------------------------------------------- spørsmål

def _person(p: dict | None) -> dict | None:
    if not p:
        return None
    out = {"id": p.get("id"), "navn": f"{p.get('fornavn', '')} {p.get('etternavn', '')}".strip()}
    if p.get("parti"):
        out["parti"] = p["parti"].get("id")
        out["parti_navn"] = p["parti"].get("navn")
    if p.get("fylke"):
        out["fylke"] = p["fylke"].get("navn")
    if p.get("vara_representant"):
        out["vara"] = True
    return out


def _norm_question(q: dict, qtype: str) -> dict:
    fra = _person(q.get("sporsmal_fra")) or {}
    return {
        "id": q["id"],
        "type": qtype,
        "type_navn": QTYPES[qtype][1],
        "sesjon": q.get("sesjon_id"),
        "nummer": q.get("sporsmal_nummer"),
        "tittel": (q.get("tittel") or "").strip(),
        "dato": _iso(q.get("datert_dato")) or _iso(q.get("sendt_dato")),
        "besvart_dato": _iso(q.get("besvart_dato")),
        "besvart": bool(q.get("besvart_dato")),
        "fra": fra,
        "til": q.get("sporsmal_til_minister_tittel"),
        "til_person": (_person(q.get("sporsmal_til")) or {}).get("navn"),
        "besvart_av": q.get("besvart_av_minister_tittel"),
        "emner": [e.get("navn") for e in q.get("emne_liste") or [] if e.get("navn")],
        "url": QTYPES[qtype][2].format(id=q["id"]),
    }


def questions_for_session(qtype: str, sesjon: str) -> list[dict]:
    endpoint = QTYPES[qtype][0]
    d = fetch(endpoint, {"sesjonid": sesjon}, ttl=_session_ttl(sesjon))
    return [_norm_question(q, qtype) for q in d.get("sporsmal_liste") or []]


def _resolve_period(ar=None, fra=None, til=None, sesjon=None) -> tuple[list[str], date | None, date | None]:
    """Returnerer (sesjoner som må hentes, fra-dato, til-dato)."""
    if sesjon:
        return [sesjon], None, None
    today = date.today()
    if ar:
        f, t = date(int(ar), 1, 1), date(int(ar), 12, 31)
    else:
        f = date.fromisoformat(fra) if fra else date(today.year, 1, 1)
        t = date.fromisoformat(til) if til else today
    return sessions_between(f, t), f, t


def _norm_text(s: str) -> str:
    return s.lower().replace("-", " ")


def _match_name(value: str | None, wanted: str | None) -> bool:
    if not wanted:
        return True
    return bool(value) and _norm_text(wanted) in _norm_text(value)


def get_questions(ar=None, fra=None, til=None, sesjon=None, typer=None, sok=None, fylke=None, parti=None,
                  representant=None, minister=None, kun_besvarte=None) -> tuple[list[dict], dict]:
    typer = typer or ["skriftlige"]
    sesj, f, t = _resolve_period(ar, fra, til, sesjon)
    out: list[dict] = []
    for qt in typer:
        for s in sesj:
            out.extend(questions_for_session(qt, s))
    terms = []
    if sok:
        # Støtt "a OR b" / "a | b" (alternativer) og ellers alle ord må finnes
        alts = [a.strip() for a in re.split(r"\s+(?:OR|ELLER)\s+|\s*\|\s*", sok) if a.strip()]
        terms = [[_norm_text(w) for w in a.split()] for a in alts]
    res = []
    for q in out:
        if f and (not q["dato"] or q["dato"] < f.isoformat()):
            continue
        if t and q["dato"] and q["dato"] > t.isoformat():
            continue
        if fylke and not _match_name(q["fra"].get("fylke"), fylke):
            continue
        if parti and not (q["fra"].get("parti", "").lower() == parti.lower() or _match_name(q["fra"].get("parti_navn"), parti)):
            continue
        if representant and not (q["fra"].get("id", "").lower() == representant.lower() or _match_name(q["fra"].get("navn"), representant)):
            continue
        if minister and not (_match_name(q["til"], minister) or _match_name(q["besvart_av"], minister) or _match_name(q["til_person"], minister)):
            continue
        if kun_besvarte is not None and q["besvart"] != kun_besvarte:
            continue
        if terms:
            hay = _norm_text(q["tittel"] + " " + " ".join(q["emner"]))
            if not any(all(w in hay for w in alt) for alt in terms):
                continue
        res.append(q)
    res.sort(key=lambda q: q["dato"] or "", reverse=True)
    meta = {"sesjoner": sesj, "fra": f.isoformat() if f else None, "til": t.isoformat() if t else None,
            "typer": typer, "antall": len(res)}
    return res, meta


GROUP_KEYS = {
    "representant": lambda q: q["fra"].get("id") or q["fra"].get("navn"),
    "fylke": lambda q: q["fra"].get("fylke") or "Ukjent",
    "parti": lambda q: q["fra"].get("parti") or "Ukjent",
    "minister": lambda q: q["til"] or "Ukjent",
    "maaned": lambda q: (q["dato"] or "")[:7],
    "sesjon": lambda q: q["sesjon"],
    "type": lambda q: q["type_navn"],
}


def count_questions(questions: list[dict], grupper_etter="representant", del_opp_etter=None, topp=None) -> dict:
    """Teller spørsmål. Med del_opp_etter fås én topp-liste per gruppe (f.eks. per fylke)."""
    key = GROUP_KEYS[grupper_etter]
    info: dict[str, dict] = {}
    for q in questions:
        k = key(q)
        if k not in info:
            if grupper_etter == "representant":
                info[k] = {"id": q["fra"].get("id"), "navn": q["fra"].get("navn"), "parti": q["fra"].get("parti"),
                           "fylke": q["fra"].get("fylke")}
            elif grupper_etter == "parti":
                info[k] = {"navn": k, "parti_navn": q["fra"].get("parti_navn")}
            else:
                info[k] = {"navn": k}

    def ranked(qs):
        c = Counter(key(q) for q in qs)
        rows = [{**info[k], "antall": n} for k, n in c.most_common()]
        if grupper_etter in ("maaned", "sesjon"):
            rows.sort(key=lambda r: r["navn"])
        return rows[:topp] if topp else rows

    if del_opp_etter:
        split = GROUP_KEYS[del_opp_etter]
        groups: dict[str, list] = defaultdict(list)
        for q in questions:
            groups[split(q)].append(q)
        return {"totalt": len(questions), "grupper": [
            {"gruppe": g, "antall": len(qs), "rader": ranked(qs)}
            for g, qs in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        ]}
    return {"totalt": len(questions), "rader": ranked(questions)}


def question_details(qid: int) -> dict:
    d = fetch("enkeltsporsmal", {"NSporsmalId": qid}, ttl=6 * 3600)
    clean = lambda s: re.sub(r"<br\s*/?>", "\n", s or "").replace("&nbsp;", " ")
    clean_tags = lambda s: re.sub(r"<[^>]+>", "", clean(s)).strip()
    qtype = {"5": "skriftlige", "4": "sporretime", "2": "interpellasjoner"}.get(str(d.get("type")), "skriftlige")
    return {
        "id": d.get("id"),
        "tittel": d.get("tittel"),
        "sporsmal": clean_tags(d.get("sporsmal")),
        "begrunnelse": clean_tags(d.get("begrunnelse")),
        "svar": clean_tags(d.get("svar")),
        "fra": _person(d.get("sporsmal_fra")),
        "til": d.get("sporsmal_til_minister_tittel"),
        "besvart_av": (_person(d.get("besvart_av")) or {}).get("navn"),
        "besvart_av_tittel": d.get("besvart_av_minister_tittel"),
        "datert": _iso(d.get("datert_dato")),
        "besvart_dato": _iso(d.get("besvart_dato")),
        "sesjon": d.get("sesjon_id"),
        "url": QTYPES[qtype][2].format(id=d.get("id")),
    }


# ---------------------------------------------------------------- personer/organer

def current_representatives() -> list[dict]:
    d = fetch("dagensrepresentanter")
    out = []
    for p in d["dagensrepresentanter_liste"]:
        r = _person(p)
        r["kjoenn"] = "kvinne" if p.get("kjoenn") == 1 else "mann"
        r["epost"] = p.get("epost")
        r["fodt"] = _iso(p.get("foedselsdato"))
        r["komiteer"] = [{"id": k["id"], "navn": k["navn"]} for k in p.get("komiteer_liste") or []]
        r["vara"] = bool(p.get("vara_representant"))
        vf = p.get("vara_for")
        if vf:
            r["moter_for"] = _person(vf)["navn"]
        out.append(r)
    out.sort(key=lambda r: (r.get("fylke") or "", r["navn"]))
    return out


def representatives(komite=None, fylke=None, parti=None, navn=None, inkluder_vara=True, periode=None) -> list[dict]:
    if periode:
        d = fetch("representanter", {"stortingsperiodeid": periode}, ttl=6 * 3600)
        reps = [_person(p) for p in d["representanter_liste"]]
    else:
        reps = current_representatives()
    res = []
    for r in reps:
        if komite and not any(komite.lower() == k["id"].lower() or _match_name(k["navn"], komite) for k in r.get("komiteer", [])):
            continue
        if fylke and not _match_name(r.get("fylke"), fylke):
            continue
        if parti and not (str(r.get("parti", "")).lower() == parti.lower() or _match_name(r.get("parti_navn"), parti)):
            continue
        if navn and not _match_name(r["navn"], navn):
            continue
        if not inkluder_vara and r.get("vara"):
            continue
        res.append(r)
    return res


def committees(sesjon=None) -> list[dict]:
    sesjon = sesjon or sessions()["innevaerende"]
    d = fetch("komiteer", {"sesjonid": sesjon}, ttl=6 * 3600)
    members: dict[str, list] = defaultdict(list)
    for r in current_representatives():
        for k in r["komiteer"]:
            members[k["id"]].append({"navn": r["navn"], "parti": r.get("parti"), "fylke": r.get("fylke"),
                                     "vara": r.get("vara", False), **({"moter_for": r["moter_for"]} if r.get("moter_for") else {})})
    return [{"id": k["id"], "navn": k["navn"], "antall": len(members[k["id"]]),
             "medlemmer": sorted(members[k["id"]], key=lambda m: (m["parti"] or "", m["navn"]))}
            for k in d["komiteer_liste"] if members[k["id"]]]  # API-et lister også nedlagte særkomiteer


def parties(sesjon=None) -> list[dict]:
    sesjon = sesjon or sessions()["innevaerende"]
    d = fetch("partier", {"sesjonid": sesjon}, ttl=6 * 3600)
    seats = Counter(r.get("parti") for r in current_representatives())
    return [{"id": p["id"], "navn": p["navn"], "mandater_na": seats.get(p["id"], 0)} for p in d["partier_liste"]]


def districts() -> list[dict]:
    d = fetch("fylker", ttl=24 * 3600)
    reps = current_representatives()
    by = defaultdict(list)
    for r in reps:
        by[r.get("fylke")].append(r)
    out = []
    for f in d["fylker_liste"]:
        if f.get("historisk_fylke"):
            continue
        rr = by.get(f["navn"], [])
        out.append({"id": f["id"], "navn": f["navn"], "antall": len(rr),
                    "partier": dict(Counter(r.get("parti") for r in rr).most_common()),
                    "representanter": [{"navn": r["navn"], "parti": r.get("parti"), "vara": r.get("vara", False)} for r in rr]})
    return out


def raw(endpoint: str, params: dict | None = None) -> dict:
    """Generisk oppslag mot et vilkårlig eksport-endepunkt (for spørsmål appen ikke dekker spesifikt)."""
    if not re.fullmatch(r"[a-zA-Z]+", endpoint):
        raise ValueError("Ugyldig endepunkt")
    return fetch(endpoint, params or {}, ttl=LIVE_TTL)
