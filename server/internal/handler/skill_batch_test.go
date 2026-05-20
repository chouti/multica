package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// batchTimeout — pure function, no DB needed
// ---------------------------------------------------------------------------

func TestBatchTimeout(t *testing.T) {
	tests := []struct {
		name     string
		count    int
		expected time.Duration
	}{
		{"zero skills", 0, 30 * time.Second},
		{"1 skill", 1, 30 * time.Second},
		{"5 skills", 5, 30 * time.Second},
		{"10 skills", 10, 60 * time.Second},
		{"20 skills", 20, 90 * time.Second},
		{"43 skills", 43, 150 * time.Second},
		{"100 skills", 100, 300 * time.Second},
		{"1000 skills (capped)", 1000, 300 * time.Second},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := batchTimeout(tt.count)
			if got != tt.expected {
				t.Errorf("batchTimeout(%d) = %v, want %v", tt.count, got, tt.expected)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// BatchImportResponse JSON contract — no DB needed
// ---------------------------------------------------------------------------

func TestBatchImportResponseEmptySlices(t *testing.T) {
	resp := BatchImportResponse{
		Skills: make([]SkillWithFilesResponse, 0),
		Errors: make([]BatchImportError, 0),
	}

	// Marshal to JSON and verify the wire format
	raw, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Assert that "skills" and "errors" are literal [] not null/missing
	for _, field := range []string{"skills", "errors"} {
		v, ok := decoded[field]
		if !ok {
			t.Fatalf("%q field missing from JSON output", field)
		}
		if v == nil {
			t.Fatalf("%q is null in JSON output, want []", field)
		}
		arr, ok := v.([]any)
		if !ok {
			t.Fatalf("%q is not an array in JSON output", field)
		}
		if len(arr) != 0 {
			t.Fatalf("%q length should be 0, got %d", field, len(arr))
		}
	}
}

// ---------------------------------------------------------------------------
// Handler-level batch import contract tests — require DB (skipped if DB unavailable)
// ---------------------------------------------------------------------------

func TestBatchImport_BadBody_Returns400(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	req := httptest.NewRequest(http.MethodPost, "/api/skills/import/batch",
		bytes.NewReader([]byte("not-json")))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Slug", handlerTestWorkspaceSlug)

	w := httptest.NewRecorder()
	testHandler.ImportSkillsBatch(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}

func TestBatchImport_MissingURL_Returns400(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	body := map[string]any{}
	raw, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/skills/import/batch",
		bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Slug", handlerTestWorkspaceSlug)

	w := httptest.NewRecorder()
	testHandler.ImportSkillsBatch(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}

func TestBatchImport_NonSkillsShURL_Returns400(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	body := map[string]any{"url": "https://github.com/owner/repo"}
	raw, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/skills/import/batch",
		bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Slug", handlerTestWorkspaceSlug)

	w := httptest.NewRecorder()
	testHandler.ImportSkillsBatch(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}
