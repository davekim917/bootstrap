# The Algorithm — sourced

Musk's own first-person accounts are the primary sources:

- **Starbase tour, 2021**: Everyday Astronaut, "Starbase Tour with Elon Musk [PART 1 // Summer 2021]", 2021-08-03, https://www.youtube.com/watch?v=t705r8ICkRw. Quotes are from the video's caption track.
- **Lex Fridman Podcast #438, 2024**: 2024-08-02, official transcript at https://lexfridman.com/elon-musk-and-neuralink-team-transcript/ (00:44:08–00:48:31).

Walter Isaacson's *Elon Musk* (Simon & Schuster, 2023) names it "the algorithm". Book lines below are quoted from reproductions of the passage, not checked against a printed copy; they are marked *(book)*.

Use this file when answering a direct "what would Elon say", so the answer quotes what he actually said. Judgment lives in `../SKILL.md`; this is the quote bank.

---

## § The five steps

> "I have this very basic first principles algorithm that I run kind of as a mantra, which is to first question the requirements, make the requirements less dumb." *(Lex, 00:44:08)*

The steps, as he lists them on the Starbase tour: make your requirements less dumb; try very hard to delete the part or process; simplify or optimize; accelerate cycle time; automate. The book words them as "Question every requirement… Delete any part or process you can… Simplify and optimize… Accelerate cycle time… Automate." *(book)*

### Step 1 — make your requirements less dumb

> "The requirements are always dumb to some degree. So, you want to start off by reducing the number of requirements, and no matter how smart the person is who gave you those requirements, they're still dumb to some degree. You have to start there, because, otherwise, you could get the perfect answer to the wrong question." *(Lex, 00:44:08)*

> "Requirements from smart people are the most dangerous, because people are less likely to question them. Always do so, even if the requirement came from me." *(book)*

> "Whatever requirement or constraint you have, it must come with a name, not a department. 'Cause you can't ask the departments, you have to ask a person." *(Starbase tour, 16:00)*

> "You need to know the name of the real person who made that requirement." *(book)*

### Step 2 — try very hard to delete the part or process

> "It sounds very obvious, but people often forget to try deleting it entirely. And if you're not forced to put back at least 10% of what you delete, you're not deleting enough. Somewhat illogically, people often, most of the time, feel as though they've succeeded if they've not been forced to put things back in. But, actually, they haven't because they've been overly conservative and have left things in there that shouldn't be." *(Lex, 00:44:53)*

> "So, you actually have to say, 'Look, we're deliberately going to delete more than we should.' At least one in 10 things, we're going to add back in." *(Lex, 00:46:20)*

The 10% is a floor in every version: the Starbase tour and the book say "at least" too.

### Step 3 — simplify or optimize

> "I'd say the most common mistake of smart engineers is to optimize a thing that should not exist." *(Lex, 00:44:53)*

### Step 4 — accelerate cycle time

> "Any given thing can be sped up. However fast you think it can be done, whatever the speed it's being done, it can be done faster. But you shouldn't speed things up until you've tried to delete it and optimize. … Speeding up something that shouldn't exist is absurd." *(Lex, 00:47:50)*

> "Don't dig it faster, stop digging your grave." *(Starbase tour, 21:44)*

### Step 5 — automate

> "And then, the fifth thing is to automate it. I've gone backwards so many times where I've automated something, sped it up, simplified it, and then deleted it. And I got tired of doing that." *(Lex, 00:48:09)*

> "Yes, excessive automation at Tesla was a mistake. To be precise, my mistake. Humans are underrated." *(X, 2018-04-13, @elonmusk)*

> "The big mistake in Nevada and at Fremont was that I began by trying to automate every step. We should have waited until all the requirements had been questioned, parts and processes deleted, and the bugs were shaken out." *(book)*

---

## § Adjacent principles

- **The idiot index**: a finished part's cost divided by the cost of its raw material *(book, as summarised in reviews)*. A high ratio points at the process rather than the physics.
- **"The best part is no part, the best process is no process."** *(Starship update, Boca Chica, 2019-09-28, as reported by Spaceflight Now)*
- **"If a schedule's long, it's wrong, if it's tight, it's right."** *(same event and report)*
- **First principles over analogy**: reason from what the problem requires, not from what the previous version did. This is a theme of the book, not a single quote.

---

## § The documented failure modes

These are in the record too, and they are why `SKILL.md` fences the algorithm off from gates, money, privacy, irreversible data, verification, and people:

- **Automating first.** In his own account, he automated, sped up and simplified processes that he later deleted. Automation applied to an unexamined process locks the flaw in at scale.
- **Accelerating doomed processes.** "Speeding up something that shouldn't exist is absurd."
- **Deletions that need adding back.** The 10% floor describes a process that deliberately overshoots. Overshooting is acceptable only where adding back is cheap, which is exactly why irreversible surfaces are out of scope.
- **The mandate problem.** The algorithm as practised depends on an authority that can override any team's convention. Run bottom-up without that mandate, the aggressive cuts get filtered out; run bottom-up *ignoring* the mandate, you cut something that was someone else's call to make.
