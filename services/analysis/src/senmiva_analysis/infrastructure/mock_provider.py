from senmiva_analysis.domain.models import ConcernId, Level, Observation, SkinProfile, SkinType


class MockAnalysisProvider:
    mode = "mock"
    model_version = "mock-1.0"
    quality_status = "demo"
    disclaimer = (
        "Demo results generated from your questionnaire, not from a photo or AI skin measurement. "
        "For cosmetic guidance only; not a medical diagnosis."
    )

    _dehydration = {
        SkinType.NORMAL: 0.28,
        SkinType.DRY: 0.78,
        SkinType.OILY: 0.31,
        SkinType.COMBINATION: 0.52,
        SkinType.UNSURE: 0.45,
    }
    _texture = {
        SkinType.NORMAL: 0.36,
        SkinType.DRY: 0.48,
        SkinType.OILY: 0.61,
        SkinType.COMBINATION: 0.53,
        SkinType.UNSURE: 0.42,
    }

    def analyze(self, profile: SkinProfile) -> tuple[Observation, ...]:
        scores = {
            ConcernId.DEHYDRATION: self._dehydration[profile.skin_type],
            ConcernId.TEXTURE: self._texture[profile.skin_type],
            ConcernId.UNEVEN_TONE: 0.47,
            ConcernId.FINE_LINES: 0.39,
        }
        # Deliberately illustrative fixtures. These are not clinically calibrated scores.
        return tuple(
            Observation(concern, self._level(scores[concern]), scores[concern])
            for concern in profile.concern_ids
        )

    @staticmethod
    def _level(score: float) -> Level:
        if score < 0.34:
            return Level.LOW
        if score < 0.67:
            return Level.MODERATE
        return Level.HIGH
