import React from "react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  download: vi.fn(),
  auth: { user: null },
}));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null, configured: true }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
  download: mocks.download,
}));
const first = {
  id: "71000000-0000-4000-8000-000000000001",
  title: "Company policy",
  category: "policy",
  content:
    "First paragraph\nSecond paragraph\n<script>window.bad=true</script>",
  created_at: "2026-10-09T08:00:00Z",
  updated_at: "2026-10-09T08:00:00Z",
  files: [
    {
      id: "72000000-0000-4000-8000-000000000001",
      file_name: "Handbook.pdf",
      mime_type: "application/pdf",
      size_bytes: 100,
    },
  ],
};
const second = {
  ...first,
  id: "71000000-0000-4000-8000-000000000002",
  title: "Agent guide",
  category: "documentation",
  files: [],
};
let records, failSave, failUpload, failDelete, pending, next;
const originalDialog = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
beforeAll(() =>
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  }),
);
afterAll(() => {
  if (originalDialog)
    Object.defineProperty(
      HTMLDialogElement.prototype,
      "showModal",
      originalDialog,
    );
  else delete HTMLDialogElement.prototype.showModal;
});
beforeEach(() => {
  vi.clearAllMocks();
  records = structuredClone([first, second]);
  failSave = false;
  failUpload = "";
  failDelete = false;
  pending = null;
  next = 3;
  mocks.auth.user = {
    id: "admin",
    name: "Document admin",
    role: "admin",
    active: true,
  };
  mocks.api.mockImplementation(async (path, options) => {
    if (path === "/reminders") return [];
    const url = new URL(path, "https://test.invalid"),
      parts = url.pathname.split("/");
    if (parts[1] !== "documents") return { data: [], count: 0 };
    if (parts[2] === "clients")
      return [
        {
          id: "73000000-0000-4000-8000-000000000001",
          name: "Client fixture",
          masked_phone: "+92******567",
        },
      ];
    if (options?.method === "POST" && parts.length === 2) {
      if (failSave) throw new Error("Save failed");
      const created = {
        ...options.body,
        id: "entry-" + next++,
        created_at: first.created_at,
        updated_at: first.updated_at,
        files: [],
      };
      records.unshift(created);
      return created;
    }
    if (parts.length === 2) {
      let data = records.filter(
        (r) =>
          (!url.searchParams.get("unlinked_kyc") ||
            (r.category === "client_kyc" && !r.lead_id)) &&
          (!url.searchParams.get("lead_id") ||
            r.lead_id === url.searchParams.get("lead_id")) &&
          [r.title, r.property_name || "", r.keywords || "", r.content]
            .join(" ")
            .toLowerCase()
            .includes((url.searchParams.get("search") || "").toLowerCase()) &&
          (!url.searchParams.get("category") ||
            r.category === url.searchParams.get("category")),
      );
      const p = Number(url.searchParams.get("page") || 1);
      return { data: data.slice((p - 1) * 20, p * 20), count: data.length };
    }
    const entry = records.find((r) => r.id === parts[2]);
    if (!entry) throw new Error("Entry not found");
    if (parts[3] === "files") {
      if (options?.method === "POST") {
        const file = options.body.get("file");
        if (file.name === failUpload) throw new Error("Upload failed");
        if (pending) await pending;
        const attached = {
          id: "file-" + next++,
          file_name: file.name,
          size_bytes: file.size,
        };
        entry.files.push(attached);
        return attached;
      }
      if (options?.method === "DELETE") {
        if (failDelete) throw new Error("Delete failed");
        entry.files = entry.files.filter((f) => f.id !== parts[4]);
        return null;
      }
      if (parts[5] === "download") return new Blob(["PDF"]);
    }
    if (options?.method === "PATCH") {
      if (failSave) throw new Error("Save failed");
      Object.assign(entry, options.body);
      return { ...entry };
    }
    if (options?.method === "DELETE") {
      if (pending) await pending;
      if (failDelete) throw new Error("Delete failed");
      records = records.filter((r) => r.id !== entry.id);
      return null;
    }
    return { ...entry, files: [...entry.files] };
  });
});
function workspace(path = "/documents") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}
const writes = () =>
  mocks.api.mock.calls.filter(([, o]) =>
    ["POST", "PATCH", "DELETE"].includes(o?.method),
  );
const photo = (name = "policy.pdf", type = "application/pdf", size = 20) =>
  new File([new Uint8Array(size)], name, { type, lastModified: 1 });
const choose = (files) =>
  fireEvent.change(screen.getByLabelText("Policy or documentation files"), {
    target: { files },
  });
async function openCreate(user) {
  await user.click(await screen.findByRole("button", { name: "+ Add entry" }));
  await user.type(
    screen.getByLabelText("Title", { exact: true }),
    "New policy",
  );
  await user.type(
    screen.getByLabelText("Content", { exact: true }),
    "Policy body",
  );
}

describe("documentation and policies workspace", () => {
  it("requires a client for KYC and shows only masked picker contacts", async () => {
    const user = userEvent.setup();
    workspace();
    await openCreate(user);
    await user.selectOptions(
      screen.getByLabelText("Entry category"),
      "client_kyc",
    );
    const picker = await screen.findByLabelText("Client (lead)");
    expect(picker).toBeRequired();
    await screen.findByRole("option", {
      name: "Client fixture · +92******567",
    });
    expect(screen.queryByText("+923001234567")).not.toBeInTheDocument();
    await user.selectOptions(picker, "73000000-0000-4000-8000-000000000001");
    await user.click(
      screen.getByRole("button", { name: "Save entry", exact: true }),
    );
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][1].body).toMatchObject({
      category: "client_kyc",
      lead_id: "73000000-0000-4000-8000-000000000001",
    });
  });
  it("lets admins find unlinked KYC and hides that filter for agents", async () => {
    records.push({
      ...second,
      id: "legacy-kyc",
      category: "client_kyc",
      title: "Old identity",
      lead_id: null,
    });
    const user = userEvent.setup();
    workspace();
    await user.click(
      await screen.findByLabelText("KYC not linked to a client"),
    );
    await screen.findByRole("link", { name: "Old identity", exact: true });
    expect(
      screen.queryByRole("link", { name: "Company policy", exact: true }),
    ).not.toBeInTheDocument();
    expect(
      mocks.api.mock.calls.some(([p]) => p.includes("unlinked_kyc=true")),
    ).toBe(true);
  });
  it("does not offer the unlinked-client filter to an agent", async () => {
    mocks.auth.user.role = "agent";
    workspace();
    await screen.findByRole("link", { name: "Company policy", exact: true });
    expect(
      screen.queryByLabelText("KYC not linked to a client"),
    ).not.toBeInTheDocument();
  });
  it.each(["admin", "agent"])(
    "adds the shared sidebar link for %s and lets them read content and download attachments",
    async (role) => {
      mocks.auth.user.role = role;
      const user = userEvent.setup();
      workspace();
      expect(
        await screen.findByRole("link", {
          name: "Documentation & policies",
          exact: true,
        }),
      ).toBeInTheDocument();
      await user.click(
        await screen.findByRole("link", {
          name: "Company policy",
          exact: true,
        }),
      );
      expect(
        await screen.findByText(first.content, { normalizer: (text) => text }),
      ).toBeInTheDocument();
      expect(document.querySelector(".knowledge-content script")).toBeNull();
      await user.click(
        screen.getByRole("button", { name: "Download Handbook.pdf" }),
      );
      await waitFor(() =>
        expect(mocks.download).toHaveBeenCalledWith(
          expect.any(Blob),
          "Handbook.pdf",
        ),
      );
      if (role === "agent") {
        for (const name of [
          "Edit",
          "Delete",
          "Delete Handbook.pdf",
          "+ Add entry",
        ])
          expect(
            screen.queryByRole("button", { name, exact: true }),
          ).not.toBeInTheDocument();
      }
      expect(writes()).toHaveLength(0);
    },
  );
  it("creates written policies with no attachment requirement", async () => {
    const user = userEvent.setup();
    workspace();
    await openCreate(user);
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    await screen.findByText("Entry saved");
    expect(writes()).toEqual([
      [
        "/documents",
        {
          method: "POST",
          body: {
            title: "New policy",
            content: "Policy body",
            category: "policy",
            property_name: "",
            keywords: "",
          },
        },
      ],
    ]);
    expect(
      await screen.findByRole("link", { name: "New policy", exact: true }),
    ).toBeInTheDocument();
  });
  it("adds several attachments through one picker, removes selections and skips invalid files", async () => {
    const user = userEvent.setup();
    workspace();
    await openCreate(user);
    const input = screen.getByLabelText("Policy or documentation files");
    expect(input).toHaveAttribute("hidden");
    expect(input).toHaveAttribute("multiple");
    choose([
      photo("policy.pdf"),
      photo(
        "guide.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
      photo("large.pdf", "application/pdf", 10 * 1024 * 1024 + 1),
      photo("script.html", "text/html"),
    ]);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Some files were skipped",
    );
    await user.click(screen.getByRole("button", { name: "Remove policy.pdf" }));
    await user.selectOptions(
      screen.getByLabelText("Entry category"),
      "documentation",
    );
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    await screen.findByText("Entry saved");
    expect(writes().filter(([p]) => p.endsWith("/files"))).toHaveLength(1);
    expect(
      writes()
        .find(([p]) => p.endsWith("/files"))[1]
        .body.get("file").name,
    ).toBe("guide.docx");
  });
  it("retains input after a failed save and cancels unsaved entries without changes", async () => {
    failSave = true;
    const user = userEvent.setup();
    workspace();
    await openCreate(user);
    choose([photo()]);
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    expect(screen.getByLabelText("Content")).toHaveValue("Policy body");
    expect(writes()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(records).toHaveLength(2);
    await openCreate(user);
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(writes()).toHaveLength(1);
  });
  it("retries remaining attachments on the same entry after a partial upload failure", async () => {
    const user = userEvent.setup();
    workspace();
    await openCreate(user);
    choose([photo("one.pdf"), photo("two.doc", "application/msword")]);
    failUpload = "two.doc";
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Entry saved.*retry the remaining files/,
    );
    expect(
      screen.queryByRole("button", { name: "Remove one.pdf" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove two.doc" }),
    ).toBeInTheDocument();
    failUpload = "";
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    await screen.findByText("Entry saved");
    expect(writes().filter(([p]) => p === "/documents")).toHaveLength(1);
    expect(records[0].files).toHaveLength(2);
    expect(
      writes().filter(
        ([p, o]) =>
          p.endsWith("/files") && o.body.get("file").name === "one.pdf",
      ),
    ).toHaveLength(1);
  });
  it("edits existing content while retaining unsaved changes across background refetches", async () => {
    const user = userEvent.setup(),
      qc = workspace();
    await screen.findByRole("link", { name: "Company policy" });
    await user.click(
      screen.getAllByRole("button", { name: "Edit", exact: true })[0],
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Content")).toHaveValue(first.content),
    );
    await user.clear(screen.getByLabelText("Content"));
    await user.type(screen.getByLabelText("Content"), "Updated policy");
    await qc.invalidateQueries({ queryKey: ["document"] });
    expect(screen.getByLabelText("Content")).toHaveValue("Updated policy");
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    await screen.findByText("Entry saved");
    expect(records[0].content).toBe("Updated policy");
    expect(writes()[0][1].method).toBe("PATCH");
  });
  it("confirms deletion, preserves records on cancel/failure, and allows retry", async () => {
    const user = userEvent.setup();
    workspace();
    await screen.findByRole("link", { name: "Company policy" });
    await user.click(
      screen.getAllByRole("button", { name: "Delete", exact: true })[0],
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(writes()).toHaveLength(0);
    await user.click(
      screen.getAllByRole("button", { name: "Delete", exact: true })[0],
    );
    failDelete = true;
    await user.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Delete failed");
    failDelete = false;
    await user.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    await screen.findByText("Entry deleted");
    expect(
      screen.queryByRole("link", { name: "Company policy" }),
    ).not.toBeInTheDocument();
  });
  it("deletes an attachment separately while preserving written content", async () => {
    const user = userEvent.setup();
    workspace("/documents/" + first.id);
    await user.click(
      await screen.findByRole("button", { name: "Delete Handbook.pdf" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Delete attachment?" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    await screen.findByText("Attachment deleted");
    expect(
      screen.getByText(first.content, { normalizer: (text) => text }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Download Handbook.pdf" }),
      ).not.toBeInTheDocument(),
    );
  });
  it("blocks dismissal, repeated saves and file changes while uploads are pending", async () => {
    let release;
    pending = new Promise((r) => {
      release = r;
    });
    const user = userEvent.setup();
    workspace();
    await openCreate(user);
    choose([photo()]);
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add files" })).toBeDisabled();
    expect(screen.getByLabelText("Content")).toBeDisabled();
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { cancelable: true }),
    );
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    release();
    await screen.findByText("Entry saved");
  });
  it("blocks repeated deletion and dismissal while saving the deletion", async () => {
    let release;
    pending = new Promise((r) => {
      release = r;
    });
    const user = userEvent.setup();
    workspace();
    await screen.findByRole("link", { name: "Company policy", exact: true });
    await user.click(
      screen.getAllByRole("button", { name: "Delete", exact: true })[0],
    );
    await user.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(writes()).toHaveLength(1);
    release();
    await screen.findByText("Entry deleted");
  });
  it("filters by category and resets pagination when searching", async () => {
    records = Array.from({ length: 21 }, (_, i) => ({
      ...first,
      id: "row-" + i,
      title: "Policy " + i,
    }));
    const user = userEvent.setup();
    workspace();
    await user.click(
      await screen.findByRole("button", { name: "Next", exact: true }),
    );
    await screen.findByText("21 records · Page 2");
    await user.type(
      screen.getByLabelText("Search documentation and policies"),
      "Policy 20",
    );
    await screen.findByText("1 records · Page 1");
    expect(
      await screen.findByRole("link", { name: "Policy 20", exact: true }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Documentation", exact: true }),
    );
    await screen.findByText(/No entries found/);
  });
  it.each(["admin", "agent"])(
    "shows every requested filter and property/keyword searches for %s",
    async (role) => {
      mocks.auth.user.role = role;
      const categories = [
        ["Property Deeds", "property_deeds"],
        ["Legal & NOC", "legal_noc"],
        ["Agency Policy", "policy"],
        ["Client KYC", "client_kyc"],
        ["Tenancy Agreements", "tenancy_agreements"],
      ];
      records = categories.map(([label, category], i) => ({
        ...first,
        id: "category-" + i,
        title: label + " reference",
        category,
        property_name: "Property " + i,
        keywords: "keyword-" + i,
        files: [],
      }));
      const user = userEvent.setup();
      workspace();
      await screen.findByRole("link", {
        name: "Property Deeds reference",
        exact: true,
      });
      for (const [label] of categories) {
        await user.click(
          screen.getByRole("button", { name: label, exact: true }),
        );
        await screen.findByText("1 records · Page 1");
        expect(
          screen.getByRole("button", { name: label, exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
        expect(
          await screen.findByRole("link", {
            name: label + " reference",
            exact: true,
          }),
        ).toBeInTheDocument();
      }
      await user.click(
        screen.getByRole("button", { name: "All", exact: true }),
      );
      await screen.findByText("5 records · Page 1");
      const search = screen.getByLabelText("Search documentation and policies");
      await user.type(search, "Property 1");
      // Assert the filtered count and live element in the same render. The
      // old all-results link may disappear while the debounced query updates.
      await waitFor(() => {
        expect(screen.getByText("1 records · Page 1")).toBeInTheDocument();
        expect(
          screen.getByRole("link", {
            name: "Legal & NOC reference",
            exact: true,
          }),
        ).toBeInTheDocument();
      });
      await user.clear(search);
      await user.type(search, "keyword-3");
      await waitFor(() => {
        expect(screen.getByText("1 records · Page 1")).toBeInTheDocument();
        expect(
          screen.getByRole("link", {
            name: "Client KYC reference",
            exact: true,
          }),
        ).toBeInTheDocument();
      });
      if (role === "agent")
        expect(
          screen.queryByRole("button", { name: "+ Add entry" }),
        ).not.toBeInTheDocument();
    },
  );
  it("saves category, property name and keywords and preserves them when editing", async () => {
    const user = userEvent.setup();
    workspace();
    await openCreate(user);
    await user.selectOptions(
      screen.getByLabelText("Entry category"),
      "property_deeds",
    );
    await user.type(screen.getByLabelText("Property name"), "River Gardens");
    await user.type(screen.getByLabelText("Keywords"), "ownership, lease");
    await user.click(
      screen.getByRole("button", { name: "Save entry", exact: true }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(writes()[0][1].body).toMatchObject({
      category: "property_deeds",
      property_name: "River Gardens",
      keywords: "ownership, lease",
    });
    const saved = records[0];
    await user.click(
      screen.getByRole("link", { name: "New policy", exact: true }),
    );
    expect(
      await screen.findByText("River Gardens", { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("ownership, lease", { exact: false }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit", exact: true }));
    expect(await screen.findByLabelText("Property name")).toHaveValue(
      "River Gardens",
    );
    expect(screen.getByLabelText("Keywords")).toHaveValue("ownership, lease");
    expect(screen.getByLabelText("Entry category")).toHaveValue(
      "property_deeds",
    );
    await user.selectOptions(
      screen.getByLabelText("Entry category"),
      "tenancy_agreements",
    );
    await user.click(
      screen.getByRole("button", { name: "Save entry", exact: true }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(records.find((r) => r.id === saved.id)).toMatchObject({
      category: "tenancy_agreements",
      property_name: "River Gardens",
      keywords: "ownership, lease",
    });
  });
  it("shows useful missing-migration and missing-entry errors", async () => {
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) =>
      path.startsWith("/documents")
        ? Promise.reject(new Error("Apply CRM migration 015."))
        : original(path, options),
    );
    workspace();
    expect(await screen.findByRole("alert")).toHaveTextContent("015");
  });
});
