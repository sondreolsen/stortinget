"""Lokal webserver for Stortingssiden.

Start:  python server.py   ->  http://localhost:8000
Fritekstspørsmål krever ANTHROPIC_API_KEY (miljøvariabel eller fil .env i denne mappen).
"""

from __future__ import annotations

import json
import os
import sys
import traceback
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent

# Les .env (KEY=VALUE per linje) hvis den finnes
env = ROOT / ".env"
if env.exists():
    for line in env.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))

import stortinget as st  # noqa: E402


def _bool(v):
    return None if v in (None, "") else v.lower() in ("1", "true", "ja")


def _int(v):
    return int(v) if v not in (None, "") else None


def _qargs(p: dict) -> dict:
    keys = ("ar", "fra", "til", "sesjon", "sok", "fylke", "parti", "representant", "minister")
    a = {k: p[k] for k in keys if p.get(k)}
    if p.get("typer"):
        a["typer"] = [t for t in p["typer"].split(",") if t in st.QTYPES]
    return a


def api(path: str, p: dict):
    if path == "meta":
        return {"sesjoner": st.sessions(), "perioder": st.periods(), "typer": {k: v[1] for k, v in st.QTYPES.items()},
                "grupper": list(st.GROUP_KEYS), "claude": bool(os.environ.get("ANTHROPIC_API_KEY"))}
    if path == "sporsmal":
        qs, meta = st.get_questions(**_qargs(p), kun_besvarte=_bool(p.get("besvart")))
        n = _int(p.get("maks")) or 500
        return {**meta, "treff": qs[:n]}
    if path == "statistikk":
        qs, meta = st.get_questions(**_qargs(p))
        return {**meta, **st.count_questions(qs, p.get("grupper_etter") or "representant",
                                             p.get("del_opp_etter") or None, _int(p.get("topp")))}
    if path == "sporsmal/detaljer":
        return st.question_details(int(p["id"]))
    if path == "representanter":
        return st.representatives(komite=p.get("komite"), fylke=p.get("fylke"), parti=p.get("parti"),
                                  navn=p.get("navn"), periode=p.get("periode"),
                                  inkluder_vara=_bool(p.get("vara")) is not False)
    if path == "komiteer":
        return st.committees()
    if path == "partier":
        return st.parties()
    if path == "valgkretser":
        return st.districts()
    raise LookupError(path)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT / "static"), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, self.path))

    def _json(self, code: int, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if not u.path.startswith("/api/"):
            return super().do_GET()
        p = {k: v[-1] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            self._json(200, api(u.path[5:], p))
        except LookupError:
            self._json(404, {"feil": "Ukjent endepunkt"})
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"feil": str(e)})

    def do_POST(self):
        if self.path != "/api/spor":
            return self._json(404, {"feil": "Ukjent endepunkt"})
        if not os.environ.get("ANTHROPIC_API_KEY"):
            return self._json(400, {"feil": "ANTHROPIC_API_KEY er ikke satt. Se README.md."})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            import assistant
            self._json(200, assistant.ask(body.get("sporsmal", ""), body.get("historikk")))
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"feil": str(e)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"Stortingssiden kjører på http://localhost:{port}  (Ctrl+C for å stoppe)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
