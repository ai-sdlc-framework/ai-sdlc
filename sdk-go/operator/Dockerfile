# Digest pin (OpenSSF Scorecard PinnedDependencies): golang:1.24 multi-arch index, resolved 2026-05-31
FROM golang:1.24@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804 AS builder

WORKDIR /workspace

# Copy SDK dependency
COPY ../go.mod ../go.sum /sdk-go/
COPY ../core/ /sdk-go/core/

# Copy operator source
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o manager main.go

# Digest pin (OpenSSF Scorecard PinnedDependencies): distroless static:nonroot multi-arch index, resolved 2026-05-31
FROM gcr.io/distroless/static:nonroot@sha256:963fa6c544fe5ce420f1f54fb88b6fb01479f054c8056d0f74cc2c6000df5240
WORKDIR /
COPY --from=builder /workspace/manager .
USER 65532:65532
ENTRYPOINT ["/manager"]
