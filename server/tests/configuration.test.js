import { describe, it, expect } from "vitest";
import { parseEnv } from "node:util";
import {
  configurationFiles,
  validateSettings,
} from "../../scripts/configuration.js";

const settings = {
  url: "https://example.supabase.co/",
  publicKey: "sb_publishable_test_public_value",
  secretKey: "sb_secret_test_server_value",
  adminEmail: "admin@example.test",
  adminPassword: 'Example"$#password123',
  agentEmail: "agent@example.test",
  agentPassword: "Example'password123",
};

describe("local setup configuration", () => {
  it("keeps secrets and passwords out of browser configuration", () => {
    const files = configurationFiles(
      settings,
      "PORT=3001\nCALL_PROVIDER=mock\nSUPABASE_SERVICE_ROLE_KEY=placeholder\n",
    );
    const frontend = parseEnv(files.client),
      backend = parseEnv(files.root);
    expect(Object.keys(frontend).sort()).toEqual([
      "VITE_API_URL",
      "VITE_SUPABASE_ANON_KEY",
      "VITE_SUPABASE_URL",
    ]);
    expect(files.client).not.toContain(settings.secretKey);
    expect(files.client).not.toContain(settings.adminPassword);
    expect(backend.SUPABASE_SERVICE_ROLE_KEY).toBe(settings.secretKey);
    expect(backend.PORT).toBe("3001");
    expect(backend.CALL_PROVIDER).toBe("mock");
    expect(backend.DEV_ADMIN_PASSWORD).toBe(settings.adminPassword);
    expect(backend.DEV_AGENT_PASSWORD).toBe(settings.agentPassword);
  });
  it("rejects swapped Supabase keys and duplicate login emails", () => {
    expect(() =>
      validateSettings({ ...settings, publicKey: settings.secretKey }),
    ).toThrow("public key");
    expect(() =>
      validateSettings({ ...settings, secretKey: settings.publicKey }),
    ).toThrow("server key");
    expect(() =>
      validateSettings({ ...settings, agentEmail: settings.adminEmail }),
    ).toThrow("different emails");
  });
  it("rejects unsafe multiline values before writing files", () => {
    expect(() =>
      configurationFiles(
        { ...settings, adminPassword: "Password123\nVITE_SECRET=exposed" },
        "",
      ),
    ).toThrow("one line");
  });
  it("configures an existing Auth account without requesting or changing login credentials", () => {
    const connection = {
      url: settings.url,
      publicKey: settings.publicKey,
      secretKey: settings.secretKey,
    };
    const existing =
      "DEV_ADMIN_EMAIL=existing@example.test\nDEV_ADMIN_PASSWORD='existing-password123'\nDEV_AGENT_EMAIL=\nDEV_AGENT_PASSWORD=\n";
    const files = configurationFiles(connection, existing, { accounts: false });
    const root = parseEnv(files.root);
    expect(root.DEV_ADMIN_EMAIL).toBe("existing@example.test");
    expect(root.DEV_ADMIN_PASSWORD).toBe("existing-password123");
    expect(root.DEV_AGENT_EMAIL).toBe("");
    expect(root.SUPABASE_SERVICE_ROLE_KEY).toBe(connection.secretKey);
    expect(files.client).not.toContain(connection.secretKey);
    expect(files.client).not.toContain("existing-password123");
  });
});
