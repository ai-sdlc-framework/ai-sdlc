FROM golang:1.24 AS builder

WORKDIR /workspace

# Copy SDK dependency
COPY ../go.mod ../go.sum /sdk-go/
COPY ../core/ /sdk-go/core/

# Copy operator source
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o manager main.go

FROM gcr.io/distroless/static:nonroot
WORKDIR /
COPY --from=builder /workspace/manager .
USER 65532:65532
ENTRYPOINT ["/manager"]
