# Contributing to Hollow

Thanks for wanting to help. The most useful thing you can do is **tell me what sounds wrong**. The simulation is measured against physics, but only people can judge how a room sounds.

## Reporting a problem

Open an issue and say:
- which room (or paste a share link),
- your browser and graphics card,
- what you heard or saw, and what you expected.

There are templates for bugs, "this sounds wrong", and ideas.

## Running it

Needs Node 20 or later. There is nothing to install.

```bash
git clone https://github.com/yahelrosenblum/hollow.git
cd hollow
node serve.mjs
npm test
```

## What I look for in a change

- **Physics changes come with evidence.** The solver is the whole point of the project. If you change it, run `npm run audit` and describe what you measured. The audit exists to catch changes that look fine and aren't.
- **A bug fix comes with a test** that fails before the fix and passes after.
- **No new dependencies and no build step.** Plain ES modules, WebGPU, WGSL and AudioWorklet.
- **No effects on the sound.** Echo, occlusion and interference should come from the simulation. See "What happens to the sound" in the README for the only five processing steps.
- **Keep files small and focused.**
- **Don't loosen a test to make it pass** without saying why in docs/DECISIONS.md. A criterion that needed loosening has hidden a real bug here before.

## Pull requests

Describe what changed, why, and how you checked it. Small pull requests are easier to review than large ones.

## License

By contributing you agree that your contribution is under the MIT license.
