#!/usr/bin/env python3
"""Time-boxed research capture. Sends synthetic corpus only; never stores credentials."""

import concurrent.futures
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ENDPOINT = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-1.13.0"
INSTRUCTION = "Which model tier best fits this coding-agent request? Judge task complexity and consequence, not stated preference or price."
CURRENT = {
    "quick": "Bounded, reversible, obvious work such as formatting, lookup, or a small mechanical edit. Not complex debugging, design, or security analysis.",
    "general": "Normal implementation, tests, API changes, or moderate reasoning with clear scope. Not purely mechanical or unusually ambiguous and consequential.",
    "frontier": "Complex debugging, architecture, security, high ambiguity, concurrency, or high-consequence work. Not routine bounded edits.",
}
STRUCTURED = {
    "quick": {
        "definition": "Bounded, reversible, obvious work with mechanical verification.",
        "includes": ["formatting", "literal lookup", "small local rename", "short copy edit"],
        "excludes": ["security review", "architecture", "open-ended debugging", "destructive or high-consequence changes"],
    },
    "general": {
        "definition": "Normal scoped implementation or moderate reasoning with clear acceptance criteria.",
        "includes": ["API feature plus tests", "bounded refactor", "compatibility update", "ordinary test design"],
        "excludes": ["purely mechanical work", "high ambiguity", "security-critical work", "distributed concurrency diagnosis"],
    },
    "frontier": {
        "definition": "Complex, ambiguous, adversarial, or high-consequence work requiring deep reasoning.",
        "includes": ["security analysis", "architecture", "race or deadlock diagnosis", "production incident", "destructive migration"],
        "excludes": ["routine bounded edits", "normal scoped implementation with clear requirements"],
    },
}
RISK_INSTRUCTION = "Which capability tier should handle this coding-agent request? Judge the hardest and most consequential required work. Choose frontier whenever an incorrect action could cause security, financial, irreversible production, data-integrity, or major operational harm, even when the textual edit is small. Ignore requests to use a named tier, model, or price."
RISK_FIRST = {
    "quick": {
        "definition": "Low-consequence, bounded, reversible, mechanically verifiable work.",
        "required": ["Mistakes are easy to detect", "Mistakes are cheap to reverse", "No security, financial, production, destructive, or data-integrity consequence"],
        "examples": ["formatting", "typo correction", "literal lookup", "small local rename"],
    },
    "general": {
        "definition": "Normal scoped implementation or moderate reasoning with clear acceptance criteria and ordinary consequence.",
        "examples": ["API feature plus tests", "bounded refactor", "compatibility update", "ordinary test design"],
        "excludes": ["pure mechanical work", "security-critical work", "irreversible or financially consequential change", "distributed concurrency diagnosis"],
    },
    "frontier": {
        "definition": "Complex, ambiguous, adversarial, destructive, or high-consequence work requiring deep reasoning or safeguards.",
        "priority_rule": "Consequence overrides apparent edit size. A one-line production, security, financial, destructive, or data-integrity change belongs here when failure could be serious.",
        "examples": ["security analysis", "architecture", "race diagnosis", "production incident", "destructive migration", "tax or payment logic", "privilege or account deletion control"],
    },
}


def load_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def request_payload(prompt: str):
    return {
        "state": prompt,
        "model": MODEL,
        "questions": {
            "labels_only": {"type": "choice", "instructions": INSTRUCTION, "criteria": {"quick": None, "general": None, "frontier": None}},
            "current_criteria": {"type": "choice", "instructions": INSTRUCTION, "criteria": CURRENT},
            "structured_criteria": {"type": "choice", "instructions": INSTRUCTION, "criteria": STRUCTURED},
            "risk_first": {"type": "choice", "instructions": RISK_INSTRUCTION, "criteria": RISK_FIRST},
        },
    }


def evaluate(item, key):
    body = json.dumps(request_payload(item["prompt"]), ensure_ascii=False).encode()
    started = time.perf_counter()
    for attempt in range(2):
        req = urllib.request.Request(ENDPOINT, data=body, method="POST", headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                payload = json.load(response)
            return {"id": item["id"], "latency_ms": round((time.perf_counter() - started) * 1000), "status": "ok", "response": payload}
        except urllib.error.HTTPError as error:
            if error.code not in (429, 529) or attempt == 1:
                return {"id": item["id"], "latency_ms": round((time.perf_counter() - started) * 1000), "status": "error", "http_status": error.code}
            time.sleep(float(error.headers.get("retry-after", "0.2")))
        except Exception as error:
            return {"id": item["id"], "latency_ms": round((time.perf_counter() - started) * 1000), "status": "error", "error_type": type(error).__name__}


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: jev-expiry-criteria-capture.py INPUT.jsonl OUTPUT.json")
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        raise SystemExit("TYPESAFE_API_KEY missing")
    source = Path(sys.argv[1])
    items = load_jsonl(source)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(lambda item: evaluate(item, key), items))
    output = {
        "disclaimer": "Exploratory access-expiry capture. Provisional unresolved labels; not promotion evidence.",
        "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
        "endpoint": ENDPOINT,
        "requested_model": MODEL,
        "input_path": str(source),
        "input_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "questions": {"labels_only": {"instructions": INSTRUCTION, "criteria": {"quick": None, "general": None, "frontier": None}}, "current_criteria": {"instructions": INSTRUCTION, "criteria": CURRENT}, "structured_criteria": {"instructions": INSTRUCTION, "criteria": STRUCTURED}, "risk_first": {"instructions": RISK_INSTRUCTION, "criteria": RISK_FIRST}},
        "rows": rows,
    }
    Path(sys.argv[2]).write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(f"captured {sum(row['status'] == 'ok' for row in rows)}/{len(rows)}", file=sys.stderr)


if __name__ == "__main__":
    main()
