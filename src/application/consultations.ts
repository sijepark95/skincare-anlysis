import { recommendProducts } from "@/domain/recommendations";
import { canonicalizeIngredients } from "@/domain/ingredients";
import {
  buildExplanationInput,
  validateExplanationPlan,
  renderExplanation,
  fallbackExplanation,
  EXPLANATION_NOTICE_VERSION,
  type ExplanationBasis,
} from "@/domain/explanations";
import type { ExplanationProvider } from "./explanation-contracts";
import { readSkinConsultation } from "./skin-consultation";
import {
  OPENAI_CONSENT_VERSION,
  VISION_NOTICE_VERSION,
  isOpenAIAnalysis,
  visibleRecommendationConcerns,
} from "@/domain/skin-vision";
import {
  AppError,
  type Analysis,
  type AnalysisProvider,
  type Answers,
  type Consultation,
  type DeviceContext,
  type Repository,
} from "./contracts";

export class Consultations {
  constructor(
    private readonly repository: Repository,
    private readonly analyzer: AnalysisProvider,
    private readonly explainer: ExplanationProvider | null = null,
    private readonly mode: "mock" | "experimental" | "openai" = "mock",
  ) {}
  start(device: DeviceContext) {
    return this.repository.start(device);
  }
  async consent(
    id: string,
    device: DeviceContext,
    accepted: boolean,
    noticeVersion = "2026-10-mvp",
  ) {
    await this.repository.session(id, device);
    await this.repository.consent(id, device, accepted, noticeVersion);
    if (!accepted) await this.repository.finish(id, device);
  }
  async answers(id: string, device: DeviceContext, answers: Answers) {
    const session = await this.repository.session(id, device);
    if (!session.consent)
      throw new AppError(
        409,
        "consent_required",
        "Please accept the privacy notice first.",
      );
    if (session.analysis) {
      // A retry may resubmit preferences after analysis succeeded but recommendations failed.
      // Keep accepted answers immutable while allowing the same operation to be replayed.
      if (session.answers && sameAnswers(session.answers, answers)) return;
      throw new AppError(
        409,
        "already_analyzed",
        "Start a new consultation to change your answers.",
      );
    }
    await this.repository.answers(id, device, answers);
  }
  async analyze(
    id: string,
    device: DeviceContext,
    image?: Uint8Array,
    requiredNoticeVersion?: string,
  ): Promise<Consultation> {
    let session = await this.repository.session(id, device);
    const noticeVersion =
      this.mode === "openai" ? OPENAI_CONSENT_VERSION : requiredNoticeVersion;
    if (!session.consent || !session.answers)
      throw new AppError(
        409,
        "answers_required",
        "Complete consent and your preferences first.",
      );
    if (noticeVersion && session.consentVersion !== noticeVersion)
      throw new AppError(
        409,
        "consent_required",
        "Start a new consultation and accept the current privacy notice first.",
      );
    if (!session.analysis) {
      if (this.mode === "openai" && image) {
        assertVisionConsent(session);
        if (!(await this.repository.claimVisionAnalysis(id, device))) {
          const cached = await this.repository.session(id, device);
          if (cached.analysis)
            return this.analyze(id, device, undefined, noticeVersion);
          throw new AppError(
            409,
            "vision_already_attempted",
            "Photo analysis has already been attempted. Continue without a photo or start a new session.",
          );
        }
        // A revocation/finish or photo-free completion can race the durable claim.
        const admitted = await this.repository.session(id, device);
        assertVisionConsent(admitted);
        if (
          !admitted.answers ||
          !sameAnswers(admitted.answers, session.answers)
        )
          throw new AppError(
            409,
            "consultation_changed",
            "The consultation changed. Please start again.",
          );
        if (admitted.analysis)
          return this.analyze(id, device, undefined, noticeVersion);
      }
      const result = await this.analyzer.analyze(id, session.answers, image);
      if (
        this.mode === "openai" &&
        (!isOpenAIAnalysis(result) ||
          (result.vision !== null) !== Boolean(image))
      )
        throw new AppError(
          503,
          "analysis_unavailable",
          "Photo observations could not be verified. Continue without a photo.",
        );
      // Recheck ownership and liveness after the network operation, before writing results.
      const current = await this.repository.session(id, device);
      if (
        !current.consent ||
        (noticeVersion && current.consentVersion !== noticeVersion) ||
        !current.answers ||
        !sameAnswers(current.answers, session.answers)
      )
        throw new AppError(
          409,
          "consultation_changed",
          "The consultation changed. Please start again.",
        );
      if (this.mode === "openai" && image) assertVisionConsent(current);
      // A concurrent photo-free completion is immutable and must not be replaced.
      if (this.mode === "openai" && current.analysis)
        return this.analyze(id, device, undefined, noticeVersion);
      await this.repository.saveAnalysis(id, device, result);
      session = await this.repository.session(id, device);
    }
    if (this.mode === "openai" && !isOpenAIAnalysis(session.analysis))
      throw new AppError(
        409,
        "analysis_mode_changed",
        "Start a new consultation for the current photo analysis.",
      );
    if (!session.recommendations) {
      const policy = await this.repository.policy(device);
      const photoConcerns =
        session.analysis?.mode === "openai"
          ? visibleRecommendationConcerns(session.analysis.vision)
          : [];
      const rankingAnswers: Answers = {
        ...session.answers!,
        concerns: [
          ...new Set([...session.answers!.concerns, ...photoConcerns]),
        ],
        concernWeights: {
          ...session.answers!.concernWeights,
          ...Object.fromEntries(
            photoConcerns
              .filter((concern) => !session.answers!.concerns.includes(concern))
              .map((concern) => [concern, 1]),
          ),
        },
      };
      const items = recommendProducts(
        await this.repository.products(device.storeId),
        rankingAnswers,
        {
          ...device,
          limit: 3,
          rules: policy.rules,
          ...(session.analysis?.mode === "openai"
            ? { priorityConcerns: photoConcerns }
            : {}),
          ...(session.analysis?.mode === "experimental"
            ? { ingredientCandidates: session.analysis.ingredients.candidates }
            : {}),
        },
      );
      await this.repository.saveRecommendations(id, device, policy, items);
    }
    return readSkinConsultation(this.repository, id, device);
  }
  finish(id: string, device: DeviceContext) {
    return this.repository.finish(id, device);
  }
  async explain(id: string, device: DeviceContext) {
    if (this.mode === "openai")
      throw new AppError(
        409,
        "explanation_disabled",
        "Your photo observations are ready without a separate AI explanation request.",
      );
    const session = await this.repository.session(id, device);
    if (
      !session.consent ||
      !session.analysis ||
      !session.recommendations ||
      session.explanationConsent?.accepted !== true ||
      session.explanationConsent.noticeVersion !== EXPLANATION_NOTICE_VERSION
    )
      throw new AppError(
        409,
        "explanation_consent_required",
        "Accept the optional AI explanation notice before analysis.",
      );
    if (session.explanation) return session;
    // A durable claim precedes any external request, including concurrent requests/restarts.
    if (!(await this.repository.claimExplanation(id, device)))
      return this.repository.session(id, device);
    // Provenance stays local. The hosted model receives matching facts only,
    // already influenced by photo-derived candidate scores when supported.
    const analysisBasis = explanationBasis(session.analysis);
    let result = fallbackExplanation(session.recommendations, analysisBasis);
    if (this.explainer && session.recommendations.length) {
      try {
        const input = buildExplanationInput(session.recommendations);
        const plan = validateExplanationPlan(
          input,
          await this.explainer.explain(input),
        );
        result = renderExplanation(session.recommendations, plan, {
          status: "generated",
          modelVersion: this.explainer.modelVersion,
          analysisBasis,
        });
      } catch {
        // Neither provider bodies nor generated content are logged or shown on failure.
      }
    }
    // Finish/revoke/expiry during a network call must prevent late persistence.
    const current = await this.repository.session(id, device);
    if (
      !current.consent ||
      current.explanationConsent?.accepted !== true ||
      current.explanationConsent.noticeVersion !== EXPLANATION_NOTICE_VERSION
    )
      throw new AppError(
        409,
        "consultation_changed",
        "The consultation changed. Please start again.",
      );
    await this.repository.saveExplanation(id, device, result);
    return this.repository.session(id, device);
  }
}

function explanationBasis(analysis: Analysis): ExplanationBasis {
  if (analysis.mode === "mock") return "mock";
  if (analysis.mode === "openai") return "questionnaire_only";
  if (!analysis.visual) return "questionnaire_only";
  const coverage = new Set(analysis.ingredients.input_coverage);
  const usedPhoto = coverage.has("visual_condition_used_source_contract_v1");
  const omitted = [
    "visual_codes_not_used_for_ingredients",
    "initial_skin_condition_omitted",
    "visual_condition_unseen_in_training_omitted",
    "visual_condition_support_unavailable_omitted",
    "no_photo_questionnaire_only",
  ].some((flag) => coverage.has(flag));
  if (
    usedPhoto &&
    !omitted &&
    analysis.visual.heads.length === 8 &&
    coverage.has("source_code_contract_aihub71886_v1") &&
    coverage.has("visual_condition_exact_training_category")
  )
    return "photo_contributed";
  if (!usedPhoto && coverage.has("visual_condition_unseen_in_training_omitted"))
    return "photo_unseen";
  return "photo_not_used";
}

function assertVisionConsent(
  session: Awaited<ReturnType<Repository["session"]>>,
) {
  if (
    !session.consent ||
    session.consentVersion !== OPENAI_CONSENT_VERSION ||
    session.visionConsent?.accepted !== true ||
    session.visionConsent.noticeVersion !== VISION_NOTICE_VERSION
  )
    throw new AppError(
      409,
      "vision_consent_required",
      "Accept the separate photo-transfer notice before using AI photo analysis.",
    );
}

function sameAnswers(left: Answers, right: Answers): boolean {
  const sorted = (values: readonly string[]) =>
    JSON.stringify([...new Set(values)].sort());
  const exclusions = (values: string[]) => {
    const normalized = canonicalizeIngredients(values);
    return sorted([
      ...normalized.canonical,
      ...normalized.unknown.map(
        (value) => `unknown:${value.trim().toLowerCase()}`,
      ),
    ]);
  };
  return (
    left.skinType === right.skinType &&
    left.sensitive === right.sensitive &&
    sorted(left.concerns) === sorted(right.concerns) &&
    exclusions(left.excludedIngredients) ===
      exclusions(right.excludedIngredients) &&
    left.concerns.every(
      (concern) =>
        (left.concernWeights?.[concern] ?? 1) ===
        (right.concernWeights?.[concern] ?? 1),
    )
  );
}
