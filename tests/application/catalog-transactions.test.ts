import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error("missing local catalog")),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import { rename, writeFile } from "node:fs/promises";
import { type CatalogWrite } from "../../src/application/contracts";
import { DEMO_STORE_ID } from "../../src/domain/demo-catalog";
import {
  DemoRepository,
  demoStaff,
} from "../../src/infrastructure/demo-repository";

const draft = (sku: string): CatalogWrite => ({
  sku,
  brand: "SENMIVA LAB",
  name: `Test ${sku}`,
  category: "serum",
  priceMinor: 2500,
  currency: "USD",
  stock: 10,
  visible: false,
  ingredients: ["Aqua", "Glycerin"],
  formulaComplete: true,
  suitableSkinTypes: ["dry"],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("atomic demo catalog snapshot writes", () => {
  it("starts manually entered drafts hidden even when the write requests visibility", async () => {
    const repository = new DemoRepository(false);
    await repository.saveDraft(DEMO_STORE_ID, {
      ...draft("HIDDEN-MANUAL"),
      visible: true,
    });
    for (const store of demoStaff.stores) {
      expect(
        (await repository.products(store.id)).find(
          (row) => row.sku === "HIDDEN-MANUAL",
        ),
      ).toMatchObject({ status: "draft", visible: false });
    }
  });

  it("starts all imported drafts hidden and publication preserves that choice", async () => {
    const repository = new DemoRepository(false);
    await repository.importDrafts(DEMO_STORE_ID, [
      { ...draft("HIDDEN-IMPORT-A"), visible: true },
      { ...draft("HIDDEN-IMPORT-B"), visible: true },
    ]);
    const imported = (await repository.products(DEMO_STORE_ID)).filter((row) =>
      row.sku.startsWith("HIDDEN-IMPORT-"),
    );
    expect(imported).toHaveLength(2);
    expect(imported.every((row) => !row.visible)).toBe(true);
    await repository.publish(imported[0].id);
    expect(
      (await repository.products(DEMO_STORE_ID)).find(
        (row) => row.id === imported[0].id,
      ),
    ).toMatchObject({ status: "published", visible: false });
  });

  it("preserves each existing store's visibility while editing a formulation", async () => {
    const repository = new DemoRepository(false);
    const existing = (await repository.products(DEMO_STORE_ID))[0];
    const otherStore = demoStaff.stores.find(
      (store) => store.id !== DEMO_STORE_ID,
    )!;
    await repository.updateListing(DEMO_STORE_ID, existing.id, {
      priceMinor: existing.priceMinor,
      stock: 5,
      visible: true,
    });
    await repository.updateListing(otherStore.id, existing.id, {
      priceMinor: existing.priceMinor,
      stock: 5,
      visible: false,
    });
    await repository.saveDraft(DEMO_STORE_ID, {
      ...existing,
      ingredients: ["Aqua", "Glycerin"],
      visible: false,
    });
    expect(
      (await repository.products(DEMO_STORE_ID)).find(
        (row) => row.id === existing.id,
      ),
    ).toMatchObject({ status: "draft", visible: true });
    expect(
      (await repository.products(otherStore.id)).find(
        (row) => row.id === existing.id,
      ),
    ).toMatchObject({ status: "draft", visible: false });
  });

  it.each([
    { sku: "CHANGED-SKU" },
    { brand: "Changed brand" },
    { name: "Changed name" },
    { category: "cleanser" as const },
  ])("rejects existing product identity changes: %j", async (changed) => {
    const repository = new DemoRepository(false);
    const before = await repository.products(DEMO_STORE_ID);
    const existing = before.find((row) => row.category === "serum")!;
    await expect(
      repository.saveDraft(DEMO_STORE_ID, { ...existing, ...changed }),
    ).rejects.toMatchObject({ code: "immutable_identity" });
    expect(await repository.products(DEMO_STORE_ID)).toEqual(before);
  });

  it("rejects unknown target IDs instead of creating or replacing a product", async () => {
    const repository = new DemoRepository(false);
    const before = await repository.products(DEMO_STORE_ID);
    await expect(
      repository.saveDraft(DEMO_STORE_ID, {
        ...draft("UNKNOWN-ID"),
        id: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await repository.products(DEMO_STORE_ID)).toEqual(before);
  });

  it("rejects conflicting CSV identity for an existing SKU without importing preceding rows", async () => {
    const repository = new DemoRepository(false);
    const before = await repository.products(DEMO_STORE_ID);
    const existing = before[0];
    await expect(
      repository.importDrafts(DEMO_STORE_ID, [
        draft("PRECEDING-VALID"),
        { ...draft(existing.sku), name: "Changed name" },
      ]),
    ).rejects.toMatchObject({ code: "immutable_identity" });
    expect(await repository.products(DEMO_STORE_ID)).toEqual(before);
  });

  it("persists an entire import in one write and one atomic rename", async () => {
    const repository = new DemoRepository(
      true,
      () => Date.now(),
      "isolated-catalog.json",
    );
    await repository.importDrafts(DEMO_STORE_ID, [
      draft("IMPORT-A"),
      draft("IMPORT-B"),
    ]);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(1);
    const rows = await repository.products(DEMO_STORE_ID);
    expect(
      rows
        .filter((row) => row.sku.startsWith("IMPORT-"))
        .map((row) => row.status),
    ).toEqual(["draft", "draft"]);
    expect(
      JSON.parse(String(vi.mocked(writeFile).mock.calls[0][1])).filter(
        (row: { sku: string }) => row.sku.startsWith("IMPORT-"),
      ).length,
    ).toBe(4);
  });

  it("commits neither valid preceding rows nor a file when a later draft is invalid", async () => {
    const repository = new DemoRepository(true);
    const before = await repository.products(DEMO_STORE_ID);
    await expect(
      repository.importDrafts(DEMO_STORE_ID, [
        draft("IMPORT-A"),
        { ...draft("IMPORT-B"), stock: -1 },
      ]),
    ).rejects.toMatchObject({ code: "invalid_draft" });
    expect(await repository.products(DEMO_STORE_ID)).toEqual(before);
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it("leaves memory unchanged on persistence failure and can recover on the next mutation", async () => {
    const repository = new DemoRepository(true);
    const before = await repository.products(DEMO_STORE_ID);
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("disk full"));
    await expect(
      repository.importDrafts(DEMO_STORE_ID, [draft("IMPORT-A")]),
    ).rejects.toThrow("disk full");
    expect(await repository.products(DEMO_STORE_ID)).toEqual(before);
    await repository.importDrafts(DEMO_STORE_ID, [draft("IMPORT-B")]);
    expect(
      (await repository.products(DEMO_STORE_ID)).some(
        (row) => row.sku === "IMPORT-B",
      ),
    ).toBe(true);
    expect(
      (await repository.products(DEMO_STORE_ID)).some(
        (row) => row.sku === "IMPORT-A",
      ),
    ).toBe(false);
  });

  it("serializes concurrent catalog mutations without losing either product", async () => {
    const repository = new DemoRepository(false);
    await Promise.all([
      repository.saveDraft(DEMO_STORE_ID, draft("CONCURRENT-A")),
      repository.saveDraft(DEMO_STORE_ID, draft("CONCURRENT-B")),
    ]);
    expect(
      (await repository.products(DEMO_STORE_ID))
        .filter((row) => row.sku.startsWith("CONCURRENT-"))
        .map((row) => row.sku),
    ).toEqual(["CONCURRENT-A", "CONCURRENT-B"]);
  });

  it("rejects duplicate import SKUs and keeps unpublished drafts unavailable", async () => {
    const repository = new DemoRepository(false);
    await expect(
      repository.importDrafts(DEMO_STORE_ID, [
        draft("DUPLICATE"),
        draft("duplicate"),
      ]),
    ).rejects.toMatchObject({ code: "duplicate_sku" });
    await repository.saveDraft(DEMO_STORE_ID, draft("DRAFT-ONLY"));
    const row = (await repository.products(DEMO_STORE_ID)).find(
      (product) => product.sku === "DRAFT-ONLY",
    )!;
    await expect(
      repository.updateListing(DEMO_STORE_ID, row.id, {
        stock: 1,
        priceMinor: 2500,
        visible: true,
      }),
    ).rejects.toMatchObject({ code: "publication_required" });
    await repository.publish(row.id);
    await repository.updateListing(DEMO_STORE_ID, row.id, {
      stock: 1,
      priceMinor: 2500,
      visible: true,
    });
    expect(
      (await repository.products(DEMO_STORE_ID)).find(
        (product) => product.id === row.id,
      ),
    ).toMatchObject({ status: "published", visible: true });
  });
});
