// Runs before `npm run dev`. If the CRM is already running in another
// terminal, explain that instead of failing with "Port 5173 is already in use".
import { createConnection } from "node:net";
const ports = [
  [5173, "website"],
  [Number(process.env.PORT || 3001), "server"],
];
const inUse = (port) =>
  new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => (socket.destroy(), done(true)));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => (socket.destroy(), done(false)));
  });
const busy = [];
for (const [port, name] of ports) if (await inUse(port)) busy.push(`${name} (port ${port})`);
if (busy.length) {
  console.error(
    [
      "",
      `The CRM is already running: ${busy.join(" and ")} ${busy.length === 1 ? "is" : "are"} in use.`,
      "  • To use it, open http://localhost:5173",
      "  • To restart it, go to the terminal window where it is running,",
      "    press Ctrl+C there, then run npm run dev again.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
