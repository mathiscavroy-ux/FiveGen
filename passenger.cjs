// Startup file for hosts that launch the app through Phusion Passenger (o2switch,
// cPanel "Setup Node.js App"). Passenger loads it with require(), which cannot load an
// ES module directly: this CommonJS file imports the real entry point instead.
import("./server/index.js").catch((err) => {
  console.error("[fivegen] démarrage impossible :", err);
  process.exit(1);
});
