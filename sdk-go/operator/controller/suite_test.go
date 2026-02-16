package controller_test

import (
	"testing"

	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"

	aisdlcv1alpha1 "github.com/ai-sdlc-framework/ai-sdlc/sdk-go/operator/api/v1alpha1"
)

// testScheme returns a runtime.Scheme with the AI-SDLC and k8s types registered.
func testScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		t.Fatalf("adding client-go scheme: %v", err)
	}
	if err := aisdlcv1alpha1.AddToScheme(s); err != nil {
		t.Fatalf("adding ai-sdlc scheme: %v", err)
	}
	return s
}
