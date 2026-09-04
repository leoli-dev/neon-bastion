# How this repository was written

Neon Bastion was built over three days by **Qwen3.8-27B-8bit**, an open-weights model running
locally on a laptop, driving the [`pi`](https://github.com/possibilities/pi) CLI coding agent.
The model wrote every line of application code and every test. A human played the game and set
the requirements; a reviewer decomposed those requirements into tasks and independently verified
each commit.

This document is the write-up of that experiment. It is deliberately unflattering where the
result was unflattering.

## The question, and the answer

> **Can a 27B open-weights model running on local hardware build a moderately complex game?**

**Yes — but how far it gets is decided by whether the acceptance criteria can be written as a
number the model can read back itself.**

Where the criterion was a number — a brightness floor, a seam-contrast ratio, match termination,
a scoring invariant, pixel variance — it worked fast and correctly, and it routinely added
negative controls nobody asked for. Where the criterion was a judgement — *does this look like
foliage, is the gun in the character's hand, how big should a first-person weapon be* — every
result needed a human to look at a screenshot. And in the final round it could not see
screenshots at all.

Over seven rounds the reviewer revised their own methodology seven times and the model revised
the code thirty-one times. **Writing the acceptance criteria turned out to be harder than
writing the implementation.**

## Setup

| Component | Value |
| --- | --- |
| Model | `mlx-community/Qwen3.8-27B-8bit` |
| Inference server | `mlx-dspark` 0.18.0 |
| Speculative decoding | DFlash2 (`incoai/Qwen3.8-27B-DFlash2`), `--max-draft auto` |
| Context window | 131,072 |
| Agent | `pi` 0.84.4 |
| Hardware | MacBook Pro, Apple M5 Max, 128 GB unified memory |
| OS / runtime | macOS 26.6.2, Python 3.14.5, mlx 0.32.2, mlx-lm 0.31.3 |

No cloud API was involved at any point. All inference ran on the laptop.

## What the numbers say

Everything below was measured independently by the reviewer from git history and the agent's
own session logs — none of it is the agent's self-report.

| Metric | Value |
| --- | --- |
| Implementation commits | **31** |
| Code change | 62 files, **+9,766 / −882** |
| Source size | `src/` 8,157 lines TS, `tests/` 4,839 lines |
| Unit tests | 31 → **149** (19 files) |
| E2E scenarios | 5 → **26** |
| Agent working time | **30.0 hours** across 35 sessions |
| Model requests | **1,688** |
| Output tokens | **1,805,870** |
| Reasoning emitted | **3,777,115 characters** |
| Tool calls | **1,836** (bash 927, edit 421, read 403, write 85) |
| Tool failure rate | **3.4%** (62 / 1,836) |

Server-side, across the run: mean accepted draft length **3.17** tokens/round, draft acceptance
**55.9%**, mean decode **19.1 tok/s**, prefix-cache reuse **94.6%**, peak MLX allocator
**72.1 GB**.

## How the work was organised

The loop that produced this repository:

1. A human plays the current build and reports what is wrong or missing.
2. The reviewer turns that into **self-contained tasks of 16–28 lines each**, with explicit,
   preferably measurable acceptance criteria.
3. One task is handed to the agent. Nothing else.
4. The agent implements it and must get `tsc --noEmit`, `vitest`, and `playwright` green before
   committing.
5. The reviewer independently re-runs all three, inspects raw canvas captures, and only then
   hands over the next task. Context is cleared between tasks.

**Step 2 is where most of the value was, and step 5 is where most of the defects were caught.**

An early attempt to hand over a 178-line specification in one message produced 32,768 tokens of
reasoning and **zero output text** — the generation hit the token cap and was discarded. Small
self-contained tasks were not a stylistic preference; they were the only thing that worked.

## The seven rounds

| Round | Input | Unit | E2E | Outcome |
| --- | --- | ---: | ---: | --- |
| 1 | Original 12 KB spec | 31 | 5 | **77/100.** Three required features absent, E2E did not implement the specified scenarios, README claimed full conformance by omitting what was missing. |
| 2 | Round-1 blockers + a UI/colour design review | 33 | 6 | **87 blind → 74 after a human played it.** Fixes were real and better than expected, but strafe was inverted, tracers were invisible, and the README documented six controls that did not exist. |
| 3 | Round-2 blockers | 38 | 6 | **Score withheld.** All fixes verified, and the agent added assertions specifically able to catch the previous round's failure mode. Then a playthrough found that AI weapon fire bypassed the event bus entirely: 7 of 8 characters shot with no tracer, flash, spark or sound. |
| 4 | Gameplay + scene redesign (15 items) | 106 | 13 | **11/11 delivered, 10 with zero intervention.** Ballistic projectiles, glass that sight passes but bullets do not, seeded random layouts, AI personalities, daylight scene. |
| 5 | Verification round | 106 | 15 | Independent re-verification plus a 40-seed sweep, which found a permanent livelock the agent's 3-seed regression could not see. |
| 6 | Art and presentation (11 items) | 149 | 26 | **11/11 delivered, 10 with zero intervention.** All green — and five visual defects that only a human looking at screenshots found. |
| 7 | Final review | 149 | 26 | Two defects fixed, **one regressed**, and one existing assertion silently invalidated. See *Known defects*. |

## Task duration: logic versus art

Round 4 was entirely gameplay logic. Round 6 was entirely art and presentation. Same model, same
process, same person writing the tasks.

| Round | Nature | Median | Total | Outlier |
| --- | --- | ---: | ---: | --- |
| 4 | Logic and gameplay (11 tasks) | **22 min** | 6.3 h | AI personalities, 176 min |
| 6 | Art and presentation (11 tasks) | **52 min** | 11.4 h | Final fix-up, 206 min |

Only **two of twenty-two tasks** ran long, and what they had in common was not difficulty — it
was that both required the model to work out *why something was happening* on its own. The other
twenty tasks were "implement one clearly specified thing against a decidable acceptance
criterion", and their median was 27 minutes.

## Where the model was genuinely good

**It kept the layering clean for seven rounds without being reminded.** `src/game/` is pure
logic and never imports Three.js, so it runs in node; `src/render/` only consumes state. When
asked to add footstep audio it *volunteered* to extract the trigger logic into
`src/game/footstep.ts` with no WebAudio dependency so it could be unit-tested. It did the same
for the walk cycle (`src/render/walkAnim.ts`).

**It put invariants at the right layer.** `resolveShot` rejects same-team targets before any
distance comparison, and wall distance is compared against candidate distance, so "a wall
between shooter and target always wins" is structural rather than a lucky branch ordering. One
`fireWeapon` call awards at most one hit and, behind an `alive` guard, at most one kill. The
global invariant `totalScore === hitScore + 3 × kills` is asserted in the E2E suite.

**It turned review findings into regression tests, not just fixes.** After a round where overlay
text rendered black-on-black and passed every assertion, its fix came with a test whose comment
reads *"toHaveText/toBeVisible pass for black-on-black, so assert computed style"* — asserting
computed colour and font family. After a round where "the arena rendered" was asserted by
screenshot byte size, it replaced that with real WebGL canvas pixel statistics.

**It wrote its own negative controls.** Unprompted, for two new brightness assertions it also
ran the inverse: boundary wall measured 78.7 mean luma, and reverting the colour to the old
near-black measured 2.0, failing consistently across three runs. This is the single most
surprising behaviour observed in the whole run.

**It learned to distinguish "no instances" from "delete the mechanism".** In round 3 it deleted
two constants as dead code — they were "dead" because the feature was never implemented, so
deleting them erased the last trace of an unmet requirement. In round 4, asked to remove a
map-element kind, it did so **but kept the neighbouring machinery and wrote a comment explaining
why** it might be needed by the random layouts. Same judgement call, corrected within three
rounds.

**Its closing reports became honest.** Round 2's README invented six controls that did not
exist. By the final round the agent tagged its own commit `(partial)` and enumerated, in the
commit message, the three acceptance items it had not managed to complete and why.

## Where the model was weak

### 1. Root-cause localisation does not converge

Both long tasks failed the same way, and neither failure was "cannot write code".

On the AI-personality task it spent 176 minutes and 369,000 characters of reasoning (the other
nine tasks that round totalled 420,000) cycling hypotheses about why one unit only fired twice —
field of view? reaction delay? target switching? health threshold? Each was plausible; it could
not narrow the space efficiently from a 300-second multi-agent simulation.

The intervention was to run the same scenario in a separate copy, print per-tick state, and hand
back the root causes. **It then converged in 30 minutes — and found three deeper defects on its
own**, including one that had silently broken a core invariant for five commits.

> Given a clear local goal and a decidable acceptance criterion, it works independently. Asked
> to localise a root cause inside a system with several interacting parts, it burns time without
> converging. Handed the root cause, it remains a strong implementer.

### 2. It could not see the screenshots — and that is the deployment, not the model

Round 6 was eleven art tasks. **Five visual defects were found, all five by a human looking at
screenshots. The agent found none.**

The checkpoint's weights *are* multimodal — the config declares a vision tower and an image
token id. But the serving path discards images in two independent places: the loader routes this
model family to the text-only backend (whose `sanitize` drops the vision weights outright, so
they never reach memory), and the request path flattens image parts out of the message content.
Empirically, a 64×64 PNG plus one line of text arrives as **17 prompt tokens** and the model
replies "No image was provided" — with no error or warning anywhere.

The consequence is that all of its acceptance work is of the form *"compute a statistic over a
region and read the number back"*. **That can prove a change took effect. It cannot prove the
result looks right.** Every one of the five defects passed its assertions:

| Defect | Why the assertion missed it |
| --- | --- |
| Boundary walls still night-black, forming a dark band at the horizon | Brightness metrics are whole-frame; the flaw is local |
| Spawn walls still near-black, four instances, plainly visible | Same |
| Hedge texture reads as dark beans scattered on a green board | Assertion only required standard deviation above a threshold — random speckle satisfies that |
| Glass wall narrow faces render as black slabs | `darkFrac ≤ 0.15` had enough slack to swallow a 12× degradation (0.008 → 0.096) |
| First-person weapon far too large; third-person weapon floating at the neck | Assertions had a lower bound but no upper bound, and never constrained hand-to-weapon distance |

The first five rounds were logic work, where the model had a closed textual feedback loop and
performed very well. The sixth round broke that loop.

### 3. `renderer.ts` is 2,226 lines

That is 27% of `src/`, holding sky, clouds, texture generation, particle pools, weapons, the
view model and the minimap. Nobody asked it to split the file, so it never did. This is
characteristic agent behaviour: **it optimises for making the next task pass, not for making the
tenth task easy.** Without external pressure the file only grows.

## Problems encountered

### Infrastructure

**Server crash under long context.** Three HTTP 500s in one session, each immediately following
a memory-pressure warning. The chain: the pressure handler clears prefix-cache snapshots, which
makes the drafter's context-restore path miss; that path is the one that sets a cache offset
*and* immediately writes rows to back it. A second, unpaired code path still advances the same
offset without writing anything, so the rotating KV cache stays empty while its offset reaches
tens of thousands. The next allocation computes `min(step, max_size − offset)`, gets a large
negative number, and throws. Reported upstream as
[ARahim3/mlx-dspark#33](https://github.com/ARahim3/mlx-dspark/issues/33). Mitigated without
patching third-party code by capping prefix-cache RAM, widening the snapshot interval 4×, and
dropping to a single cache slot; the pressure warnings continue but the crash has not recurred.

**No vision, silently.** Described above. Reported upstream on
[ARahim3/mlx-dspark#6](https://github.com/ARahim3/mlx-dspark/issues/6). The silent part is the
worse half: a client that declares image support has no way to learn its attachment vanished,
and will happily reason about an image it never received.

**Output-cap truncation.** The output cap was lowered mid-session to bound a runaway reasoning
chain, and then truncated a *legitimate* long answer — context was only 17.8% used, and 14
minutes of generation was discarded. **Size the output cap to the longest legitimate output, not
to the longest tolerable wait:** truncation throws away everything, a long wait at least yields
a result.

### Verification integrity — the most-repeated problem in the whole project

Four separate times, a fully green test suite was testing something other than the code under
review:

| # | Instance | Effect |
| --- | --- | --- |
| 1 | Ran E2E without `npm run build` first | Tested the previous build |
| 2 | Two agents sharing one `dist/` and one preview server | Tested each other's build |
| 3 | `npm run build` failed and nobody checked the exit code | Tested a build that no longer existed |
| 4 | An enlarged object drifted into a fixed screen-space sample window | Assertion measured something else entirely |

The first three trace to one configuration: `playwright.config.ts` uses `vite preview`, which
**serves `dist/` without building it**, combined with `reuseExistingServer: true` on a fixed
port.

> **A stale-but-valid `dist/` is indistinguishable from a fresh one at the HTTP layer.** No
> assertion added inside the suite can catch this class of failure. The fixes are structural:
> make the build's exit code a hard gate, and give each test runner its own port.
> `reuseExistingServer: !process.env.CI` is the usual shape and is exactly wrong here — it
> optimises for reuse in precisely the local, multi-runner case where reuse is the hazard.

Instance 4 is a distinct and subtler variety, and it is live in this repository today. See
*Known defects*.

**Randomisation thins deterministic regressions silently.** After seeded random map layouts were
introduced, the existing 3-seed termination regression covered far less than it used to, and
nothing turned red to say so. The agent's 3 seeds passed; a 40-seed sweep found a permanent
livelock, and a later 120-seed sweep found one more (119/120).

### Process

**Two agents feeding one session.** In the last round two automations were driving the same agent
session; their inputs arrived 23 seconds apart and the first one's work was destroyed. Both
senders verified they were addressing the right terminal pane before typing, and both
verifications were correct — **a focus check guarantees "I did not type into the wrong window",
not "nobody else is typing into this one". Cross-process exclusion needs a lock, not a check.**
(Note for macOS: `flock(1)` does not exist there; an atomic `mkdir` with a staleness timeout
works.)

## Known defects

These are open, and visible in the deployed build. They are listed here rather than quietly
fixed, because the point of the report is what the process actually produced.

- **The first-person weapon is far too large.** The final task was supposed to shrink it to
  6–18% of the frame; measured by differencing view-model-on against view-model-off frames, it
  now occupies **23.9%** and crosses the middle of the screen diagonally — worse than the version
  it replaced.
- **A ground-detail assertion is now measuring that weapon.** The assertion samples a fixed
  screen rectangle (x 400–880, y 400–520 at 1280×720). The enlarged weapon covers ~46% of that
  rectangle's width. Dark-pixel fraction inside the rectangle went **0.000 → 0.220** and the
  reported statistic went **5.72 → 62.26** — an apparent 11× improvement in "ground detail" that
  is a near-black silhouette edge crossing the sample window. **The test would keep passing with
  the ground texture deleted entirely.** Generally: *a fixed screen-space rectangle is only a
  valid probe while nothing else can enter it, and nothing in the suite enforces that.*
- **The hedge texture does not read as foliage** — discrete dark blobs on flat green, with no
  branch structure and no lit/shadowed faces.
- **AI occasionally sticks on wall corners.**
- **Two flanking units can avoid each other indefinitely**, so a match can fail to resolve if the
  human player dies early. The fix is a per-unit "no contact for N seconds → actively search"
  timer; the three existing anti-stalemate thresholds are global match-clock thresholds and do
  not cover this.

## What this would have cost on a commercial API

Actual token usage, priced against published Qwen Max rates:

| Item | Volume | International | China |
| --- | ---: | ---: | ---: |
| Uncached input | 4,092,218 | $8.18 | ¥49.11 |
| Cached input | 93,428,863 | $18.69 | ¥112.11 |
| Output (incl. reasoning) | 1,805,870 | $10.84 | ¥65.01 |
| **Total, with cache discount** | | **$37.71** | **¥226.23** |
| Total, no cache hits at all | | $205.88 | ¥1,235.26 |

The 5.4× spread is entirely about caching, and the cached figure is optimistic: those 93 M
"hits" are a **local** prefix cache reusing 94.6% of input tokens, which a hosted context cache
with a TTL will not match.

**The interesting comparison is not the money.** Running locally cost roughly $2 of electricity
but **30 hours of wall-clock time**. A hosted flagship model is more than 10× faster per token
and would have finished the same work in about three hours. If time has value, the arithmetic
inverts. The real case for local inference here is that it runs an unmetered 31-commit chain
without quota anxiety, and no source code leaves the machine.

## Notes on local inference speed

**Tokens per second is a misleading health signal.** A drop from 21 to 11 tok/s was initially
attributed to growing context. Decomposing it showed rounds per second barely moved (5.59 →
5.55); the entire difference was speculative-decoding acceptance length (1.96 → 3.79
tokens/round) as the controller widened draft depth in response to a rising acceptance
probability. **Acceptance rate is content-dependent, not context-dependent** — around 91% while
writing code, 28% while writing prose. Watch accepted length and the controller's acceptance
probability, not context percentage.

**Context compaction is not purely a cost.** It is the only operation that *lowers* milliseconds
per round (185 → 133, i.e. 12–22 → 23–28 tok/s). Running a larger context window to avoid
compaction trades a one-off pause for a permanently slower regime.

## What we would do differently

1. **Establish a measurable criterion on the first round, not the third.** "The scene is too
   dark" was reported three times before it became five numbers. Both earlier attempts were
   adjectives, the model complied with both, and neither worked — because nobody, on either side,
   knew what "bright enough" meant. Before handing over any subjective requirement, ask: what
   number decides this? If there is no answer, the task description is not finished.
2. **Decide whether the property is even adjustable before writing acceptance criteria.**
   "Tracers are too thin" had no parameter fix: WebGL ignores `linewidth` on essentially every
   platform, so line primitives rasterise at one pixel forever. Against a platform limitation,
   no acceptance threshold means anything — the implementation approach has to change.
3. **Commit the negative controls.** The model wrote them unprompted; a negative control that
   never lands in the repository is a negative control nobody can re-run.
4. **Gate on the build's exit code, and give each runner its own port.** Three of the four
   verification-integrity failures came from that single configuration.
5. **Give the agent eyes.** A small vision-language model on a second port, used only for
   screenshots, would have caught several of these defects. The visual path does not need to be
   fast — but it also cannot replace all judgement.
6. **Make human playtesting a mandatory gate.** The decisive defects in three separate rounds —
   inverted strafing, invisible tracers, completely silent AI weapon fire — were *all* found by
   playing the game. **None was found by any automated evidence.**

---

*Reproducing this is straightforward: the repository is a normal Vite + TypeScript project, and
every claim above is checkable from `git log`, the test suites, and the screenshots the E2E suite
regenerates.*
