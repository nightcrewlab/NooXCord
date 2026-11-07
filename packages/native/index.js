// Loads the prebuilt native module; exports null when unavailable so callers can degrade gracefully.
const path = require("node:path");

let mod = null;
let loadError = null;
try {
  mod = require(path.join(__dirname, `nooxcord-native.${process.platform}-${process.arch}.node`));
} catch (e) {
  loadError = e;
}
module.exports = { native: mod, loadError };
