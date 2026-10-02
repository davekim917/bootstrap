---
name: slack-humanizer
description: ALWAYS use this, without being asked, whenever you write Slack text that the user will send or that goes out under the user's name. That includes replying, responding, answering or following up in Slack for them or on their behalf; drafting a Slack message, DM, group DM, channel post or thread reply for them; "reply to her", "respond in that thread", "send them the numbers", "draft something for the group DM", "what should I say back"; and posting through chat.postMessage as the user. Also use it when they say "slack-humanizer", "make it sound like me" or "too AI", and whenever you build a chat.postMessage payload yourself, because its Posting section is how any Slack message gets real lists. For the user's Slack it replaces the generic humanizer. Not for email.
---

# slack-humanizer

Draft Slack messages that read as if the user typed them, then post them as Slack rich text so lists render as real lists.

The voice below is the default. A **voice profile** overrides it: look for `slack-voice.md` in the shared workgroup directory, the project root, or the user's memory. The profile is where anything specific to one person or one company lives: their own openers and habits, who the readers are, and real example messages. None of that belongs in this skill.

Brevity comes first: the conclusion, the numbers that prove it, the next step, then stop. Stay well under 150 words.

Casual is fine; sloppy is not. A draft that reads lowercase, clipped or full of shorthand makes the sender sound careless. When a profile's habits and that bar pull apart, the bar wins.

## Voice

- **Short and conversational.** A typical message is one or two sentences. A quick back-and-forth goes out as several short messages, not one long one.
- **Proper capitalization, always.** Capitalize the opener, every bullet start, and every sentence after a period or question mark. No lowercase-start messages or bullets. The last sentence or bullet can end without a period. Exclamation marks are rare, used mostly in greetings.
- **Openers:** "Hi Priya - ...", "Hey Marcus - ...", "Hi all,". In a thread, start with an @-mention and get straight to it. No sign-off.
- **No acronyms or shorthand.** Write "because", "with", "through", "definitely", and the full name of a thing. The only exceptions: literal code or event names in backticks, and "cc @x". Numbers as digits ("all 3", "48 out of 50"), dates as 7/31, times as 3:30pm.
- **Full sentences with a subject.** "I went through it against the plan", not "went thru it". Fragments are fine inside a bullet only when they read as complete thoughts.
- **Questions and checks.** Ask, and confirm what was understood: "so X, is that right?", "can you let me know ...", "do you know if ...", "am I understanding that correctly?". Closing with a question or "let me know" is normal.
- **Direct, not cushioned.** State the fact plainly ("No issues on our end", "that's the issue", "we cannot prevent that on our end"). No "Great question", no "I hope this helps", no "happy to help" filler.
- **Emoji:** only in casual threads, and sparingly. Never in a numbers or incident message.

## Structure

Use bullets and numbered lists when there is more than one point:

- Lead-in line, then the list: "A couple of things:", "A few questions and feedback:", "Below is an update on X. Please let me know if you have any questions:"
- Bullets for parallel points or items (a list of tools, open items, findings). Each bullet is a plain sentence or fragment, usually no final period. Sub-points are nested one level.
- Numbered when answering someone's numbered questions in order, or listing steps.
- Every list goes out as a real Slack list (a `rich_text_list` block), never as typed `•` or `1.` characters in plain text. See Posting below.
- Short plain labels on their own line are fine ("Meeting recap", "Dashboard"). No bold section headers, no `*Label:*` bold-colon lead-ins, no headings.
- One idea per bullet. Don't nest a whole paragraph inside a bullet.

## What gives away the AI (remove it)

- Anything that makes the sender sound careless: a lowercase sentence start, an acronym, "bc/w/thru" shorthand.
- Em dashes (—). Use " - " or a new sentence.
- Bold, headers, `*Data:*`-style labels, emoji section markers.
- Stacked explanation paragraphs: "Here's what's going on...", "The short version is...", "Good news is... bad news is...".
- Hedged or inflated wording: "it appears that", "notably", "crucially", "ensure", "leverage", "seamless", "robust".
- Rule-of-three rhythm, "not X but Y" contrasts, a one-line punchy closer.
- Table, column and model names or internal codes when the reader isn't technical. Use dates and plain words. Keep technical names only for technical readers.
- Over-thanking and closers: "Thanks so much!", "Hope this helps!", "Let me know if you need anything else!"

## Audience dial

- **Operations and other non-technical readers:** plain words, dates not codes, numbers on their own lines or as bullets, one clear ask per person, each ask @-mentioning that person.
- **Technical channels:** can name tables, pull requests and system objects. Still short. Put the conclusion first if the message runs long.
- **Executives:** "Hey Sam - " + the point + the number + the ask. A few sentences, or a short bullet list.

## Examples

Illustrative only. Real example messages belong in the voice profile.

> Can you let me know which accounts need the adjustment?

> If someone was in one role for 10 days and another for 20 days in a given month, the bonus should only apply to those 20 days of eligibility?

> <@x> A few things:
> - The pull request has outstanding review comments that should be addressed
> - Since these are new fields and we're moving quickly on the proof of concept, perhaps we should keep them hidden for now

> No issues on our end, 48 out of 50 locations are reporting. <@y> I'm seeing that the nightly sync job was erroring overnight, so we didn't get the batch during the normal window

A longer reply to an engineer:

> Hey Marcus - nice to meet you, and thanks for catching the naming ones. I went through it against the tracking plan, a few things:
> - The new `Checkout Step Viewed` values look good, we'll add them to the plan
> - Could `item_type` be the existing `purchase_mode` (subscribe | one_time)?
> - `Cart Item Removed` already fires server side for these, so I'd drop the new client event because it would double count. Do you know if it could track only on success? Fine as a follow-up too
>
> Does that match what you're seeing?

## Procedure

1. Get the facts right first. This skill changes the wording, never the numbers or the claims.
2. Cut to the salient points. Stay in the sender's lane: give the facts and what they mean. Don't assign tasks to other teams, don't quiz them about their process, and don't guess at causes in their area unless the user asks. Ask a question only when the facts themselves need clarifying. If supporting detail exists (a breakdown, line detail), attach it as a file. Don't offer it with "I can send ... if that helps".
3. Rewrite using the voice and structure above, with the voice profile applied when one exists. Pick the audience dial.
4. Run the "gives away the AI" list as a checklist.
5. Final pass before showing it: read every period and question mark and confirm the next word is capitalized, confirm the opener and every bullet start with a capital, and search for acronyms and shorthand.
6. Show the user the draft as a quote block, with lists written as `- item` / `1. item`. Never post as the user without their explicit go-ahead for that message.
7. Post it as rich text (below), then read it back and confirm every list came back as a `rich_text_list`.

## Posting

Every Slack message sent through `chat.postMessage` goes out as a `rich_text` block, one-liners included. Plain `text` with typed `•` lines shows up in Slack as plain text, not as a list.

Write the approved draft as plain lines (`- item`, `1. item`, two spaces per nesting level, `<@U…>` mentions, `<#C…>` channels, `<url|label>` links, backticks for code). A bare URL drops trailing sentence punctuation, so wrap one that really ends in `!` or `.` as `<url>`. `rich_text.py` sits next to this file. Build the payload with it and post:

```bash
python3 <this skill's directory>/rich_text.py --channel C0123 [--thread-ts 1790000000.000100] < draft.txt > payload.json
curl -s -X POST https://slack.com/api/chat.postMessage -H 'Content-Type: application/json; charset=utf-8' --data @payload.json
```

The script emits one `rich_text` block (paragraphs as `rich_text_section`, lists as `rich_text_list` with `style` bullet/ordered and `indent`) plus a plain `text` fallback for notifications. It only builds the payload. Authenticate the way this environment already does for Slack: send no auth header when a credential gateway injects one, otherwise the token header you normally use.

Read the message back with `conversations.replies` (or `conversations.history`) and check the `blocks`. Find user IDs with `search.messages` (`from:handle`) when `users.list` rate-limits.

## Building a voice profile

When the user wants the drafts to sound more like them, build `slack-voice.md` from their own messages and save it beside their other private notes, never in a shared or public repository.

1. Pull their messages: `curl -s -G https://slack.com/api/search.messages --data-urlencode "query=from:me" --data-urlencode count=100 --data-urlencode page=N --data-urlencode sort=timestamp`.
2. Drop anything with an em dash, bold, or `*Label:*` lead-ins, or longer than about 600 characters, as likely AI-drafted.
3. Write down what differs from the defaults above: openers, list habits, questions they tend to ask, emoji they actually use, who their readers are, and a handful of real messages as examples.
4. Learn tone and structure from the raw messages, not casing or abbreviations. The capitalization and no-shorthand bar above still applies.
5. Keep raw dumps in a temporary directory and delete them when done. Direct messages, self-DMs included, often contain credentials.
