#!/usr/bin/env python3
"""Parse the Struzon "New joiner login information" PDFs into a JSON seed file.

Every PDF in Employee_LoginInfo_PDFs/ has the same flat "Label Value" layout.
There are two "Password" rows: the first belongs to the
Server\\Desktop\\Spark\\Username (the device login we authenticate against),
the second to the Email ID. We keep both but only the device password is used
for monitoring authentication.
"""
import json
import os
import sys
from pypdf import PdfReader

PDF_DIR = os.path.join(os.path.dirname(__file__), "..", "Employee_LoginInfo_PDFs")
OUT = os.path.join(os.path.dirname(__file__), "..", "server", "data", "employees.seed.json")

# Known labels in the order/identity they appear. Longest first so prefix
# matching never grabs a shorter label by mistake.
LABELS = [
    "Employee Name",
    "Employee Code",
    "Designation",
    "Server\\Desktop\\Spark\\Username",
    "Email ID Username",
    "Web Mail Access URL",
    "Struzon Employee portal",
    "Reporting Manager",
    "Team Leader",
    "Team",
    "Password",
]


def parse_line(line):
    for label in sorted(LABELS, key=len, reverse=True):
        if line.startswith(label):
            return label, line[len(label):].strip()
    return None, None


def parse_pdf(path):
    text = PdfReader(path).pages[0].extract_text() or ""
    rec = {
        "name": "", "emp_id": "", "designation": "",
        "device_username": "", "device_password": "",
        "email": "", "email_password": "",
        "webmail_url": "", "portal_url": "",
        "team": "", "reporting_manager": "", "team_leader": "",
    }
    password_seen = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        label, value = parse_line(line)
        if label == "Employee Name":
            rec["name"] = value
        elif label == "Employee Code":
            rec["emp_id"] = value
        elif label == "Designation":
            rec["designation"] = value
        elif label == "Server\\Desktop\\Spark\\Username":
            rec["device_username"] = value
        elif label == "Email ID Username":
            rec["email"] = value
        elif label == "Web Mail Access URL":
            rec["webmail_url"] = value
        elif label == "Struzon Employee portal":
            rec["portal_url"] = value
        elif label == "Team":
            rec["team"] = value
        elif label == "Reporting Manager":
            rec["reporting_manager"] = value
        elif label == "Team Leader":
            rec["team_leader"] = value
        elif label == "Password":
            # First Password row = device password, second = email password
            if password_seen == 0:
                rec["device_password"] = value
            else:
                rec["email_password"] = value
            password_seen += 1
    return rec


def main():
    files = sorted(f for f in os.listdir(PDF_DIR) if f.lower().endswith(".pdf"))
    records = []
    problems = []
    for f in files:
        rec = parse_pdf(os.path.join(PDF_DIR, f))
        if not rec["emp_id"] or not rec["device_username"] or not rec["device_password"]:
            problems.append((f, rec))
        records.append(rec)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(records, fh, indent=2, ensure_ascii=False)
    print(f"Parsed {len(records)} employees -> {OUT}")
    if problems:
        print(f"\n{len(problems)} record(s) with missing key fields:", file=sys.stderr)
        for f, rec in problems:
            print(f"  {f}: id={rec['emp_id']!r} user={rec['device_username']!r} pw={'set' if rec['device_password'] else 'MISSING'}", file=sys.stderr)


if __name__ == "__main__":
    main()
