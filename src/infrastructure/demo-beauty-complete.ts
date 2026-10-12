import { randomUUID } from "node:crypto";
import {
  AppError,
  type DeviceContext,
  type Policy,
} from "@/application/contracts";
import {
  COMPLETE_PHOTO_NOTICE_VERSION,
  COMPLETE_PREVIEW_NOTICE_VERSION,
  type BeautyCompleteRepository,
  type BeautyCompleteState,
  type BeautyGuestContext,
  type CompleteSkinProfile,
  type CompletePreviewPlan,
  type CompleteSavedGuide,
  type GuestGender,
  type BeautyDemographics,
} from "@/application/beauty-complete-contracts";
import {
  validBeautyPreferences,
  type BeautyPreferences,
} from "@/domain/beauty";
import {
  validateBeautyAnalysis,
  type BeautyAnalysis,
} from "@/domain/beauty-analysis";
import {
  OPENAI_CONSENT_VERSION,
  OPENAI_SKIN_DISCLAIMER,
  OPENAI_SKIN_MODEL,
  isOpenAIAnalysis,
  type SkinVision,
} from "@/domain/skin-vision";
import {
  validBaseChoice,
  validCosmeticShadeDraft,
  type BaseChoice,
  type CosmeticShade,
  type CosmeticShadeDraft,
} from "@/domain/cosmetic-shades";
import { canonicalizeIngredients } from "@/domain/ingredients";
import { concerns, skinTypes, type Recommendation } from "@/domain/types";
import { DemoRepository, demoRepository } from "./demo-repository";

interface Entry {
  state: BeautyCompleteState;
  expiresAt: number;
  requestId: string | null;
  photoInvalidated: boolean;
  previewChoices: string | null;
  slotRequests: Map<number, string>;
  finishing: boolean;
  recommendations: Recommendation[];
  policy: Policy | null;
}
function empty(): BeautyCompleteState {
  return {
    guest: null,
    photoConsent: false,
    attempted: false,
    beauty: {
      consent: false,
      attempted: false,
      analysis: null,
      preferences: null,
      excludedIngredients: [],
    },
    skinVision: null,
    skinProfile: { skinType: "unsure", concerns: [], excludedIngredients: [] },
    base: { depth: "unknown", undertone: "unknown", concealerPurpose: "match" },
    previewConsent: false,
    previewPlan: null,
  };
}
const fail = (code: string, message: string) =>
  new AppError(409, code, message);
const adult = (context: BeautyGuestContext | null) =>
  !!context && !["under13", "13-15", "16-17"].includes(context.ageBand);
const utcWeek = (time: number) => {
  const day = new Date(time);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.getTime();
};

/** Single-process demo: no customer files, individual Gender, photos, prompts or generated pixels. */
export class DemoBeautyCompleteRepository implements BeautyCompleteRepository {
  private entries = new Map<string, Entry>();
  private shades: CosmeticShade[] = [];
  private aggregates = new Map<
    string,
    {
      week: number;
      store: string;
      age: Record<string, number>;
      gender: Record<string, number>;
    }
  >();
  constructor(
    private readonly repository: DemoRepository,
    private readonly now = () => Date.now(),
  ) {}

  private async active(
    id: string,
    device: DeviceContext,
    requireContext = true,
  ): Promise<Entry | null> {
    this.sweep();
    await this.repository.session(id, device);
    const entry = this.entries.get(id) ?? null;
    if (requireContext && !entry)
      throw fail("complete_context_required", "Choose an age range first.");
    return entry;
  }
  private sweep() {
    for (const [id, entry] of this.entries)
      if (entry.expiresAt <= this.now()) this.entries.delete(id);
    for (const [key, row] of this.aggregates)
      if (row.week < utcWeek(this.now()) - 5 * 7 * 86400000)
        this.aggregates.delete(key);
  }
  async readComplete(id: string, device: DeviceContext) {
    return structuredClone(
      (await this.active(id, device, false))?.state ?? empty(),
    );
  }
  async setGuestContext(
    id: string,
    device: DeviceContext,
    context: BeautyGuestContext,
  ) {
    const session = await this.repository.session(id, device);
    const existing = this.entries.get(id);
    if (
      existing?.state.attempted &&
      existing.state.guest?.ageBand !== context.ageBand
    )
      throw fail(
        "age_locked",
        "Start a new session to change the age range after photo processing.",
      );
    await this.repository.registerCompleteSession(id, device, () =>
      this.entries.delete(id),
    );
    const entry = existing ?? {
      state: empty(),
      expiresAt: Date.parse(session.createdAt) + 15 * 60000,
      requestId: null,
      photoInvalidated: false,
      previewChoices: null,
      slotRequests: new Map(),
      finishing: false,
      recommendations: [],
      policy: null,
    };
    entry.state.guest = structuredClone({
      ...context,
      analyticsConsent: adult(context) && context.analyticsConsent,
    });
    this.entries.set(id, entry);
  }
  async completePhotoConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    const entry = (await this.active(id, device))!;
    const session = await this.repository.session(id, device);
    if (
      !session.consent ||
      session.consentVersion !== OPENAI_CONSENT_VERSION ||
      noticeVersion !== COMPLETE_PHOTO_NOTICE_VERSION ||
      (accepted && entry.state.guest?.ageBand === "under13")
    )
      throw fail(
        "complete_consent_required",
        "Accept the current photo notice first.",
      );
    entry.state.photoConsent = accepted;
    entry.state.beauty.consent = accepted;
    if (!accepted) {
      entry.photoInvalidated ||= entry.state.attempted;
      entry.state.beauty.analysis = null;
      entry.state.skinVision = null;
      entry.state.previewConsent = false;
      this.cancel(entry);
    }
  }
  async claimCompleteAnalysis(id: string, device: DeviceContext) {
    const entry = (await this.active(id, device))!;
    const session = await this.repository.session(id, device);
    if (
      !session.consent ||
      !entry.state.photoConsent ||
      entry.state.attempted ||
      entry.photoInvalidated
    )
      throw fail(
        "complete_attempt_unavailable",
        "This photo attempt is unavailable.",
      );
    entry.state.attempted = true;
    entry.state.beauty.attempted = true;
    entry.requestId = randomUUID();
    return entry.requestId;
  }
  async saveCompleteAnalysis(
    id: string,
    device: DeviceContext,
    requestId: string,
    beauty: BeautyAnalysis,
    skin: SkinVision,
  ) {
    const entry = (await this.active(id, device))!;
    const validated = validateBeautyAnalysis(beauty, requestId);
    if (
      !entry.state.photoConsent ||
      entry.photoInvalidated ||
      !entry.state.attempted ||
      entry.requestId !== requestId ||
      entry.state.beauty.analysis ||
      validated?.prompt_version !== "beauty-style-suggestion-v2" ||
      !isOpenAIAnalysis({
        request_id: requestId,
        mode: "openai",
        model_version: OPENAI_SKIN_MODEL,
        quality_status: skin?.image_quality,
        observations: [],
        disclaimer: OPENAI_SKIN_DISCLAIMER,
        vision: skin,
      })
    )
      throw fail(
        "complete_write_failed",
        "This consultation changed before its observation was saved.",
      );
    entry.state.beauty.analysis = structuredClone(validated);
    entry.state.skinVision = structuredClone(skin);
    await this.repository.markCompleteAnalyzed(id, device);
  }
  async setSkinProfile(
    id: string,
    device: DeviceContext,
    profile: CompleteSkinProfile,
  ) {
    const entry = (await this.active(id, device))!;
    const resolved = canonicalizeIngredients(profile.excludedIngredients);
    if (
      !skinTypes.includes(profile.skinType) ||
      profile.concerns.some((goal) => !concerns.includes(goal)) ||
      profile.excludedIngredients.length > 20 ||
      resolved.unknown.length
    )
      throw fail("invalid_skin_profile", "Check your skincare preferences.");
    entry.state.skinProfile = structuredClone({
      ...profile,
      concerns: [...new Set(profile.concerns)],
      excludedIngredients: resolved.canonical,
    });
    entry.state.beauty.excludedIngredients = [...resolved.canonical];
  }
  async setBaseChoice(id: string, device: DeviceContext, base: BaseChoice) {
    const entry = (await this.active(id, device))!;
    if (!validBaseChoice(base))
      throw fail("invalid_base", "Check the base color direction.");
    entry.state.base = structuredClone(base);
  }
  async confirmCompletePreferences(
    id: string,
    device: DeviceContext,
    preferences: BeautyPreferences,
  ) {
    const entry = (await this.active(id, device))!;
    if (!validBeautyPreferences(preferences))
      throw fail("invalid_preferences", "Check your confirmed choices.");
    if (
      JSON.stringify(preferences) !==
      JSON.stringify(entry.state.beauty.preferences)
    )
      this.cancel(entry);
    entry.state.beauty.preferences = structuredClone(preferences);
  }
  async saveCompleteRecommendations(
    id: string,
    device: DeviceContext,
    policy: Policy,
    items: Recommendation[],
  ) {
    const entry = (await this.active(id, device))!;
    entry.policy = structuredClone(policy);
    entry.recommendations = structuredClone(items);
  }
  async completePreviewConsent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion: string,
  ) {
    const entry = (await this.active(id, device))!;
    if (
      noticeVersion !== COMPLETE_PREVIEW_NOTICE_VERSION ||
      (accepted && !entry.state.photoConsent)
    )
      throw fail(
        "preview_consent_required",
        "Accept the current preview notice after photo permission.",
      );
    entry.state.previewConsent = accepted;
    if (!accepted) this.cancel(entry);
  }
  async createPreviewPlan(id: string, device: DeviceContext) {
    const entry = (await this.active(id, device))!;
    if (
      !entry.state.previewConsent ||
      !entry.state.photoConsent ||
      !entry.state.beauty.preferences ||
      entry.state.beauty.analysis?.prompt_version !==
        "beauty-style-suggestion-v2" ||
      entry.state.beauty.analysis.image_quality !== "usable"
    )
      throw fail(
        "preview_unavailable",
        "Confirm a usable photo direction and preview permission first.",
      );
    if (entry.state.previewPlan)
      throw fail(
        "preview_plan_exists",
        "This session already has a preview plan.",
      );
    entry.previewChoices = JSON.stringify(entry.state.beauty.preferences);
    entry.state.previewPlan = {
      id: randomUUID(),
      deadline: new Date(
        Math.min(this.now() + 12 * 60000, entry.expiresAt),
      ).toISOString(),
      cancelled: false,
      slots: Array.from({ length: 9 }, (_, slot) => ({
        slot,
        kind: slot < 3 ? "makeup" : slot < 6 ? "hair_style" : "hair_color",
        status: "pending",
      })),
    };
    return structuredClone(entry.state.previewPlan);
  }
  private validPlan(entry: Entry, planId: string): CompletePreviewPlan {
    const plan = entry.state.previewPlan;
    if (
      !plan ||
      plan.id !== planId ||
      plan.cancelled ||
      Date.parse(plan.deadline) <= this.now() ||
      !entry.state.photoConsent ||
      !entry.state.previewConsent ||
      entry.previewChoices !== JSON.stringify(entry.state.beauty.preferences)
    ) {
      this.cancel(entry);
      throw fail(
        "preview_changed",
        "The preview plan ended or your choices changed.",
      );
    }
    return plan;
  }
  async claimPreviewSlot(
    id: string,
    device: DeviceContext,
    planId: string,
    slot: number,
  ) {
    const entry = (await this.active(id, device))!;
    const plan = this.validPlan(entry, planId);
    if (
      !Number.isInteger(slot) ||
      slot < 0 ||
      slot > 8 ||
      plan.slots[slot].status !== "pending" ||
      plan.slots.some((item) => item.status === "running") ||
      plan.slots
        .slice(0, slot)
        .some((item) => !["complete", "failed"].includes(item.status))
    )
      throw fail(
        "preview_slot_unavailable",
        "Preview slots run once in their planned order.",
      );
    plan.slots[slot].status = "running";
    const requestId = randomUUID();
    entry.slotRequests.set(slot, requestId);
    return requestId;
  }
  async assertPreviewSlot(
    id: string,
    device: DeviceContext,
    planId: string,
    slot: number,
  ) {
    const entry = (await this.active(id, device))!;
    const plan = this.validPlan(entry, planId);
    if (plan.slots[slot]?.status !== "running" || !entry.slotRequests.has(slot))
      throw fail(
        "preview_slot_unavailable",
        "This preview slot is no longer active.",
      );
  }
  async finishPreviewSlot(
    id: string,
    device: DeviceContext,
    planId: string,
    slot: number,
    status: "complete" | "failed",
  ) {
    const entry = (await this.active(id, device))!;
    const plan = this.validPlan(entry, planId);
    if (plan.slots[slot]?.status !== "running" || !entry.slotRequests.has(slot))
      throw fail(
        "preview_slot_unavailable",
        "This preview slot is no longer active.",
      );
    plan.slots[slot].status = status;
  }
  private cancel(entry: Entry) {
    if (!entry.state.previewPlan) return;
    entry.state.previewPlan.cancelled = true;
    for (const slot of entry.state.previewPlan.slots)
      if (["pending", "running"].includes(slot.status))
        slot.status = "cancelled";
    entry.slotRequests.clear();
  }
  async cancelPreviewPlan(id: string, device: DeviceContext, planId: string) {
    const entry = (await this.active(id, device))!;
    if (entry.state.previewPlan?.id !== planId)
      throw fail("preview_plan_not_found", "This preview plan is unavailable.");
    this.cancel(entry);
  }
  async finishComplete(
    id: string,
    device: DeviceContext,
    gender: GuestGender | null,
  ) {
    const entry = await this.active(id, device, false).catch(async (error) => {
      if (error instanceof AppError && error.code === "session_not_found")
        return null;
      throw error;
    });
    if (!entry) {
      await this.repository.finish(id, device);
      return;
    }
    if (entry.finishing) return;
    entry.finishing = true;
    const completed =
      !!entry.state.beauty.preferences || !!entry.state.skinVision;
    const guest = entry.state.guest;
    if (completed && adult(guest) && guest?.analyticsConsent) {
      const week = utcWeek(this.now());
      const key = `${device.storeId}:${week}`;
      const aggregate = this.aggregates.get(key) ?? {
        week,
        store: device.storeId,
        age: {},
        gender: {},
      };
      aggregate.age[guest.ageBand] = (aggregate.age[guest.ageBand] ?? 0) + 1;
      if (
        gender &&
        [
          "woman",
          "man",
          "nonbinary",
          "self_described",
          "prefer_not_to_say",
        ].includes(gender)
      )
        aggregate.gender[gender] = (aggregate.gender[gender] ?? 0) + 1;
      this.aggregates.set(key, aggregate);
    }
    this.cancel(entry);
    await this.repository.finishCompleteSession(id, device, completed);
    this.entries.delete(id);
  }
  async cosmeticShades(storeId: string) {
    const products = await this.repository.products(storeId);
    const legacy = await this.repository.lipShades(storeId);
    const ids = new Set(products.map((product) => product.id));
    return structuredClone([
      ...this.shades.filter((shade) => ids.has(shade.variantId)),
      ...legacy
        .filter(
          (shade) =>
            !this.shades.some(
              (current) => current.variantId === shade.variantId,
            ),
        )
        .map((shade) => ({ ...shade, category: "lip_color" as const })),
    ]);
  }
  async publishCosmeticShade(
    storeId: string,
    variantId: string,
    draft: CosmeticShadeDraft,
  ) {
    const product = (await this.repository.products(storeId)).find(
      (row) => row.id === variantId,
    );
    if (
      !product ||
      product.category !== draft.category ||
      !validCosmeticShadeDraft(draft)
    )
      throw fail(
        "invalid_shade",
        "Review the product category and shade details.",
      );
    const previous = this.shades.find((row) => row.variantId === variantId);
    this.shades = this.shades.filter((row) => row.variantId !== variantId);
    this.shades.push({
      ...structuredClone(draft),
      variantId,
      organizationId: product.organizationId,
      version: (previous?.version ?? 0) + 1,
      versionId: randomUUID(),
    });
  }
  async saveCompleteGuide(): Promise<{ expiresAt: string }> {
    throw fail(
      "sharing_unavailable",
      "Phone sharing needs a connected database and public HTTPS address.",
    );
  }
  async readCompleteGuide(): Promise<CompleteSavedGuide> {
    throw new AppError(
      404,
      "guide_not_found",
      "This saved guide is unavailable.",
    );
  }
  async revokeCompleteGuide(): Promise<void> {
    throw new AppError(
      404,
      "guide_not_found",
      "This saved guide is unavailable.",
    );
  }
  async demographics(storeId: string): Promise<BeautyDemographics> {
    await this.repository.products(storeId);
    this.sweep();
    const end = utcWeek(this.now());
    const start = end - 4 * 7 * 86400000;
    const age: Record<string, number> = {},
      gender: Record<string, number> = {};
    for (const row of this.aggregates.values())
      if (row.store === storeId && row.week >= start && row.week < end) {
        for (const [key, count] of Object.entries(row.age))
          age[key] = (age[key] ?? 0) + count;
        for (const [key, count] of Object.entries(row.gender))
          gender[key] = (gender[key] ?? 0) + count;
      }
    const distribution = (counts: Record<string, number>) =>
      Object.values(counts).some((count) => count > 0 && count < 10)
        ? { suppressed: true, counts: {} }
        : { suppressed: false, counts };
    return {
      periodStart: new Date(start).toISOString(),
      periodEnd: new Date(end).toISOString(),
      unit: "completed_sessions",
      age: distribution(age),
      gender: distribution(gender),
    };
  }
}

const globals = globalThis as typeof globalThis & {
  aeluneDemoComplete?: DemoBeautyCompleteRepository;
};
export const demoBeautyCompleteRepository = (globals.aeluneDemoComplete ??=
  new DemoBeautyCompleteRepository(demoRepository));
