# About Hollow

**One line:** a free sound simulator in your browser. Draw a room, clap, and hear what the room does to sound.

**What it is.** Hollow solves the 2D wave equation on your graphics card, tens of thousands of times a second, for the room you draw. The sound you hear is the air pressure at two cells beside the listener's head. Echoes, muffled sound behind a door, interference and sound bending around corners come from the simulation, not from effects.

**Who it's for.** People curious about sound, teachers of physics and music, and sound designers who want to hear and export room responses.

**Facts you can check**

- Free and open source under the MIT license.
- Runs in a browser with WebGPU (recent desktop Chrome or Edge). No install, no account, no server.
- 12 built-in rooms, a room editor with walls, curves, doors and windows, up to 8 speakers, a time panel (pause, step, slow motion, reversal), measurement tools, recording and WAV and impulse-response export, and 6 acoustic challenges.
- Ships with 26 physics checks that compare the solver with theory, 142 unit tests and browser test scripts. Every bug the checks found and every criterion that changed is written up in [DECISIONS.md](DECISIONS.md), and the measured results are in [PHYSICS_AUDIT.md](PHYSICS_AUDIT.md).
- No dependencies and no build step.
- Nothing you make leaves your device. The only outside request is the page's fonts, from Google Fonts.

**Honest limits**

- It's 2D, so it behaves like a very tall room. It's an instrument and a way to understand sound, not a tool for predicting real buildings.
- Sound reaches about a quarter of the simulation rate, so it sounds darker than a recording.
- WebGPU is required. There is no fallback.
- It has been measured, but a person has not yet listened to every room and judged how it sounds. Feedback on that is welcome.

**Author:** Yahel Rozenblum.

**Links:** [Live demo](https://yahelrosenblum.github.io/hollow/) · [Source](https://github.com/yahelrosenblum/hollow) · [Classroom ideas](CLASSROOM.md)

**Images:** [cathedral](images/cathedral.jpg), [welcome screen](images/welcome.jpg), [phone](images/phone.jpg), [social card](images/social-card.png).
