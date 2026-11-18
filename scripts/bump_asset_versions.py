#!/usr/bin/env python3
"""Bump `?v=...` cache-busting query strings for local CSS/JS assets in feedback-v1/*.html."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import re
from pathlib import Path

ASSET_PATTERN = re.compile(
    r"""((?:src|href)=["'])(?!https?:|//|data:)([^"'?#]+\.(?:css|js))\?v=[^"']*(["'])"""
)


def file_short_hash(asset_path: Path) -> str:
    digest = hashlib.sha256(asset_path.read_bytes()).hexdigest()
    return digest[:8]


def bump_html_files(
    web_root: Path,
    mode: str,
    custom_version: str | None,
    dry_run: bool,
) -> tuple[int, int]:
    now_ver = custom_version or dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    changed_files = 0
    updated_refs = 0

    for html_path in sorted(web_root.glob("*.html")):
        original = html_path.read_text(encoding="utf-8")
        file_hits = 0

        def replace_match(match: re.Match[str]) -> str:
            nonlocal file_hits
            prefix, rel_path, suffix = match.group(1), match.group(2), match.group(3)
            if rel_path.startswith("js/libs/"):
                return match.group(0)

            if mode == "hash":
                target_file = (web_root / rel_path).resolve()
                if not target_file.is_file():
                    return match.group(0)
                ver = file_short_hash(target_file)
            else:
                ver = now_ver

            replacement = f"{prefix}{rel_path}?v={ver}{suffix}"
            if replacement != match.group(0):
                file_hits += 1
            return replacement

        updated = ASSET_PATTERN.sub(replace_match, original)
        if updated != original:
            changed_files += 1
            updated_refs += file_hits
            if not dry_run:
                html_path.write_text(updated, encoding="utf-8")
            print(f"{'[dry-run] ' if dry_run else ''}updated {html_path.name}: {file_hits} asset(s)")

    return changed_files, updated_refs


def main() -> int:
    parser = argparse.ArgumentParser(description="Bump ?v= cache-busting versions in feedback-v1/*.html")
    parser.add_argument(
        "--mode",
        choices=("timestamp", "hash"),
        default="timestamp",
        help="timestamp: give every asset a new timestamp version (default); hash: per-file sha256[:8]",
    )
    parser.add_argument(
        "--version",
        dest="custom_version",
        default=None,
        help="Explicit version string for timestamp mode (e.g. 20261118-02)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without modifying files",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    web_root = repo_root / "feedback-v1"
    if not web_root.is_dir():
        raise SystemExit(f"Web root not found: {web_root}")

    changed_files, updated_refs = bump_html_files(
        web_root=web_root,
        mode=args.mode,
        custom_version=args.custom_version,
        dry_run=args.dry_run,
    )
    print(f"Done: {changed_files} HTML file(s), {updated_refs} asset reference(s) updated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
