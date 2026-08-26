#!/usr/bin/env python3
"""
Zet een officiële CosIng-annex (.xls) om naar een CSV met één kopregel.

CosIng levert de annexen als legacy Excel-bestand met een lay-out die niet
direct te parsen is:

  - een preamble van een paar regels (aanmaakdatum, titel van de annex)
  - een kopregel verdeeld over TWEE rijen met samengevoegde cellen:
    rij A heeft "Substance identification", rij B eronder de echte kolomnamen
  - celwaarden met harde newlines erin (voorwaarden per producttype)

Dit script vlakt dat af tot één kopregel plus datarijen, zodat
scripts/import-cosing.js er zonder speciale gevallen mee overweg kan.

Gebruik:
    python3 scripts/cosing-xls-to-csv.py COSING_Annex_III_v2.xls > annex3.csv

Vereist xlrd (`pip install xlrd`). De bestanden die CosIng genereert hebben
overlappende sectoren in de OLE-container; xlrd noemt dat corruptie maar leest
ze prima met ignore_workbook_corruption.
"""

import csv
import sys

try:
    import xlrd
except ImportError:
    sys.exit("xlrd ontbreekt. Installeer met: pip install xlrd")

KOPREGEL_MARKER = "reference number"


def cel(sheet, rij, kol):
    waarde = sheet.cell_value(rij, kol)
    if isinstance(waarde, float) and waarde.is_integer():
        # Referentienummers komen als float binnen (1.0 i.p.v. 1).
        return str(int(waarde))
    return str(waarde).strip()


def vind_kopregel(sheet):
    """Geeft (index_bovenste_koprij, aantal_koprijen) terug."""
    for r in range(min(40, sheet.nrows)):
        if cel(sheet, r, 0).lower() == KOPREGEL_MARKER:
            # De rij eronder hoort erbij als kolom 0 leeg is (samengevoegde
            # cel) maar er verderop wél kolomnamen staan.
            if r + 1 < sheet.nrows:
                eronder = [cel(sheet, r + 1, c) for c in range(sheet.ncols)]
                if not eronder[0] and any(eronder):
                    return r, 2
            return r, 1
    sys.exit(
        f"Kon de kopregel niet vinden: geen cel '{KOPREGEL_MARKER}' in kolom A "
        f"van de eerste 40 rijen. Is dit wel een CosIng-annex?"
    )


def bouw_koppen(sheet, start, aantal):
    """Voegt de koprijen samen: de onderste, specifiekere naam wint."""
    koppen = []
    for c in range(sheet.ncols):
        namen = [cel(sheet, start + i, c) for i in range(aantal)]
        gevuld = [n for n in namen if n]
        koppen.append(gevuld[-1] if gevuld else f"kolom{c}")
    return koppen


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)

    pad = sys.argv[1]
    boek = xlrd.open_workbook(pad, ignore_workbook_corruption=True)
    sheet = boek.sheet_by_index(0)

    start, aantal = vind_kopregel(sheet)
    koppen = bouw_koppen(sheet, start, aantal)

    schrijver = csv.writer(sys.stdout, quoting=csv.QUOTE_MINIMAL)
    schrijver.writerow(koppen)

    geschreven = 0
    for r in range(start + aantal, sheet.nrows):
        rij = [cel(sheet, r, c) for c in range(sheet.ncols)]
        if not any(rij):
            continue
        schrijver.writerow(rij)
        geschreven += 1

    print(
        f"{pad}: {geschreven} rijen, {len(koppen)} kolommen "
        f"(kopregel op rij {start + 1}, {aantal} rij(en))",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
