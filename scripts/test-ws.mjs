/* Quick end-to-end test of the WebSocket relay (main.ts) — not part of the app. */
import WebSocket from "ws";

const URL = "ws://localhost:8000/ws?room=TEST";
const log = (tag, obj) => console.log(`[${tag}]`, JSON.stringify(obj));

function client(name, color) {
  const ws = new WebSocket(URL);
  const state = { id: "", youHost: false, peers: [] };
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    if (m.t === "welcome") {
      state.id = m.id;
      state.youHost = m.youHost;
      state.peers = m.peers;
      log(name, { event: "welcome", youHost: m.youHost, peers: m.peers.length });
      ws.send(JSON.stringify({ t: "join", name, color }));
    } else {
      log(name, { event: m.t, ...m });
    }
  });
  return { ws, state, name };
}

const A = client("ALPHA", "#ff2d78");
A.ws.on("open", () => {
  setTimeout(() => {
    const B = client("BRAVO", "#00f0ff");
    B.ws.on("open", () => {
      // Host (A) sends a message the relay must forward to B
      setTimeout(() => {
        A.ws.send(JSON.stringify({ t: "start" }));
        setTimeout(() => {
          // A leaves -> B should be promoted to host
          A.ws.close();
          setTimeout(() => {
            console.log("--- done ---");
            process.exit(0);
          }, 400);
        }, 400);
      }, 400);
    });
  }, 200);
});
