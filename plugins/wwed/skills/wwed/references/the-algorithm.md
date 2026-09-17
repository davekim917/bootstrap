# The Algorithm — sourced

Primary source: Walter Isaacson, *Elon Musk* (Simon & Schuster, Sept 2023), the
algorithm at pp. 284–286 of the hardback. Musk's own first-person rendering is quoted
widely; the corollaries are listed in the book alongside the five steps.

Use this file when answering a direct "what would Elon say" so the answer quotes what he
actually said. Judgment lives in `../SKILL.md`; this is the quote bank.

---

## § The five steps, in his words

> I have everyone at my companies rigorously implement a five-step process for
> engineering. I call it The Algorithm. I'll list the steps, then explain. **The order is
> very important.**
>
> 1. Make your requirements less dumb.
> 2. Try very hard to delete the part or process.
> 3. Simplify or optimize.
> 4. Accelerate.
> 5. Automate.

### Step 1 — make your requirements less dumb

> The first step is to question the requirements, and make your requirements less dumb.
> You have to start there, because otherwise you could get the perfect answer to the
> wrong question.

> Your requirements are definitely dumb. It does not matter who gave them to you.
> Requirements from smart people are the most dangerous, because you're less likely to
> question them. Always question requirements, even if it came from me. Everyone is wrong
> some of the time.

> Whatever requirements or constraints you do have must come from a person, not a
> department. You can't actually ask a department… Otherwise, you could have a
> requirement made up by an intern two years ago off the cuff, or someone who isn't even
> at the company anymore. You must know the name of the real person who made every
> requirement.

Isaacson's reporting on where this came from, at SpaceX:

> Whenever one of his engineers cited "a requirement" as a reason for doing something,
> Musk would grill them: Who made that requirement? And answering "The military" or "The
> legal department" was not good enough… All requirements should be treated as
> recommendations, he repeatedly instructed. The only immutable ones were those decreed
> by the laws of physics.

Tim Buzza, SpaceX VP of launch and testing: *"We would talk about how we were going to
qualify an engine or certify a fuel tank, and he would ask, 'Why do we have to do
that?' … And we would say, 'There is a military specification that says it's a
requirement.' And he'd reply, 'Who wrote that? Why does it make sense?'"*

### Step 2 — try very hard to delete the part or process

> It sounds obvious, but people often forget to try deleting something entirely.

> If you're not adding deleted things back in 10 percent of the time, you're clearly not
> deleting enough. Somewhat illogically, people often feel they've succeeded if they are
> not forced to put anything back in. But actually they have failed in a different way,
> because they've been overly conservative and have left things in there that shouldn't
> be.

Isaacson notes the word *delete* appears throughout the book as the recurring technique;
the underlying method is **zero-based design** — every requirement starts deleted and is
added back only once proven necessary, usually in a slimmed-down form.

### Step 3 — simplify or optimize

> The most common mistake of smart engineers is to optimize a thing that should not
> exist.

> Everyone was trained in high school and college to answer the question in front of
> them. It's convergent logic. You can't tell the professor, "Your question is dumb." You
> have to answer the question. Without knowing it, almost everyone has this mental
> straightjacket on.

### Step 4 — accelerate cycle time

> Once you're moving in the right direction, and moving efficiently… you're moving too
> slow. Go faster. You can always make things go faster.

> I mistakenly spent a lot of time accelerating processes that I later realized should
> have been deleted. Speeding up something that shouldn't exist is absurd. If you're
> digging your grave, don't dig it faster. Stop digging.

### Step 5 — automate

> The big mistake I made in the Tesla factories in Nevada and Fremont was trying to
> automate every step too early. To fix that, we had to tear hundreds of expensive robots
> out of the production line. We put a hole in the side of the building just to remove all
> that equipment.

> Always wait until the end of designing a process — after you have questioned all the
> requirements and deleted unnecessary parts — before you introduce automation.

---

## § The corollaries

| Corollary | His words |
|---|---|
| Hands-on management | "All technical managers must have hands-on experience. Managers of software teams must spend at least 20% of their time coding. Otherwise, they are like a cavalry leader who can't ride a horse." |
| Comradery is dangerous | "Comradery is dangerous. It makes it hard for people to challenge each other's work. There is a tendency not to throw a colleague under the bus. That needs to be avoided." |
| Confident wrongness | "It's OK to be wrong. Just don't be confident and wrong." |
| Lead from the front | "Never ask your troops to do something you're not willing to do." |
| Skip-level | "Whenever there are problems to solve, don't just meet with your managers. Do a skip level, where you meet with the level right below your managers." |
| Hiring | When hiring, look for attitude — skills can be taught, attitude changes take a brain transplant. |
| Urgency | "A maniacal sense of urgency is our operating principle." |
| Rules | "The only rules are the ones dictated by the laws of physics. Everything else is a recommendation." |

---

## § Adjacent principles from the same book

- **The idiot index** — a finished part's cost divided by the cost of its raw material. A
  high index means the waste is in the process, not in physics. Rockets scored badly,
  Musk argued, because of complacent adherence to military and NASA specs.
- **The best part is no part. The best process is no process.**
- **First principles over analogy** — reason from what the problem requires, not from what
  the previous version did.
- **Named responsibility** — "every part, every process, and every specification needs to
  have a name attached."
- **"If a schedule is long, it's wrong."**

---

## § The documented failure modes

These are in the record too, and they are why `SKILL.md` fences the algorithm off from
gates, money, privacy, irreversible data, verification, and people:

- **Fremont / Nevada over-automation** — automating before deleting, then physically
  removing the robots. Automation applied to an unexamined process locks the flaw in at
  scale.
- **Acceleration of doomed processes** — his own retrospective on speeding up Tesla lines
  that should have been deleted.
- **Deletions that needed adding back** — the 10% rule is not rhetoric; it describes a
  process that routinely overshoots. Overshooting is acceptable only where adding back is
  cheap, which is exactly why irreversible surfaces are out of scope.
- **The mandate problem** — the algorithm as practised depends on an authority that can
  override any team's convention. Run bottom-up without that mandate, the aggressive cuts
  get filtered out; run bottom-up *ignoring* the mandate, you cut something that was
  someone else's call to make.
- **Comradery-as-liability, taken too far** — the principle is "challenge the work." It is
  not licence for the acerbic version of conflict the book also documents.

# Citations

- Walter Isaacson, *Elon Musk*, Simon & Schuster, 2023 — the algorithm, pp. 284–286.
- <https://www.the-independent.com/tech/elon-musk-algorithm-tesla-spacex-biography-b2414965.html> — page reference and corollary summary.
- <https://bagerbach.com/books/elon-musk/> — book notes including the corollary list and the idiot index.
- <https://thedigitalleader.substack.com/p/delete-delete-delete-the-critical> — the Buzza quotes and the zero-based-design framing.
- <https://carymillsap.com/2023/12/08/the-algorithm/> — step-by-step rendering with Musk's retrospectives.
