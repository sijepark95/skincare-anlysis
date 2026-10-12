import base64
import binascii

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from senmiva_analysis.api.boundary import PrivateAnalysisBoundary
from senmiva_analysis.api.contracts import AnalyzeRequest, AnalyzeResponse, ExperimentalRequest, ExperimentalResponse, OpenAIPhotoResponse, MAX_IMAGE_BYTES
from senmiva_analysis.api.color_contracts import ColorPhotoRequest
from senmiva_analysis.application.color_analysis import AnalyzeColorAppearance, ColorAnalysisProvider
from senmiva_analysis.domain.color import ColorAnalysisResponse
from senmiva_analysis.infrastructure.color_protocol import OpenAIColorProvider
from senmiva_analysis.api.beauty_contracts import BeautyPhotoRequest, BeautyMakeupRequest, BeautyPreviewRequest
from senmiva_analysis.application.beauty_complete import AnalyzeBeautyComplete, BeautyCompleteProvider
from senmiva_analysis.domain.beauty_complete import BeautyCompleteResponse
from senmiva_analysis.infrastructure.beauty_complete_provider import OpenAIBeautyCompleteProvider
from senmiva_analysis.application.beauty_preview import GenerateBeautyPreview, BeautyPreviewProvider
from senmiva_analysis.domain.beauty_preview import BeautyPreviewResponse
from senmiva_analysis.infrastructure.beauty_preview_provider import OpenAIBeautyPreviewProvider
from senmiva_analysis.application.beauty_analysis import AnalyzeBeautyAppearance, BeautyAnalysisProvider
from senmiva_analysis.domain.beauty import BeautyAnalysisResponse
from senmiva_analysis.infrastructure.beauty_protocol import OpenAIBeautyProvider
from senmiva_analysis.application.beauty_makeup import BeautyMakeupProvider, GenerateBeautyMakeup
from senmiva_analysis.domain.beauty_makeup import BeautyMakeupResponse
from senmiva_analysis.infrastructure.beauty_makeup_provider import OpenAIBeautyMakeupProvider
from senmiva_analysis.application.analyze import AnalyzeSkinProfile
from senmiva_analysis.application.experimental import AnalyzeExperimentalProfile
from senmiva_analysis.application.photo_analysis import AnalyzePhotoAppearance
from senmiva_analysis.application.ports import ExperimentalProvider, ImageRejectedError, PhotoAnalysisProvider, ProviderBusyError, ProviderRefusedError, ProviderUnavailableError
from senmiva_analysis.domain.models import SkinProfile
from senmiva_analysis.infrastructure.mock_provider import MockAnalysisProvider
from senmiva_analysis.infrastructure.experimental_provider import ExperimentalAnalysisProvider
from senmiva_analysis.infrastructure.openai_provider import OpenAIPhotoProvider
from senmiva_analysis.settings import Settings


def create_app(settings: Settings | None = None, *, experimental_provider: ExperimentalProvider | None = None,
               openai_provider: PhotoAnalysisProvider | None = None,
               color_provider: ColorAnalysisProvider | None = None,
               beauty_provider: BeautyAnalysisProvider | None = None,
               beauty_makeup_provider: BeautyMakeupProvider | None = None,
               beauty_complete_provider: BeautyCompleteProvider | None = None,
               beauty_preview_provider: BeautyPreviewProvider | None = None) -> FastAPI:
    configured = settings or Settings.from_environment()
    use_case = AnalyzeSkinProfile(MockAnalysisProvider())
    experimental = None
    if configured.provider == "experimental":
        experimental = AnalyzeExperimentalProfile(experimental_provider or ExperimentalAnalysisProvider(configured))
    photo_analysis = None
    color_analysis = None
    beauty_analysis = None
    beauty_makeup = None
    beauty_complete = None
    beauty_preview = None
    if configured.provider == "openai":
        photo_analysis = AnalyzePhotoAppearance(openai_provider or OpenAIPhotoProvider(configured))
        color_analysis = AnalyzeColorAppearance(color_provider or OpenAIColorProvider(configured))
        beauty_analysis = AnalyzeBeautyAppearance(beauty_provider or OpenAIBeautyProvider(configured))
        beauty_complete = AnalyzeBeautyComplete(beauty_complete_provider or OpenAIBeautyCompleteProvider(configured))
        if configured.beauty_makeup_enabled:
            beauty_makeup = GenerateBeautyMakeup(beauty_makeup_provider or OpenAIBeautyMakeupProvider(configured))
        if configured.beauty_preview_enabled:
            beauty_preview = GenerateBeautyPreview(beauty_preview_provider or OpenAIBeautyPreviewProvider(configured))
    app = FastAPI(
        title="Senmiva private analysis",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    app.add_middleware(PrivateAnalysisBoundary, api_key=configured.api_key)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError):
        # Do not echo rejected input (which could accidentally contain a photo or personal data).
        return JSONResponse(status_code=422, content={"detail": "Invalid analysis request."})

    @app.get("/healthz")
    def health() -> dict[str, str]:
        return {"status": "ok", "mode": configured.provider}

    @app.post("/v1/analyze", response_model=AnalyzeResponse)
    def analyze(body: AnalyzeRequest) -> AnalyzeResponse:
        if configured.provider != "mock":
            raise HTTPException(503, "Mock analysis is disabled in the configured mode.")
        result = use_case.execute(
            body.request_id,
            SkinProfile(tuple(body.concern_ids), body.skin_type, body.sensitive),
        )
        return AnalyzeResponse.model_validate(result)

    @app.post("/v1/analyze/experimental", response_model=ExperimentalResponse)
    def analyze_experimental(body: ExperimentalRequest) -> ExperimentalResponse:
        if experimental is None:
            raise HTTPException(503, "Experimental analysis is not configured.")
        image = None
        try:
            if body.image_base64 is not None:
                try:
                    image = base64.b64decode(body.image_base64, validate=True)
                except (ValueError, binascii.Error):
                    raise HTTPException(422, "Invalid image encoding.") from None
                if not image or len(image) > MAX_IMAGE_BYTES:
                    raise HTTPException(413, "Analysis image is too large or empty.")
            result = experimental.execute(body.request_id, SkinProfile(tuple(body.concern_ids), body.skin_type, body.sensitive), image)
            return ExperimentalResponse.model_validate(result)
        except ImageRejectedError:
            raise HTTPException(422, "Use a static JPEG, PNG or WebP, at least 224 pixels per side, up to 10 MiB and 25 million pixels.") from None
        except ProviderBusyError:
            raise HTTPException(429, "Analysis is busy; try again.") from None
        except Exception as error:
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(503, "Experimental analysis is unavailable; try again.") from None
        finally:
            image = None
            # Drop the base64 reference as soon as inference finishes. No temp files.
            body.image_base64 = None

    @app.post("/v1/analyze/openai", response_model=OpenAIPhotoResponse)
    def analyze_openai(body: ExperimentalRequest) -> OpenAIPhotoResponse:
        if photo_analysis is None:
            raise HTTPException(503, "OpenAI photo observation is not configured.")
        image = None
        try:
            if body.image_base64 is not None:
                try:
                    image = base64.b64decode(body.image_base64, validate=True)
                except (ValueError, binascii.Error):
                    raise HTTPException(422, "Invalid image encoding.") from None
                if not image or len(image) > MAX_IMAGE_BYTES:
                    raise HTTPException(413, "Analysis image is too large or empty.")
            return OpenAIPhotoResponse.model_validate(photo_analysis.execute(body.request_id, image))
        except ImageRejectedError:
            raise HTTPException(422, "Use a static JPEG, PNG or WebP, at least 224 pixels per side, up to 10 MiB and 25 million pixels.") from None
        except ProviderRefusedError:
            raise HTTPException(422, "Photo observation could not be provided. Continue without a photo or choose another image.") from None
        except ProviderBusyError:
            raise HTTPException(429, "Analysis is busy; try again.") from None
        except Exception as error:
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(503, "OpenAI photo observation is unavailable. Continue without a photo.") from None
        finally:
            image = None
            body.image_base64 = None

    @app.post("/v1/analyze/color", response_model=ColorAnalysisResponse)
    def analyze_color(body: ColorPhotoRequest) -> ColorAnalysisResponse:
        if color_analysis is None:
            raise HTTPException(503, "OpenAI colour suggestion is not configured.")
        image = None
        try:
            try:
                image = base64.b64decode(body.image_base64, validate=True)
            except (ValueError, binascii.Error):
                raise HTTPException(422, "Invalid image encoding.") from None
            if not image or len(image) > MAX_IMAGE_BYTES:
                raise HTTPException(413, "Analysis image is too large or empty.")
            return color_analysis.execute(body.request_id, image)
        except ImageRejectedError:
            raise HTTPException(422, "Use a static JPEG, PNG or WebP, at least 224 pixels per side, up to 10 MiB and 25 million pixels.") from None
        except ProviderRefusedError:
            raise HTTPException(422, "Colour suggestion could not be provided. Choose a palette yourself or finish this session.") from None
        except ProviderBusyError:
            raise HTTPException(429, "Analysis is busy; try again.") from None
        except Exception as error:
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(503, "Colour suggestion is unavailable. Choose a palette yourself.") from None
        finally:
            image = None
            body.image_base64 = ""

    @app.post("/v1/analyze/beauty", response_model=BeautyAnalysisResponse)
    def analyze_beauty(body: BeautyPhotoRequest) -> BeautyAnalysisResponse:
        if beauty_analysis is None:
            raise HTTPException(503, "OpenAI beauty suggestion is not configured.")
        image = None
        try:
            try:
                image = base64.b64decode(body.image_base64, validate=True)
            except (ValueError, binascii.Error):
                raise HTTPException(422, "Invalid image encoding.") from None
            if not image or len(image) > MAX_IMAGE_BYTES:
                raise HTTPException(413, "Analysis image is too large or empty.")
            return beauty_analysis.execute(body.request_id, image)
        except ImageRejectedError:
            raise HTTPException(422, "Use a static JPEG, PNG or WebP, at least 224 pixels per side, up to 10 MiB and 25 million pixels.") from None
        except ProviderRefusedError:
            raise HTTPException(422, "Beauty suggestion could not be provided. Choose your style preferences yourself or finish this session.") from None
        except ProviderBusyError:
            raise HTTPException(429, "Analysis is busy; try again.") from None
        except Exception as error:
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(503, "Beauty suggestion is unavailable. Choose your style preferences yourself.") from None
        finally:
            image = None
            body.image_base64 = ""

    @app.post("/v1/generate/beauty-makeup", response_model=BeautyMakeupResponse)
    def generate_beauty_makeup(body: BeautyMakeupRequest) -> BeautyMakeupResponse:
        if beauty_makeup is None:
            body.image_base64 = ""
            raise HTTPException(503, "Makeup previews are not configured. Continue with the beauty guide.")
        image = None
        try:
            try:
                image = base64.b64decode(body.image_base64, validate=True)
            except (ValueError, binascii.Error):
                raise HTTPException(422, "Invalid image encoding.") from None
            if not image or len(image) > MAX_IMAGE_BYTES:
                raise HTTPException(413, "Preview image is too large or empty.")
            return beauty_makeup.execute(body.request_id, image, body.palette_id)
        except ImageRejectedError:
            raise HTTPException(422, "Use a static JPEG, PNG or WebP, at least 224 pixels per side, up to 10 MiB and 25 million pixels.") from None
        except ProviderBusyError:
            raise HTTPException(429, "Preview generation is busy.") from None
        except Exception as error:
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(503, "Makeup previews could not be generated. Continue with the beauty guide.") from None
        finally:
            image = None
            body.image_base64 = ""

    @app.post("/v1/analyze/beauty-complete", response_model=BeautyCompleteResponse)
    def analyze_beauty_complete(body: BeautyPhotoRequest) -> BeautyCompleteResponse:
        image = None
        try:
            if beauty_complete is None:
                raise HTTPException(503, "Integrated photo observation is not configured.")
            try:
                image = base64.b64decode(body.image_base64, validate=True)
            except (ValueError, binascii.Error):
                raise HTTPException(422, "Invalid image encoding.") from None
            if not image or len(image) > MAX_IMAGE_BYTES:
                raise HTTPException(413, "Analysis image is too large or empty.")
            return beauty_complete.execute(body.request_id, image)
        except ImageRejectedError:
            raise HTTPException(422, "Use a static JPEG, PNG or WebP, at least 224 pixels per side, up to 10 MiB and 25 million pixels.") from None
        except ProviderRefusedError:
            raise HTTPException(422, "Photo observations could not be provided. Continue without a photo.") from None
        except ProviderBusyError:
            raise HTTPException(429, "Analysis is busy.") from None
        except Exception as error:
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(503, "Photo observations are unavailable. Continue without a photo.") from None
        finally:
            image = None
            body.image_base64 = ""

    @app.post("/v1/generate/beauty-preview", response_model=BeautyPreviewResponse)
    def generate_beauty_preview(body: BeautyPreviewRequest) -> BeautyPreviewResponse:
        image = None
        try:
            if beauty_preview is None:
                raise HTTPException(503, "Beauty previews are not configured. Continue with the beauty guide.")
            try:
                image = base64.b64decode(body.image_base64, validate=True)
            except (ValueError, binascii.Error):
                raise HTTPException(422, "Invalid image encoding.") from None
            if not image or len(image) > MAX_IMAGE_BYTES:
                raise HTTPException(413, "Preview image is too large or empty.")
            return beauty_preview.execute(body.request_id, image, body.palette_id, body.kind, body.index, body.face_shape, body.styling_direction)
        except ImageRejectedError:
            raise HTTPException(422, "Use a static JPEG, PNG or WebP, at least 224 pixels per side, up to 10 MiB and 25 million pixels.") from None
        except ProviderBusyError:
            raise HTTPException(429, "Preview generation is busy.") from None
        except Exception as error:
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(503, "This preview could not be generated. Continue with the beauty guide.") from None
        finally:
            image = None
            body.image_base64 = ""

    return app
