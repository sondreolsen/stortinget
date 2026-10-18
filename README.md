# Stortingsdata

**https://sondreolsen.github.io/stortinget/**

Søk i skriftlige spørsmål, spørretimespørsmål og interpellasjoner, og se dagens representanter, komiteer, partier og valgkretser – hentet live fra [Stortingets åpne data](https://data.stortinget.no/dokumentasjon-og-hjelp/).

Siden er ren HTML/JavaScript uten server. Nettleseren henter data direkte fra `data.stortinget.no`, så alt er alltid oppdatert. Ingen innlogging eller API-nøkkel trengs.

## Faner

| Fane | Hva den gjør |
|---|---|
| **Spør** | Skriv spørsmålet på vanlig norsk. Siden tolker det og viser hvordan den forsto det (periode, tema, parti, valgkrets osv.). |
| **Spørsmålsstatistikk** | Tell spørsmål per representant, valgkrets, parti, statsråd, måned eller sesjon. «Del opp etter» gir én toppliste per gruppe. Klikk på et navn for å se spørsmålene. |
| **Søk i spørsmål** | Fritekstsøk med filtre. «Vis svar» henter begrunnelse og statsrådens svar. |
| **Representanter** | Dagens representanter, inkludert vararepresentanter som møter, med komiteer og e-post. |
| **Komiteer** | Alle komiteer med dagens medlemmer. |
| **Partier og valgkretser** | Antall representanter per parti og partifordeling per valgkrets. |

Alle tabeller kan lastes ned som CSV. Et spørsmål kan lenkes direkte: `https://sondreolsen.github.io/stortinget/?q=Hvem sitter i finanskomiteen`.

## Eksempler på spørsmål

- Lag en liste over hvor mange skriftlige spørsmål de ulike representantene har stilt i år
- Lag en liste over de 10 som har stilt flest skriftlige spørsmål, fordelt på fylke
- Er det noen som har stilt spørsmål om Hordfast de siste årene?
- Hvor mange spørsmål har hvert parti stilt til samferdselsministeren i 2025?
- Hvilke statsråder får flest spørsmål denne sesjonen?
- Hvem i finanskomiteen er fra Hordaland? · Høyres representanter fra Vestland · Kvinnelige representanter fra Oslo

Tolken forstår perioder («i år», «i fjor», «siste 3 år», «siden 2020», «denne sesjonen»), spørsmålstyper, partier, valgkretser (også nye fylkesnavn som Vestland og Innlandet), komiteer, representantnavn og statsråder. Sett tekst i anførselstegn for eksakt frase, og bruk `OR` mellom alternativer, f.eks. `Hordfast OR E39 Stord`.

## Verdt å vite

- «Valgkrets»/«fylke» er valgkretsen representanten er valgt fra, med Stortingets (gamle) fylkesnavn.
- Alle spørsmål tas med, også de som venter på svar, er trukket eller har bortfalt. Status vises ved hvert spørsmål, og «Søk i spørsmål» kan filtrere på besvart/ikke besvart. I «Spør» kan du skrive f.eks. «ubesvarte spørsmål til samferdselsministeren».
- Tekstsøk går i spørsmålsteksten og emneord, ikke i begrunnelse eller svar. Skrivemåter som «E39», «E 39» og «E-39» behandles likt, og bestemt form treffer ubestemt («Storehaugen» finner også «Storehaug»).
- Lange perioder (10+ år) laster mange datasett og kan ta noen sekunder første gang.
- Siden er ikke en offisiell tjeneste fra Stortinget.
- Ikonet er laget fra et foto av Stortingsbygningen av Leonhard Lenz, frigitt som CC0 (fri bruk) på [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Stortinget_Oslo_2022-08-17_05.jpg).

## Kjør lokalt

```
python -m http.server 8000
```

og åpne http://localhost:8000.

## Filer

- `index.html`, `style.css` – siden
- `data.js` – henting, filtrering og opptelling mot Stortingets API
- `nlq.js` – tolker norske fritekstspørsmål
- `app.js` – fanene og visningene
- `lokal-claude/` – en eldre lokal variant der fritekstspørsmål besvares av Claude (krever egen Anthropic API-nøkkel og `python server.py`)
