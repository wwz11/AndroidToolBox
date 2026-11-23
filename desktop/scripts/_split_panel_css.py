"""Split domain CSS rules from styles.css into styles/panels/*.css"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(r"e:\PyCharmPrograms\AndroidTVToolBox\desktop\src")
CSS = ROOT / "styles.css"
OUT = ROOT / "styles" / "panels"

# Order matters: first match wins. Longer / more specific domains first when overlapping.
DOMAINS: list[tuple[str, tuple[str, ...]]] = [
    ("apps.css", (".apps-", ".apk-")),
    ("shell.css", (".shell-", ".preset-")),
    ("logcat.css", (".logcat-",)),
    ("emmc.css", (".emmc-",)),
    ("files.css", (".files-",)),
    ("serial.css", (".serial-",)),
]


def selector_matches(selector: str, prefixes: tuple[str, ...]) -> bool:
    """True if any simple class token in the selector starts with a domain prefix."""
    # Strip :pseudo and [attrs] loosely for class token scan
    for m in re.finditer(r"\.([a-zA-Z0-9_-]+)", selector):
        cls = "." + m.group(1)
        for pref in prefixes:
            if cls.startswith(pref):
                return True
    return False


def extract_top_level_chunks(text: str) -> list[tuple[str, str]]:
    chunks: list[tuple[str, str]] = []
    i = 0
    n = len(text)
    while i < n:
        if text[i].isspace():
            j = i
            while j < n and text[j].isspace():
                j += 1
            chunks.append(("ws", text[i:j]))
            i = j
            continue
        if text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            chunks.append(("comment", text[i:j]))
            i = j
            continue
        if text[i] == "@":
            j = i
            while j < n and text[j] not in "{;":
                j += 1
            if j >= n:
                chunks.append(("other", text[i:]))
                break
            if text[j] == ";":
                chunks.append(("atrule", text[i : j + 1]))
                i = j + 1
                continue
            depth = 0
            k = j
            while k < n:
                c = text[k]
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        k += 1
                        break
                k += 1
            chunks.append(("atrule", text[i:k]))
            i = k
            continue
        j = i
        while j < n and text[j] != "{":
            j += 1
        if j >= n:
            chunks.append(("other", text[i:]))
            break
        depth = 0
        k = j
        while k < n:
            c = text[k]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    k += 1
                    break
            k += 1
        chunks.append(("rule", text[i:k]))
        i = k
    return chunks


def domain_hits(blob: str) -> list[str]:
    hits: list[str] = []
    for name, prefs in DOMAINS:
        if selector_matches(blob, prefs):
            hits.append(name)
    return hits


def main() -> None:
    text = CSS.read_text(encoding="utf-8")
    chunks = extract_top_level_chunks(text)
    buckets: dict[str, list[str]] = {name: [] for name, _ in DOMAINS}
    remain: list[str] = []

    for kind, chunk in chunks:
        if kind in ("ws", "comment", "other"):
            remain.append(chunk)
            continue

        hits = domain_hits(chunk)
        if kind == "atrule":
            # Exclusive domain @media/@keyframes → extract; shared → keep in main
            if len(hits) == 1:
                buckets[hits[0]].append(chunk.strip())
                buckets[hits[0]].append("\n\n")
            else:
                remain.append(chunk)
            continue

        # rule
        if len(hits) == 1:
            buckets[hits[0]].append(chunk.strip())
            buckets[hits[0]].append("\n\n")
        elif len(hits) > 1:
            # Cross-domain selector list — keep in main to avoid splitting commas wrongly
            remain.append(chunk)
        else:
            remain.append(chunk)

    OUT.mkdir(parents=True, exist_ok=True)
    for name, _ in DOMAINS:
        body = "".join(buckets[name]).strip() + "\n"
        (OUT / name).write_text(
            f"/* extracted from styles.css — {name} */\n\n{body}",
            encoding="utf-8",
        )
        print(f"{name}: {len(body.splitlines())} lines, hex={len(re.findall(r'#[0-9a-fA-F]{{3,8}}', body))}")

    remain_text = "".join(remain)
    # collapse excessive blank lines
    remain_text = re.sub(r"\n{3,}", "\n\n", remain_text)
    CSS.write_text(remain_text, encoding="utf-8")
    print(f"styles.css remain: {len(remain_text.splitlines())} lines, hex={len(re.findall(r'#[0-9a-fA-F]{{3,8}}', remain_text))}")


if __name__ == "__main__":
    main()
