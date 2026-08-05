package interoperability

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
)

// DefaultMaximumObservedPayloadBytes bounds a single payload considered by the
// laboratory harness. It is an evidence-capture limit, not a production wire
// protocol limit.
const DefaultMaximumObservedPayloadBytes = 4 << 20

// Direction records the observed direction of an opaque wire event.
type Direction string

const (
	DirectionClientToAgent Direction = "client_to_agent"
	DirectionAgentToClient Direction = "agent_to_client"
)

// Phase is a BetterDesk-owned semantic label assigned by the lab driver. It
// deliberately does not encode external message names or schema fields.
type Phase string

const (
	PhaseTransportOpened Phase = "transport_opened"
	PhaseHandshake       Phase = "handshake"
	PhaseAuthentication  Phase = "authentication"
	PhaseCapability      Phase = "capability"
	PhaseDesktop         Phase = "desktop"
	PhaseInput           Phase = "input"
	PhaseRejected        Phase = "rejected"
	PhaseTransportClosed Phase = "transport_closed"
)

// VectorKind determines whether an expected payload fingerprint is permitted.
// Black-box vectors intentionally retain only metadata; synthetic vectors may
// fingerprint independently generated, non-secret test bytes.
type VectorKind string

const (
	VectorKindBlackBox  VectorKind = "black_box"
	VectorKindSynthetic VectorKind = "synthetic"
)

// ObservationMode selects how ObserveWire handles the payload supplied by a
// lab driver. Neither mode retains the payload itself.
type ObservationMode string

const (
	// ObservationMetadataOnly stores direction, phase, and byte count only.
	// Use it for all stock-client observations, especially authentication and
	// nonce-bearing messages.
	ObservationMetadataOnly ObservationMode = "metadata_only"
	// ObservationSyntheticFingerprint is permitted only for independently
	// generated, non-secret test data. It adds a SHA-256 fingerprint.
	ObservationSyntheticFingerprint ObservationMode = "synthetic_fingerprint"
)

// ExpectedObservation is one ordered, lossy assertion in a conformance vector.
// PayloadFingerprint is optional and may be used only by synthetic vectors.
type ExpectedObservation struct {
	Direction          Direction
	Phase              Phase
	MinimumBytes       int
	MaximumBytes       int
	PayloadFingerprint string
}

// Vector is a BetterDesk-owned test contract for a single observed behavior.
// It never stores a raw frame, decoded external message, credential, nonce, or
// copied schema.
type Vector struct {
	ID                    string
	SpecificationRevision string
	Kind                  VectorKind
	Steps                 []ExpectedObservation
}

// Validate checks a vector using the default evidence-capture bound.
func (v Vector) Validate() error {
	return validateVector(v, DefaultMaximumObservedPayloadBytes)
}

// Observation is a lossy record emitted by a lab driver. Raw payload bytes are
// intentionally absent so a RunResult can be attached to a release record
// without retaining client traffic.
type Observation struct {
	Direction          Direction
	Phase              Phase
	PayloadBytes       int
	PayloadFingerprint string
}

// ObserveWire creates a bounded, lossy observation and immediately discards
// the payload reference. Callers must use ObservationMetadataOnly for any
// stock-client traffic.
func ObserveWire(direction Direction, phase Phase, payload []byte, mode ObservationMode) (Observation, error) {
	return observeWire(direction, phase, payload, mode, DefaultMaximumObservedPayloadBytes)
}

// ObservationSink receives metadata-only observations from a laboratory probe.
// It deliberately offers no method that accepts or returns a persisted raw
// packet.
type ObservationSink interface {
	Record(Observation) error
}

// BlackBoxProbe drives an isolated client-lab scenario. The probe, client
// binary, credentials, and any temporary packet capture remain outside this
// package and repository.
type BlackBoxProbe interface {
	Run(context.Context, Vector, ObservationSink) error
}

// BlackBoxProbeFunc adapts a function into a BlackBoxProbe.
type BlackBoxProbeFunc func(context.Context, Vector, ObservationSink) error

// Run implements BlackBoxProbe.
func (f BlackBoxProbeFunc) Run(ctx context.Context, vector Vector, sink ObservationSink) error {
	if f == nil {
		return ErrNilProbe
	}
	return f(ctx, vector, sink)
}

// Harness runs one vector against a supplied lab probe. A successful result
// only means that this vector matched this probe run; it is not a broad
// compatibility or provenance assertion.
type Harness struct {
	// MaximumObservedPayloadBytes is optional and defaults to
	// DefaultMaximumObservedPayloadBytes. It applies to both vectors and
	// observations supplied by the probe.
	MaximumObservedPayloadBytes int
}

// RunResult contains only the vector identifier and lossy observations.
type RunResult struct {
	VectorID     string
	Observations []Observation
}

// Run validates and executes one vector. It rejects out-of-order events,
// payloads beyond the configured evidence bound, and accidental fingerprints
// in a black-box run.
func (h Harness) Run(ctx context.Context, vector Vector, probe BlackBoxProbe) (RunResult, error) {
	if probe == nil {
		return RunResult{}, ErrNilProbe
	}
	if ctx == nil {
		ctx = context.Background()
	}

	maxBytes := h.maximumObservedPayloadBytes()
	checked := cloneVector(vector)
	if err := validateVector(checked, maxBytes); err != nil {
		return RunResult{}, err
	}

	recorder := &runRecorder{
		kind:     checked.Kind,
		expected: cloneExpectedObservations(checked.Steps),
		maxBytes: maxBytes,
	}
	if err := probe.Run(ctx, cloneVector(checked), recorder); err != nil {
		return recorder.result(checked.ID), err
	}
	if err := recorder.complete(); err != nil {
		return recorder.result(checked.ID), err
	}
	return recorder.result(checked.ID), nil
}

func (h Harness) maximumObservedPayloadBytes() int {
	if h.MaximumObservedPayloadBytes > 0 {
		return h.MaximumObservedPayloadBytes
	}
	return DefaultMaximumObservedPayloadBytes
}

type runRecorder struct {
	mu sync.Mutex

	kind     VectorKind
	expected []ExpectedObservation
	maxBytes int
	actual   []Observation
	failure  error
}

func (r *runRecorder) Record(observation Observation) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.failure != nil {
		return r.failure
	}
	if err := validateObservation(observation, r.maxBytes); err != nil {
		r.failure = err
		return err
	}
	if r.kind == VectorKindBlackBox && observation.PayloadFingerprint != "" {
		r.failure = fmt.Errorf("%w: black-box observation contains a payload fingerprint", ErrUnsafeObservation)
		return r.failure
	}

	index := len(r.actual)
	r.actual = append(r.actual, observation)
	if index >= len(r.expected) {
		r.failure = fmt.Errorf("%w: unexpected %s %s observation", ErrConformanceMismatch, observation.Direction, observation.Phase)
		return r.failure
	}
	if err := r.expected[index].matches(observation); err != nil {
		r.failure = err
		return err
	}
	return nil
}

func (r *runRecorder) complete() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.failure != nil {
		return r.failure
	}
	if len(r.actual) != len(r.expected) {
		return fmt.Errorf("%w: observed %d steps, expected %d", ErrConformanceMismatch, len(r.actual), len(r.expected))
	}
	return nil
}

func (r *runRecorder) result(vectorID string) RunResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	return RunResult{
		VectorID:     vectorID,
		Observations: append([]Observation(nil), r.actual...),
	}
}

func (step ExpectedObservation) matches(observation Observation) error {
	if step.Direction != observation.Direction || step.Phase != observation.Phase {
		return fmt.Errorf("%w: expected %s %s, got %s %s",
			ErrConformanceMismatch,
			step.Direction,
			step.Phase,
			observation.Direction,
			observation.Phase,
		)
	}
	if observation.PayloadBytes < step.MinimumBytes || observation.PayloadBytes > step.MaximumBytes {
		return fmt.Errorf("%w: %s %s payload size %d is outside [%d,%d]",
			ErrConformanceMismatch,
			step.Direction,
			step.Phase,
			observation.PayloadBytes,
			step.MinimumBytes,
			step.MaximumBytes,
		)
	}
	if step.PayloadFingerprint != "" && step.PayloadFingerprint != observation.PayloadFingerprint {
		return fmt.Errorf("%w: synthetic payload fingerprint mismatch", ErrConformanceMismatch)
	}
	return nil
}

func observeWire(direction Direction, phase Phase, payload []byte, mode ObservationMode, maxBytes int) (Observation, error) {
	if len(payload) > maxBytes {
		return Observation{}, fmt.Errorf("%w: payload size %d exceeds %d bytes", ErrUnsafeObservation, len(payload), maxBytes)
	}

	observation := Observation{
		Direction:    direction,
		Phase:        phase,
		PayloadBytes: len(payload),
	}
	switch mode {
	case ObservationMetadataOnly:
	case ObservationSyntheticFingerprint:
		sum := sha256.Sum256(payload)
		observation.PayloadFingerprint = hex.EncodeToString(sum[:])
	default:
		return Observation{}, fmt.Errorf("%w: unknown observation mode %q", ErrUnsafeObservation, mode)
	}
	if err := validateObservation(observation, maxBytes); err != nil {
		return Observation{}, err
	}
	return observation, nil
}

func validateVector(vector Vector, maxBytes int) error {
	if strings.TrimSpace(vector.ID) == "" ||
		strings.TrimSpace(vector.SpecificationRevision) == "" ||
		!knownVectorKind(vector.Kind) ||
		len(vector.Steps) == 0 ||
		maxBytes <= 0 {
		return ErrInvalidVector
	}

	for _, step := range vector.Steps {
		if err := validateExpectedObservation(step, maxBytes); err != nil {
			return err
		}
		if vector.Kind == VectorKindBlackBox && step.PayloadFingerprint != "" {
			return fmt.Errorf("%w: black-box vectors cannot pin a payload fingerprint", ErrUnsafeObservation)
		}
	}
	return nil
}

func validateExpectedObservation(step ExpectedObservation, maxBytes int) error {
	if !knownDirection(step.Direction) ||
		!knownPhase(step.Phase) ||
		step.MinimumBytes < 0 ||
		step.MaximumBytes < step.MinimumBytes ||
		step.MaximumBytes > maxBytes {
		return ErrInvalidVector
	}
	if step.PayloadFingerprint != "" {
		if !validFingerprint(step.PayloadFingerprint) || step.MinimumBytes != step.MaximumBytes {
			return ErrInvalidVector
		}
	}
	return nil
}

func validateObservation(observation Observation, maxBytes int) error {
	if !knownDirection(observation.Direction) ||
		!knownPhase(observation.Phase) ||
		observation.PayloadBytes < 0 ||
		observation.PayloadBytes > maxBytes ||
		(observation.PayloadFingerprint != "" && !validFingerprint(observation.PayloadFingerprint)) {
		return ErrUnsafeObservation
	}
	return nil
}

func cloneVector(vector Vector) Vector {
	vector.Steps = cloneExpectedObservations(vector.Steps)
	return vector
}

func cloneExpectedObservations(steps []ExpectedObservation) []ExpectedObservation {
	return append([]ExpectedObservation(nil), steps...)
}

func knownDirection(direction Direction) bool {
	return direction == DirectionClientToAgent || direction == DirectionAgentToClient
}

func knownPhase(phase Phase) bool {
	switch phase {
	case PhaseTransportOpened,
		PhaseHandshake,
		PhaseAuthentication,
		PhaseCapability,
		PhaseDesktop,
		PhaseInput,
		PhaseRejected,
		PhaseTransportClosed:
		return true
	default:
		return false
	}
}

func knownVectorKind(kind VectorKind) bool {
	return kind == VectorKindBlackBox || kind == VectorKindSynthetic
}

func validFingerprint(fingerprint string) bool {
	if len(fingerprint) != sha256.Size*2 || fingerprint != strings.ToLower(fingerprint) {
		return false
	}
	_, err := hex.DecodeString(fingerprint)
	return err == nil
}

var (
	// ErrInvalidVector indicates a vector that cannot be safely used as
	// BetterDesk-owned conformance evidence.
	ErrInvalidVector = errors.New("interoperability: invalid conformance vector")
	// ErrUnsafeObservation indicates an observation that would exceed the
	// evidence boundary or retain unsafe black-box detail.
	ErrUnsafeObservation = errors.New("interoperability: unsafe wire observation")
	// ErrConformanceMismatch indicates a probe result that differs from its
	// declared vector without exposing raw wire payloads.
	ErrConformanceMismatch = errors.New("interoperability: conformance mismatch")
	// ErrNilProbe indicates a harness run without a lab driver.
	ErrNilProbe = errors.New("interoperability: missing black-box probe")
)
