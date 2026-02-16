package telemetry

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

const instrumentationName = "ai-sdlc-go"

// GetTracer returns the AI-SDLC tracer.
func GetTracer() trace.Tracer {
	return otel.Tracer(instrumentationName)
}

// GetMeter returns the AI-SDLC meter.
func GetMeter() metric.Meter {
	return otel.Meter(instrumentationName)
}

// WithSpan wraps a function call in a traced span.
func WithSpan(ctx context.Context, spanName string, attrs []attribute.KeyValue, fn func(context.Context) error) error {
	ctx, span := GetTracer().Start(ctx, spanName, trace.WithAttributes(attrs...))
	defer span.End()

	err := fn(ctx)
	if err != nil {
		span.RecordError(err)
	}
	return err
}
