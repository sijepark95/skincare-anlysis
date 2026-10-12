"""Adapter wiring only: generated codes and no Torch, photos or private artifacts."""

import sys
from types import ModuleType

import pytest

from senmiva_analysis.application.ports import ProviderUnavailableError
from senmiva_analysis.domain.models import ConcernId, SkinProfile, SkinType
from senmiva_analysis.infrastructure.experimental_provider import ExperimentalAnalysisProvider
from senmiva_analysis.settings import Settings


CODES = {"sensitivity": "NS", "pigmentation": "P1", "wrinkles": "W1", "acne": "NA",
         "pores": "VP", "sagging": "SA", "keratin": "ND", "redness": "NR"}


@pytest.fixture
def adapter(tmp_path, monkeypatch):
    calls = {"photo": [], "ingredients": [], "init": []}

    class ImageError(ValueError):
        pass

    class Photo:
        def __init__(self, *args, **kwargs):
            pass

        def metadata(self):
            return {"model_run": "synthetic-photo", "checkpoint_epoch": 1}

        def predict_image(self, image):
            calls["photo"].append(image)
            return {"heads": [{"key": key, "predicted_code": value,
                               "probabilities": [{"code": value, "probability": 1.0}]}
                              for key, value in reversed(tuple(CODES.items()))]}

    class Ingredients:
        def __init__(self, *args, **kwargs):
            calls["init"].append(kwargs)

        def predict_kiosk(self, skin_type, concerns, *, visual_codes=None):
            calls["ingredients"].append((skin_type, concerns, visual_codes))
            return {"model_version": "synthetic-ingredients", "candidates": [{"ingredient": "Panthenol", "score": .7}],
                    "input_coverage": ["visual_condition_used_source_contract_v1" if visual_codes else "no_photo_questionnaire_only"]}

    package = ModuleType("senmiva_training")
    package.__path__ = []
    monkeypatch.setitem(sys.modules, "senmiva_training", package)
    for name, attributes in {
        "photo_inference": {"PhotoInputError": ImageError, "PhotoPredictor": Photo},
        "ingredient_inference": {"IngredientPredictor": Ingredients},
        "workspace": {"private_output": lambda path: path},
    }.items():
        module = ModuleType(f"senmiva_training.{name}")
        for key, value in attributes.items():
            setattr(module, key, value)
        monkeypatch.setitem(sys.modules, module.__name__, module)
    provider = ExperimentalAnalysisProvider(Settings(api_key="synthetic-secret-longer-than-32-chars", provider="experimental", ml_workspace=tmp_path))
    return provider, calls, tmp_path


def test_exact_photo_codes_enter_ranking_without_overriding_questionnaire(adapter):
    provider, calls, workspace = adapter
    profile = SkinProfile((ConcernId.DEHYDRATION, ConcernId.FINE_LINES), SkinType.DRY, True)
    visual, ingredients = provider.analyze(profile, b"generated-not-a-person")
    assert calls["ingredients"] == [("dry", ("dehydration", "fine_lines"), CODES)]
    assert len(visual.heads) == 8
    assert ingredients.input_coverage == ("visual_condition_used_source_contract_v1",)
    assert calls["init"] == [{"condition_support": workspace / "contracts" / "ingredients-001-source-codes-v1.json"}]
    assert provider.model_version.endswith(":source-codes-v1")
    assert profile.sensitive is True


def test_no_photo_keeps_questionnaire_only_path(adapter):
    provider, calls, _ = adapter
    visual, ingredients = provider.analyze(SkinProfile((ConcernId.TEXTURE,), SkinType.UNSURE, False), None)
    assert visual is None and not calls["photo"]
    assert calls["ingredients"] == [("unsure", ("texture",), None)]
    assert ingredients.input_coverage == ("no_photo_questionnaire_only",)


@pytest.mark.parametrize("fault", ["partial", "duplicate", "unknown"])
def test_invalid_photo_contract_does_not_reach_ranking_and_releases_slot(adapter, monkeypatch, fault):
    provider, calls, _ = adapter
    original = provider._photo.predict_image
    heads = original(b"synthetic")["heads"]
    if fault == "partial":
        heads.pop()
    elif fault == "duplicate":
        heads[0] = heads[1]
    else:
        heads[0]["key"] = "invented"
    monkeypatch.setattr(provider._photo, "predict_image", lambda _: {"heads": heads})
    profile = SkinProfile((ConcernId.TEXTURE,), SkinType.NORMAL, False)
    with pytest.raises(ProviderUnavailableError, match="no result was saved"):
        provider.analyze(profile, b"synthetic")
    assert not calls["ingredients"]
    assert provider._slot.acquire(blocking=False)
    provider._slot.release()
