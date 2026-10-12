import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { heartleafReport, expectedNames } from "../fixtures/ingredient-report";

test("pasted ingredient reports require review and a blank SKU receives an internal code", async ({
  page,
}, testInfo) => {
  let writes = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/v1/management/products" &&
      request.method() === "POST"
    )
      writes++;
  });
  await page.goto("/management/catalog");
  await page.getByRole("button", { name: "Add product" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a product" });
  await dialog
    .getByLabel("Product name", { exact: true })
    .fill("Reviewed report draft");
  await dialog.getByLabel("Brand", { exact: true }).fill("Demo maker");
  await dialog.getByLabel("Store price (USD)").fill("28.00");
  await dialog.getByLabel("Stock units").fill("5");
  await dialog.getByLabel("Full INCI ingredient list").fill(heartleafReport);
  await expect(
    dialog.getByRole("heading", { name: "Review extracted ingredients" }),
  ).toBeVisible();
  const preview = dialog.getByRole("list", {
    name: "Extracted ingredient names",
  });
  await expect(preview.getByRole("listitem")).toHaveText(expectedNames);
  await expect(preview.getByRole("listitem")).toHaveCount(38);
  await expect(dialog.getByLabel("Full formula verified")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(dialog.locator("#product-ingredients-error")).toContainText(
    "Use extracted ingredients before saving",
  );
  await expect(dialog.getByLabel("Full INCI ingredient list")).toHaveValue(
    heartleafReport,
  );
  expect(writes).toBe(0);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await dialog
    .getByRole("heading", { name: "Review extracted ingredients" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("ingredient-report-review-1024.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Use extracted ingredients" })
    .click();
  await expect(dialog.getByLabel("Full INCI ingredient list")).toHaveValue(
    expectedNames.join("; "),
  );
  await expect(dialog.getByLabel("Full formula verified")).not.toBeChecked();
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/management/products" &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Save draft", exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({
    sku: "",
    ingredients: expectedNames,
    formulaComplete: false,
    visible: false,
  });
  await expect(dialog).toHaveCount(0);
  const catalog = await (
    await page.request.get("/api/v1/management/catalog")
  ).json();
  const product = catalog.products.find(
    (product: { name: string }) => product.name === "Reviewed report draft",
  );
  expect(product).toMatchObject({
    ingredients: expectedNames,
    formulaComplete: false,
    status: "draft",
    visible: false,
  });
  expect(product.sku).toMatch(/^SMV-[a-f0-9]{32}$/);
  expect(writes).toBe(1);
});

test("manual drafts accept a one-character SKU and the shared catalog text limits", async ({
  page,
}) => {
  const name = "Manual draft " + "n".repeat(128);
  const brand = "Demo brand " + "b".repeat(90);
  const unresolved = "Unresolved ingredient " + "x".repeat(85);
  await page.goto("/management/catalog");
  await page.getByRole("button", { name: "Add product" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a product" });
  await dialog
    .getByLabel("Product name", { exact: true })
    .fill("  " + name + "  ");
  await dialog.getByLabel("Brand", { exact: true }).fill("  " + brand + "  ");
  await dialog.getByLabel("SKU", { exact: true }).fill("1");
  await dialog.getByLabel("Store price (USD)").fill("250000.50");
  await dialog.getByLabel("Stock units").fill("7");
  await dialog
    .getByLabel("Full INCI ingredient list")
    .fill("Aqua;\n1,2-Hexanediol, " + unresolved);
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/management/products" &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Save draft", exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({
    name,
    brand,
    sku: "1",
    priceMinor: 25000050,
    stock: 7,
    ingredients: ["Aqua", "1,2-Hexanediol", unresolved],
    formulaComplete: false,
    visible: false,
  });
  await expect(dialog).toHaveCount(0);
  const product = page.getByRole("row").filter({ hasText: name });
  await expect(product.getByText("draft", { exact: true })).toBeVisible();
  await expect(product.getByText("Hidden", { exact: true })).toBeVisible();
  await product
    .getByRole("button", { name: "Store listing", exact: true })
    .click();
  const listing = page.getByRole("dialog", { name: "Store listing" });
  await expect(listing.getByLabel("Store price (USD)")).toHaveValue("250000.5");
  await listing.getByLabel("Stock units").fill("8");
  await listing
    .getByRole("button", { name: "Save listing", exact: true })
    .click();
  await expect(listing).toHaveCount(0);
  await expect(product.getByText("$250,000.50", { exact: true })).toBeVisible();
  await expect(
    product.getByRole("cell", { name: "8", exact: true }),
  ).toBeVisible();
});

test("manual product validation keeps values, focuses invalid fields and shows server feedback", async ({
  page,
}, testInfo) => {
  let requests = 0;
  await page.route("**/api/v1/management/products?*", (route) => {
    requests++;
    return route.fulfill({
      status: 422,
      json: {
        error: {
          code: "invalid_product",
          message: "Correct the highlighted product fields and try again.",
          fields: { ingredients: "Review this ingredient name before saving." },
        },
      },
    });
  });
  await page.goto("/management/catalog");
  await page.getByRole("button", { name: "Add product" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a product" });
  await dialog
    .getByLabel("Product name", { exact: true })
    .fill("Manual validation serum");
  await dialog.getByLabel("Brand", { exact: true }).fill("Demo maker");
  await dialog.getByLabel("SKU", { exact: true }).fill("bad sku");
  await dialog.getByLabel("Store price (USD)").fill("19.99");
  await dialog.getByLabel("Stock units").fill("7");
  await dialog.getByLabel("Full INCI ingredient list").fill("Aqua; Glycerin");
  await dialog.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(dialog.getByLabel("SKU", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(dialog.getByLabel("SKU", { exact: true })).toBeFocused();
  await expect(dialog.locator("#product-sku-error")).toContainText(
    "SKU may contain",
  );
  expect(requests).toBe(0);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await dialog.getByLabel("SKU", { exact: true }).fill("VALID-DRAFT");
  // Two synchronous submissions must produce one request before busy renders.
  await dialog.locator("form").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(dialog.locator("#product-ingredients-error")).toHaveText(
    "Review this ingredient name before saving.",
  );
  await expect(dialog.getByLabel("Full INCI ingredient list")).toBeFocused();
  await expect(dialog.getByLabel("Full INCI ingredient list")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(requests).toBe(1);
  await expect(dialog.getByLabel("Product name", { exact: true })).toHaveValue(
    "Manual validation serum",
  );
  await expect(dialog.getByLabel("Brand", { exact: true })).toHaveValue(
    "Demo maker",
  );
  await expect(dialog.getByLabel("SKU", { exact: true })).toHaveValue(
    "VALID-DRAFT",
  );
  await expect(dialog.getByLabel("Store price (USD)")).toHaveValue("19.99");
  await expect(dialog.getByLabel("Stock units")).toHaveValue("7");
  await expect(dialog.getByLabel("Full INCI ingredient list")).toHaveValue(
    "Aqua; Glycerin",
  );
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("product-field-errors-1024.png"),
    fullPage: true,
  });
});

const header = "sku,brand,name,category,price,stock,ingredients,skin_types";
const rows = [
  "E2E-CSV-01,SENMIVA LAB,E2E Dewdrop Serum,serum,24.50,12,Aqua;Glycerin,dry",
  "E2E-CSV-02,SENMIVA LAB,E2E Calm Cream,moisturizer,30.00,10,Aqua;Squalane;Ceramide NP,dry;normal",
];

test("CSV review blocks bad rows, imports drafts, publishes and isolates store listings", async ({
  page,
}) => {
  await page.goto("/management/catalog");
  await expect(
    page.getByRole("heading", { name: "Product catalog." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Import CSV" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Import your product shelf",
  });
  await dialog.getByLabel("Choose product CSV").setInputFiles({
    name: "invalid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      [header, rows[0], rows[1].replace("30.00", "30.001")].join("\n"),
    ),
  });
  await dialog.getByRole("button", { name: "Preview import" }).click();
  await expect(dialog.getByText(/Row 3 · price:/)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Import \d+ drafts/ }),
  ).toHaveCount(0);
  await dialog.getByLabel("Choose product CSV").setInputFiles({
    name: "valid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([header, ...rows].join("\n")),
  });
  await dialog.getByRole("button", { name: "Preview import" }).click();
  await expect(
    dialog.getByText("2 products ready to import as drafts."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Import 2 drafts" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(
    "2 products imported as drafts",
  );
  await page.getByRole("textbox", { name: "Search products" }).fill("E2E-CSV-");
  const product = page.getByRole("row").filter({ hasText: "E2E-CSV-01" });
  await expect(product.getByText("draft", { exact: true })).toBeVisible();
  await expect(product.getByText("Hidden", { exact: true })).toBeVisible();
  await product.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(product.getByText("published", { exact: true })).toBeVisible();
  await expect(product.getByText("Hidden", { exact: true })).toBeVisible();
  await product
    .getByRole("button", { name: "Store listing", exact: true })
    .click();
  const listing = page.getByRole("dialog", { name: "Store listing" });
  await listing.getByLabel("Store price (USD)").fill("17.25");
  await listing.getByLabel("Stock units").fill("0");
  await listing.getByLabel("Visible in this store").check();
  await listing.getByRole("button", { name: "Save listing" }).click();
  await expect(listing).toHaveCount(0);
  await expect(product.getByText("$17.25", { exact: true })).toBeVisible();
  await expect(
    product.getByRole("cell", { name: "0", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Current store")
    .selectOption({ label: "Brooklyn Studio" });
  await expect(product.getByText("$24.50", { exact: true })).toBeVisible();
  await expect(product.getByText("Hidden", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByLabel("Current store")).toHaveValue(
    "22222222-2222-4222-8222-222222222223",
  );
  await page
    .getByRole("link", { name: "Product catalog", exact: true })
    .click();
  await expect(page.getByLabel("Current store")).toHaveValue(
    "22222222-2222-4222-8222-222222222223",
  );
  await page.getByRole("textbox", { name: "Search products" }).fill("E2E-CSV-");
  await page.getByLabel("Current store").selectOption({ label: "Soho Studio" });
  await expect(product.getByText("$17.25", { exact: true })).toBeVisible();
  // Existing product editing must submit an explicit CatalogWrite DTO, without tenant/read-model fields.
  await product.getByRole("button", { name: "Edit details" }).click();
  const editor = page.getByRole("dialog", { name: "Edit product details" });
  for (const label of [
    "Product name",
    "Brand",
    "SKU",
    "Store price (USD)",
    "Stock units",
  ])
    await expect(editor.getByLabel(label, { exact: true })).toBeDisabled();
  await expect(
    editor.getByRole("combobox", { name: "Category", exact: true }),
  ).toBeDisabled();
  await editor
    .getByLabel("Full INCI ingredient list")
    .fill("Aqua, Glycerin, Panthenol");
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(editor).toHaveCount(0);
  await expect(product.getByText("draft", { exact: true })).toBeVisible();
});

test("desktop management and product dialog are accessible with keyboard focus restoration", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/management/catalog");
  await expect(
    page.getByRole("textbox", { name: "Search products" }),
  ).toBeVisible();
  await expect(page.getByText("Loading your shelf…")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  let accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    accessibility.violations,
    JSON.stringify(
      accessibility.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
    ),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("management-catalog-1440x900.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Add product" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a product" });
  await expect(dialog).toBeVisible();
  accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    accessibility.violations,
    JSON.stringify(
      accessibility.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
    ),
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add product" })).toBeFocused();
});

test("the cinematic brand landing preserves the working kiosk entry point", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A little closer. A lot clearer." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Find your beauty direction", exact: true }),
  ).toHaveAttribute("href", "/kiosk");
  await expect(page.locator("#experience")).toHaveAttribute(
    "data-story-mode",
    "simple",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("hero-desktop-1440x900.png"),
    fullPage: true,
  });
});
