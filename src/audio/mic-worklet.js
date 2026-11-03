// Captures microphone blocks on the audio thread and posts them out. Nothing else happens to
// them here: the only thing that changes this sound is the room it gets injected into.

class HollowMic extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(channel.slice());
    return true;
  }
}

registerProcessor('hollow-mic', HollowMic);
