#!/usr/bin/env python3
"""Turn an approved Slack draft into a chat.postMessage payload with one rich_text block.

Usage: python3 rich_text.py --channel C123 [--thread-ts 1790.1] < draft.txt > payload.json

Draft syntax (the approved draft, as plain lines):
  "- item" or "• item"           bullet
  "1. item"                      numbered
  "  - item" or "◦ item"         nested one level (2 spaces per level)
  `code`  <@U123>  <#C123>  <https://x|label>  https://x  :emoji:  :pray::skin-tone-3:
Everything else is paragraph text. Blank lines are kept as blank lines.
"""
import argparse
import json
import re
import sys

LIST_RE = re.compile(r"^(?P<indent>[ \t]*)(?P<marker>[-*•◦▪]|\d+[.)])[ \t]+(?P<body>.*)$")
INLINE_RE = re.compile(
    r"`(?P<code>[^`]+)`"
    r"|<@(?P<user>[UW][A-Z0-9]+)>"
    r"|<#(?P<channel>[CGD][A-Z0-9]+)(?:\|[^>]*)?>"
    r"|<!subteam\^(?P<usergroup>S[A-Z0-9]+)(?:\|[^>]*)?>"
    r"|<!(?P<broadcast>here|channel|everyone)>"
    r"|<(?P<link_url>(?:https?://|mailto:|tel:)[^|>]+)(?:\|(?P<link_text>[^>]+))?>"
    r"|(?P<bare_url>https?://[^\s<>]+)"
    r"|(?<![A-Za-z0-9]):(?P<emoji>[a-z0-9_+\-]+):(?::skin-tone-(?P<tone>[2-6]):)?"
)


def split_bare_url(raw):
    """Separate a bare URL from the sentence punctuation that follows it."""
    url = raw
    while len(url) > 1:
        last = url[-1]
        opener = {")": "(", "]": "["}.get(last)
        if last in ".,;:!?'\"" or (opener and url.count(last) > url.count(opener)):
            url = url[:-1]
        else:
            break
    return url, raw[len(url):]


def inline(text):
    out, pos = [], 0
    for m in INLINE_RE.finditer(text):
        if m.start() > pos:
            out.append({"type": "text", "text": text[pos:m.start()]})
        g = m.groupdict()
        if g["code"] is not None:
            out.append({"type": "text", "text": g["code"], "style": {"code": True}})
        elif g["user"]:
            out.append({"type": "user", "user_id": g["user"]})
        elif g["channel"]:
            out.append({"type": "channel", "channel_id": g["channel"]})
        elif g["usergroup"]:
            out.append({"type": "usergroup", "usergroup_id": g["usergroup"]})
        elif g["broadcast"]:
            out.append({"type": "broadcast", "range": g["broadcast"]})
        elif g["link_url"]:
            el = {"type": "link", "url": g["link_url"]}
            if g["link_text"]:
                el["text"] = g["link_text"]
            out.append(el)
        elif g["bare_url"]:
            url, trailing = split_bare_url(g["bare_url"])
            out.append({"type": "link", "url": url})
            pos = m.end() - len(trailing)
            continue
        else:
            el = {"type": "emoji", "name": g["emoji"]}
            if g["tone"]:
                el["skin_tone"] = int(g["tone"])
            out.append(el)
        pos = m.end()
    if pos < len(text):
        out.append({"type": "text", "text": text[pos:]})
    return out or [{"type": "text", "text": " "}]


def parse_item(line):
    m = LIST_RE.match(line)
    if not m:
        return None
    width = len(m["indent"].expandtabs(2))
    level = width // 2 if width else (1 if m["marker"] == "◦" else 0)
    ordered = m["marker"][0].isdigit()
    number = int(m["marker"][:-1]) if ordered else None
    return min(level, 8), "ordered" if ordered else "bullet", number, m["body"]


def opens_new_list(current, level, style, number):
    """An ordered item renders the number the draft wrote, so any number but the next one starts a list."""
    if current is None or current["indent"] != level or current["style"] != style:
        return True
    return style == "ordered" and number != current.get("offset", 0) + len(current["elements"]) + 1


def build(draft):
    elements = []
    para = []          # pending paragraph lines
    current = None     # open rich_text_list element

    def flush_para(trailing_newline):
        nonlocal para
        if not para:
            return
        text = "\n".join(para)
        if elements and elements[-1]["type"] == "rich_text_list":
            text = "\n" + text
        if trailing_newline:
            text += "\n"
        elements.append({"type": "rich_text_section", "elements": inline(text)})
        para = []

    for line in draft.rstrip("\n").split("\n"):
        item = parse_item(line)
        if item is None:
            if current is not None:
                current = None
                if line.strip() == "":
                    continue  # the list already ends its own line
            if not para and line.strip() == "" and not elements:
                continue
            para.append(line)
            continue
        level, style, number, body = item
        if para:
            while para and para[-1].strip() == "":
                para.pop()
            flush_para(trailing_newline=True)
        if opens_new_list(current, level, style, number):
            current = {"type": "rich_text_list", "style": style, "indent": level, "elements": []}
            if style == "ordered" and number > 1:
                current["offset"] = number - 1
            elements.append(current)
        current["elements"].append({"type": "rich_text_section", "elements": inline(body)})

    while para and para[-1].strip() == "":
        para.pop()
    flush_para(trailing_newline=False)
    return [{"type": "rich_text", "elements": elements}]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--channel", required=True)
    ap.add_argument("--thread-ts")
    args = ap.parse_args()
    draft = sys.stdin.read()
    payload = {
        "channel": args.channel,
        # Notifications and search use `text`; Slack shows the blocks.
        "text": re.sub(r"\s+", " ", draft).strip(),
        "blocks": build(draft),
    }
    if args.thread_ts:
        payload["thread_ts"] = args.thread_ts
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
