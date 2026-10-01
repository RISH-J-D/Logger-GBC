#!/usr/bin/env python3
"""Parse Project Data.xlsx into JSON seeds for the projects + teams tables.

Columns: S.No | Client Name | Project Name | Project Value | COR Value |
         Project Rep | Team | Status | Updated_by | PO Date
"""
import json
import os
import openpyxl

XLSX = os.path.join(os.path.dirname(__file__), "..", "Project Data.xlsx")
OUT_PROJECTS = os.path.join(os.path.dirname(__file__), "..", "server", "data", "projects.seed.json")
OUT_TEAMS = os.path.join(os.path.dirname(__file__), "..", "server", "data", "teams.seed.json")


def clean(v):
    return str(v).strip() if v is not None else ""


def main():
    wb = openpyxl.load_workbook(XLSX, data_only=True)
    ws = wb["Sheet1"]
    rows = list(ws.iter_rows(min_row=3, values_only=True))  # skip title + header

    projects = {}   # name -> record (dedupe by name, keep first/most-recent)
    teams = {}      # team name -> count
    for r in rows:
        name = clean(r[2])
        if not name:
            continue
        client = clean(r[1])
        value = r[3] if isinstance(r[3], (int, float)) else None
        rep = clean(r[5])
        team = clean(r[6])
        status = clean(r[7]) or "Active"
        po = r[9]
        po_date = po.strftime("%Y-%m-%d") if hasattr(po, "strftime") else None

        if team and team.lower() not in ("multiple",):
            teams[team] = teams.get(team, 0) + 1

        # Keep the first occurrence; prefer an Active one if a later row is Active.
        if name not in projects or (status == "Active" and projects[name]["status"] != "Active"):
            projects[name] = {
                "name": name, "client": client, "value": value, "rep": rep,
                "team": team, "status": status, "po_date": po_date,
            }

    proj_list = sorted(projects.values(), key=lambda p: p["name"].lower())
    team_list = sorted(teams.keys(), key=str.lower)

    os.makedirs(os.path.dirname(OUT_PROJECTS), exist_ok=True)
    with open(OUT_PROJECTS, "w") as f:
        json.dump(proj_list, f, indent=2, ensure_ascii=False)
    with open(OUT_TEAMS, "w") as f:
        json.dump(team_list, f, indent=2, ensure_ascii=False)

    active = sum(1 for p in proj_list if p["status"] == "Active")
    print(f"Parsed {len(proj_list)} distinct projects ({active} active) -> {OUT_PROJECTS}")
    print(f"Parsed {len(team_list)} teams -> {OUT_TEAMS}: {', '.join(team_list)}")


if __name__ == "__main__":
    main()
