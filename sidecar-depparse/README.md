# sidecar-depparse

Python FastAPI service that detects *requirement constructions* in
natural-language text using spaCy dependency parses.

Used by the AI-SDLC orchestrator's Layer 1 deterministic SA scorer
(RFC-0008 §B.4.2) to evaluate DID constraints such as
`must-not-require developer` against issue descriptions.

## Endpoints

### `POST /v1/match`

```json
{
  "text": "Add inventory sync via webhook for developer integration",
  "patterns": ["developer integration required"]
}
```

Response:

```json
{
  "matches": [
    {
      "pattern": "developer integration required",
      "matched_text": "developer integration",
      "dep_path": ["pobj", "prep"],
      "construction": "prep(for)"
    }
  ]
}
```

### `GET /healthz`

```json
{ "status": "ok", "model": "en_core_web_sm==3.7.1", "model_loaded": true }
```

## Local dev

```bash
cd sidecar-depparse
pip install -e ".[dev]"
python -m spacy download en_core_web_sm
pytest
python -m sidecar_depparse.app
```

## Docker

```bash
docker build -t ai-sdlc/sidecar-depparse .
docker run --rm -p 8088:8088 ai-sdlc/sidecar-depparse
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `SIDECAR_HOST` | `127.0.0.1` | Bind host |
| `SIDECAR_PORT` | `8088` | Bind port |
| `SIDECAR_LOG_LEVEL` | `INFO` | Python log level |
| `SIDECAR_SPACY_MODEL` | `en_core_web_sm` | spaCy model name |
