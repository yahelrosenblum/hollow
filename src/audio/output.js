// Main-thread side of the audio path: it only creates the device and hands a direct port to
// the simulation worker. No sample ever passes through the main thread on its way out.

export async function createAudioOutput(simPort, { gain = 0.5 } = {}) {
  if (typeof AudioWorkletNode === 'undefined') {
    throw new Error('This browser does not support AudioWorklet.');
  }
  const context = new AudioContext({ latencyHint: 'interactive' });
  await context.audioWorklet.addModule(new URL('./hollow-worklet.js', import.meta.url));
  const node = new AudioWorkletNode(context, 'hollow-output', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  node.connect(context.destination);
  node.port.postMessage({ type: 'sim-port', port: simPort }, [simPort]);
  node.port.postMessage({ type: 'gain', value: gain });
  return {
    context,
    node,
    setGain(value) {
      node.port.postMessage({ type: 'gain', value });
    },
    resume() {
      return context.resume();
    },
    outputLatency() {
      return (context.outputLatency || 0) + (context.baseLatency || 0);
    },
    close() {
      node.disconnect();
      return context.close();
    },
  };
}
