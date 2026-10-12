import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { deflateSync } from "node:zlib";

// In-memory generated PNG, no person/photo fixture or disk input.
function png(width = 320, height = 320) {
  const crc32 = (data) => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, payload) => {
    const name = Buffer.from(type),
      length = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    crc.writeUInt32BE(crc32(Buffer.concat([name, payload])));
    return Buffer.concat([length, name, payload, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      rows[offset] = 220;
      rows[offset + 1] = 190 + (x % 40);
      rows[offset + 2] = 200 + (y % 40);
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function selectPhoto(page) {
  await page
    .getByLabel("테스트할 사진")
    .setInputFiles({
      name: "synthetic.png",
      mimeType: "image/png",
      buffer: png(),
    });
  await expect(page.locator("#photo-preview")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#model-status")).toContainText("준비 완료");
});

test("local shell is accessible at desktop and narrow widths with no external requests", async ({
  page,
}) => {
  await expect(
    page.getByRole("button", { name: "모델로 테스트", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "사진과 결과 비우기" }),
  ).toBeDisabled();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
  const external = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter(
        (url) => url.startsWith("http") && !url.startsWith(location.origin),
      ),
  );
  expect(external).toEqual([]);
});

test("photo stays in browser until consent and explicit submit; eight outputs clear fully", async ({
  page,
}) => {
  let uploads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/predict") uploads++;
  });
  await page.evaluate(() => {
    const revoke = URL.revokeObjectURL.bind(URL);
    window.revocations = 0;
    URL.revokeObjectURL = (url) => {
      window.revocations++;
      revoke(url);
    };
  });
  await selectPhoto(page);
  expect(uploads).toBe(0);
  await expect(page.locator("#analyze")).toBeDisabled();
  await page.getByLabel(/본인 사진 또는/).check();
  expect(uploads).toBe(0);
  await page.locator("#analyze").click();
  await expect(page.locator(".head-card")).toHaveCount(8);
  expect(uploads).toBe(1);
  await expect(page.locator("#result-heading")).toBeFocused();
  await page.locator(".head-card summary").first().click();
  await expect(page.locator(".probabilities").first()).toContainText("50.0%");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "사진과 결과 비우기" }).click();
  await expect(page.locator("#photo-preview")).not.toHaveAttribute("src");
  await expect(page.locator(".head-card")).toHaveCount(0);
  await expect(page.locator("#consent")).not.toBeChecked();
  expect(await page.evaluate(() => window.revocations)).toBe(1);
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
});

test("unsupported, oversized and small images are rejected before any upload", async ({
  page,
}) => {
  let uploads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/predict") uploads++;
  });
  const cases = [
    {
      file: {
        name: "vector.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from("<svg></svg>"),
      },
      message: "HEIC",
    },
    {
      file: {
        name: "large.png",
        mimeType: "image/png",
        buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
      },
      message: "10MB",
    },
    {
      file: { name: "small.png", mimeType: "image/png", buffer: png(100, 100) },
      message: "224픽셀",
    },
  ];
  for (const item of cases) {
    await page.getByLabel("테스트할 사진").setInputFiles(item.file);
    await expect(page.getByRole("alert")).toContainText(item.message);
    await expect(page.locator("#analyze")).toBeDisabled();
  }
  expect(uploads).toBe(0);
});

test("clear ignores a late response even if transport does not honor abort", async ({
  page,
}) => {
  const response = await page.request.get("/api/model");
  const metadata = await response.json();
  const result = {
    mode: "experimental_local_photo",
    heads: metadata.targets.map((target) => ({
      key: target.key,
      predicted_code: target.codes[0],
      probabilities: target.codes.map((code) => ({
        code,
        probability: 1 / target.codes.length,
      })),
    })),
  };
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (url, options) =>
      url === "/api/predict"
        ? new Promise((resolve) => {
            window.finishPrediction = resolve;
          })
        : original(url, options);
  });
  await selectPhoto(page);
  await page.locator("#consent").check();
  await page.locator("#analyze").click();
  await expect(page.locator("#loading")).toBeVisible();
  await page.locator("#clear").click();
  await page.evaluate(
    (result) =>
      window.finishPrediction(
        new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    result,
  );
  await expect(page.locator("#empty")).toBeVisible();
  await expect(page.locator(".head-card")).toHaveCount(0);
  await expect(page.locator("#photo-preview")).not.toHaveAttribute("src");
});

test("inactivity and page exit clear the preview and results", async ({
  page,
}) => {
  await page.clock.install();
  await selectPhoto(page);
  await page.clock.fastForward(120_001);
  await expect(page.locator("#photo-preview")).not.toHaveAttribute("src");
  await expect(page.locator("#announcement")).toContainText("2분");
  await selectPhoto(page);
  await page.evaluate(() =>
    dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
  );
  await expect(page.locator("#photo-preview")).not.toHaveAttribute("src");
  await expect(page.locator("#analyze")).toBeDisabled();
});

test("server failures keep retry available without reusing withdrawn consent", async ({
  page,
}) => {
  await page.route("**/api/predict", (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      body: '{"error":"busy"}',
    }),
  );
  await selectPhoto(page);
  await page.locator("#consent").check();
  await page.locator("#analyze").click();
  await expect(page.getByRole("alert")).toContainText("다른 사진");
  await expect(page.locator("#analyze")).toBeEnabled();
  await page.locator("#consent").uncheck();
  await expect(page.locator("#analyze")).toBeDisabled();
});

test("a pending image decode can be cleared and also expires after inactivity", async ({
  page,
}) => {
  await page.clock.install();
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "src",
    );
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      ...descriptor,
      set(value) {
        if (!value.startsWith("blob:")) descriptor.set.call(this, value);
      },
    });
    const revoke = URL.revokeObjectURL.bind(URL);
    window.revocations = 0;
    URL.revokeObjectURL = (url) => {
      window.revocations++;
      revoke(url);
    };
  });
  const file = { name: "synthetic.png", mimeType: "image/png", buffer: png() };
  await page.getByLabel("테스트할 사진").setInputFiles(file);
  await expect(page.locator("#clear")).toBeEnabled();
  await expect(page.locator("#analyze")).toBeDisabled();
  await page.locator("#clear").click();
  expect(await page.evaluate(() => window.revocations)).toBe(1);
  await page.getByLabel("테스트할 사진").setInputFiles(file);
  await page.clock.fastForward(120_001);
  await expect(page.locator("#clear")).toBeDisabled();
  expect(await page.evaluate(() => window.revocations)).toBe(2);
});

test("withdrawing consent during a pending prediction prevents late results", async ({
  page,
}) => {
  const response = await page.request.get("/api/model");
  const metadata = await response.json();
  const result = {
    mode: "experimental_local_photo",
    heads: metadata.targets.map((target) => ({
      key: target.key,
      predicted_code: target.codes[0],
      probabilities: target.codes.map((code) => ({
        code,
        probability: 1 / target.codes.length,
      })),
    })),
  };
  await page.evaluate(() => {
    const original = fetch.bind(window);
    window.fetch = (url, options) =>
      url === "/api/predict"
        ? new Promise((resolve) => {
            window.finishPrediction = resolve;
          })
        : original(url, options);
  });
  await selectPhoto(page);
  await page.locator("#consent").check();
  await page.locator("#analyze").click();
  await expect(page.locator("#loading")).toBeVisible();
  await page.locator("#consent").uncheck();
  await page.evaluate(
    (result) => window.finishPrediction(new Response(JSON.stringify(result))),
    result,
  );
  await expect(page.locator("#photo-preview")).not.toHaveAttribute("src");
  await expect(page.locator(".head-card")).toHaveCount(0);
  await expect(page.locator("#analyze")).toBeDisabled();
});

test("request timeout shows Korean retry feedback and keeps clear available", async ({
  page,
}) => {
  await page.clock.install();
  await page.evaluate(() => {
    const original = fetch.bind(window);
    window.fetch = (url, options) =>
      url === "/api/predict"
        ? new Promise((resolve, reject) =>
            options.signal.addEventListener("abort", () =>
              reject(new DOMException("Timeout", "AbortError")),
            ),
          )
        : original(url, options);
  });
  await selectPhoto(page);
  await page.locator("#consent").check();
  await page.locator("#analyze").click();
  await page.clock.fastForward(60_001);
  await expect(page.getByRole("alert")).toContainText(
    "처리가 시간 안에 끝나지 않았습니다",
  );
  await expect(page.locator("#analyze")).toBeEnabled();
  await expect(page.locator("#clear")).toBeEnabled();
});
