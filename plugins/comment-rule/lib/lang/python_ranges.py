"""Reads [{"id", "text"}] as JSON on stdin; writes [{"id", "ranges", "error"}].

Each range is [start, end) in code points of the given text, which the caller has already
normalised to LF line endings, as Python's own reader does.
"""
import ast
import io
import json
import sys
import tokenize


def line_starts(text):
    starts = [0]
    for index, char in enumerate(text):
        if char == "\n":
            starts.append(index + 1)
    return starts


def char_col(line, byte_col):
    return len(line.encode("utf-8")[:byte_col].decode("utf-8", errors="ignore"))


def scan(text):
    starts = line_starts(text)
    lines = text.split("\n")
    ranges = []
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type == tokenize.COMMENT and not (token.start == (1, 0) and token.string.startswith("#!")):
            ranges.append([starts[token.start[0] - 1] + token.start[1], starts[token.end[0] - 1] + token.end[1]])
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return ranges, "partial: syntax error, string statements not counted"
    for node in ast.walk(tree):
        if not isinstance(node, ast.Expr):
            continue
        value = node.value
        if isinstance(value, ast.JoinedStr) or (isinstance(value, ast.Constant) and isinstance(value.value, str)):
            start = starts[node.lineno - 1] + char_col(lines[node.lineno - 1], node.col_offset)
            end = starts[node.end_lineno - 1] + char_col(lines[node.end_lineno - 1], node.end_col_offset)
            ranges.append([start, end])
    return ranges, None


def main():
    results = []
    for item in json.load(sys.stdin):
        try:
            ranges, note = scan(item["text"])
            results.append({"id": item["id"], "ranges": ranges, "error": note})
        except (tokenize.TokenError, IndentationError, SyntaxError, ValueError) as error:
            results.append({"id": item["id"], "ranges": None, "error": f"unparsable: {error}"})
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
