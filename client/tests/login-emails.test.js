import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rememberLoginEmail, savedLoginEmails } from "../src/lib/loginEmails";
const key = "hd-marketing-login-emails-v1";
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
it("keeps five unique recent emails per portal, without passwords or other data", () => {
  rememberLoginEmail("admin", "owner@example.com");
  for (let i = 0; i < 7; i++)
    rememberLoginEmail("agent", `agent${i}@example.com`);
  rememberLoginEmail("agent", "  AGENT4@example.com ");
  expect(savedLoginEmails("agent")).toEqual([
    "agent4@example.com",
    "agent6@example.com",
    "agent5@example.com",
    "agent3@example.com",
    "agent2@example.com",
  ]);
  expect(savedLoginEmails("admin")).toEqual(["owner@example.com"]);
  expect(JSON.parse(localStorage.getItem(key))).toEqual({
    agent: savedLoginEmails("agent"),
    admin: ["owner@example.com"],
    staff: [],
  });
});
it("ignores malformed values, unknown roles and duplicate stored emails", () => {
  localStorage.setItem(
    key,
    JSON.stringify({
      agent: [
        "VALID@example.com",
        " valid@example.com ",
        null,
        { password: "not-an-email" },
        "bad",
        "a b@example.com",
      ],
      admin: "wrong-shape",
      password: "unrelated-data",
    }),
  );
  expect(savedLoginEmails("agent")).toEqual(["valid@example.com"]);
  expect(savedLoginEmails("admin")).toEqual([]);
  expect(savedLoginEmails("other")).toEqual([]);
  rememberLoginEmail("agent", {
    email: "object@example.com",
    password: "not-an-email",
  });
  rememberLoginEmail("other", "unknown@example.com");
  rememberLoginEmail("agent", "bad");
  expect(savedLoginEmails("agent")).toEqual(["valid@example.com"]);
  rememberLoginEmail("agent", "new@example.com");
  expect(JSON.parse(localStorage.getItem(key))).toEqual({
    agent: ["new@example.com", "valid@example.com"],
    admin: [],
    staff: [],
  });
});
it("recovers from invalid JSON and blocked storage without failing login work", () => {
  localStorage.setItem(key, "broken-json");
  expect(savedLoginEmails("agent")).toEqual([]);
  rememberLoginEmail("agent", "person@example.com");
  expect(savedLoginEmails("agent")).toEqual(["person@example.com"]);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Blocked");
  });
  expect(savedLoginEmails("agent")).toEqual([]);
  expect(() => rememberLoginEmail("agent", "person@example.com")).not.toThrow();
});
