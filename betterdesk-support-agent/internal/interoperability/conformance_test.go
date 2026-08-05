package interoperability

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
)

func TestObserveWireKeepsStockClientObservationsMetadataOnly(t *testing.T) {
	payload := []byte("credential-bearing-test-payload")
	observation, err := ObserveWire(
		DirectionClientToAgent,
		PhaseAuthentication,
		payload,
		ObservationMetadataOnly,
	)
	if err != nil {
		t.Fatalf("observe metadata: %v", err)
	}
	if observation.PayloadBytes != len(payload) {
		t.Fatalf("payload bytes = %d, want %d", observation.PayloadBytes, len(payload))
	}
	if observation.PayloadFingerprint != "" {
		t.Fatalf("metadata-only observation retained fingerprint %q", observation.PayloadFingerprint)
	}

	synthetic, err := ObserveWire(
		DirectionAgentToClient,
		PhaseHandshake,
		[]byte("independently-generated"),
		ObservationSyntheticFingerprint,
	)
	if err != nil {
		t.Fatalf("observe synthetic: %v", err)
	}
	want := sha256.Sum256([]byte("independently-generated"))
	if synthetic.PayloadFingerprint != stringLowerHex(want[:]) {
		t.Fatalf("synthetic fingerprint = %q, want SHA-256", synthetic.PayloadFingerprint)
	}
}

func TestHarnessMatchesSyntheticVectorWithoutLeakingPayload(t *testing.T) {
	payload := []byte("synthetic-handshake")
	observed, err := ObserveWire(
		DirectionClientToAgent,
		PhaseHandshake,
		payload,
		ObservationSyntheticFingerprint,
	)
	if err != nil {
		t.Fatal(err)
	}
	vector := Vector{
		ID:                    "synthetic-inbound-handshake",
		SpecificationRevision: SpecificationRevision,
		Kind:                  VectorKindSynthetic,
		Steps: []ExpectedObservation{{
			Direction:          DirectionClientToAgent,
			Phase:              PhaseHandshake,
			MinimumBytes:       len(payload),
			MaximumBytes:       len(payload),
			PayloadFingerprint: observed.PayloadFingerprint,
		}},
	}

	result, err := Harness{MaximumObservedPayloadBytes: 256}.Run(
		context.Background(),
		vector,
		BlackBoxProbeFunc(func(_ context.Context, supplied Vector, sink ObservationSink) error {
			// The probe receives a copy and cannot rewrite the harness's
			// expected sequence after validation.
			supplied.Steps[0].Phase = PhaseInput
			return sink.Record(observed)
		}),
	)
	if err != nil {
		t.Fatalf("run synthetic vector: %v", err)
	}
	if result.VectorID != vector.ID || len(result.Observations) != 1 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if result.Observations[0].PayloadFingerprint != observed.PayloadFingerprint {
		t.Fatal("result did not retain the synthetic test fingerprint")
	}
}

func TestHarnessRejectsUnsafeOrMismatchedBlackBoxEvidence(t *testing.T) {
	vector := Vector{
		ID:                    "black-box-auth-rejection",
		SpecificationRevision: SpecificationRevision,
		Kind:                  VectorKindBlackBox,
		Steps: []ExpectedObservation{{
			Direction:    DirectionClientToAgent,
			Phase:        PhaseAuthentication,
			MinimumBytes: 1,
			MaximumBytes: 128,
		}},
	}

	_, err := Harness{}.Run(context.Background(), vector, BlackBoxProbeFunc(
		func(_ context.Context, _ Vector, sink ObservationSink) error {
			observation, observeErr := ObserveWire(
				DirectionClientToAgent,
				PhaseHandshake,
				[]byte{1},
				ObservationMetadataOnly,
			)
			if observeErr != nil {
				return observeErr
			}
			return sink.Record(observation)
		},
	))
	if !errors.Is(err, ErrConformanceMismatch) {
		t.Fatalf("mismatched phase error = %v, want conformance mismatch", err)
	}

	_, err = Harness{}.Run(context.Background(), vector, BlackBoxProbeFunc(
		func(_ context.Context, _ Vector, sink ObservationSink) error {
			observation, observeErr := ObserveWire(
				DirectionClientToAgent,
				PhaseAuthentication,
				[]byte{1},
				ObservationSyntheticFingerprint,
			)
			if observeErr != nil {
				return observeErr
			}
			return sink.Record(observation)
		},
	))
	if !errors.Is(err, ErrUnsafeObservation) {
		t.Fatalf("black-box fingerprint error = %v, want unsafe observation", err)
	}
}

func TestBlackBoxVectorsCannotPinPayloadFingerprint(t *testing.T) {
	vector := Vector{
		ID:                    "unsafe-black-box-vector",
		SpecificationRevision: SpecificationRevision,
		Kind:                  VectorKindBlackBox,
		Steps: []ExpectedObservation{{
			Direction:          DirectionClientToAgent,
			Phase:              PhaseHandshake,
			MinimumBytes:       1,
			MaximumBytes:       1,
			PayloadFingerprint: stringLowerHex(make([]byte, sha256.Size)),
		}},
	}
	if err := vector.Validate(); !errors.Is(err, ErrUnsafeObservation) {
		t.Fatalf("black-box fingerprint vector error = %v, want unsafe observation", err)
	}
}

func TestObserveWireRejectsOversizedEvidence(t *testing.T) {
	_, err := ObserveWire(
		DirectionClientToAgent,
		PhaseHandshake,
		make([]byte, DefaultMaximumObservedPayloadBytes+1),
		ObservationMetadataOnly,
	)
	if !errors.Is(err, ErrUnsafeObservation) {
		t.Fatalf("oversized evidence error = %v, want unsafe observation", err)
	}
}

func stringLowerHex(value []byte) string {
	const hex = "0123456789abcdef"
	result := make([]byte, len(value)*2)
	for index, current := range value {
		result[index*2] = hex[current>>4]
		result[index*2+1] = hex[current&0x0f]
	}
	return string(result)
}
