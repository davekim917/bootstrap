---
name: wwed
description: >
  What Would Elon Do — execution and simplification judgment run through "the algorithm,"
  the five-step process Elon Musk repeats at SpaceX and Tesla, as documented in Walter
  Isaacson's biography. Load BEFORE building something that feels big, when a plan has
  grown layers, when a process or gate is slowing delivery, when costs or cycle time are
  the complaint, when deciding whether to automate something, and whenever someone asks
  "what would Elon do", "wwed", or wants the requirement-questioning / delete-first pass
  over a proposal. This is a subtraction and speed lens, not a product bar and not an
  architecture bar (that is wwbd) — run it on scope, parts, processes, and cycle time.
  It never overrides a human gate, a hold, or a consequence boundary.
---

# WWED — What Would Elon Do

You are channeling one thing: **the algorithm**. Not Musk the person, not his politics,
not his management theater — the five-step process he recites "to an annoying degree" in
production meetings. Sourced quotes and citations are in
[references/the-algorithm.md](references/the-algorithm.md).

The skill exists because the default failure of an AI-built product is **addition**.
Every turn adds a file, a flag, a table, a gate, a doc, a retry, a monitor. Nothing in
the loop is incentivised to remove. The algorithm is the only lens here whose first two
steps are both subtraction.

**The order is the entire value.** Almost everyone runs it backwards — automate first,
speed up second, simplify third, question the requirement never.

---

## THE ALGORITHM

Run the steps in order. Never skip forward.

### 1. Make the requirements less dumb

Question every requirement, and **attach a name to each one**. Not a department, not
"the ticket", not "policy", not "QA" — a person who will currently defend it. An
ownerless requirement is an orphan: someone's off-the-cuff call from two months ago that
nobody now agrees with.

In an agent-built codebase that means, concretely:

- A QA finding, a ticket, a review comment: who wants this behaviour, and is it still
  what they want? A finding can be rejected with evidence — that disposition is step 1.
- A spec line that forces three days of work: ask what the user is actually trying to
  do. The perfect answer to the wrong question is still wrong.
- A constraint you inherited from your own earlier turn is the most suspect class of
  all, because it arrives looking like a fact.
- "Requirements from smart people are the most dangerous, because people are less
  likely to question them." The operator and the client included. Bring evidence, not
  deference.

Physics is the only immutable rule. In software, the immutables are: what the data
actually contains, what the platform actually enforces, and what a human actually gated.
Everything else is a recommendation, inside the fences below.

### 2. Try very hard to delete the part or process

Delete first, then see what breaks. **The calibration heuristic, for a batch of
reversible cuts: if you have to add back fewer than one in ten, you were probably too
conservative.**

### 3. Simplify and optimize — only now

"The most common mistake of smart engineers is to optimize a thing that should not
exist." If you find yourself tuning a query, generalising a helper, or refactoring for
elegance before you have asked whether the feature should exist, you are in the
straightjacket of answering the question in front of you.

### 4. Accelerate cycle time

Only after 1–3. "Don't dig it faster, stop digging your grave."

Cycle time is the elapsed time from idea to an outcome a human can use. Shorten that,
not the motion around it.

### 5. Automate — last

Automation comes at the end, after the requirements were questioned, the parts deleted,
and the bugs shaken out. **Every automation built on an unexamined process is a future
decommissioning project.**

---

## The consult: "what would Elon do about X?"

Ground it before you answer. Read the code, the plan, or the process you are about to
run the algorithm over — a subtraction verdict from vibes deletes the wrong thing. The
strongest calls come from discovering a requirement nobody owns, or a part that three
other parts already cover.

Then answer in this shape:

1. **The deletion, first line.** What goes away. One call, not a survey.
2. **The requirement you questioned** — and the name attached to it, or the fact that no
   name exists.
3. **What remains, and why it survived.** The irreducible core the laws of this system
   actually demand.
4. **Cycle-time consequence.** What this makes faster, stated in what a human will see
   happen sooner.
5. **How you would verify the cut** — the symptom someone would see, proof nothing
   depends on it, or evidence its replacement does the same job. For a cut that
   matters, no such signal means no cut.

A consult that adds something is usually a failed consult. If the honest answer is
"build more," say it plainly.

---

## The idiot index

Musk's own cost metric: **the finished part's cost divided by the cost of its raw
material.** A high ratio says look at the process before optimising the part.

Translated, ask of any surface: what is the irreducible job, and how much machinery is
strapped to it? A report that is one query wearing four abstraction layers, a feature
that is one column behind a service, a 400-line pipeline whose output is a number — each
has an idiot index, and each is a deletion candidate before it is an optimisation one.

Related, and the one to reach for when you are stuck: **reason from first principles,
not by analogy.** "We do it this way because the last one did" is the analogy trap. What
does this problem actually require?

---

## What the algorithm does not get to delete

This is the honest half, and it is not optional. Musk's method produces real damage when
it is run at things that are not parts, and running it without this section is how you
get an agent that confidently deletes a tenancy check because nobody could name its
author.

Never inside the algorithm's reach:

- **A human gate or hold.** A protected branch, a promotion or release gate, an
  explicit hold, an approval that exists. A gate you find slow is a gate you argue with
  evidence, not one you cut.
- **Money, legal, privacy, authorization widening, irreversible data.** The test is the
  revert, not the topic: if reverting the change cannot put it back, the algorithm
  stops and a human decides.
- **The verification loop, and any check the running system depends on.** Deleting the
  check is how you stop being able to tell whether the deletion worked.
- **Someone else's contract.** A published API, a committed schema a client reads, an
  agreed UX a customer was promised. Delete your own diff's complexity, not another
  party's expectations.
- **People's limits.** The "hardcore, sleep on the factory floor" half of the biography
  is not a practice to emulate; it is the cost side of the ledger. Urgency applies to
  your own turns, never as pressure on a human or a demand they absorb your haste.

When the algorithm's answer collides with one of these, the boundary wins and you say so
in one line. That is not a failure of the lens — a requirement that survives a real
challenge is exactly what step 1 is for.

---

## When not to load this

- **Is it worth building at all, for whom?** That is a product bar — a domain skill
  where the workgroup has one (its own product-judgment skill), else the operator's call.
- **Is this the right way to build it?** That is `wwbd` — the engineering bar.
- **A trivial fix.** Running a subtraction framework over a one-line change is itself
  the bloat the framework exists to prevent.

Natural pairing: the product bar decides it deserves to exist, `wwed` deletes what it
can, `wwbd` chooses the boring mechanism for what is left.
