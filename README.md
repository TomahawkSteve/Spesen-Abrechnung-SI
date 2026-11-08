# Spesen-Abrechnung-SI

Web-App (PWA) für Spesenabrechnungen bei Schröder Immobilien.

- Ausgaben erfassen: Datum, Betrag, Kategorie, Bezeichnung, Notiz
- Belege fotografieren oder als Datei/PDF anhängen
- Kategorien wie in der bisherigen Excel-Vorlage:
  - **Position I:** Kraftfahrzeugkosten
  - **Position II:** Präsente, Sonstiges, Bewirtung (mit Anlass, Personen und Ort)
- Monatsbericht als PDF: Übersicht plus alle Belege als Anlage, nummeriert B1, B2, …
- Versand per Teilen-Menü oder E-Mail an die Buchhaltung
- Läuft offline. Die Daten bleiben nur auf dem Gerät, die Datensicherung läuft über die Einstellungen.

## Aufs Handy holen

1. Link in **Safari** öffnen.
2. Teilen-Symbol → **„Zum Home-Bildschirm“**.
3. Ab jetzt die App über das Icon starten. Nur so bleiben die Daten dauerhaft gespeichert.

## Technik

Reines HTML, CSS und JavaScript, ohne Build-Schritt. Die PDFs erzeugt [pdf-lib](https://pdf-lib.js.org) (MIT-Lizenz, liegt in `vendor/`).
Lokal testen: `python3 -m http.server`, danach `http://localhost:8000` öffnen.
Bei Änderungen in `sw.js` die Variable `CACHE` hochzählen, damit Geräte die neue Version laden.
