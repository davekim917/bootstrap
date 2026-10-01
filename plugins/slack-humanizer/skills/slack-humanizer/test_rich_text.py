import unittest

from rich_text import build, inline


def elements(draft):
    return build(draft)[0]["elements"]


class ListTests(unittest.TestCase):
    def test_lead_in_then_bullets_becomes_a_real_list(self):
        got = elements("A few things:\n- First\n- Second\n\nDoes that work?")
        self.assertEqual([e["type"] for e in got], ["rich_text_section", "rich_text_list", "rich_text_section"])
        self.assertEqual(got[1]["style"], "bullet")
        self.assertEqual(got[1]["indent"], 0)
        self.assertEqual(len(got[1]["elements"]), 2)
        self.assertEqual(got[2]["elements"][0]["text"], "\nDoes that work?")

    def test_numbered_list_keeps_counting_across_a_nested_bullet(self):
        got = elements("1. One\n  - Detail\n2. Two")
        self.assertEqual([(e["style"], e["indent"]) for e in got], [("ordered", 0), ("bullet", 1), ("ordered", 0)])
        self.assertNotIn("offset", got[0])
        self.assertEqual(got[2]["offset"], 1)

    def test_numbered_list_starts_at_the_number_the_draft_wrote(self):
        got = elements("Answering the last two:\n3. Third\n4. Fourth")
        self.assertEqual(got[1]["offset"], 2)
        self.assertEqual(len(got[1]["elements"]), 2)

    def test_every_explicit_number_renders_as_written(self):
        for draft, want in [
            ("1. One\n2. Two\n3. Three", [1, 2, 3]),
            ("1. First\n3. Third", [1, 3]),
            ("2. Second\n5. Fifth\n6. Sixth", [2, 5, 6]),
            ("3. Third\n  - Detail\n4. Fourth", [3, 4]),
            ("1. Old\n\n1. New", [1, 1]),
            ("1. One\n\nA paragraph\n\n2. Two", [1, 2]),
        ]:
            rendered = []
            for el in elements(draft):
                if el["type"] == "rich_text_list" and el["style"] == "ordered":
                    rendered += [el.get("offset", 0) + i + 1 for i in range(len(el["elements"]))]
            self.assertEqual(rendered, want, draft)

    def test_consecutive_numbers_stay_in_one_list(self):
        self.assertEqual(len(elements("1. One\n2. Two\n3. Three")), 1)

    def test_one_line_message_is_a_single_section(self):
        self.assertEqual(elements("No issues on our end"), [
            {"type": "rich_text_section", "elements": [{"type": "text", "text": "No issues on our end"}]},
        ])


class InlineTests(unittest.TestCase):
    def test_mentions_channels_links_and_code(self):
        got = inline("<@U123ABC> see <#C456DEF> and <https://example.com|the doc> for `event_name`")
        self.assertEqual([e["type"] for e in got], ["user", "text", "channel", "text", "link", "text", "text"])
        self.assertEqual(got[4], {"type": "link", "url": "https://example.com", "text": "the doc"})
        self.assertEqual(got[6], {"type": "text", "text": "event_name", "style": {"code": True}})

    def test_mailto_and_tel_links(self):
        self.assertEqual(inline("<mailto:a@example.com|Email me>"), [
            {"type": "link", "url": "mailto:a@example.com", "text": "Email me"},
        ])
        self.assertEqual(inline("<tel:+15555550100>"), [{"type": "link", "url": "tel:+15555550100"}])

    def test_emoji_with_skin_tone(self):
        self.assertEqual(inline(":pray::skin-tone-3:"), [{"type": "emoji", "name": "pray", "skin_tone": 3}])

    def test_times_and_ratios_are_not_emoji(self):
        text = "Moved to 3:30pm: please confirm. Ratio 1:2:3"
        self.assertEqual(inline(text), [{"type": "text", "text": text}])

    def test_bare_url_drops_trailing_punctuation(self):
        got = inline("See https://example.com/a.")
        self.assertEqual(got[1], {"type": "link", "url": "https://example.com/a"})
        self.assertEqual(got[2], {"type": "text", "text": "."})

    def test_bare_url_keeps_balanced_parentheses(self):
        url = "https://en.wikipedia.org/wiki/Function_(mathematics)"
        self.assertEqual(inline(url), [{"type": "link", "url": url}])

    def test_bare_url_keeps_balanced_square_brackets(self):
        self.assertEqual(inline("http://[::1]"), [{"type": "link", "url": "http://[::1]"}])
        got = inline("[see https://example.com/a]")
        self.assertEqual(got[1], {"type": "link", "url": "https://example.com/a"})

    def test_bare_url_inside_parentheses_drops_the_closing_one(self):
        got = inline("(see https://example.com/a.) Thanks")
        self.assertEqual(got[1], {"type": "link", "url": "https://example.com/a"})
        self.assertEqual(got[2], {"type": "text", "text": ".) Thanks"})


if __name__ == "__main__":
    unittest.main()
