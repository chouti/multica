package service

import "unicode/utf8"

// maxSynthesizedFallbackCommentRunes caps the rune count of a synthesized
// fallback comment so a runaway raw execution-stream dump cannot reach the
// issue thread (GH #5455). The boundary is rune-based (not bytes) so
// multibyte content like CJK is not unfairly truncated.
const maxSynthesizedFallbackCommentRunes = 200

// truncateFallbackCommentBody returns the body unchanged when it fits within
// the rune cap, and replaces over-cap input with a fixed safe notice. The
// safe notice never embeds any portion of the input (a 200KB raw stream
// must not leak even one identifiable token) and stays under 256 runes so
// the issue timeline itself never balloons.
func truncateFallbackCommentBody(body string, cap int) string {
	if utf8.RuneCountInString(body) <= cap {
		return body
	}
	// "not posted" + "Execution log" phrasing is pinned by the test (see
	// TestTruncateFallbackCommentBody "raw execution-stream dump" case) and
	// must not drift without updating both sides.
	return "Execution log was not posted because it exceeded the synthesized comment size limit. Open the task run to view the full output."
}
