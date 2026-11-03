# Decisions

Technical decisions that weren't obvious, and every change to an acceptance criterion. Each entry says what was measured.

## Solver

### Walls mirror their diagonals instead of removing them

**Found by:** the glass transmission check, whose results made no sense, then a uniform-duct test.

Removing the diagonal stencil edges beside a wall leaves the row next to the wall with 5/6 of the correct conductance along the wall. A wave grazing a wall then travels at the wrong speed and scatters. A rigid wall is a mirror, so a diagonal that would enter a flat wall reflects onto the axial edge running along it. Each cell stores two bits per axial edge counting those reflections, and the mirror is applied only where the wall covers both ends of the edge, which keeps the operator symmetric. Random-room eigenvalue checks confirm it stays stable.

### The update is written in differences

**Found by:** the GPU vs CPU check, which diverged in plain air by about 13 dB per doubling of time.

The expanded form `centre*u + axial*sumA + diagonal*sumD - prev` relies on coefficients summing to exactly 2. In 32-bit they don't, so a constant field isn't preserved and that mode can grow exponentially. The CPU reference, using 64-bit arithmetic, hid this completely. The update is now:

`u+ = u- + (2(u - u-) + axial*(sumA - 4u) + diagonal*(sumD - 4u)) * norm`

A constant field is now preserved exactly at any rounding. GPU vs CPU went from -11.8 dB to about -80 dB.

### LAMBDA2 is 0.74, not the 0.75 limit

At exactly 3/4 the checkerboard mode has a double root at z = -1, so rounding can feed linear growth in it. 0.74 costs about 0.7% in grid spacing and removes the double root.

### Three field buffers, not two

The original plan overwrote `u-` in place. Viscous loss needs the neighbours' previous values, which in-place writes would have already destroyed. A third buffer only costs memory. Reversal is still a swap.

### Foam uses viscous loss, not pressure damping

**Found by:** the foam absorption check.

Pressure damping made thin foam absorb lows better than highs (81% at 125 Hz, 47% at 2 kHz for two cells), the reverse of real foam. Viscous loss acts on velocity and grows with frequency. Measured now: 41% at 125 Hz and 96% at 2 kHz, 12 cells deep. It grows as frequency squared rather than as in real porous material, so it's a qualitative model of foam, not a calibrated one.

### Glass is a stiff heavy sheet

**Found by:** the mass-law check.

A soft one-cell sheet is an L-C-L network, and its third-order term made transmission fall far too fast (measured -49 dB at 1 kHz against a predicted -50 dB from the circuit, and -32 dB from the mass law). The cell needs a large stiffness, limited by its eigenvalue: an isolated sheet cell reaches 6.67 m*k, so `m*k` must stay below 0.81. 0.9 went unstable and was caught by both the random-room check and GPU NaNs. It's now 0.75.

### Division removed from the update path

WGSL only promises 2.5 ULP on division. `1 / (1 + g)` is precomputed per cell.

### Source injection is differentiated, ears get a half-order filter

Injecting a signal directly makes the room's mean pressure grow without limit, because the constant mode of the wave equation has a double root at z = 1. The first difference removes that. The half-order filter at the ear (-3 dB/octave) then gives a flat response from source to ear, compensating the 1/sqrt(f) of 2D propagation. This doesn't make the simulation three-dimensional.

### Sources are band-limited, and the band edge is filtered at the ear

**Found by:** adding foam made the measured decay longer. Absorption can't do that.

The late tail sat at 0.329 × the simulation rate, at both 8 and 16 kHz. Along a grid axis, waves stop propagating where sin(ω/2) = λ, which for λ² = 0.74 is 0.3295. So this was the grid's own cutoff, not the room: waves there barely move, never reach an absorber, and ring on. It would have been audible as sizzle after every clap and baked into every exported impulse response.

Sources now pass through a 47-tap linear-phase low-pass, stopped by about 0.32 fs. Ear signals get a low-pass at 0.27 fs and a notch on the cutoff, because sudden events in the room can excite it too. That notch and low-pass are a disclosed fifth step in the output chain. Measured for a foam-lined room: 3.7 s before, 0.21 s after, against 1.31 s bare. 8 and 16 kHz now agree (0.24 s and 0.22 s).

Cost: usable bandwidth is about a quarter of the simulation rate, not a third.

### Decay time refuses to guess

Backward integration always reaches zero at the end of a recording, even if the sound hasn't died away, and reported 1.9 s for a room whose real decay is about 14 s. If the last 5% of a recording is within 40 dB of the opening, `decayTime` returns null and the interface says "longer than".

### Doors are heavy sheets, not rigid walls

A rigid door sealed the doorway completely, so no sound passed at all, which is wrong for a real door and contradicted the Next Door scene. A door leaf is now a 15 kg/m² mass sheet. Measured at 1 kHz: 47.7 dB quieter shut than open.

### The doorway cut has square ends

Rounded ends cut 20 cm past both ends of the leaf, so a shut door had gaps. Measured before the fix: -1.6 dB, meaning the door did nothing.

### The listener's head reflects perfectly in lossless rooms

The head normally absorbs a little. In the Time Mirror room that one object stopped reversal working: field match was 90%. With a perfect head it is 99.9999999%.

### A lossless room's clap is a 1.5 ms pulse

A 12 ms noise clap has already spread several metres by the time it ends, so there is never a tight focus to return to. Measured with the short pulse: 99.9999999% of the energy back near the source, in a 65 cm spot. With one wall added during the return: 50% field match, 32% energy, 4.6 m spot.

### Speakers for interference experiments go ahead and behind the listener

Ears sit 10.5 cm either side of the head, so speakers placed across the listener are not equidistant from either ear. At 700 Hz that offset is nearly half a wavelength and turned cancellation into addition (+1.8 dB). Ahead and behind, both ears are equidistant: -54 dB in anti-phase and +6.01 dB in phase.

### Two opposed speakers put the listener on the grid's symmetry

**Found by:** measuring the "Two opposed" button at every rate, instead of at one.

The null at the ears ranged from 4 dB to 54 dB depending only on where the listener stood relative to the cells. At 8 kHz with the listener in the middle of the room, the left ear cancelled by 4 dB, where the panel says you should hear almost nothing. The listener's head is only a few cells across. Off-centre on the grid, it scatters the speaker in front and the one behind differently, so the two paths aren't mirror images. The button now moves the listener to the nearest cell centre, turns them to the nearest grid axis, and spaces the speakers a whole number of cells away. Measured at every rate from three starting positions: 35 to 117 dB of cancellation, and +6.0 dB in phase.

### The reed is part of the centred damping term, fills the bore, and sits against the closed end

The first version was an explicit term that blew up to NaN at its shipping gain, because the margin at the grid limit only tolerates a damping coefficient of about 0.03. Centred damping is stable at any strength when it absorbs.

The geometry took several measured attempts, and three of them produced tempting wrong answers:

- In a wide bore, it played the resonance across the pipe (c / 2w), ignoring length.
- With a gap behind it, it played that gap's own quarter-wave resonance, about 1 kHz.
- A one-cell reed gets weaker as the grid gets finer, so at 16 kHz short pipes never started. The "3.3 kHz note" reported then was rounding noise at -88 dB. The audit now requires the reed to be audibly playing.

Viscous loss in the reed, tried as a stand-in for reed mass, made no measurable improvement to the pitch and was first removed. That was a mistake, because the check that judged it was too narrow. It only ran 8 and 16 kHz with one starting noise. A browser run of the shipped scene at 22 kHz gave a faint 5.6 kHz squeal and no note, and the CPU reference then did the same at 16 kHz (6.4 kHz) with different noise. A reed amplifies every mode that passes through it, and high modes trapped across a lossless pipe lose nothing, while the note leaks out of the open end. Which one wins comes down to chance. A diffusivity of 0.03 m²/s costs the note almost nothing, because viscous loss grows with frequency squared, and removes the competition. The audit now runs all four rates and two seeds.

The breath that starts the reed had the same problem from another side. It was plain noise, and the source chain's first difference takes away its lows, more so at higher rates, so at 16 and 22 kHz the note started with almost nothing and a mode across the pipe got there first. It's now `BreathSource`: noise that is flat once differentiated, landing in the room at the same strength as the audit's.

Measured in the browser through the real button, pipe length against pitch:

| Rate | 1.0 m | 0.6 m (the scene) | 0.45 m | 0.35 m |
|---|---|---|---|---|
| 8 kHz | 81 Hz | 129 Hz | 168 Hz | 209 Hz |
| 11 kHz | 80 Hz | 129 Hz | 171 Hz | 205 Hz |
| 16 kHz | 80 Hz | 125 Hz | 163 Hz | 216 Hz |
| 22 kHz | 77 Hz | 119 Hz | does not start | does not start |

**Known limitation:** at 22 kHz, pipes shorter than about half a metre don't start. The reed is 20 cm long, so in those pipes it's a large part of the bore. The audit covers 0.6 m to 1.4 m.

The scene's pipe also went from 1.2 m to 0.6 m, because a 40–60 Hz note is below what laptop and phone speakers can play. Its instructions changed too: they said to draw a wall across the pipe to shorten it, which seals the pipe and silences it. That's correct physics and a wrong instruction.

**A limitation that turned out to be a bug:** the reed used to play flat of the struck pipe, by 0.75-0.85× at 16 kHz and 0.5-0.6× at 8 kHz, and at 11 kHz it didn't start at all. That was written up here as a property of the model. It wasn't. Every painted object is thickened by 0.72 of a cell so that thin shapes stay unbroken, and the reed is painted after the walls. Its thickened edge overwrote the inside of the pipe walls next to it, by an amount depending on how the grid fell, and at 11 kHz it erased them completely. A leak beside the reed lowers the note, and a large one stops it. Fluids no longer paint over walls, and a unit test covers every rate. Measured after the fix, at 1.0 m: 81.2 Hz against 81.5 struck at 8 kHz, 80.4 against 80.9 at 11 kHz. The same rule protects foam and heavy gas placed against a wall.

## Look and first impression

**Found by:** the first person who tried it. They didn't understand what it was, and said it didn't look good.

The field used to be drawn as faint tinted ink. Now it's drawn as light: pressure is emitted light, drawn into a high-range texture, then bloomed, tone mapped with a filmic curve, vignetted and given film grain. Walls are dark glass whose faces light up only where the field beside them is moving. The display reads the solver's data and changes nothing in it.

Brightness problems and their fixes, each found by looking:

- **The quiet echo was drawn as brightly as the wavefronts.** The exposure followed the ears, so as an echo died away the picture was turned back up to full, and the room became speckle. The picture now adapts more slowly than the ears, so an echo visibly fades.
- **Faint light was too strong.** The brightness curve is steep, so a low-level echo stays dark and only strong wavefronts burn bright.
- **Silence came out white.** In slow motion a wave hadn't reached the ears yet, so they'd heard nothing and the exposure went to the maximum. Slow motion and pause now take their exposure from the strength of the sources.
- **People can now choose.** A Brightness slider in Listen covers what one default can't.

The welcome runs the cathedral at 1/32 speed with no sound, because browsers won't play audio before a click. Each preview is a 1.5 ms snap rather than a 12 ms clap, which leaves a thin ring rather than a thick band of noise, and the room is quietened before each one, because at that speed the echo barely fades between snaps. Clicking starts the sound and the real-time simulation.

Layout: the field fills the window, and the controls float over it on dark glass. The room is placed in the part of the field the controls don't cover. The room picker shows a drawing of each room, made from its own objects with the same tracing the main view uses.

The light pipeline was measured before shipping, because it shares the GPU with the sound: at 1729 × 1080 with bloom, a tone playing and a clap every 1.5 s, 16 kHz and 22 kHz both held exactly real time with no dropouts over 20 s each.

From the code review of the redesign, all fixed:

- A fast click on Start could leave the preview's timer running, so it kept quietening the live room every 4 seconds.
- A preview snap could land after the click.
- The last preview snap could still be ringing when the sound came on.
- The original-versus-reversed wipe split the window rather than the room.
- Its frame offset was a 32-bit float, which reads one cell off past 16 million.
- On a short screen the welcome could squeeze the room to a sliver.
- Keys reached the app behind the welcome, and focus was lost when it closed.

## GPU

### At most 8 storage buffers

WebGPU only guarantees 8 per stage. Injector points, tap points and source samples share one buffer, and tap output shares one with the cursor. Requesting a higher limit would have shut out weaker GPUs.

### Pipeline failures must be loud

`WaveEngine.create` wraps pipeline creation in an error scope. Without it, a failed pipeline quietly computes nothing, which briefly looked like a large performance improvement during development.

### Worker-owned GPU, direct port to the worklet

The GPU device lives in a worker, and samples go straight from it to the audio thread over a MessagePort. Neither the sound nor the solver depends on the main thread, so a busy interface can't cause an audio dropout.

### The audio thread is the clock

The solver only computes what the worklet's consumption report asks for, so simulated time can't drift from audio time.

### A hidden page's stalls are not evidence about the GPU

**Found by:** a 30-minute soak that reported 0.408× real time with 289 dropouts, and the rate falling to 8 kHz.

The solver wasn't falling behind: the audio clock itself had slowed, and the solver followed it to within 0.3%. Three wrong explanations came first, and each was ruled out by measurement: timer throttling limiting batch size (raising the cap changed nothing), exact digital silence (an inaudible signal behaved the same), and Hollow's worklet being too slow (`process()` uses under 1% of its time budget). The controls that settled it, on a hidden page:

| Running | Empty AudioWorklet | Hollow | Plain oscillator |
|---|---|---|---|
| Nothing audible | about 0, stalling | about 0, stalling | 1.000 |
| An oscillator at -60 dBFS playing | 1.000 | 1.000 | 1.000 |
| Oscillator stopped | about 0 within 10 s | about 0 within 10 s | |

So the browser stalls a hidden page's AudioWorklet thread and its GPU work, by seconds at a time, unless the page is audibly playing. An empty worklet does the same, so this isn't Hollow's code, and it can't be fixed from a web page. Someone listening is never in that state. A muted test always is, so the soak was measuring its own muting.

What did need fixing is what Hollow did about it. The governor read those stalls as a slow GPU and lowered the rate for good, since it never steps back up on its own. A boot benchmark taken while hidden picked 8 kHz on a GPU that manages 16 kHz or more. Now:

- Underruns while hidden aren't counted, and the governor settles again on return.
- A benchmark during which the page was hidden is treated as doubtful: it's used for now, says nothing about a busy GPU, and is repeated when the page comes back.
- While a measurement runs, other requests to the worker wait their turn. It swaps the solver's buffers, and an overlapping request failed with "Buffer was destroyed before mapping was resolved".

**For users:** in a hidden tab with nothing audible, the simulation effectively pauses. It stays in step with the audio clock, and picks up when the tab returns.

**For testing:** an off-screen browser pane also never fires `requestAnimationFrame`, even with `document.hidden` false, so door swings and fly-pasts need a timer substitute there. The soak and gates play a 30 Hz hum at -60 dBFS, in a separate audio context, to stay awake. Timing from a pane nobody is looking at says nothing about what a person gets.

### The catch-up batch is capped by the engine's limit

**Found by:** the browser gate that uses every control, and caused by the fix for the problem above.

Raising the catch-up cap to 0.12 s of audio meant 2,646 steps at 22 kHz, past the engine's hard limit of 2,048. Any stall at 22 kHz then threw on every tick, for good, in silence: audio had never primed, so not even an underrun was reported. No earlier check ran 22 kHz after that change. The cap now respects the limit, and a unit test covers every rate.

### Smaller fixes from the same browser gates

- **Undoing a door swing did nothing.** The swing's frames replaced the room without recording it, so the undo point saved was the nearly open door. Every frame is now one undo group based on where the door started.
- **Rewind speed fired twice.** The button kept its original 1/32 handler after the slider was moved, because `onclick = null` doesn't remove a listener added with `addEventListener`. It now reads one stored speed.
- **The organ pipe's blurb** said "Hold Blow", and the button says "Hold to blow".
- **From the code review of these fixes:**
  - A re-measure that failed would have retried forever, holding every other request in the queue, and left the solver on a benchmark grid. A failed measurement is now never retried, and the room goes back on the solver.
  - A re-measure at an unchanged rate stopped whatever was playing. Now it carries on.
  - A fluid could still erase a window or a door, which are sheets rather than walls. Both are now protected, with a unit test.
- **Gates set the saved volume.** Two test scripts called `setVolume(0.02)`, which persists, and left a real visitor's volume at 2%. They now quiet the output without saving.

### The microphone's rate conversion is a tested class

**Found by:** injecting samples through the real Hold to talk button, which is how the plan said to test it.

The inline conversion read before the start of a block once its carry passed 2 samples, which gave NaN. A real voice would have blown up the simulation the first time anyone used it. It's now `StreamResampler`, with unit tests for every rate pair, block boundaries and pitch. It also has a low-pass that the old comment claimed the grid provided: the grid can't remove what has already folded down into the band. A 13 kHz tone now arrives over 20 dB down rather than as a false 3 kHz.

## The 30-minute soak

**Criterion, set before the final run:** solver within 1% of the audio clock over the whole run; no errors; no instability. Real-time rate and dropouts are reported beside it.

**Result: missed.** Final code, 30 minutes, every feature running, the page off-screen 99% of the time with the hum keeping its audio awake:

- 0 errors, no instability, loudest ear value 2.3, and the rate never changed.
- The audio clock ran at 1.000 throughout.
- In the 33 of 59 half-minutes with no dropouts, the solver ran at 0.9996× real time: no drift.
- From minute 10 to 25, GPU batches stalled for 1 to 2 seconds at a time: 180 dropouts, and a mean of 0.845× real time. That gap is all of the 15.7% by which the solver fell behind the audio clock.

So the clock lock holds whenever the GPU delivers, and the miss is GPU stalls. The criterion stayed as written and that run stayed a miss.

**Second run, on screen: met.** Same code and criterion, with the browser pane on screen 96% of the time (animation frames at 139 per second on average), the live wallpaper and screen recorder closed, and Unreal Editor still open:

- Solver and audio clock 0.59% apart; 0 errors; loudest ear value 0.82; 0.994× real time overall, and 0.9998× in the 49 of 60 half-minutes with no dropout.
- No multi-second stalls: the longest batch was 408 ms, during a rate change. So the hidden page caused most of the first run's stalls.
- 38 dropouts. 12 came at minute 3, when the governor stepped down from 16 kHz to 8 kHz with Unreal Editor using the GPU, which is the governor doing its job. Most of the rest came between minutes 3.5 and 13.5 at 8 kHz, where the GPU has plenty of headroom. The soak rebuilds the room every few seconds (doors, added objects, workspace switches), and a rebuild can briefly interrupt audio. A person editing that often would hear the occasional gap.

`docs/audit/soak.json` holds the second run. The first run's numbers are the ones above.

## Acceptance criteria changes

### GPU vs CPU: judged with the constant offset removed

- **Original:** under -80 dB on the raw field.
- **Measured:** -58.6 dB raw; -80.3 dB with the constant offset removed. Two correct solvers differing only in 32-bit rounding (the CPU reference in strict 32-bit against itself in 64-bit) give -63.0 dB raw and -79.8 dB without the offset.
- **Why it changed:** the raw target isn't reachable, because rounding alone exceeds it. Nearly all of the raw difference is a constant pressure offset, which is silent and carries no wave.
- **For users:** nothing audible. The offset is removed before the speakers and before any display.

### Time reversal: judged with the constant offset removed

- **Measured:** after 12.5 s of sound, -85.0 dB in the waves and -28.2 dB raw, with an offset of 0.002 against a pulse peak of 1.
- **Why it changed:** same reason. Rounding feeds the constant mode, and it grows slowly.
- **For users:** refocusing is exact to about 1 part in 18,000 in amplitude after 12.5 s.

### Throughput: measured under load

- **Target:** at least one rate above 1.5x real time.
- **Measured:** see `PHYSICS_AUDIT.md`. Other programs were using about 98% of this GPU at the time (nvidia-smi reports `pythonw` at about 65% and Unreal Editor at about 18%), and they were not closed for the audit. An earlier run on a less busy GPU reached 2.3x at 16 kHz.
- **Why it stands:** the target remains, and a miss under load is reported as a miss. The app's answer to a busy GPU is the rate governor.

### Reed pitch: loosened, then restored

- **Original:** the plan said a reed should sound "near" the pipe's resonance. While building the check I first wrote this as within 10% of the struck pipe.
- **First measured:** 0.75-0.87× at 16 kHz and 0.48-0.62× at 8 kHz. No setting found met 10% at both rates, so the criterion was loosened to between 0.45× and 1.05×. That loosening was made after seeing the numbers, and it hid a bug: the walls beside the reed were being painted over (see the reed section above).
- **Now:** back to within 10%, at all four rates and with two starting noises, audibly playing, and more than 1.4× higher in the shortest pipe. See `PHYSICS_AUDIT.md` for the measured values.
- **The lesson:** a criterion loosened to fit a measurement should have prompted a search for the cause. Here the loosened number was a symptom.

## Scope changes from the approved plan

- **C80 dropped,** as the plan says. It's calibrated for 3D halls.
- **Air absorption:** no viscous term in plain air, because it would double the cost of the fast path. Air loss is frequency-independent, set per scene.
