package interoperability

import (
	"context"
	"errors"
	"testing"
)

func TestDescriptorAndAdmissionValidation(t *testing.T) {
	descriptor := Descriptor{
		ID:                    "betterdesk-observed-wire",
		SpecificationRevision: SpecificationRevision,
		SupportedFeatures:     []Feature{FeatureDesktop, FeatureInput},
	}
	if err := descriptor.Validate(); err != nil {
		t.Fatalf("valid descriptor: %v", err)
	}

	descriptor.SupportedFeatures = append(descriptor.SupportedFeatures, FeatureInput)
	if err := descriptor.Validate(); !errors.Is(err, ErrInvalidDescriptor) {
		t.Fatalf("duplicate feature error = %v, want invalid descriptor", err)
	}

	admission := Admission{
		SessionID:         "session-42",
		OperatorID:        "operator-42",
		Transport:         "relay",
		RequestedFeatures: []Feature{FeatureDesktop, FeatureInput},
		GrantPresentation: "opaque-grant-presentation",
	}
	if err := admission.Validate(); err != nil {
		t.Fatalf("valid admission: %v", err)
	}

	admission.RequestedFeatures = []Feature{"session_initiate"}
	if err := admission.Validate(); !errors.Is(err, ErrInvalidAdmission) {
		t.Fatalf("outbound feature error = %v, want invalid admission", err)
	}
}

func TestTemporaryAuditedSurfacesAreIndependentInventory(t *testing.T) {
	surfaces := TemporaryAuditedSurfaces()
	if len(surfaces) != 3 {
		t.Fatalf("surface count = %d, want 3", len(surfaces))
	}
	for _, surface := range surfaces {
		if surface.Path == "" || surface.Role == "" || surface.Status != temporaryAuditedStatus {
			t.Fatalf("invalid audited surface: %#v", surface)
		}
	}

	surfaces[0].Path = "mutated"
	if got := TemporaryAuditedSurfaces()[0].Path; got == "mutated" {
		t.Fatal("audited surface inventory returned a shared slice")
	}
}

func TestAdapterBoundaryIsInboundOnly(t *testing.T) {
	var _ Adapter = testAdapter{}

	adapter := testAdapter{}
	if err := adapter.Descriptor().Validate(); err != nil {
		t.Fatalf("test adapter descriptor: %v", err)
	}
}

type testAdapter struct{}

func (testAdapter) Descriptor() Descriptor {
	return Descriptor{
		ID:                    "test-inbound-adapter",
		SpecificationRevision: SpecificationRevision,
		SupportedFeatures:     []Feature{FeatureDesktop},
	}
}

func (testAdapter) ServeInbound(context.Context, InboundTransport, SessionAuthorizer) error {
	return nil
}
