#!/usr/bin/env python3
"""Module docstring
spanning two lines."""
import os  # trailing comment

s = "# not a comment"
t = """
# not a comment either
"""


def f():
    """Function docstring."""
    "bare string statement used as a comment"
    return f"{s}"  # noqa: E501 look-alike directive
