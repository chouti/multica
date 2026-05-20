package main

import "testing"

func TestIsSkillImportBatch(t *testing.T) {
	tests := []struct {
		name   string
		url    string
		expect bool
	}{
		// Batch mode — 2 path segments
		{"batch: https scheme", "https://skills.sh/everyinc/compound-engineering-plugin", true},
		{"batch: no scheme", "skills.sh/owner/repo", true},
		{"batch: http scheme", "http://skills.sh/owner/repo", true},
		{"batch: trailing slash", "https://skills.sh/owner/repo/", true},

		// Single skill — 3 path segments
		{"single: https scheme", "https://skills.sh/owner/repo/skill-name", false},
		{"single: no scheme", "skills.sh/owner/repo/skill-name", false},
		{"single: trailing slash", "https://skills.sh/owner/repo/skill-name/", false},

		// Non-skills.sh URLs
		{"github url", "https://github.com/owner/repo", false},
		{"clawhub url", "https://clawhub.ai/owner/skill", false},
		{"random url", "https://example.com/owner/repo", false},

		// Edge cases
		{"empty", "", false},
		{"invalid url", "://invalid", false},
		{"single segment", "https://skills.sh/owner", false},
		{"four segments", "https://skills.sh/a/b/c/d", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isSkillImportBatch(tt.url)
			if got != tt.expect {
				t.Errorf("isSkillImportBatch(%q) = %v, want %v", tt.url, got, tt.expect)
			}
		})
	}
}
