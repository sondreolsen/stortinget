"""Fritekstspørsmål om Stortinget, besvart av Claude med verktøy mot Stortingets API."""

from __future__ import annotations

import json
import os
from datetime import date

import anthropic

import stortinget as st

MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
MAX_ROUNDS = 12

PERIOD_PROPS = {
    "ar": {"type": "integer", "description": "Kalenderår, f.eks. 2026. 'i år' = inneværende år."},
    "fra": {"type": "string", "description": "Fra-dato YYYY-MM-DD (alternativ til ar)."},
    "til": {"type": "string", "description": "Til-dato YYYY-MM-DD (standard: i dag)."},
    "sesjon": {"type": "string", "description": "Stortingssesjon, f.eks. '2025-2026' (1. okt–30. sep). Overstyrer ar/fra/til."},
    "typer": {"type": "array", "items": {"type": "string", "enum": list(st.QTYPES)},
              "description": "Spørsmålstyper. Standard: ['skriftlige']."},
    "fylke": {"type": "string", "description": "Valgkrets/fylke til spørrer, f.eks. 'Hordaland'."},
    "parti": {"type": "string", "description": "Partikode (A, H, FrP, SV, Sp, R, MDG, KrF, V) eller navn."},
    "representant": {"type": "string", "description": "Navn (del av) eller person-id til spørrer."},
    "minister": {"type": "string", "description": "Statsråd spørsmålet er stilt til, f.eks. 'samferdselsministeren'."},
    "sok": {"type": "string", "description": "Fritekst i tittel/spørsmålstekst og emner. Alle ord må finnes; "
                                               "bruk ' OR ' mellom alternativer, f.eks. 'Hordfast OR E39 Stord'."},
}

TOOLS = [
    {
        "name": "sok_sporsmal",
        "description": "Søk og list spørsmål (skriftlige spørsmål, spørretimespørsmål, interpellasjoner) med filtre. "
                       "Uten periode brukes 1. januar i år til i dag. Returnerer antall treff og de nyeste treffene.",
        "input_schema": {"type": "object", "properties": {
            **PERIOD_PROPS,
            "maks": {"type": "integer", "description": "Maks antall treff som returneres (standard 40, maks 200)."},
        }},
    },
    {
        "name": "sporsmal_statistikk",
        "description": "Tell spørsmål gruppert etter representant, fylke, parti, minister, måned, sesjon eller type. "
                       "Med del_opp_etter fås én rangert liste per gruppe, f.eks. grupper_etter='representant' og "
                       "del_opp_etter='fylke' gir topplisten innen hvert fylke.",
        "input_schema": {"type": "object", "properties": {
            **PERIOD_PROPS,
            "grupper_etter": {"type": "string", "enum": list(st.GROUP_KEYS)},
            "del_opp_etter": {"type": "string", "enum": list(st.GROUP_KEYS)},
            "topp": {"type": "integer", "description": "Antall rader (per gruppe). Utelat for alle."},
        }, "required": ["grupper_etter"]},
    },
    {
        "name": "sporsmal_detaljer",
        "description": "Hent full tekst for ett spørsmål: spørsmål, begrunnelse og statsrådens svar.",
        "input_schema": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]},
    },
    {
        "name": "representanter",
        "description": "Dagens representanter (oppdatert, inkl. vararepresentanter som møter) med parti, fylke og "
                       "komiteer. Filtrer på komité (navn eller id), fylke, parti eller navn. "
                       "Med periode (f.eks. '2021-2025') listes alle representanter i en tidligere stortingsperiode.",
        "input_schema": {"type": "object", "properties": {
            "komite": {"type": "string"}, "fylke": {"type": "string"}, "parti": {"type": "string"},
            "navn": {"type": "string"}, "inkluder_vara": {"type": "boolean"}, "periode": {"type": "string"},
        }},
    },
    {
        "name": "komiteer",
        "description": "Alle stortingskomiteer i inneværende sesjon med dagens medlemmer.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "partier",
        "description": "Partier på Stortinget i inneværende sesjon med antall representanter nå.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "valgkretser",
        "description": "Valgkretsene (fylkene) med dagens representanter og partifordeling.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "stortinget_api",
        "description": "Generisk GET mot https://data.stortinget.no/eksport/<endepunkt> for data de andre verktøyene "
                       "ikke dekker, f.eks. 'saker' (sesjonid), 'sak' (sakid), 'voteringer' (sakid), "
                       "'voteringsresultat' (voteringid), 'moter' (sesjonid), 'horinger' (sesjonid), "
                       "'person' (personid) osv. Resultatet kuttes ved ca. 30 000 tegn.",
        "input_schema": {"type": "object", "properties": {
            "endepunkt": {"type": "string"}, "parametre": {"type": "object"},
        }, "required": ["endepunkt"]},
    },
]


def _period_args(a: dict) -> dict:
    keys = ("ar", "fra", "til", "sesjon", "typer", "fylke", "parti", "representant", "minister", "sok")
    return {k: a[k] for k in keys if a.get(k) not in (None, "", [])}


def _compact(q: dict) -> dict:
    return {"id": q["id"], "dato": q["dato"], "type": q["type_navn"], "fra": q["fra"].get("navn"),
            "parti": q["fra"].get("parti"), "fylke": q["fra"].get("fylke"), "til": q["til"],
            "besvart": q["besvart"], "tittel": q["tittel"][:400], "url": q["url"]}


def run_tool(name: str, a: dict):
    if name == "sok_sporsmal":
        qs, meta = st.get_questions(**_period_args(a))
        n = min(int(a.get("maks") or 40), 200)
        return {**meta, "viser": min(n, len(qs)), "treff": [_compact(q) for q in qs[:n]]}
    if name == "sporsmal_statistikk":
        qs, meta = st.get_questions(**_period_args(a))
        return {**meta, **st.count_questions(qs, a["grupper_etter"], a.get("del_opp_etter"), a.get("topp"))}
    if name == "sporsmal_detaljer":
        return st.question_details(a["id"])
    if name == "representanter":
        return st.representatives(**{k: v for k, v in a.items() if v not in (None, "")})
    if name == "komiteer":
        return st.committees()
    if name == "partier":
        return st.parties()
    if name == "valgkretser":
        return st.districts()
    if name == "stortinget_api":
        return st.raw(a["endepunkt"], a.get("parametre"))
    raise ValueError(f"Ukjent verktøy {name}")


def _system() -> str:
    s = st.sessions()["innevaerende"]
    return (
        "Du er en analytiker som svarer på spørsmål om Stortinget ved hjelp av verktøy mot Stortingets åpne data "
        "(data.stortinget.no). Svar på norsk bokmål, kort og presist.\n"
        f"Dagens dato er {date.today().isoformat()}. Inneværende sesjon er {s}. "
        "En sesjon går fra 1. oktober til 30. september. 'I år' betyr kalenderåret med mindre brukeren sier sesjon.\n"
        "Retningslinjer:\n"
        "- Hent alltid data med verktøyene; ikke gjett tall eller navn.\n"
        "- Lister og rangeringer presenteres som markdown-tabeller. Lenk til spørsmål med url-feltet.\n"
        "- Si kort hvilken periode og hvilke spørsmålstyper tallene gjelder, og hvordan du tolket tvetydige "
        "spørsmål (f.eks. 'fordelt på fylke' = topplisten med fylke som kolonne, eller én liste per fylke).\n"
        "- Ved tekstsøk: prøv relevante varianter og synonymer (bokmål/nynorsk, prosjektnavn, veinummer) "
        "før du konkluderer med at ingen har spurt.\n"
        "- Fylke = valgkretsen representanten er valgt fra."
    )


def ask(question: str, history: list[dict] | None = None) -> dict:
    client = anthropic.Anthropic()
    messages: list = []
    for h in (history or [])[-6:]:
        if h.get("q") and h.get("a"):
            messages += [{"role": "user", "content": h["q"]}, {"role": "assistant", "content": h["a"]}]
    messages.append({"role": "user", "content": question})
    calls = []
    for _ in range(MAX_ROUNDS):
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            system=_system(),
            tools=TOOLS,
            messages=messages,
            output_config={"effort": "medium"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        if resp.stop_reason == "refusal":
            return {"svar": "Modellen avslo å svare på dette spørsmålet.", "kall": calls}
        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        if resp.stop_reason != "tool_use" or not tool_uses:
            text = "\n".join(b.text for b in resp.content if b.type == "text").strip()
            return {"svar": text or "(tomt svar)", "kall": calls}
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for tu in tool_uses:
            calls.append({"verktoy": tu.name, "input": tu.input})
            try:
                out = json.dumps(run_tool(tu.name, tu.input), ensure_ascii=False)
                if len(out) > 30000:
                    out = out[:30000] + " …[avkortet]"
                results.append({"type": "tool_result", "tool_use_id": tu.id, "content": out})
            except Exception as e:  # feilen sendes tilbake så Claude kan prøve noe annet
                results.append({"type": "tool_result", "tool_use_id": tu.id, "content": f"Feil: {e}", "is_error": True})
        messages.append({"role": "user", "content": results})
    return {"svar": "Fant ikke et svar innen grensen for antall oppslag. Prøv å omformulere spørsmålet.", "kall": calls}
