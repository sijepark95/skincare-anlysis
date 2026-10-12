"""Private, memory-only adapters for explicitly selected offline experiments."""

import threading

from senmiva_analysis.application.ports import ImageRejectedError, ProviderBusyError, ProviderUnavailableError
from senmiva_analysis.domain.models import IngredientCandidate, IngredientOutput, ModelProbability, SkinProfile, VisualHead, VisualOutput
from senmiva_analysis.settings import Settings


LABELS = {"sensitivity": "Sensitivity", "pigmentation": "Pigmentation", "wrinkles": "Wrinkles",
          "acne": "Acne", "pores": "Pores", "sagging": "Sagging", "keratin": "Keratin", "redness": "Redness"}


class ExperimentalAnalysisProvider:
    disclaimer = ("Experimental local models; not a diagnosis or a calibrated skin measurement. "
                  "Visual class-code meanings and capture quality are unverified. Ingredient candidates use partial questionnaire features "
                  "and a photo-derived whole source-code category only when verified in recommendation training. "
                  "The combined pipeline is unvalidated and targets are unreviewed silver labels. "
                  "Scores do not establish efficacy, concentration or allergy safety. Photos are processed in memory and never saved or used for training.")

    def __init__(self, settings: Settings) -> None:
        try:
            from senmiva_training.photo_inference import PhotoInputError, PhotoPredictor
            from senmiva_training.ingredient_inference import IngredientPredictor
            from senmiva_training.workspace import private_output
            workspace = private_output(settings.ml_workspace)
            self._photo = PhotoPredictor(workspace / "manifests" / settings.photo_manifest,
                                         workspace / "runs" / settings.photo_run, device=settings.device)
            self._ingredients = IngredientPredictor(workspace / "manifests" / settings.ingredient_manifest,
                                                    workspace / "runs" / settings.ingredient_run,
                                                    condition_support=workspace / "contracts" / f"{settings.ingredient_manifest}-source-codes-v1.json")
            self._image_error = PhotoInputError
            info = self._photo.metadata()
            self._photo_version = f"{info['model_run']}:best:epoch-{info['checkpoint_epoch']}"
            self.model_version = f"{info['model_run']}+{settings.ingredient_run}:source-codes-v1"
            self._slot = threading.Lock()
        except Exception:
            raise ProviderUnavailableError("Verified local experimental models are unavailable; startup refused.") from None

    def analyze(self, profile: SkinProfile, image: bytes | None) -> tuple[VisualOutput | None, IngredientOutput]:
        if not self._slot.acquire(blocking=False):
            raise ProviderBusyError("Analysis is busy; try again.")
        try:
            visual = None
            visual_codes = None
            if image is not None:
                try:
                    photo = self._photo.predict_image(image)
                except self._image_error:
                    raise ImageRejectedError("Use a static JPEG, PNG or WebP, at least 224 pixels per side, up to 10 MiB and 25 million pixels.") from None
                visual = VisualOutput(self._photo_version, tuple(VisualHead(head["key"], LABELS[head["key"]], head["predicted_code"],
                                      tuple(ModelProbability(**item) for item in head["probabilities"])) for head in photo["heads"]))
                visual_codes = {head.key: head.predicted_code for head in visual.heads}
                if len(visual.heads) != 8 or len(visual_codes) != 8:
                    raise ValueError("Invalid visual source-code contract.")
            output = self._ingredients.predict_kiosk(profile.skin_type.value, tuple(concern.value for concern in profile.concern_ids),
                                                     visual_codes=visual_codes)
            ingredients = IngredientOutput(output["model_version"], tuple(IngredientCandidate(**item) for item in output["candidates"]), tuple(output["input_coverage"]))
            return visual, ingredients
        except (ImageRejectedError, ProviderBusyError):
            raise
        except Exception:
            raise ProviderUnavailableError("Experimental inference failed; no result was saved.") from None
        finally:
            self._slot.release()
