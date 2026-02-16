package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// ── Pipeline CRD ────────────────────────────────────────────────────

// PipelineResource is the Kubernetes CRD wrapper for the AI-SDLC Pipeline resource.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type PipelineResource struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   core.PipelineSpec    `json:"spec"`
	Status *core.PipelineStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type PipelineResourceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []PipelineResource `json:"items"`
}

// ── AgentRole CRD ───────────────────────────────────────────────────

// AgentRoleResource is the Kubernetes CRD wrapper for the AI-SDLC AgentRole resource.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Role",type=string,JSONPath=`.spec.role`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type AgentRoleResource struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   core.AgentRoleSpec    `json:"spec"`
	Status *core.AgentRoleStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type AgentRoleResourceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AgentRoleResource `json:"items"`
}

// ── QualityGate CRD ─────────────────────────────────────────────────

// QualityGateResource is the Kubernetes CRD wrapper for the AI-SDLC QualityGate resource.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type QualityGateResource struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   core.QualityGateSpec    `json:"spec"`
	Status *core.QualityGateStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type QualityGateResourceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []QualityGateResource `json:"items"`
}

// ── AutonomyPolicy CRD ──────────────────────────────────────────────

// AutonomyPolicyResource is the Kubernetes CRD wrapper for the AI-SDLC AutonomyPolicy resource.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type AutonomyPolicyResource struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   core.AutonomyPolicySpec    `json:"spec"`
	Status *core.AutonomyPolicyStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type AutonomyPolicyResourceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AutonomyPolicyResource `json:"items"`
}

// ── AdapterBinding CRD ──────────────────────────────────────────────

// AdapterBindingResource is the Kubernetes CRD wrapper for the AI-SDLC AdapterBinding resource.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Interface",type=string,JSONPath=`.spec.interface`
// +kubebuilder:printcolumn:name="Type",type=string,JSONPath=`.spec.type`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type AdapterBindingResource struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   core.AdapterBindingSpec    `json:"spec"`
	Status *core.AdapterBindingStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type AdapterBindingResourceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AdapterBindingResource `json:"items"`
}

func init() {
	SchemeBuilder.Register(
		&PipelineResource{}, &PipelineResourceList{},
		&AgentRoleResource{}, &AgentRoleResourceList{},
		&QualityGateResource{}, &QualityGateResourceList{},
		&AutonomyPolicyResource{}, &AutonomyPolicyResourceList{},
		&AdapterBindingResource{}, &AdapterBindingResourceList{},
	)
}
