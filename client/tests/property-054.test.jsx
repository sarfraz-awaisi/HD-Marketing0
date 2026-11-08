import React from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PropertyForm from "../src/components/properties/PropertyForm";
import PropertyDocuments from "../src/components/properties/PropertyDocuments";
import PropertyCard from "../src/components/properties/PropertyCard";
import PropertyDetails from "../src/components/properties/PropertyDetails";
import { ToastProvider } from "../src/components/common/UI";
import {
  priceForEditing,
  priceFrom,
  pricePK,
  propertyPrice,
  splitPrice,
} from "../src/lib/price";
import { floorLabel } from "../src/lib/inventory";
import { shareText } from "../src/lib/propertyDocuments";
// Update 054: price units, floors and property documents. API responses are
// mocked; the server tests check the same rules against the database.
const mocks = vi.hoisted(() => ({ api: vi.fn(), download: vi.fn() }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
  download: mocks.download,
}));
const originalDialog = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
});
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
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete navigator.share;
  delete navigator.canShare;
});

describe("prices as said in Pakistan", () => {
  it("converts Crore, Lakh, Thousand and PKR exactly", () => {
    for (const [amount, unit, value] of [
      ["2.3", "crore", 23000000],
      ["1.5", "crore", 15000000],
      ["75", "lakh", 7500000],
      ["85,000", "pkr", 85000],
      ["45", "thousand", 45000],
      ["1,50,000", "pkr", 150000],
      ["12,34,56,789", "pkr", 123456789],
      ["2.3456789", "crore", 23456789],
      ["0", "pkr", 0],
      // A unit typed with the amount wins over the list.
      ["2.3 cr", "pkr", 23000000],
      ["1.5 Crore", "pkr", 15000000],
      ["75 lac", "pkr", 7500000],
      ["75 Lakh", "crore", 7500000],
      ["45K", "pkr", 45000],
      ["Rs. 85,000", "lakh", 85000],
    ])
      expect(priceFrom(amount, unit), amount).toEqual({ value });
  });
  it("refuses negative, ambiguous, malformed and overflowing prices", () => {
    for (const [amount, unit, error] of [
      ["", "pkr", "Enter the price"],
      ["-5", "lakh", "A price cannot be negative"],
      [
        "2 crore 50 lakh",
        "pkr",
        "Enter one amount and unit, for example 2.5 Crore",
      ],
      ["5 marla", "pkr", "Enter one amount and unit, for example 2.5 Crore"],
      ["1,5", "crore", "Check the commas, for example 1,50,000 or 150,000"],
      ["1.2.3", "lakh", "Enter the amount as a number, for example 2.3"],
      ["2.34567891", "crore", "Use at most 7 decimal places for Crore"],
      ["85000.123", "pkr", "Use at most 2 decimal places for PKR"],
      ["1000001", "crore", "Enter a price up to PKR 1,000,000 Crore"],
    ])
      expect(priceFrom(amount, unit), amount).toEqual({ error });
    expect(splitPrice("2 crore 50 lakh")).toBeNull();
  });
  it("shows saved prices readably and opens them in a fitting unit", () => {
    expect(pricePK(23000000)).toBe("PKR 2.3 Crore");
    expect(pricePK(15000000)).toBe("PKR 1.5 Crore");
    expect(pricePK(7500000)).toBe("PKR 75 Lakh");
    expect(pricePK(85000)).toBe("PKR 85,000");
    expect(pricePK(9999999)).toBe("PKR 1 Crore");
    expect(propertyPrice({ price: 45000, purpose: "rent" })).toBe(
      "PKR 45,000/month",
    );
    expect(priceForEditing(23000000)).toEqual({ amount: "2.3", unit: "crore" });
    expect(priceForEditing(7500000)).toEqual({ amount: "75", unit: "lakh" });
    expect(priceForEditing(23456789)).toEqual({
      amount: "23456789",
      unit: "pkr",
    });
    expect(priceForEditing(85000)).toEqual({ amount: "85000", unit: "pkr" });
    expect(priceForEditing(null)).toEqual({ amount: "", unit: "pkr" });
  });
});

describe("the property form", () => {
  const fill = async (user, { type = "Apartment", purpose = "rent" } = {}) => {
    await user.type(screen.getByLabelText("Property title"), "Sea view flat");
    await user.selectOptions(screen.getByLabelText("Property type"), type);
    await user.selectOptions(screen.getByLabelText("Purpose"), purpose);
    await user.type(screen.getByLabelText("City"), "Karachi");
    await user.type(screen.getByLabelText("Size"), "1100");
  };
  const renderForm = (initial, onSave = vi.fn()) => {
    render(
      <PropertyForm initial={initial} ownership="agent" onSave={onSave} />,
    );
    return onSave;
  };
  it("converts the amount and unit to PKR, with a preview, for sale and rent", async () => {
    const user = userEvent.setup();
    const onSave = renderForm();
    await fill(user, { type: "House", purpose: "sale" });
    await user.type(screen.getByLabelText("Price"), "2.3");
    await user.selectOptions(screen.getByLabelText("Price unit"), "crore");
    expect(screen.getByRole("status")).toHaveTextContent(
      "= PKR 23,000,000 · 2.3 Crore",
    );
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      price: 23000000,
      purpose: "sale",
    });
    // Rent is clearly per month; "45K" typed in full moves the unit.
    await user.selectOptions(screen.getByLabelText("Purpose"), "rent");
    const rent = screen.getByLabelText("Monthly rent");
    await user.clear(rent);
    await user.type(rent, "45K");
    await user.tab();
    expect(rent).toHaveValue("45");
    expect(screen.getByLabelText("Price unit")).toHaveValue("thousand");
    expect(screen.getByRole("status")).toHaveTextContent(
      "= PKR 45,000 per month",
    );
  });
  it("explains a price it cannot use", async () => {
    const user = userEvent.setup();
    const onSave = renderForm();
    await fill(user);
    await user.type(screen.getByLabelText("Monthly rent"), "-5");
    await user.click(screen.getByRole("button", { name: "Save record" }));
    expect(
      await screen.findByText("A price cannot be negative"),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
  it("records any floor for floor-based types, checked against the total floors", async () => {
    const user = userEvent.setup();
    const onSave = renderForm();
    await fill(user);
    await user.type(screen.getByLabelText("Monthly rent"), "45000");
    expect(screen.getByLabelText("Total building floors")).toBeInTheDocument();
    const floor = screen.getByLabelText("Floor");
    expect(
      within(floor)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Not specified",
      "Basement",
      "Lower ground",
      "Ground floor",
      "Upper floor (enter the number)",
    ]);
    await user.selectOptions(floor, "upper");
    await user.type(screen.getByLabelText("Floor number"), "25");
    await user.type(screen.getByLabelText("Total building floors"), "20");
    await user.click(screen.getByRole("button", { name: "Save record" }));
    expect(
      await screen.findByText(
        "The floor cannot be above the building's 20 floors",
      ),
    ).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Total building floors"));
    await user.type(screen.getByLabelText("Total building floors"), "60");
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      floor_level: 25,
      floors: 60,
    });
    // Basement, lower ground and ground need no number.
    await user.selectOptions(floor, "-2");
    expect(screen.queryByLabelText("Floor number")).toBeNull();
    // Plots and land have no floor.
    await user.selectOptions(
      screen.getByLabelText("Property type"),
      "Residential Plot",
    );
    expect(screen.queryByLabelText("Floor")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Property type"), "House");
    expect(screen.queryByLabelText("Floor")).toBeNull();
    expect(screen.getByLabelText("Floors")).toBeInTheDocument();
  });
  it("asks before a new type removes a saved floor", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onSave = renderForm({
      id: "p1",
      title: "Flat",
      type: "Apartment",
      purpose: "rent",
      availability: "available",
      city: "Karachi",
      area: 1100,
      area_unit: "sq ft",
      price: 45000,
      floor_level: 7,
      floors: 20,
      updated_at: "2026-11-08T10:00:00Z",
    });
    expect(screen.getByLabelText("Floor number")).toHaveValue(7);
    expect(screen.getByLabelText("Monthly rent")).toHaveValue("45000");
    await user.selectOptions(screen.getByLabelText("Property type"), "House");
    expect(
      screen.getByText("Saving as House removes the floor (7th floor)."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      type: "House",
      floor_level: null,
    });
    confirm.mockRestore();
  });
  it("collects PDFs to upload with the property", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const onSave = renderForm();
    await fill(user);
    await user.type(screen.getByLabelText("Monthly rent"), "45000");
    await user.upload(screen.getByLabelText("Property documents"), [
      new File(["%PDF-1.7"], "Brochure.pdf", { type: "application/pdf" }),
      new File(["x"], "photo.png", { type: "image/png" }),
    ]);
    expect(
      screen.getByText(
        "Some files were skipped. Choose PDF files up to 20 MB each.",
      ),
    ).toBeInTheDocument();
    const list = screen.getByRole("list", {
      name: "Documents ready to upload",
    });
    expect(within(list).getByText("Brochure.pdf")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][3].map((d) => d.file.name)).toEqual([
      "Brochure.pdf",
    ]);
  });
});

describe("property cards and details", () => {
  const flat = {
    id: "p1",
    title: "Sea view flat",
    type: "Apartment",
    purpose: "rent",
    price: 45000,
    area: 1100,
    area_unit: "sq ft",
    availability: "available",
    location: "Clifton, Karachi",
    floor_level: 7,
    floors: 20,
    amenities: [],
    cover_photo: null,
  };
  it("shows the price readably and the floor", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PropertyCard property={flat} onView={() => {}} />
        <PropertyDetails
          property={{ ...flat, price: 23456789, purpose: "sale" }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("PKR 45,000")).toBeInTheDocument();
    expect(screen.getByText("/month")).toBeInTheDocument();
    expect(
      screen.getByText(/1,100 Square feet · Apartment · For rent · 7th floor/),
    ).toBeInTheDocument();
    expect(screen.getByText("PKR 2.35 Crore")).toBeInTheDocument();
    expect(screen.getByText("PKR 23,456,789")).toBeInTheDocument();
    expect(screen.getByText("Total building floors")).toBeInTheDocument();
    expect(floorLabel(-1)).toBe("Lower ground");
    expect([1, 2, 3, 11, 12, 13, 21, 22, 23, 101].map(floorLabel)).toEqual([
      "1st floor",
      "2nd floor",
      "3rd floor",
      "11th floor",
      "12th floor",
      "13th floor",
      "21st floor",
      "22nd floor",
      "23rd floor",
      "101st floor",
    ]);
  });
});

describe("property documents", () => {
  const property = {
    id: "p1",
    title: "Sea view flat",
    type: "Apartment",
    purpose: "rent",
    price: 45000,
    location: "Clifton, Karachi",
    floor_level: 7,
  };
  const docs = [
    {
      id: "d1",
      file_name: "DHA Phase 6 Brochure.pdf",
      size_bytes: 2516582,
      created_at: "2026-11-08T10:00:00Z",
      uploaded_by_name: "Ali Agent",
    },
  ];
  const pdf = new Blob(["%PDF-1.7"], { type: "application/pdf" });
  const show = (canManage) => {
    mocks.api.mockImplementation(async (path, options) => {
      if (path === "/properties/p1/documents" && !options?.method) return docs;
      if (path.endsWith("/file")) return pdf;
      return null;
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <PropertyDocuments property={property} canManage={canManage} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  };
  it("lists documents with View, Download and WhatsApp, read-only without access", async () => {
    show(false);
    expect(
      await screen.findByText("DHA Phase 6 Brochure.pdf"),
    ).toBeInTheDocument();
    expect(screen.getByText(/2\.4 MB/)).toBeInTheDocument();
    for (const name of ["View", "Download", "Share"])
      expect(
        screen.getByRole("button", { name: new RegExp(`^${name} DHA`) }),
      ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add PDFs/ })).toBeNull();
  });
  it("opens the PDF in a new tab and downloads it through the API", async () => {
    const user = userEvent.setup();
    const tab = { closed: false, location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab);
    URL.createObjectURL = vi.fn(() => "blob:pdf");
    URL.revokeObjectURL = vi.fn();
    show(true);
    await user.click(
      await screen.findByRole("button", {
        name: "View DHA Phase 6 Brochure.pdf",
      }),
    );
    await waitFor(() => expect(tab.location.href).toBe("blob:pdf"));
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    expect(mocks.api).toHaveBeenCalledWith("/properties/p1/documents/d1/file", {
      download: true,
    });
    await user.click(
      screen.getByRole("button", { name: "Download DHA Phase 6 Brochure.pdf" }),
    );
    await waitFor(() =>
      expect(mocks.download).toHaveBeenCalledWith(
        expect.any(Blob),
        "DHA Phase 6 Brochure.pdf",
      ),
    );
  });
  it("shares the PDF itself where the device can, and says so when it cannot", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "open").mockReturnValue(null);
    show(true);
    // Desktop: WhatsApp opens with the details and the PDF downloads; nothing
    // claims it was attached.
    await user.click(
      await screen.findByRole("button", {
        name: "Share DHA Phase 6 Brochure.pdf on WhatsApp",
      }),
    );
    expect(window.open).toHaveBeenCalledWith(
      `https://wa.me/?text=${encodeURIComponent(shareText(property))}`,
      "_blank",
      "noopener,noreferrer",
    );
    expect(
      await screen.findByText(
        /browsers cannot attach files to WhatsApp automatically/,
      ),
    ).toBeInTheDocument();
    expect(mocks.download).toHaveBeenCalled();
    expect(shareText(property)).toBe(
      "Sea view flat\nApartment, 7th floor, for rent\nClifton, Karachi\nPKR 45,000/month",
    );
    // A phone: the share sheet receives the file.
    navigator.canShare = vi.fn(() => true);
    navigator.share = vi.fn(async () => {});
    await user.click(
      screen.getByRole("button", {
        name: "Share DHA Phase 6 Brochure.pdf on WhatsApp",
      }),
    );
    await waitFor(() => expect(navigator.share).toHaveBeenCalled());
    const shared = navigator.share.mock.calls[0][0];
    expect(shared.files[0]).toBeInstanceOf(File);
    expect(shared.files[0].name).toBe("DHA Phase 6 Brochure.pdf");
    expect(shared.files[0].type).toBe("application/pdf");
  });
  it("asks before removing a document", async () => {
    const user = userEvent.setup();
    show(true);
    await user.click(
      await screen.findByRole("button", {
        name: "Remove DHA Phase 6 Brochure.pdf",
      }),
    );
    const confirm = screen.getByRole("group", {
      name: "Remove DHA Phase 6 Brochure.pdf?",
    });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(mocks.api).not.toHaveBeenCalledWith(
      "/properties/p1/documents/d1",
      expect.anything(),
    );
    await user.click(
      screen.getByRole("button", { name: "Remove DHA Phase 6 Brochure.pdf" }),
    );
    await user.click(
      within(screen.getByRole("group", { name: /^Remove/ })).getByRole(
        "button",
        { name: "Remove" },
      ),
    );
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith("/properties/p1/documents/d1", {
        method: "DELETE",
      }),
    );
    expect(await screen.findByText("Document removed")).toBeInTheDocument();
  });
});
