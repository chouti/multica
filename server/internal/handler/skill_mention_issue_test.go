package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// These tests pin the U1 boundary contract for the issue description
// @skill-designation field (`skill_mention_agents`) on the create and update
// issue endpoints: the map shape is validated at the boundary exactly like
// the comment path (parseSkillMentionAgents — malformed agent UUID, per-skill
// cap 8, map cap 16 → 400), and a request without the field keeps today's
// behavior byte-for-byte (silent no-op, R12). Durable binding and enqueue
// wiring are later units; here a rejected request must leave zero writes.

// createIssueExpectStatus drives the real CreateIssue handler and returns the
// recorder. The title is derived from the test name so the duplicate-issue
// guard never fires and any leaked row can be cleaned up by title.
func createIssueExpectStatus(t *testing.T, body map[string]any, wantStatus int) *httptest.ResponseRecorder {
	t.Helper()
	title := body["title"].(string)
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id = $1 AND title = $2)`,
			testWorkspaceID, title)
		testPool.Exec(context.Background(),
			`DELETE FROM issue WHERE workspace_id = $1 AND title = $2`, testWorkspaceID, title)
	})
	req := newRequest(http.MethodPost, "/api/issues", body)
	w := httptest.NewRecorder()
	testHandler.CreateIssue(w, req)
	if w.Code != wantStatus {
		t.Fatalf("CreateIssue: expected %d, got %d: %s", wantStatus, w.Code, w.Body.String())
	}
	return w
}

// updateIssueExpectStatus drives the real UpdateIssue handler for an
// already-inserted issue id.
func updateIssueExpectStatus(t *testing.T, issueID string, body map[string]any, wantStatus int) *httptest.ResponseRecorder {
	t.Helper()
	req := newRequest(http.MethodPut, "/api/issues/"+issueID, body)
	req = withURLParam(req, "id", issueID)
	w := httptest.NewRecorder()
	testHandler.UpdateIssue(w, req)
	if w.Code != wantStatus {
		t.Fatalf("UpdateIssue: expected %d, got %d: %s", wantStatus, w.Code, w.Body.String())
	}
	return w
}

// TestSkillMentionIssueCreate_MalformedAgentUUID400s: an issue create that
// sends a skill_mention_agents entry with a non-UUID agent id must 400 at the
// boundary and the issue must not be persisted.
func TestSkillMentionIssueCreate_MalformedAgentUUID400s(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	title := "skill-mention-issue-create-malformed-" + t.Name()
	createIssueExpectStatus(t, map[string]any{
		"title": title,
		"skill_mention_agents": map[string][]string{
			"00000000-0000-0000-0000-0000000000aa": {"not-a-uuid"},
		},
	}, http.StatusBadRequest)
	if got := countIssuesWithTitle(t, title); got != 0 {
		t.Fatalf("malformed designation must not persist the issue; got %d rows", got)
	}
}

// TestSkillMentionIssueUpdate_MalformedAgentUUID400s: an issue update that
// sends a malformed agent id must 400 and leave the issue untouched.
func TestSkillMentionIssueUpdate_MalformedAgentUUID400s(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {"not-a-uuid"},
		},
	}, http.StatusBadRequest)
	var description *string
	if err := testPool.QueryRow(context.Background(),
		`SELECT description FROM issue WHERE id = $1`, fx.IssueID).Scan(&description); err != nil {
		t.Fatalf("load issue description: %v", err)
	}
	if description != nil {
		t.Fatalf("malformed designation must not change the issue; description = %q", *description)
	}
}

// TestSkillMentionIssueCreate_OverPerSkillCap400s: one designation
// list with more than maxSkillMentionAgentsPerSkill (8) agents must 400 and
// the issue must not be persisted. Mirrors
// TestUpdateComment_SkillMentionAgentsOverPerSkillCap400s.
func TestSkillMentionIssueCreate_OverPerSkillCap400s(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	title := "skill-mention-issue-create-per-skill-cap-" + t.Name()
	agentIDs := []string{
		"00000000-0000-0000-0000-000000000001",
		"00000000-0000-0000-0000-000000000002",
		"00000000-0000-0000-0000-000000000003",
		"00000000-0000-0000-0000-000000000004",
		"00000000-0000-0000-0000-000000000005",
		"00000000-0000-0000-0000-000000000006",
		"00000000-0000-0000-0000-000000000007",
		"00000000-0000-0000-0000-000000000008",
		"00000000-0000-0000-0000-000000000009",
	}
	createIssueExpectStatus(t, map[string]any{
		"title": title,
		"skill_mention_agents": map[string][]string{
			"00000000-0000-0000-0000-0000000000aa": agentIDs,
		},
	}, http.StatusBadRequest)
	if got := countIssuesWithTitle(t, title); got != 0 {
		t.Fatalf("over-cap designation must not persist the issue; got %d rows", got)
	}
}

// TestSkillMentionIssueUpdate_OverPerSkillCap400s mirrors the comment
// per-skill cap test on the issue update path.
func TestSkillMentionIssueUpdate_OverPerSkillCap400s(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	agentIDs := []string{
		fx.OtherAgentID, fx.JID,
		"00000000-0000-0000-0000-000000000001",
		"00000000-0000-0000-0000-000000000002",
		"00000000-0000-0000-0000-000000000003",
		"00000000-0000-0000-0000-000000000004",
		"00000000-0000-0000-0000-000000000005",
		"00000000-0000-0000-0000-000000000006",
		"00000000-0000-0000-0000-000000000007",
	}
	updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID: agentIDs,
		},
	}, http.StatusBadRequest)
	var description *string
	if err := testPool.QueryRow(context.Background(),
		`SELECT description FROM issue WHERE id = $1`, fx.IssueID).Scan(&description); err != nil {
		t.Fatalf("load issue description: %v", err)
	}
	if description != nil {
		t.Fatalf("over-cap designation must not change the issue; description = %q", *description)
	}
}

// TestSkillMentionIssueCreate_OverMapSizeCap400s: a designation map
// with more than maxSkillMentionAgentsMapSize (16) skill entries must 400 and
// the issue must not be persisted, even though each per-skill list is within
// the per-skill cap.
func TestSkillMentionIssueCreate_OverMapSizeCap400s(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	title := "skill-mention-issue-create-map-size-cap-" + t.Name()
	skillAgents := make(map[string][]string, 17)
	for i := 0; i < 17; i++ {
		skillAgents[fmt.Sprintf("00000000-0000-0000-0000-%012d", i)] =
			[]string{"00000000-0000-0000-0000-000000000001"}
	}
	createIssueExpectStatus(t, map[string]any{
		"title":                title,
		"skill_mention_agents": skillAgents,
	}, http.StatusBadRequest)
	if got := countIssuesWithTitle(t, title); got != 0 {
		t.Fatalf("over-map-cap designation must not persist the issue; got %d rows", got)
	}
}

// TestSkillMentionIssueUpdate_OverMapSizeCap400s mirrors the comment
// map-size cap test on the issue update path: 17 skill entries, one
// well-formed agent each.
func TestSkillMentionIssueUpdate_OverMapSizeCap400s(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	skillIDs := make([]string, 0, 17)
	skillIDs = append(skillIDs, fx.SkillID, fx.SecondSkillID)
	for i := 0; i < 15; i++ {
		skillIDs = append(skillIDs, insertHandlerTestSkill(t, fmt.Sprintf("issue-mapsize-%d", i), fmt.Sprintf("issue map size skill %d", i)))
	}
	skillAgents := make(map[string][]string, len(skillIDs))
	for _, sid := range skillIDs {
		skillAgents[sid] = []string{fx.OtherAgentID}
	}
	updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"description":          fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"skill_mention_agents": skillAgents,
	}, http.StatusBadRequest)
	var description *string
	if err := testPool.QueryRow(context.Background(),
		`SELECT description FROM issue WHERE id = $1`, fx.IssueID).Scan(&description); err != nil {
		t.Fatalf("load issue description: %v", err)
	}
	if description != nil {
		t.Fatalf("over-map-cap designation must not change the issue; description = %q", *description)
	}
}

// TestSkillMentionIssueCreate_WithoutFieldUnchanged pins R12 on the create
// path: a request without the field behaves exactly like today — 201, issue
// persisted with title and description as sent, no designation side effects.
func TestSkillMentionIssueCreate_WithoutFieldUnchanged(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	title := "skill-mention-issue-create-no-field-" + t.Name()
	description := "plain description without designation"
	createIssueExpectStatus(t, map[string]any{
		"title":       title,
		"description": description,
	}, http.StatusCreated)
	var gotDescription *string
	if err := testPool.QueryRow(context.Background(),
		`SELECT description FROM issue WHERE workspace_id = $1 AND title = $2`,
		testWorkspaceID, title).Scan(&gotDescription); err != nil {
		t.Fatalf("issue must persist on a field-less request: %v", err)
	}
	if gotDescription == nil || *gotDescription != description {
		t.Fatalf("description must persist verbatim; got %v", gotDescription)
	}
}

// TestSkillMentionIssueUpdate_WithoutFieldUnchanged pins R12 on the update
// path: a request without the field updates the description as usual (200 +
// persisted) with zero designation behavior.
func TestSkillMentionIssueUpdate_WithoutFieldUnchanged(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	description := "updated without designation"
	updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"description": description,
	}, http.StatusOK)
	var gotDescription *string
	if err := testPool.QueryRow(context.Background(),
		`SELECT description FROM issue WHERE id = $1`, fx.IssueID).Scan(&gotDescription); err != nil {
		t.Fatalf("load issue description: %v", err)
	}
	if gotDescription == nil || *gotDescription != description {
		t.Fatalf("description must update verbatim; got %v", gotDescription)
	}
}
