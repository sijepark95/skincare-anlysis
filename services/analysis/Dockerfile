FROM python:3.12.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/src:/app/shared

WORKDIR /app
COPY services/analysis/requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock \
    && groupadd --gid 10001 senmiva \
    && useradd --uid 10001 --gid 10001 --no-create-home senmiva

COPY --chown=10001:10001 services/analysis/src ./src
# Only the dependency-free appearance protocol is shared. No training code,
# checkpoints, source images or Torch dependencies enter this image.
COPY --chown=10001:10001 ml/src/senmiva_training/__init__.py ml/src/senmiva_training/vision_api.py ./shared/senmiva_training/
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2)"
CMD ["python", "-m", "uvicorn", "senmiva_analysis.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--limit-concurrency", "32", "--timeout-keep-alive", "5"]
