import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { gracefulShutdown } from "../src/lifecycle.js";
import request from "supertest";
import { createApp } from "../src/app.js";
describe("deployment lifecycle", () => {
  it("drains only once and exits after accepted work completes", () => {
    const signals = new EventEmitter(),
      exit = vi.fn(),
      state = {};
    let finished;
    const server = {
      close: vi.fn((cb) => {
        finished = cb;
      }),
      closeIdleConnections: vi.fn(),
    };
    gracefulShutdown(server, state, { signals, exit });
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    expect(state.draining).toBe(true);
    expect(server.close).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    finished();
    expect(exit).toHaveBeenCalledWith(0);
  });
  it("readiness rejects database failures and draining without leaking details", async () => {
    const query = {
      select: () => query,
      limit: () => query,
      abortSignal: vi
        .fn()
        .mockResolvedValue({ error: { message: "private-token" } }),
    };
    const db = { from: () => query };
    let response = await request(createApp(db)).get("/ready");
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain("private-token");
    query.abortSignal.mockResolvedValue({ error: null });
    expect((await request(createApp(db)).get("/ready")).status).toBe(200);
    query.abortSignal.mockClear();
    response = await request(
      createApp(db, { lifecycle: { draining: true } }),
    ).get("/ready");
    expect(response.status).toBe(503);
    expect(query.abortSignal).not.toHaveBeenCalled();
  });
});
