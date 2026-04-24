"""FastAPI application exposing the dep-parse sidecar."""

from __future__ import annotations

import logging
import os
import sys
from functools import lru_cache
from typing import Optional

from fastapi import FastAPI, HTTPException

from .detector import detect_matches
from .schemas import HealthResponse, MatchRequest, MatchResponse


# Structured JSON-ish log format. Upgrade to structlog later if needed.
logging.basicConfig(
    format='{"level":"%(levelname)s","time":"%(asctime)s","logger":"%(name)s","msg":"%(message)s"}',
    level=os.environ.get("SIDECAR_LOG_LEVEL", "INFO"),
)
log = logging.getLogger("sidecar-depparse")


MODEL_NAME = os.environ.get("SIDECAR_SPACY_MODEL", "en_core_web_sm")


@lru_cache(maxsize=1)
def _load_nlp():
    """Lazy-load spaCy model; fails fast with a helpful error."""
    try:
        import spacy  # type: ignore
    except ImportError as err:  # pragma: no cover - install-time failure
        raise RuntimeError(
            "spacy is not installed — run `pip install spacy` first"
        ) from err
    try:
        return spacy.load(MODEL_NAME)
    except OSError as err:
        raise RuntimeError(
            f"spaCy model '{MODEL_NAME}' is not installed. "
            f"Run: python -m spacy download {MODEL_NAME}"
        ) from err


def _model_version() -> Optional[str]:
    try:
        nlp = _load_nlp()
        meta = getattr(nlp, "meta", {}) or {}
        version = meta.get("version")
        if version:
            return f"{MODEL_NAME}=={version}"
        return MODEL_NAME
    except RuntimeError:
        return None


def create_app() -> FastAPI:
    app = FastAPI(
        title="AI-SDLC dep-parse sidecar",
        version="0.1.0",
        description=(
            "Detects requirement constructions (RFC-0008 §B.4.2) in natural-language text "
            "using spaCy dependency parses."
        ),
    )

    @app.get("/healthz", response_model=HealthResponse)
    def healthz() -> HealthResponse:
        version = _model_version()
        return HealthResponse(
            status="ok",
            model=version,
            model_loaded=version is not None,
        )

    @app.post("/v1/match", response_model=MatchResponse)
    def match(req: MatchRequest) -> MatchResponse:
        try:
            nlp = _load_nlp()
        except RuntimeError as err:
            log.error("spacy model not ready: %s", err)
            raise HTTPException(status_code=503, detail=str(err))

        result = detect_matches(req.text, req.patterns, nlp)
        return MatchResponse(matches=[m.__dict__ for m in result])  # type: ignore[arg-type]

    return app


app = create_app()


def main() -> None:  # pragma: no cover - entrypoint
    """Dev entrypoint — `sidecar-depparse` script in pyproject."""
    import uvicorn

    host = os.environ.get("SIDECAR_HOST", "127.0.0.1")
    port = int(os.environ.get("SIDECAR_PORT", "8088"))
    uvicorn.run("sidecar_depparse.app:app", host=host, port=port, log_config=None)


if __name__ == "__main__":  # pragma: no cover
    main()
    sys.exit(0)
