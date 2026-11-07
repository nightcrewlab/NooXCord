// Posts mono Float32 PCM blocks from the input to the main thread.
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("nx-capture", Capture);
