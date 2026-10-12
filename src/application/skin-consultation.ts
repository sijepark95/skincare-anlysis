import { buildSkinConsultation } from "@/domain/skin-consultation";
import { validateCatalogDraft } from "@/domain/catalog";
import { canonicalizeIngredients } from "@/domain/ingredients";
import { isOpenAIAnalysis } from "@/domain/skin-vision";
import { isSkincareCategory } from "@/domain/skin-recommendation-context";
import {
  AppError,
  type Consultation,
  type DeviceContext,
  type Repository,
} from "./contracts";

/** A derived read model: no image reads, new AI calls, personal-text storage or ranking changes. */
export async function readSkinConsultation(
  repository: Repository,
  id: string,
  device: DeviceContext,
): Promise<Consultation> {
  const session = await repository.session(id, device);
  if (session.analysis?.mode !== "openai") return session;
  if (!session.answers || session.recommendations === null)
    return { ...session, skinConsultation: null };
  if (!isOpenAIAnalysis(session.analysis))
    throw new AppError(
      503,
      "invalid_analysis",
      "The saved photo observations could not be verified.",
    );

  const [policy, catalog] = await Promise.all([
    repository.policy(device, id),
    repository.products(device.storeId),
  ]);
  const current = await repository.session(id, device);
  // Expiry/finish/revoke must also invalidate a read that was assembling the report.
  if (
    !current.consent ||
    !current.answers ||
    !current.analysis ||
    !isOpenAIAnalysis(current.analysis) ||
    current.analysis.request_id !== session.analysis.request_id
  )
    throw new AppError(
      409,
      "consultation_changed",
      "This consultation has ended. Please start again.",
    );
  const exclusions = canonicalizeIngredients(
    current.answers.excludedIngredients,
  );
  const remaining = new Map(
    (current.recommendations ?? []).map((item) => [item.product.id, item]),
  );
  const seen = new Set<string>();
  // Reload only previously selected IDs. Current catalog edits can remove matches,
  // never introduce products or change their original order/score.
  const recommendations = session.recommendations.flatMap((item) => {
    const catalogProduct = catalog.find(
      (candidate) => candidate.id === item.product.id,
    );
    const product = remaining.get(item.product.id)?.product;
    if (
      !product ||
      !catalogProduct ||
      seen.has(product.id) ||
      product.organizationId !== device.organizationId ||
      product.storeId !== device.storeId ||
      !isSkincareCategory(product.category) ||
      product.status !== "published" ||
      !product.visible ||
      product.stock <= 0 ||
      !validateCatalogDraft(product).valid ||
      catalogProduct.organizationId !== device.organizationId ||
      catalogProduct.storeId !== device.storeId ||
      catalogProduct.status !== "published" ||
      !catalogProduct.visible ||
      catalogProduct.stock <= 0 ||
      !validateCatalogDraft(catalogProduct).valid ||
      exclusions.unknown.length > 0
    )
      return [];
    const formula = new Set(
      canonicalizeIngredients(product.ingredients).canonical,
    );
    const catalogFormula = new Set(
      canonicalizeIngredients(catalogProduct.ingredients).canonical,
    );
    if (
      exclusions.canonical.some(
        (ingredient) =>
          formula.has(ingredient) || catalogFormula.has(ingredient),
      ) ||
      item.matchedIngredients.some(
        (ingredient) =>
          !formula.has(ingredient) || !catalogFormula.has(ingredient),
      )
    )
      return [];
    seen.add(product.id);
    return [{ ...item, product }];
  });
  const report = buildSkinConsultation({
    vision: current.analysis.vision,
    questionnaire: current.answers,
    rules: policy.rules,
    recommendations,
    policyVersion: policy.version,
    policySource: policy.source,
  });
  // A removed or changed reason cannot leave an unexplained product on the screen.
  const explainedIds = new Set(
    report.products.map((product) => product.productId),
  );
  return {
    ...current,
    recommendations: recommendations.filter((item) =>
      explainedIds.has(item.product.id),
    ),
    skinConsultation: report,
  };
}
