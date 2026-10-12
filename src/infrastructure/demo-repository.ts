import { randomUUID, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BeautyRepository,
  BeautySession,
} from "@/application/beauty-consultations";
import {
  BEAUTY_PHOTO_NOTICE_VERSION,
  validateBeautyAnalysis,
  type BeautyAnalysis,
} from "@/domain/beauty-analysis";
import {
  validBeautyPreferences,
  type BeautyPreferences,
} from "@/domain/beauty";
import { canonicalizeIngredient } from "@/domain/ingredients";
import { BEAUTY_MAKEUP_NOTICE_VERSION } from "@/domain/beauty-makeup";
import type {
  ColorSession,
  PersonalColorRepository,
} from "@/application/personal-color";
import {
  COLOR_PHOTO_NOTICE_VERSION,
  validateColorAnalysis,
  type ColorAnalysis,
} from "@/domain/color-analysis";
import {
  validColorPreferences,
  validLipShadeDraft,
  type ColorPreferences,
  type LipShade,
  type LipShadeDraft,
} from "@/domain/personal-color";
import {
  DEMO_ORGANIZATION_ID,
  DEMO_STORE_ID,
  demoProducts,
  DEMO_RULES,
  validateCatalogDraft,
  validateCatalogDraftStructure,
} from "@/domain";
import type { Product, Recommendation } from "@/domain/types";
import {
  isOpenAIAnalysis,
  VISION_NOTICE_VERSION,
  OPENAI_CONSENT_VERSION,
} from "@/domain/skin-vision";
import {
  EXPLANATION_NOTICE_VERSION,
  EXPLANATION_PROMPT_VERSION,
  type RecommendationExplanation,
} from "@/application/explanation-contracts";
import {
  AppError,
  type Answers,
  type Analysis,
  type CatalogWrite,
  type Consultation,
  type DeviceContext,
  type DeviceRecord,
  type Metrics,
  type Policy,
  type Repository,
  type StaffContext,
} from "@/application/contracts";

export const demoStaff: StaffContext = {
  organizationId: DEMO_ORGANIZATION_ID,
  organizationName: "Senmiva Studio",
  role: "owner",
  stores: [
    {
      id: DEMO_STORE_ID,
      name: "Soho Studio",
      location: "New York, NY",
      currency: "USD",
    },
    {
      id: "22222222-2222-4222-8222-222222222223",
      name: "Brooklyn Studio",
      location: "Brooklyn, NY",
      currency: "USD",
    },
  ],
};
const catalogPath =
  process.env.DEMO_CATALOG_PATH ??
  path.join(process.cwd(), ".local", "catalog.json");
const hash = (v: string) => createHash("sha256").update(v).digest("hex");

/** Single-process demo only. Customer consultation data is deliberately never written to disk. */
export class DemoRepository
  implements Repository, PersonalColorRepository, BeautyRepository
{
  private catalog: Product[] | null = null;
  private sessions = new Map<string, Consultation>();
  private activity = new Map<string, number>();
  private explanationClaims = new Set<string>();
  private visionClaims = new Set<string>();
  private invalidatedVisionClaims = new Set<string>();
  private colorStates = new Map<string, ColorSession>();
  private invalidatedColorClaims = new Set<string>();
  private beautyStates = new Map<string, BeautySession>();
  private invalidatedBeautyClaims = new Set<string>();
  private beautyMakeupStates = new Map<
    string,
    {
      consent: boolean;
      attempted: boolean;
      invalidated: boolean;
      choices: string | null;
    }
  >();
  private analyzedSessions = new Set<string>();
  private completeSessions = new Map<string, () => void>();
  private shades: LipShade[] = [];
  private sessionPolicySnapshots = new Map<string, Policy>();
  private deviceRows = new Map<string, DeviceRecord>();
  private codes = new Map<
    string,
    { storeId: string; label: string; expiresAt: number }
  >();
  private counts = new Map<string, Metrics>();
  private writeQueue: Promise<void> = Promise.resolve();
  private loading: Promise<void> | null = null;
  constructor(
    private readonly persist = true,
    private readonly now = () => Date.now(),
    private readonly catalogFile = catalogPath,
  ) {}
  private async load() {
    if (this.loading) return this.loading;
    if (this.catalog) return;
    this.loading ??= (async () => {
      try {
        this.catalog = this.persist
          ? (JSON.parse(await readFile(this.catalogFile, "utf8")) as Product[])
          : null;
      } catch {
        /* First demo run has no catalog file. */
      }
      this.catalog ??= demoStaff.stores.flatMap((store) =>
        demoProducts.map((p) => ({ ...structuredClone(p), storeId: store.id })),
      );
      if (this.persist) {
        try {
          this.shades = JSON.parse(
            await readFile(`${this.catalogFile}.shades.json`, "utf8"),
          ) as LipShade[];
        } catch {
          this.shades = [];
        }
      }
    })();
    await this.loading;
  }
  /** One staged snapshot per coherent mutation: no intermediate file or partial memory commit. */
  private async mutateCatalog(mutate: (next: Product[]) => void) {
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await this.load();
        const next = structuredClone(this.catalog!);
        mutate(next);
        if (this.persist) {
          await mkdir(path.dirname(this.catalogFile), { recursive: true });
          const tmp = `${this.catalogFile}.${randomUUID()}.tmp`;
          try {
            await writeFile(tmp, JSON.stringify(next, null, 2), {
              mode: 0o600,
            });
            await rename(tmp, this.catalogFile);
          } catch (error) {
            await unlink(tmp).catch(() => undefined);
            throw error;
          }
        }
        this.catalog = next;
      });
    this.writeQueue = operation;
    await operation;
  }
  private store(storeId: string) {
    if (!demoStaff.stores.some((s) => s.id === storeId))
      throw new AppError(404, "store_not_found", "Store not found.");
  }
  private metric(storeId: string) {
    const m = this.counts.get(storeId) ?? {
      started: 0,
      completed: 0,
      analyzed: 0,
    };
    this.counts.set(storeId, m);
    return m;
  }
  private sweep() {
    for (const [id, s] of this.sessions)
      if (
        this.now() - (this.activity.get(id) ?? Date.parse(s.createdAt)) >=
          15 * 60_000 ||
        (this.completeSessions.has(id) &&
          this.now() - Date.parse(s.createdAt) >= 15 * 60_000)
      )
        this.removeSession(id);
    for (const [key, value] of this.codes)
      if (value.expiresAt <= this.now()) this.codes.delete(key);
  }
  private removeSession(id: string) {
    this.completeSessions.get(id)?.();
    this.completeSessions.delete(id);
    this.sessions.delete(id);
    this.activity.delete(id);
    this.explanationClaims.delete(id);
    this.visionClaims.delete(id);
    this.invalidatedVisionClaims.delete(id);
    this.colorStates.delete(id);
    this.invalidatedColorClaims.delete(id);
    this.beautyStates.delete(id);
    this.invalidatedBeautyClaims.delete(id);
    this.beautyMakeupStates.delete(id);
    this.analyzedSessions.delete(id);
    this.sessionPolicySnapshots.delete(id);
  }
  private verifiedDevice(device: DeviceContext) {
    const paired = this.ensureDevice(device.deviceId, device.storeId);
    if (
      device.organizationId !== paired.organizationId ||
      device.storeId !== paired.storeId
    )
      throw new AppError(
        404,
        "device_not_found",
        "Device context does not match this store.",
      );
    return paired;
  }
  ensureDevice(id: string, storeId = DEMO_STORE_ID): DeviceContext {
    this.store(storeId);
    const device = this.deviceRows.get(id);
    if (device?.revoked)
      throw new AppError(
        401,
        "device_revoked",
        "This device has been disconnected. Pair it again with a new code.",
      );
    this.deviceRows.set(
      id,
      device ?? {
        id,
        label: "Demo consultation tablet",
        storeId,
        revoked: false,
        lastSeen: null,
      },
    );
    return {
      organizationId: DEMO_ORGANIZATION_ID,
      storeId: device?.storeId ?? storeId,
      deviceId: id,
    };
  }
  pair(code: string, id: string): DeviceContext {
    this.sweep();
    const key = hash(code.trim().toUpperCase());
    const entry = this.codes.get(key);
    if (!entry)
      throw new AppError(
        400,
        "invalid_code",
        "This pairing code is invalid or expired.",
      );
    this.codes.delete(key);
    for (const [key, session] of this.sessions)
      if (session.deviceId === id) this.removeSession(key);
    this.deviceRows.set(id, {
      id,
      label: entry.label,
      storeId: entry.storeId,
      revoked: false,
      lastSeen: null,
    });
    return this.ensureDevice(id, entry.storeId);
  }
  async products(storeId: string) {
    this.store(storeId);
    await this.load();
    return structuredClone(this.catalog!.filter((p) => p.storeId === storeId));
  }
  private applyDraft(catalog: Product[], storeId: string, input: CatalogWrite) {
    const validation = validateCatalogDraftStructure(input);
    if (!validation.valid)
      throw new AppError(
        422,
        "invalid_draft",
        validation.errors.map((error) => error.message).join(" "),
      );
    const bySku = catalog.find(
      (p) => p.sku.toUpperCase() === input.sku.toUpperCase(),
    );
    const byId = input.id ? catalog.find((p) => p.id === input.id) : undefined;
    if (input.id && !byId)
      throw new AppError(404, "not_found", "Product not found.");
    if (byId && bySku && byId.id !== bySku.id)
      throw new AppError(
        409,
        "duplicate_sku",
        "This SKU belongs to another product.",
      );
    const existing = byId ?? bySku;
    if (
      existing &&
      (existing.sku !== input.sku ||
        existing.brand !== input.brand ||
        existing.name !== input.name ||
        existing.category !== input.category)
    )
      throw new AppError(
        422,
        "immutable_identity",
        "Existing SKU, brand, name and category cannot change through a formulation draft.",
      );
    const id = existing?.id ?? randomUUID();
    for (const store of demoStaff.stores) {
      const current = catalog.find(
        (p) => p.id === id && p.storeId === store.id,
      );
      const row: Product = {
        ...structuredClone(input),
        id,
        organizationId: DEMO_ORGANIZATION_ID,
        storeId: store.id,
        status: "draft",
        visible: current?.visible ?? false,
        ...(store.id === storeId
          ? {}
          : {
              priceMinor: current?.priceMinor ?? input.priceMinor,
              stock: current?.stock ?? 0,
            }),
      };
      if (current) catalog[catalog.indexOf(current)] = row;
      else catalog.push(row);
    }
  }
  async saveDraft(storeId: string, input: CatalogWrite) {
    this.store(storeId);
    await this.mutateCatalog((next) => this.applyDraft(next, storeId, input));
  }
  async importDrafts(storeId: string, inputs: CatalogWrite[]) {
    this.store(storeId);
    if (inputs.length === 0 || inputs.length > 500)
      throw new AppError(
        422,
        "invalid_import",
        "Import between 1 and 500 products.",
      );
    if (
      new Set(inputs.map((input) => input.sku.toUpperCase())).size !==
      inputs.length
    )
      throw new AppError(
        422,
        "duplicate_sku",
        "Remove duplicate SKUs before importing.",
      );
    await this.mutateCatalog((next) => {
      for (const input of inputs) this.applyDraft(next, storeId, input);
    });
  }
  async publish(id: string) {
    await this.mutateCatalog((next) => {
      const row = next.find((p) => p.id === id);
      if (!row) throw new AppError(404, "not_found", "Product not found.");
      const validation = validateCatalogDraft(row);
      if (!validation.valid)
        throw new AppError(
          422,
          "publication_blocked",
          validation.errors.map((e) => e.message).join(" "),
        );
      for (const p of next) if (p.id === id) p.status = "published";
    });
  }
  async updateListing(
    storeId: string,
    id: string,
    patch: Pick<Product, "priceMinor" | "stock" | "visible">,
  ) {
    this.store(storeId);
    await this.mutateCatalog((next) => {
      const p = next.find((p) => p.id === id && p.storeId === storeId);
      if (!p) throw new AppError(404, "not_found", "Listing not found.");
      const updated = { ...p, ...patch };
      const validation = validateCatalogDraftStructure(updated);
      if (!validation.valid)
        throw new AppError(
          422,
          "invalid_listing",
          validation.errors.map((error) => error.message).join(" "),
        );
      if (patch.visible && p.status !== "published")
        throw new AppError(
          422,
          "publication_required",
          "Publish the reviewed formulation before showing this product.",
        );
      Object.assign(p, patch);
    });
  }
  async beautySession(
    id: string,
    device: DeviceContext,
  ): Promise<BeautySession> {
    await this.session(id, device);
    return structuredClone(
      this.beautyStates.get(id) ?? {
        consent: false,
        attempted: false,
        analysis: null,
        preferences: null,
        excludedIngredients: [],
      },
    );
  }
  async beautyConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    const session = await this.session(id, device);
    if (
      !session.consent ||
      (accepted && session.consentVersion !== OPENAI_CONSENT_VERSION) ||
      noticeVersion !== BEAUTY_PHOTO_NOTICE_VERSION
    )
      throw new AppError(
        403,
        "beauty_consent_required",
        "Accept the current beauty-photo notice first.",
      );
    const snapshot = await this.beautySession(id, device);
    if (!this.sessions.has(id))
      throw new AppError(
        404,
        "session_not_found",
        "This consultation has ended.",
      );
    const state = this.beautyStates.get(id) ?? snapshot;
    if (!accepted) {
      state.analysis = null;
      state.preferences = null;
      if (state.attempted) this.invalidatedBeautyClaims.add(id);
      const makeup = this.beautyMakeupStates.get(id);
      if (makeup) {
        makeup.consent = false;
        makeup.invalidated = makeup.attempted;
      }
    }
    state.consent = accepted;
    this.beautyStates.set(id, state);
    this.activity.set(id, this.now());
  }
  async beautyMakeupState(id: string, device: DeviceContext) {
    await this.session(id, device);
    const value = this.beautyMakeupStates.get(id);
    return {
      consent: value?.consent ?? false,
      attempted: value?.attempted ?? false,
    };
  }
  async beautyMakeupConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    const session = await this.session(id, device);
    const beauty = await this.beautySession(id, device);
    if (
      noticeVersion !== BEAUTY_MAKEUP_NOTICE_VERSION ||
      !session.consent ||
      (accepted &&
        (session.consentVersion !== OPENAI_CONSENT_VERSION || !beauty.consent))
    )
      throw new AppError(
        403,
        "makeup_consent_required",
        "Accept the current photo and makeup notices first.",
      );
    const value = this.beautyMakeupStates.get(id) ?? {
      consent: false,
      attempted: false,
      invalidated: false,
      choices: null,
    };
    value.consent = accepted;
    if (!accepted && value.attempted) value.invalidated = true;
    this.beautyMakeupStates.set(id, value);
  }
  async claimBeautyMakeup(id: string, device: DeviceContext) {
    this.assertLegacyPhoto(id);
    const beauty = await this.beautySession(id, device);
    const value = this.beautyMakeupStates.get(id);
    if (
      !beauty.consent ||
      !value?.consent ||
      value.attempted ||
      !beauty.preferences ||
      beauty.analysis?.prompt_version !== "beauty-style-suggestion-v2" ||
      beauty.analysis.image_quality !== "usable"
    )
      throw new AppError(
        409,
        "makeup_unavailable",
        "This session cannot start makeup previews.",
      );
    value.attempted = true;
    value.choices = JSON.stringify(beauty.preferences);
  }
  async assertBeautyMakeup(id: string, device: DeviceContext) {
    const beauty = await this.beautySession(id, device);
    const value = this.beautyMakeupStates.get(id);
    if (
      !beauty.consent ||
      !value?.consent ||
      !value.attempted ||
      value.invalidated ||
      value.choices !== JSON.stringify(beauty.preferences)
    )
      throw new AppError(
        409,
        "makeup_changed",
        "This session changed while previews were being created.",
      );
  }
  async claimBeautyAnalysis(
    id: string,
    device: DeviceContext,
  ): Promise<boolean> {
    this.assertLegacyPhoto(id);
    const session = await this.session(id, device);
    const snapshot = await this.beautySession(id, device);
    if (!this.sessions.has(id))
      throw new AppError(
        404,
        "session_not_found",
        "This consultation has ended.",
      );
    const state = this.beautyStates.get(id) ?? snapshot;
    if (
      !session.consent ||
      session.consentVersion !== OPENAI_CONSENT_VERSION ||
      !state.consent
    )
      throw new AppError(
        403,
        "beauty_consent_required",
        "Accept the beauty-photo notice first.",
      );
    if (state.attempted) return false;
    state.attempted = true;
    this.beautyStates.set(id, state);
    return true;
  }
  async saveBeautyAnalysis(
    id: string,
    device: DeviceContext,
    analysis: BeautyAnalysis,
  ) {
    await this.beautySession(id, device);
    const state = this.beautyStates.get(id);
    if (
      !this.sessions.has(id) ||
      !state ||
      !state.consent ||
      !state.attempted ||
      state.analysis ||
      this.invalidatedBeautyClaims.has(id) ||
      !validateBeautyAnalysis(analysis)
    )
      throw new AppError(
        409,
        "beauty_write_failed",
        "This consultation changed before its suggestion could be saved.",
      );
    state.analysis = structuredClone(analysis);
    if (!this.analyzedSessions.has(id)) {
      this.analyzedSessions.add(id);
      this.metric(device.storeId).analyzed++;
    }
  }
  async confirmBeautyPreferences(
    id: string,
    device: DeviceContext,
    preferences: BeautyPreferences,
  ) {
    const session = await this.session(id, device);
    if (!session.consent || !validBeautyPreferences(preferences))
      throw new AppError(
        422,
        "invalid_beauty_preferences",
        "Accept the notice and choose your style.",
      );
    const snapshot = await this.beautySession(id, device);
    if (!this.sessions.has(id))
      throw new AppError(
        404,
        "session_not_found",
        "This consultation has ended.",
      );
    const state = this.beautyStates.get(id) ?? snapshot;
    const makeup = this.beautyMakeupStates.get(id);
    if (makeup?.attempted) makeup.invalidated = true;
    state.preferences = structuredClone(preferences);
    this.beautyStates.set(id, state);
    this.activity.set(id, this.now());
  }
  async beautyExclusions(
    id: string,
    device: DeviceContext,
    ingredients: string[],
  ) {
    const session = await this.session(id, device);
    const resolved = ingredients.map(canonicalizeIngredient);
    if (
      !session.consent ||
      ingredients.length > 20 ||
      resolved.some((item) => !item)
    )
      throw new AppError(
        422,
        "invalid_exclusions",
        "Choose listed ingredients to avoid.",
      );
    const snapshot = await this.beautySession(id, device);
    if (!this.sessions.has(id))
      throw new AppError(
        404,
        "session_not_found",
        "This consultation has ended.",
      );
    const state = this.beautyStates.get(id) ?? snapshot;
    state.excludedIngredients = [...new Set(resolved as string[])];
    this.beautyStates.set(id, state);
    this.activity.set(id, this.now());
  }
  async createBeautyGuide(): Promise<{ expiresAt: string }> {
    throw new AppError(
      409,
      "sharing_unavailable",
      "Phone sharing needs a connected database and a public HTTPS address.",
    );
  }
  async colorSession(id: string, device: DeviceContext): Promise<ColorSession> {
    await this.session(id, device);
    return structuredClone(
      this.colorStates.get(id) ?? {
        consent: false,
        attempted: false,
        analysis: null,
        preferences: null,
      },
    );
  }
  async colorConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    const session = await this.session(id, device);
    if (
      !session.consent ||
      (accepted && session.consentVersion !== OPENAI_CONSENT_VERSION) ||
      noticeVersion !== COLOR_PHOTO_NOTICE_VERSION
    )
      throw new AppError(
        403,
        "color_consent_required",
        "Accept the current privacy notice first.",
      );
    const snapshot = await this.colorSession(id, device);
    if (!this.sessions.has(id))
      throw new AppError(
        404,
        "session_not_found",
        "This consultation has ended.",
      );
    const state = this.colorStates.get(id) ?? snapshot;
    if (!accepted) {
      state.analysis = null;
      state.preferences = null;
      if (state.attempted) this.invalidatedColorClaims.add(id);
    }
    state.consent = accepted;
    this.colorStates.set(id, state);
    this.activity.set(id, this.now());
  }
  async claimColorAnalysis(
    id: string,
    device: DeviceContext,
  ): Promise<boolean> {
    this.assertLegacyPhoto(id);
    const session = await this.session(id, device);
    const snapshot = await this.colorSession(id, device);
    if (!this.sessions.has(id))
      throw new AppError(
        404,
        "session_not_found",
        "This consultation has ended.",
      );
    const state = this.colorStates.get(id) ?? snapshot;
    if (
      !session.consent ||
      session.consentVersion !== OPENAI_CONSENT_VERSION ||
      !session.answers ||
      !state.consent
    )
      throw new AppError(
        403,
        "color_consent_required",
        "Accept the separate color-photo notice first.",
      );
    if (state.attempted) return false;
    state.attempted = true;
    this.colorStates.set(id, state);
    return true;
  }
  async saveColorAnalysis(
    id: string,
    device: DeviceContext,
    analysis: ColorAnalysis,
  ) {
    await this.colorSession(id, device);
    const state = this.colorStates.get(id);
    if (
      !this.sessions.has(id) ||
      !state ||
      !state.consent ||
      !state.attempted ||
      state.analysis ||
      this.invalidatedColorClaims.has(id) ||
      !validateColorAnalysis(analysis)
    )
      throw new AppError(
        409,
        "color_write_failed",
        "This consultation changed before the color result could be saved.",
      );
    state.analysis = structuredClone(analysis);
    this.colorStates.set(id, state);
  }
  async confirmColorPreferences(
    id: string,
    device: DeviceContext,
    preferences: ColorPreferences,
  ) {
    const session = await this.session(id, device);
    if (
      !session.consent ||
      !session.answers ||
      !validColorPreferences(preferences)
    )
      throw new AppError(
        422,
        "invalid_color_preferences",
        "Complete preferences and choose a listed palette.",
      );
    const snapshot = await this.colorSession(id, device);
    if (!this.sessions.has(id))
      throw new AppError(
        404,
        "session_not_found",
        "This consultation has ended.",
      );
    const state = this.colorStates.get(id) ?? snapshot;
    state.preferences = structuredClone(preferences);
    this.colorStates.set(id, state);
    this.activity.set(id, this.now());
  }
  async lipShades(storeId: string): Promise<LipShade[]> {
    this.store(storeId);
    await this.load();
    const ids = new Set(
      this.catalog!.filter((p) => p.storeId === storeId).map((p) => p.id),
    );
    return structuredClone(
      this.shades.filter((shade) => ids.has(shade.variantId)),
    );
  }
  async publishLipShade(
    storeId: string,
    variantId: string,
    draft: LipShadeDraft,
  ) {
    this.store(storeId);
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await this.load();
        const product = this.catalog!.find(
          (p) => p.id === variantId && p.storeId === storeId,
        );
        if (
          !product ||
          product.category !== "lip_color" ||
          product.status !== "published" ||
          !validateCatalogDraft(product).valid ||
          !validLipShadeDraft(draft)
        )
          throw new AppError(
            422,
            "shade_publication_blocked",
            "Publish a complete reviewed lip formula and shade first.",
          );
        const prior = this.shades.find((s) => s.variantId === variantId);
        const next = this.shades.filter((s) => s.variantId !== variantId);
        next.push({
          ...structuredClone(draft),
          variantId,
          organizationId: DEMO_ORGANIZATION_ID,
          versionId: randomUUID(),
          version: (prior?.version ?? 0) + 1,
        });
        if (this.persist) {
          const target = `${this.catalogFile}.shades.json`;
          await mkdir(path.dirname(target), { recursive: true });
          const temp = `${target}.${randomUUID()}.tmp`;
          try {
            await writeFile(temp, JSON.stringify(next), "utf8");
            await rename(temp, target);
          } finally {
            await unlink(temp).catch(() => undefined);
          }
        }
        this.shades = next;
      });
    this.writeQueue = operation;
    await operation;
  }
  async start(device: DeviceContext) {
    this.sweep();
    this.verifiedDevice(device);
    const existing = [...this.sessions.values()].find(
      (s) => s.deviceId === device.deviceId,
    );
    if (existing) return structuredClone(existing);
    const row: Consultation = {
      id: randomUUID(),
      ...device,
      createdAt: new Date(this.now()).toISOString(),
      consent: false,
      answers: null,
      analysis: null,
      recommendations: null,
    };
    this.sessions.set(row.id, row);
    this.activity.set(row.id, this.now());
    this.metric(device.storeId).started++;
    this.deviceRows.get(device.deviceId)!.lastSeen = row.createdAt;
    return structuredClone(row);
  }
  async session(id: string, device: DeviceContext) {
    this.sweep();
    this.verifiedDevice(device);
    const s = this.sessions.get(id);
    if (
      !s ||
      s.deviceId !== device.deviceId ||
      s.organizationId !== device.organizationId ||
      s.storeId !== device.storeId
    )
      throw new AppError(
        404,
        "session_not_found",
        "This consultation has ended. Please start again.",
      );
    return structuredClone(s);
  }
  async consent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion = "2026-10-mvp",
  ) {
    await this.session(id, device);
    if (
      ![
        "2026-10-mvp",
        "2026-10-experimental-v1",
        OPENAI_CONSENT_VERSION,
      ].includes(noticeVersion)
    )
      throw new AppError(
        422,
        "invalid_consent_version",
        "This privacy notice is not supported.",
      );
    if (!accepted) {
      this.removeSession(id);
      return;
    }
    this.sessions.get(id)!.consent = true;
    this.sessions.get(id)!.consentVersion = noticeVersion;
    this.activity.set(id, this.now());
  }
  async answers(id: string, device: DeviceContext, answers: Answers) {
    const s = await this.session(id, device);
    if (!s.consent)
      throw new AppError(
        409,
        "consent_required",
        "Consent is required before preferences.",
      );
    if (s.analysis)
      throw new AppError(
        409,
        "already_analyzed",
        "Start a new consultation to change your answers.",
      );
    this.sessions.get(id)!.answers = structuredClone(answers);
    this.activity.set(id, this.now());
  }
  async explanationConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    const session = await this.session(id, device);
    if (!session.consent)
      throw new AppError(
        409,
        "consent_required",
        "Complete the privacy notice first.",
      );
    if (
      noticeVersion !== EXPLANATION_NOTICE_VERSION ||
      typeof accepted !== "boolean"
    )
      throw new AppError(
        422,
        "invalid_consent_version",
        "This explanation privacy notice is not supported.",
      );
    if (
      session.explanationConsent?.accepted === accepted &&
      session.explanationConsent.noticeVersion === noticeVersion
    )
      return;
    if (session.analysis || this.explanationClaims.has(id))
      throw new AppError(
        409,
        "explanation_consent_locked",
        "Start a new consultation to change this choice.",
      );
    const current = this.sessions.get(id);
    if (!current)
      throw new AppError(
        404,
        "session_not_found",
        "This consultation has ended.",
      );
    current.explanationConsent = { accepted, noticeVersion };
    this.activity.set(id, this.now());
  }
  async visionConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    const session = await this.session(id, device);
    if (!session.consent || session.consentVersion !== OPENAI_CONSENT_VERSION)
      throw new AppError(
        403,
        "consent_required",
        "Complete the current privacy notice first.",
      );
    if (
      noticeVersion !== VISION_NOTICE_VERSION ||
      typeof accepted !== "boolean"
    )
      throw new AppError(
        422,
        "invalid_consent_version",
        "This photo privacy notice is not supported.",
      );
    if (
      session.visionConsent?.accepted === accepted &&
      session.visionConsent.noticeVersion === noticeVersion
    )
      return;
    if (session.analysis)
      throw new AppError(
        409,
        "vision_consent_locked",
        "Finish and clear this consultation to withdraw this choice.",
      );
    const current = this.sessions.get(id);
    if (!current)
      throw new AppError(
        404,
        "session_not_found",
        "This consultation has ended.",
      );
    // Withdrawal invalidates an in-flight response but preserves the one-attempt claim.
    current.visionConsent = { accepted, noticeVersion };
    if (!accepted && this.visionClaims.has(id))
      this.invalidatedVisionClaims.add(id);
    this.activity.set(id, this.now());
  }
  async claimVisionAnalysis(
    id: string,
    device: DeviceContext,
  ): Promise<boolean> {
    this.assertLegacyPhoto(id);
    await this.session(id, device);
    const session = this.sessions.get(id);
    if (
      !session ||
      !session.consent ||
      session.consentVersion !== OPENAI_CONSENT_VERSION ||
      !session.visionConsent?.accepted ||
      session.visionConsent.noticeVersion !== VISION_NOTICE_VERSION
    )
      throw new AppError(
        403,
        "vision_consent_required",
        "Separate photo-processing consent is required.",
      );
    if (!session.answers)
      throw new AppError(
        409,
        "answers_required",
        "Complete preferences before requesting photo analysis.",
      );
    if (session.analysis) return false;
    if (this.visionClaims.has(id)) return false;
    this.visionClaims.add(id);
    return true;
  }
  async claimExplanation(id: string, device: DeviceContext): Promise<boolean> {
    await this.session(id, device);
    const session = this.sessions.get(id);
    if (!session)
      throw new AppError(
        404,
        "session_not_found",
        "This consultation has ended.",
      );
    if (
      !session.consent ||
      !session.explanationConsent?.accepted ||
      session.explanationConsent.noticeVersion !== EXPLANATION_NOTICE_VERSION
    )
      throw new AppError(
        403,
        "explanation_consent_required",
        "Optional explanation consent is required.",
      );
    if (!session.analysis || session.recommendations === null)
      throw new AppError(
        409,
        "recommendations_required",
        "Complete the recommendations first.",
      );
    if (this.explanationClaims.has(id)) return false;
    this.explanationClaims.add(id);
    return true;
  }
  async saveExplanation(
    id: string,
    device: DeviceContext,
    explanation: RecommendationExplanation,
  ): Promise<void> {
    await this.session(id, device);
    const session = this.sessions.get(id);
    if (!session)
      throw new AppError(
        404,
        "session_not_found",
        "This consultation has ended.",
      );
    if (
      !session.consent ||
      !session.explanationConsent?.accepted ||
      session.explanationConsent.noticeVersion !== EXPLANATION_NOTICE_VERSION ||
      !this.explanationClaims.has(id)
    )
      throw new AppError(
        403,
        "explanation_consent_required",
        "A consented explanation claim is required.",
      );
    if (session.explanation) return;
    const products = session.recommendations;
    if (
      !products ||
      explanation.products.length !== products.length ||
      explanation.products.some(
        (p, index) =>
          p.productId !== products[index].product.id ||
          p.text.length < 1 ||
          p.text.length > 600,
      ) ||
      !["generated", "fallback"].includes(explanation.status) ||
      explanation.summary.length < 1 ||
      explanation.summary.length > 600 ||
      explanation.promptVersion !== EXPLANATION_PROMPT_VERSION ||
      (explanation.status === "generated"
        ? !explanation.modelVersion || explanation.modelVersion.length > 120
        : explanation.modelVersion !== null)
    )
      throw new AppError(
        422,
        "invalid_explanation",
        "The explanation does not match the final recommendations.",
      );
    session.explanation = structuredClone(explanation);
  }
  async saveAnalysis(id: string, device: DeviceContext, analysis: Analysis) {
    const session = await this.session(id, device);
    if (!session.consent || !session.answers)
      throw new AppError(
        409,
        "answers_required",
        "Complete consent and preferences first.",
      );
    if (analysis.request_id !== id)
      throw new AppError(
        422,
        "invalid_analysis",
        "The analysis result does not match this consultation.",
      );
    if (analysis.mode === "openai") {
      if (!isOpenAIAnalysis(analysis))
        throw new AppError(
          422,
          "invalid_analysis",
          "The photo observations are not valid.",
        );
      if (
        session.consentVersion !== OPENAI_CONSENT_VERSION ||
        (analysis.vision !== null &&
          (!session.visionConsent?.accepted ||
            session.visionConsent.noticeVersion !== VISION_NOTICE_VERSION ||
            !this.visionClaims.has(id))) ||
        (analysis.vision !== null && this.invalidatedVisionClaims.has(id))
      )
        throw new AppError(
          403,
          "vision_consent_required",
          "A current consented photo claim is required.",
        );
    }
    const s = this.sessions.get(id)!;
    if (!s.analysis) {
      s.analysis = structuredClone(analysis);
      if (!this.analyzedSessions.has(id)) {
        this.analyzedSessions.add(id);
        this.metric(device.storeId).analyzed++;
      }
    }
    this.activity.set(id, this.now());
  }
  async saveRecommendations(
    id: string,
    device: DeviceContext,
    policy: Policy,
    items: Recommendation[],
  ) {
    const s = await this.session(id, device);
    if (!s.analysis)
      throw new AppError(
        409,
        "analysis_required",
        "Complete the consultation first.",
      );
    if (s.recommendations === null) {
      this.sessions.get(id)!.recommendations = structuredClone(items);
      this.sessionPolicySnapshots.set(id, structuredClone(policy));
    }
    this.activity.set(id, this.now());
  }
  async finish(id: string, device: DeviceContext) {
    this.verifiedDevice(device);
    const s = this.sessions.get(id);
    if (!s) return;
    if (
      s.deviceId !== device.deviceId ||
      s.organizationId !== device.organizationId ||
      s.storeId !== device.storeId
    )
      throw new AppError(404, "session_not_found", "Consultation not found.");
    if (s.analysis || this.beautyStates.get(id)?.preferences)
      this.metric(s.storeId).completed++;
    this.removeSession(id);
  }
  /** A complete context reserves a fresh source purpose; legacy photo routes cannot reuse it. */
  async registerCompleteSession(
    id: string,
    device: DeviceContext,
    onPurge: () => void,
  ) {
    await this.session(id, device);
    if (
      this.visionClaims.has(id) ||
      this.colorStates.get(id)?.attempted ||
      this.beautyStates.get(id)?.attempted ||
      this.beautyMakeupStates.get(id)?.attempted
    )
      throw new AppError(
        409,
        "fresh_session_required",
        "Start a new consultation for the integrated photo purpose.",
      );
    if (!this.completeSessions.has(id)) this.completeSessions.set(id, onPurge);
  }
  private assertLegacyPhoto(id: string) {
    if (this.completeSessions.has(id))
      throw new AppError(
        409,
        "complete_source_guard",
        "This session uses the integrated photo purpose.",
      );
  }
  async markCompleteAnalyzed(id: string, device: DeviceContext) {
    await this.session(id, device);
    if (!this.completeSessions.has(id))
      throw new AppError(
        409,
        "complete_context_required",
        "Start the integrated consultation first.",
      );
    if (!this.analyzedSessions.has(id)) {
      this.analyzedSessions.add(id);
      this.metric(device.storeId).analyzed++;
    }
  }
  async finishCompleteSession(
    id: string,
    device: DeviceContext,
    completed: boolean,
  ) {
    this.verifiedDevice(device);
    const existing = this.sessions.get(id);
    if (!existing) return;
    await this.session(id, device);
    if (!this.completeSessions.has(id))
      throw new AppError(
        409,
        "complete_context_required",
        "Start the integrated consultation first.",
      );
    if (completed) this.metric(device.storeId).completed++;
    this.removeSession(id);
  }
  async policy(device?: DeviceContext, sessionId?: string): Promise<Policy> {
    if (sessionId) {
      if (!device)
        throw new AppError(
          403,
          "device_required",
          "A paired device is required.",
        );
      await this.session(sessionId, device);
      const snapshot = this.sessionPolicySnapshots.get(sessionId);
      if (snapshot) return structuredClone(snapshot);
    }
    return {
      id: "44444444-4444-4444-8444-444444444444",
      version: "demo-1",
      source: "mock-onboarding-v1",
      rules: [...structuredClone(DEMO_RULES)],
    };
  }
  async metrics(storeId: string) {
    this.store(storeId);
    return { ...this.metric(storeId) };
  }
  async devices(storeId: string) {
    this.store(storeId);
    return structuredClone(
      [...this.deviceRows.values()].filter((d) => d.storeId === storeId),
    );
  }
  async pairingCode(storeId: string, label: string) {
    this.store(storeId);
    this.sweep();
    const code = randomBytes(8).toString("hex").toUpperCase();
    const expiresAt = this.now() + 10 * 60_000;
    this.codes.set(hash(code), { storeId, label, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  async revokeDevice(id: string) {
    const d = this.deviceRows.get(id);
    if (!d) throw new AppError(404, "device_not_found", "Device not found.");
    d.revoked = true;
    for (const [key, s] of this.sessions)
      if (s.deviceId === id) this.removeSession(key);
  }
}
const globals = globalThis as typeof globalThis & {
  senmivaDemo?: DemoRepository;
};
export const demoRepository = (globals.senmivaDemo ??= new DemoRepository());
