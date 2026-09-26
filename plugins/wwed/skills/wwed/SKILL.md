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
production meetings, and the handful of corollaries that make it run. Sourced quotes and
citations are in [references/the-algorithm.md](references/the-algorithm.md).

The skill exists because the default failure of an AI-built product is **addition**.
Every turn adds a file, a flag, a table, a gate, a doc, a retry, a monitor. Nothing in
the loop is incentivised to remove. The algorithm is the only lens here whose first two
steps are both subtraction.

**The order is the entire value.** Almost everyone runs it backwards — automate first,
speed up second, simplify third, question the requirement never. Musk tore hundreds of
robots out of Fremont and cut a hole in the building to get them out, because he
automated a process that should have been deleted.

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
- "Requirements from smart people are the most dangerous, because you're less likely to
  question them." The operator and the client included. Bring evidence, not deference.

Physics is the only immutable rule. In software, the immutables are: what the data
actually contains, what the platform actually enforces, and what a human actually gated.
Everything else is a recommendation.

### 2. Try very hard to delete the part or process

Delete first, then see what breaks. **The calibration rule: if you never have to add
anything back, you did not delete enough — the target is restoring about 1 in 10.**
People feel successful when they put nothing back; that means they were too
conservative.

What counts as a part or process here: a module, a dependency, a table, a column, a
config flag, an endpoint, a code path, an abstraction layer, a status field, a doc, a
scheduled job, a review round, a PR. "The best part is no part. The best process is no
process."

**What is not a part: a test, a verification recipe, a type boundary, or an input
validation.** Those are the pass/fail loop — closer to physics than to parts. Delete the
code they guard if the requirement is dumb; never delete the guard to make a red thing
green. An existing test asserting the opposite behaviour is the current contract.

### 3. Simplify and optimize — only now

"The most common mistake of smart engineers is to optimize a thing that should not
exist." If you find yourself tuning a query, generalising a helper, or refactoring for
elegance before you have asked whether the feature should exist, you are in the
straightjacket of answering the question in front of you.

### 4. Accelerate cycle time

Only after 1–3. "If you're digging your grave, don't dig it faster."

Cycle time in our world is: idea → deployed build a human can click. The levers are
fewer PRs carrying more batched work, one frozen head per review round instead of
five fix-pushes, batching findings by seam, shipping the smallest version and letting
QA run the deployed build instead of reasoning about it longer. "If a schedule is long,
it's wrong." A plan measured in weeks of sequential agent turns is a plan that has not
been deleted down yet.

### 5. Automate — last

Monitors, scheduled tasks, generators and hooks come at the end, after the requirements
were questioned, the parts deleted, and the bugs shaken out. **Every automation built on
an unexamined process is a future decommissioning project** — and an automation in this
system costs more than it looks, because it wakes containers, writes records, and has to
be debugged by an agent with fresh context at 3am.

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
5. **What you would add back if you over-deleted** — the checkable signal that would
   prove the cut was too deep. This is how the cut stays cheap to reverse.

A consult that adds something is usually a failed consult. If the honest answer is
"build more," say it plainly, but name what you deleted to pay for it.

---

## The idiot index

Musk's own cost metric: **the finished part's cost divided by the cost of its raw
material.** A high ratio means the waste is in your process, not in physics. Rockets
scored badly because of complacent adherence to military specs nobody would defend.

Translated, ask of any surface: what is the irreducible job, and how much machinery is
strapped to it? A report that is one query wearing four abstraction layers, a feature
that is one column behind a service, a 400-line pipeline whose output is a number — each
has an idiot index, and each is a deletion candidate before it is an optimisation one.

Related, and the one to reach for when you are stuck: **reason from first principles,
not by analogy.** "We do it this way because the last one did" is the analogy trap. What
does this problem actually require?

---

## Corollaries worth keeping

- **Hands-on or no opinion.** Managers of software teams spend time in the code;
  otherwise they are a cavalry leader who cannot ride a horse. For you: never judge a
  seam you have not read.
- **Comradery is dangerous.** It makes people reluctant to challenge a colleague's work.
  Agreeing with a sibling agent, or with a peer review, is not evidence — especially
  when you share a method. Challenge it.
- **"It's OK to be wrong. Just don't be confident and wrong."** Uncertainty stated out
  loud costs nothing; a confident wrong claim costs the next three turns.
- **Skip a level to find the truth.** Don't only read the summary — read the source. Our
  version of the skip-level: read the ruling, the diff, the log, the row, never our own
  paraphrase of it.
- **Maniacal sense of urgency, about the right thing.** Urgency belongs to the part of
  the work a human is waiting on. Urgency applied to a process that should be deleted is
  just noise at higher volume.
- **Demo, don't describe.** Build the smallest working version and show it. A working
  screen beats a design document, and a design document is only a deliverable when a
  human asked for one.

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
  revert, not the topic: if `git revert` plus a redeploy cannot put it back, the
  algorithm stops and a human decides.
- **The verification loop.** Tests, recipes, CI at head. Deleting the check is how you
  stop being able to tell whether the deletion worked.
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

Natural pairing: the product bar decides it deserves to exist, `wwed` deletes two
thirds of it, `wwbd` chooses the boring mechanism for what is left.
