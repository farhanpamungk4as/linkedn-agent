import { createServer, connect } from "node:net";

// Chromium binds CDP to its own loopback. This relay shares the browser's
// network namespace and exposes CDP only to the project's private network.
createServer((client) => {
  const upstream = connect(9222, "127.0.0.1");
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
}).listen(9223, "0.0.0.0");
