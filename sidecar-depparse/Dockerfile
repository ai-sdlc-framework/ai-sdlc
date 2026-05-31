# Digest pin (OpenSSF Scorecard PinnedDependencies): python:3.12-slim multi-arch index, resolved 2026-05-31
FROM python:3.12-slim@sha256:090ba77e2958f6af52a5341f788b50b032dd4ca28377d2893dcf1ecbdfdfe203

WORKDIR /app

# System build deps for spaCy
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY src ./src

RUN pip install --no-cache-dir . \
    && python -m spacy download en_core_web_sm

ENV SIDECAR_HOST=0.0.0.0 \
    SIDECAR_PORT=8088 \
    SIDECAR_LOG_LEVEL=INFO

EXPOSE 8088

CMD ["python", "-m", "sidecar_depparse.app"]
