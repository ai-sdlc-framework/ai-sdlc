// Package aisdlc provides a Go SDK for the AI-SDLC Framework.
//
// The AI-SDLC Framework defines declarative resources (Pipeline, AgentRole,
// QualityGate, AutonomyPolicy, AdapterBinding) for governing AI agents in
// software development lifecycles.
//
// This SDK provides:
//   - Core types and JSON Schema validation
//   - Fluent builders for all resource types
//   - Policy evaluation engine (enforcement, autonomy, complexity)
//   - Adapter interfaces and registry
//   - Agent orchestration and memory
//   - Reconciler loop for continuous state management
//   - Telemetry, audit, security, compliance, and metrics modules
package aisdlc

// Version is the current version of the AI-SDLC Go SDK.
const Version = "0.1.1"
