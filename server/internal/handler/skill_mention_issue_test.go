package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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

// ---------------------------------------------------------------------------
// U2: create-path designation wiring — handler pre-gate (R15), in-transaction
// bind (R6), post-create merge/enqueue split (R7/R8), and per-agent outcomes
// on the create response (R16). These tests drive the real CreateIssue
// handler against the local dev DB and assert both the durable side effects
// (agent_skill rows, agent_task_queue rows) and the response outcome field.
// ---------------------------------------------------------------------------

// skillDesignationOutcomeView is the wire shape of one entry in the create
// response's skill_designation_outcomes field. Asserting the raw strings
// (rather than server-side constants) pins the exact API contract clients
// parse.
type skillDesignationOutcomeView struct {
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
	Status     string `json:"status"`
	ReasonCode string `json:"reason_code"`
}

// decodeCreateIssueDesignations decodes the create response body and returns
// the new issue id plus its designation outcomes.
func decodeCreateIssueDesignations(t *testing.T, w *httptest.ResponseRecorder) (string, []skillDesignationOutcomeView) {
	t.Helper()
	var resp struct {
		ID                       string                        `json:"id"`
		SkillDesignationOutcomes []skillDesignationOutcomeView `json:"skill_designation_outcomes"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if resp.ID == "" {
		t.Fatalf("create response missing issue id")
	}
	return resp.ID, resp.SkillDesignationOutcomes
}

func findDesignationOutcome(outcomes []skillDesignationOutcomeView, targetID string) *skillDesignationOutcomeView {
	for i := range outcomes {
		if outcomes[i].TargetID == targetID {
			return &outcomes[i]
		}
	}
	return nil
}

// cleanupAgentSkillBinding removes a binding a designation test created via
// the create path.
func cleanupAgentSkillBinding(t *testing.T, agentID, skillID string) {
	t.Helper()
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`, agentID, skillID)
	})
}

// insertHandlerTestAgentInForeignWorkspace creates an agent in a throwaway
// workspace so the designation gate's cross-workspace agent scoping can be
// exercised (GetAgentInWorkspace must scope it out even though the row
// exists).
func insertHandlerTestAgentInForeignWorkspace(t *testing.T, namePrefix string) string {
	t.Helper()
	ctx := context.Background()
	slug := "foreign-agent-" + strings.ToLower(strings.ReplaceAll(t.Name(), "_", "-"))

	var workspaceID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO workspace (name, slug, description, issue_prefix)
		VALUES ($1, $2, $3, $4)
		RETURNING id
	`, "Foreign Agent Workspace "+t.Name(), slug, "", "FAW").Scan(&workspaceID); err != nil {
		t.Fatalf("insert foreign workspace: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, workspaceID)
	})

	var agentID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent (
			workspace_id, name, description, runtime_mode, runtime_config,
			runtime_id, visibility, permission_mode, max_concurrent_tasks, owner_id,
			instructions, custom_env, custom_args
		)
		VALUES ($1, $2, '', 'cloud', '{}'::jsonb, $3, 'workspace', 'public_to', 1, $4, '', '{}'::jsonb, '[]'::jsonb)
		RETURNING id
	`, workspaceID, namePrefix+"-"+t.Name(), handlerTestRuntimeID(t), testUserID).Scan(&agentID); err != nil {
		t.Fatalf("insert foreign agent: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID)
	})
	return agentID
}

// TestSkillMentionIssueCreate_BacklogDesignationBindsOnly covers AE1: a
// backlog create with a designation writes the durable agent_skill row (R6)
// but enqueues nothing (R8), and the outcome reports the bind-only result
// (R16).
func TestSkillMentionIssueCreate_BacklogDesignationBindsOnly(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	title := "skill-mention-issue-create-backlog-bind-" + t.Name()
	w := createIssueExpectStatus(t, map[string]any{
		"title":       title,
		"status":      "backlog",
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {fx.OtherAgentID},
		},
	}, http.StatusCreated)
	issueID, outcomes := decodeCreateIssueDesignations(t, w)

	// Bound in the create transaction even though no run may start (R6+R8).
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected designated agent bound to skillA in the create transaction, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, issueID); got != 0 {
		t.Fatalf("backlog designation must not enqueue, got %d tasks", got)
	}
	o := findDesignationOutcome(outcomes, fx.OtherAgentID)
	if o == nil || o.Status != "bound" {
		t.Fatalf("expected bind-only outcome for the backlog designation, got %+v", outcomes)
	}
}

// TestSkillMentionIssueCreate_DesignateAssigneeMerges covers AE4: designating
// the assignee agent merges the designation trigger into the create's natural
// enqueue (R7, KTD3) — exactly one run, whose in-transaction binding means it
// already carries the skill (R6).
func TestSkillMentionIssueCreate_DesignateAssigneeMerges(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	title := "skill-mention-issue-create-assignee-merge-" + t.Name()
	w := createIssueExpectStatus(t, map[string]any{
		"title":         title,
		"status":        "todo",
		"description":   fmt.Sprintf("[@SkillB](mention://skill/%s) take this", fx.SecondSkillID),
		"assignee_type": "agent",
		"assignee_id":   fx.JID,
		"skill_mention_agents": map[string][]string{
			fx.SecondSkillID: {fx.JID},
		},
	}, http.StatusCreated)
	issueID, outcomes := decodeCreateIssueDesignations(t, w)

	// Merge: the natural assignee run is the ONLY run — no double-fire.
	if got := countQueuedOrDispatched(t, fx.JID, issueID); got != 1 {
		t.Fatalf("expected exactly 1 run for the designate-assignee merge, got %d", got)
	}
	// The bind landed in the create transaction, before the run was enqueued,
	// so the first run's bundle carries the skill.
	if got := countAgentSkillBindingsFor(t, fx.JID, fx.SecondSkillID); got != 1 {
		t.Fatalf("expected assignee bound to skillB in the create transaction, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.JID, fx.SecondSkillID)
	o := findDesignationOutcome(outcomes, fx.JID)
	if o == nil || o.Status != "merged" {
		t.Fatalf("expected merged outcome for the designate-assignee create, got %+v", outcomes)
	}
}

// TestSkillMentionIssueCreate_DesignationRollsBackWithFailedCreate pins the
// R6 atomicity contract: when the create itself fails, the in-transaction
// bind rolls back with it — no agent_skill rows survive. (A bind placed
// pre-create outside the transaction, or post-commit, would leak rows here.)
func TestSkillMentionIssueCreate_DesignationRollsBackWithFailedCreate(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	title := "skill-mention-issue-create-rollback-" + t.Name()
	createIssueExpectStatus(t, map[string]any{
		"title":           title,
		"description":     fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"parent_issue_id": "00000000-0000-0000-0000-0000000000ff",
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {fx.OtherAgentID},
		},
	}, http.StatusBadRequest)
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 0 {
		t.Fatalf("failed create must not leave designation bindings behind, got %d", got)
	}
}

// TestSkillMentionIssueCreate_DesignateNonAssigneeBindsAndEnqueues: a
// designation targeting a non-assignee agent on a non-backlog create binds
// that agent and enqueues exactly one run for it (R7), attributed to the
// creating member.
func TestSkillMentionIssueCreate_DesignateNonAssigneeBindsAndEnqueues(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	title := "skill-mention-issue-create-non-assignee-" + t.Name()
	w := createIssueExpectStatus(t, map[string]any{
		"title":       title,
		"status":      "todo",
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {fx.OtherAgentID},
		},
	}, http.StatusCreated)
	issueID, outcomes := decodeCreateIssueDesignations(t, w)

	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected non-assignee designated agent bound to skillA, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, issueID); got != 1 {
		t.Fatalf("expected exactly 1 run enqueued for the designated non-assignee, got %d", got)
	}
	// The designation carries no trigger comment, so the run must be
	// attributed to the creating member directly (MUL-4302 §4).
	var originator string
	if err := testPool.QueryRow(context.Background(), `
		SELECT originator_user_id::text FROM agent_task_queue
		WHERE issue_id = $1 AND agent_id = $2 AND status IN ('queued', 'dispatched')
	`, issueID, fx.OtherAgentID).Scan(&originator); err != nil {
		t.Fatalf("load designation task originator: %v", err)
	}
	if originator != testUserID {
		t.Fatalf("designation run must be attributed to the creating member; got originator %q, want %q", originator, testUserID)
	}
	o := findDesignationOutcome(outcomes, fx.OtherAgentID)
	if o == nil || o.Status != "queued" || o.ReasonCode != "queued" {
		t.Fatalf("expected queued outcome for the designated non-assignee, got %+v", outcomes)
	}
}

// TestSkillMentionIssueCreate_GateBlockedPrivateAgentOthersSurvive covers AE7
// (strengthened): designating an agent the creator cannot invoke produces NO
// binding (the gate ran before the create transaction) and NO run, surfaces a
// blocked outcome, and does not abort a second admissible designation in the
// same request (R15/R16).
func TestSkillMentionIssueCreate_GateBlockedPrivateAgentOthersSurvive(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	// Owner-only agent owned by a different user; the creator (testUserID) is
	// workspace owner but the invoke gate has no admin bypass for private
	// agents (MUL-3963).
	privateAgentID, _, _ := privateAgentTestFixture(t)
	title := "skill-mention-issue-create-private-gate-" + t.Name()
	w := createIssueExpectStatus(t, map[string]any{
		"title":       title,
		"status":      "todo",
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {privateAgentID, fx.OtherAgentID},
		},
	}, http.StatusCreated)
	issueID, outcomes := decodeCreateIssueDesignations(t, w)

	// Gate-blocked agent: no bind (gate ran pre-transaction), no run.
	if got := countAgentSkillBindingsFor(t, privateAgentID, fx.SkillID); got != 0 {
		t.Fatalf("gate-blocked private agent must NOT be bound, got %d bindings", got)
	}
	if got := countQueuedOrDispatched(t, privateAgentID, issueID); got != 0 {
		t.Fatalf("gate-blocked private agent must NOT be enqueued, got %d tasks", got)
	}
	bo := findDesignationOutcome(outcomes, privateAgentID)
	if bo == nil || bo.Status != "blocked" || bo.ReasonCode != "invocation_not_allowed" {
		t.Fatalf("expected blocked/invocation_not_allowed outcome for the private agent, got %+v", outcomes)
	}
	// The admissible co-designated agent still binds and triggers.
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected co-designated admissible agent bound, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, issueID); got != 1 {
		t.Fatalf("expected co-designated admissible agent enqueued, got %d tasks", got)
	}
	qo := findDesignationOutcome(outcomes, fx.OtherAgentID)
	if qo == nil || qo.Status != "queued" {
		t.Fatalf("expected queued outcome for the co-designated admissible agent, got %+v", outcomes)
	}
}

// TestSkillMentionIssueCreate_ArchivedAndRuntimelessAgentsBlocked: the
// remaining gate-set members — an archived designated agent blocks with
// target_unavailable, and one with no runtime bound blocks with
// runtime_offline (mirroring the comment path's gate reasons); neither is
// bound or enqueued.
func TestSkillMentionIssueCreate_ArchivedAndRuntimelessAgentsBlocked(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	archivedAgentID := createHandlerTestAgent(t, "Handler Designate Archived", nil)
	if _, err := testPool.Exec(ctx, `UPDATE agent SET archived_at = now() WHERE id = $1`, archivedAgentID); err != nil {
		t.Fatalf("archive agent: %v", err)
	}
	runtimelessAgentID := createHandlerTestAgent(t, "Handler Designate Runtimeless", nil)
	if _, err := testPool.Exec(ctx, `UPDATE agent SET runtime_id = NULL WHERE id = $1`, runtimelessAgentID); err != nil {
		t.Fatalf("clear agent runtime: %v", err)
	}

	title := "skill-mention-issue-create-gate-reasons-" + t.Name()
	w := createIssueExpectStatus(t, map[string]any{
		"title":       title,
		"status":      "todo",
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {archivedAgentID, runtimelessAgentID},
		},
	}, http.StatusCreated)
	issueID, outcomes := decodeCreateIssueDesignations(t, w)

	for _, agentID := range []string{archivedAgentID, runtimelessAgentID} {
		if got := countAgentSkillBindingsFor(t, agentID, fx.SkillID); got != 0 {
			t.Fatalf("gate-blocked agent %s must NOT be bound, got %d bindings", agentID, got)
		}
		if got := countQueuedOrDispatched(t, agentID, issueID); got != 0 {
			t.Fatalf("gate-blocked agent %s must NOT be enqueued, got %d tasks", agentID, got)
		}
	}
	ao := findDesignationOutcome(outcomes, archivedAgentID)
	if ao == nil || ao.Status != "blocked" || ao.ReasonCode != "target_unavailable" {
		t.Fatalf("expected blocked/target_unavailable for the archived agent, got %+v", outcomes)
	}
	ro := findDesignationOutcome(outcomes, runtimelessAgentID)
	if ro == nil || ro.Status != "blocked" || ro.ReasonCode != "runtime_offline" {
		t.Fatalf("expected blocked/runtime_offline for the runtimeless agent, got %+v", outcomes)
	}
}

// TestSkillMentionIssueCreate_CrossWorkspaceSkillDesignationDropped: a
// designation keyed by a skill that does not resolve in the request workspace
// is silently dropped (no bind, no outcome — comment-path parity), while a
// real designation in the same request still binds and enqueues.
func TestSkillMentionIssueCreate_CrossWorkspaceSkillDesignationDropped(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	foreignSkillID := insertHandlerTestSkillInForeignWorkspace(t, "skill-mention-foreign", "foreign skill")
	title := "skill-mention-issue-create-cross-ws-skill-" + t.Name()
	description := fmt.Sprintf("[@Foreign](mention://skill/%s) and [@SkillB](mention://skill/%s)", foreignSkillID, fx.SecondSkillID)
	w := createIssueExpectStatus(t, map[string]any{
		"title":       title,
		"status":      "todo",
		"description": description,
		"skill_mention_agents": map[string][]string{
			foreignSkillID:   {fx.OtherAgentID},
			fx.SecondSkillID: {fx.JID},
		},
	}, http.StatusCreated)
	issueID, outcomes := decodeCreateIssueDesignations(t, w)

	// Foreign-skill designation: dropped silently — no bind, no run, no outcome.
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, foreignSkillID); got != 0 {
		t.Fatalf("cross-workspace skill designation must not bind, got %d bindings", got)
	}
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, issueID); got != 0 {
		t.Fatalf("cross-workspace skill designation must not enqueue, got %d tasks", got)
	}
	if o := findDesignationOutcome(outcomes, fx.OtherAgentID); o != nil {
		t.Fatalf("cross-workspace skill designation must be silent, got outcome %+v", *o)
	}
	// The real designation in the same request still binds and enqueues.
	if got := countAgentSkillBindingsFor(t, fx.JID, fx.SecondSkillID); got != 1 {
		t.Fatalf("expected in-workspace designation bound, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.JID, fx.SecondSkillID)
	if got := countQueuedOrDispatched(t, fx.JID, issueID); got != 1 {
		t.Fatalf("expected in-workspace designation enqueued, got %d tasks", got)
	}
}

// TestSkillMentionIssueCreate_CrossWorkspaceAgentBlocked: a designation naming
// an agent that exists only in a FOREIGN workspace counts as blocked with the
// enumeration-safe invocation_not_allowed reason (same shape as not-invocable
// — the caller learns nothing about the target's existence), while the local
// co-designated agent binds and enqueues.
func TestSkillMentionIssueCreate_CrossWorkspaceAgentBlocked(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	foreignAgentID := insertHandlerTestAgentInForeignWorkspace(t, "foreign-designate")
	title := "skill-mention-issue-create-cross-ws-agent-" + t.Name()
	w := createIssueExpectStatus(t, map[string]any{
		"title":       title,
		"status":      "todo",
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {foreignAgentID, fx.OtherAgentID},
		},
	}, http.StatusCreated)
	issueID, outcomes := decodeCreateIssueDesignations(t, w)

	if got := countAgentSkillBindingsFor(t, foreignAgentID, fx.SkillID); got != 0 {
		t.Fatalf("cross-workspace agent must NOT be bound, got %d bindings", got)
	}
	if got := countQueuedOrDispatched(t, foreignAgentID, issueID); got != 0 {
		t.Fatalf("cross-workspace agent must NOT be enqueued, got %d tasks", got)
	}
	fo := findDesignationOutcome(outcomes, foreignAgentID)
	if fo == nil || fo.Status != "blocked" || fo.ReasonCode != "invocation_not_allowed" {
		t.Fatalf("expected blocked/invocation_not_allowed for the cross-workspace agent, got %+v", outcomes)
	}
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected local co-designated agent bound, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, issueID); got != 1 {
		t.Fatalf("expected local co-designated agent enqueued, got %d tasks", got)
	}
}

// TestSkillMentionIssueCreate_DesignationWithoutChipNotHonored pins the
// content coupling: a designation whose skill chip does not appear in the
// submitted description is never honored (no bind, no run, no outcome), even
// when another chip-backed designation in the same request is.
func TestSkillMentionIssueCreate_DesignationWithoutChipNotHonored(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	title := "skill-mention-issue-create-no-chip-" + t.Name()
	// Only skillA has a chip in the description; the skillB designation has no
	// matching chip and must be ignored.
	w := createIssueExpectStatus(t, map[string]any{
		"title":       title,
		"status":      "todo",
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) only this one", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID:       {fx.OtherAgentID},
			fx.SecondSkillID: {fx.JID},
		},
	}, http.StatusCreated)
	issueID, outcomes := decodeCreateIssueDesignations(t, w)

	if got := countAgentSkillBindingsFor(t, fx.JID, fx.SecondSkillID); got != 0 {
		t.Fatalf("designation without a description chip must not bind, got %d bindings", got)
	}
	if got := countQueuedOrDispatched(t, fx.JID, issueID); got != 0 {
		t.Fatalf("designation without a description chip must not enqueue, got %d tasks", got)
	}
	if o := findDesignationOutcome(outcomes, fx.JID); o != nil {
		t.Fatalf("designation without a description chip must be silent, got outcome %+v", *o)
	}
	// The chip-backed designation still binds and enqueues.
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected chip-backed designation bound, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, issueID); got != 1 {
		t.Fatalf("expected chip-backed designation enqueued, got %d tasks", got)
	}
}

// TestSkillMentionIssueCreate_SquadLeaderDesignationMerges covers the squad
// equivalence (review M3): when the assignee is a squad, designating its
// leader merges into the natural leader run — exactly one run, no duplicate
// enqueue, merged outcome. This doubles as the pending-guard pin: without the
// HasPendingTaskForIssueAndAgent check before the designation enqueue, the
// second enqueue would collide with the unique pending-task index.
func TestSkillMentionIssueCreate_SquadLeaderDesignationMerges(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// Squad led by the seeded agent J (proven to accept leader runs on create
	// by TestCreateIssueAssignedToSquadEnqueuesLeader).
	var squadID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO squad (workspace_id, name, description, leader_id, creator_id)
		VALUES ($1, $2, '', $3, $4)
		RETURNING id
	`, testWorkspaceID, "Designation Merge Squad "+t.Name(), fx.JID, testUserID).Scan(&squadID); err != nil {
		t.Fatalf("create squad: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM squad WHERE id = $1`, squadID)
	})

	title := "skill-mention-issue-create-squad-merge-" + t.Name()
	w := createIssueExpectStatus(t, map[string]any{
		"title":         title,
		"status":        "todo",
		"description":   fmt.Sprintf("[@SkillB](mention://skill/%s) take this", fx.SecondSkillID),
		"assignee_type": "squad",
		"assignee_id":   squadID,
		"skill_mention_agents": map[string][]string{
			fx.SecondSkillID: {fx.JID},
		},
	}, http.StatusCreated)
	issueID, outcomes := decodeCreateIssueDesignations(t, w)

	// Exactly ONE run for the leader: the natural squad-leader enqueue, into
	// which the designation merged (no duplicate, no ErrDuplicatePendingTask).
	if got := countQueuedOrDispatched(t, fx.JID, issueID); got != 1 {
		t.Fatalf("expected exactly 1 leader run for the squad-leader merge, got %d", got)
	}
	// The leader was bound in the create transaction, so the natural run
	// carries the skill.
	if got := countAgentSkillBindingsFor(t, fx.JID, fx.SecondSkillID); got != 1 {
		t.Fatalf("expected squad leader bound to skillB in the create transaction, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.JID, fx.SecondSkillID)
	o := findDesignationOutcome(outcomes, fx.JID)
	if o == nil || o.Status != "merged" {
		t.Fatalf("expected merged outcome for the squad-leader designation, got %+v", outcomes)
	}
}

// ---------------------------------------------------------------------------
// U3: edit-path designation wiring — post-commit gate against the FINAL merged
// description (R15 content coupling), best-effort bind before any enqueue
// (KTD2 edit-side), final-assignee/status split (R9: assignee / squad leader
// bind-only; R11 backlog + KTD6 SuppressRun park the run but never the bind),
// pending-guard merge (review M3), the KTD7 handoff event summary on
// designation-triggered runs, and per-agent outcomes on the update response
// (R16). These tests drive the real UpdateIssue handler against the local dev
// DB.
// ---------------------------------------------------------------------------

// decodeUpdateIssueDesignations decodes the update response body and returns
// the issue id plus its designation outcomes.
func decodeUpdateIssueDesignations(t *testing.T, w *httptest.ResponseRecorder) (string, []skillDesignationOutcomeView) {
	t.Helper()
	var resp struct {
		ID                       string                        `json:"id"`
		SkillDesignationOutcomes []skillDesignationOutcomeView `json:"skill_designation_outcomes"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode update response: %v", err)
	}
	if resp.ID == "" {
		t.Fatalf("update response missing issue id")
	}
	return resp.ID, resp.SkillDesignationOutcomes
}

// setIssueAssigneeStatusForTest rewrites the fixture issue's persisted status
// and assignee directly, so an edit-path test starts from a known pre-state
// (the given, not the behavior under test). Empty assigneeType/assigneeID
// store NULL (unassigned).
func setIssueAssigneeStatusForTest(t *testing.T, issueID, status, assigneeType, assigneeID string) {
	t.Helper()
	var at, aid any
	if assigneeType != "" {
		at = assigneeType
	}
	if assigneeID != "" {
		aid = assigneeID
	}
	if _, err := testPool.Exec(context.Background(),
		`UPDATE issue SET status = $2, assignee_type = $3, assignee_id = $4 WHERE id = $1`,
		issueID, status, at, aid); err != nil {
		t.Fatalf("set issue assignee/status: %v", err)
	}
}

// setIssueDescriptionForTest rewrites the fixture issue's persisted
// description directly (a test pre-state, e.g. a chip an earlier autosave
// already committed).
func setIssueDescriptionForTest(t *testing.T, issueID, description string) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`UPDATE issue SET description = $2 WHERE id = $1`, issueID, description); err != nil {
		t.Fatalf("set issue description: %v", err)
	}
}

// loadDesignationTask reads the single queued/dispatched task for (agent,
// issue) so tests can assert the run's handoff note and attribution.
func loadDesignationTask(t *testing.T, agentID, issueID string) (handoffNote string, originator string) {
	t.Helper()
	var note, orig *string
	if err := testPool.QueryRow(context.Background(), `
		SELECT handoff_note, originator_user_id::text FROM agent_task_queue
		WHERE issue_id = $1 AND agent_id = $2 AND status IN ('queued', 'dispatched')
	`, issueID, agentID).Scan(&note, &orig); err != nil {
		t.Fatalf("load designation task: %v", err)
	}
	if note != nil {
		handoffNote = *note
	}
	if orig != nil {
		originator = *orig
	}
	return handoffNote, originator
}

// skillNameForTest loads a skill row's display name for handoff-note
// assertions.
func skillNameForTest(t *testing.T, skillID string) string {
	t.Helper()
	var name string
	if err := testPool.QueryRow(context.Background(),
		`SELECT name FROM skill WHERE id = $1`, skillID).Scan(&name); err != nil {
		t.Fatalf("load skill name: %v", err)
	}
	return name
}

// TestSkillMentionIssueUpdate_DesignateAssigneeBindsOnly covers AE2: an edit
// that designates the issue's current assignee agent binds that agent to the
// skill but starts no run (R9 — accepting the assignee default is a
// content-maintenance gesture), and the outcome reports the bind-only result.
func TestSkillMentionIssueUpdate_DesignateAssigneeBindsOnly(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	setIssueAssigneeStatusForTest(t, fx.IssueID, "todo", "agent", fx.OtherAgentID)

	w := updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {fx.OtherAgentID},
		},
	}, http.StatusOK)
	_, outcomes := decodeUpdateIssueDesignations(t, w)

	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected designated assignee bound to skillA, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 0 {
		t.Fatalf("designating the assignee must not enqueue a run, got %d tasks", got)
	}
	o := findDesignationOutcome(outcomes, fx.OtherAgentID)
	if o == nil || o.Status != "bound" {
		t.Fatalf("expected bind-only outcome for the assignee designation, got %+v", outcomes)
	}
}

// TestSkillMentionIssueUpdate_DesignateNonAssigneeBindsAndTriggers covers AE3:
// an edit that designates a NON-assignee agent on a todo issue binds that
// agent and enqueues exactly one run for it (R9), carrying the KTD7 handoff
// event summary (actor + skill label + "while editing the issue description")
// and attributed to the editing member. The assignee itself gets no run from
// a description-only edit.
func TestSkillMentionIssueUpdate_DesignateNonAssigneeBindsAndTriggers(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	setIssueAssigneeStatusForTest(t, fx.IssueID, "todo", "agent", fx.JID)

	w := updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {fx.OtherAgentID},
		},
	}, http.StatusOK)
	_, outcomes := decodeUpdateIssueDesignations(t, w)

	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected designated non-assignee bound to skillA, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected exactly 1 run enqueued for the designated non-assignee, got %d", got)
	}
	// KTD7: the designation-triggered run carries the event summary — actor,
	// skill label, and the edit gesture — never the description body.
	note, originator := loadDesignationTask(t, fx.OtherAgentID, fx.IssueID)
	skillName := skillNameForTest(t, fx.SkillID)
	if !strings.Contains(note, handlerTestName) ||
		!strings.Contains(note, "@"+skillName) ||
		!strings.Contains(note, "while editing the issue description") {
		t.Fatalf("designation run must carry the KTD7 handoff event summary, got %q", note)
	}
	if originator != testUserID {
		t.Fatalf("designation run must be attributed to the editing member; got originator %q, want %q", originator, testUserID)
	}
	// A description-only edit does not trigger the assignee.
	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("description-only edit must not start an assignee run, got %d tasks", got)
	}
	o := findDesignationOutcome(outcomes, fx.OtherAgentID)
	if o == nil || o.Status != "queued" || o.ReasonCode != "queued" {
		t.Fatalf("expected queued outcome for the designated non-assignee, got %+v", outcomes)
	}
}

// TestSkillMentionIssueUpdate_BacklogDesignationBindsOnly covers R11: on a
// backlog issue, designating a non-assignee binds but never enqueues.
func TestSkillMentionIssueUpdate_BacklogDesignationBindsOnly(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	setIssueAssigneeStatusForTest(t, fx.IssueID, "backlog", "agent", fx.JID)

	w := updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {fx.OtherAgentID},
		},
	}, http.StatusOK)
	_, outcomes := decodeUpdateIssueDesignations(t, w)

	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected designated agent bound despite backlog, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 0 {
		t.Fatalf("backlog designation must not enqueue, got %d tasks", got)
	}
	o := findDesignationOutcome(outcomes, fx.OtherAgentID)
	if o == nil || o.Status != "bound" {
		t.Fatalf("expected bind-only outcome for the backlog designation, got %+v", outcomes)
	}
}

// TestSkillMentionIssueUpdate_SuppressRunDesignationBindsOnly mirrors the
// comment path's _SuppressedDesignatedAgentStillBound (KTD6): suppress_run
// stops the designation run this turn but must not undo the durable bind.
func TestSkillMentionIssueUpdate_SuppressRunDesignationBindsOnly(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	setIssueAssigneeStatusForTest(t, fx.IssueID, "todo", "agent", fx.JID)

	w := updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"description":  fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"suppress_run": true,
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {fx.OtherAgentID},
		},
	}, http.StatusOK)
	_, outcomes := decodeUpdateIssueDesignations(t, w)

	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected designated agent bound despite suppress_run, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 0 {
		t.Fatalf("suppressed designation must not enqueue, got %d tasks", got)
	}
	o := findDesignationOutcome(outcomes, fx.OtherAgentID)
	if o == nil || o.Status != "bound" {
		t.Fatalf("expected bind-only outcome for the suppressed designation, got %+v", outcomes)
	}
}

// TestSkillMentionIssueUpdate_ReassignFinalBasisSplit pins R9's final-basis
// arbitration: one request that reassigns the issue (J → other) AND designates
// both agents. The designation of the NEW assignee folds into the natural
// assign run (merged — exactly one run, no designation double-fire, and the
// natural run carries no handoff note); the designation of the OLD assignee —
// now a non-assignee — binds and triggers with the KTD7 handoff note.
func TestSkillMentionIssueUpdate_ReassignFinalBasisSplit(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	setIssueAssigneeStatusForTest(t, fx.IssueID, "todo", "agent", fx.JID)

	w := updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"description":   fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"assignee_type": "agent",
		"assignee_id":   fx.OtherAgentID,
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {fx.JID, fx.OtherAgentID},
		},
	}, http.StatusOK)
	_, outcomes := decodeUpdateIssueDesignations(t, w)

	// New assignee: the natural assign run is the ONLY run; the designation
	// merged into it (no second enqueue), and the bind landed.
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected exactly 1 run for the new assignee (natural assign run), got %d", got)
	}
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected new assignee bound to skillA, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	if note, _ := loadDesignationTask(t, fx.OtherAgentID, fx.IssueID); note != "" {
		t.Fatalf("the natural assign run must not carry a designation handoff note, got %q", note)
	}
	mo := findDesignationOutcome(outcomes, fx.OtherAgentID)
	if mo == nil || mo.Status != "merged" || mo.ReasonCode != "coalesced" {
		t.Fatalf("expected merged/coalesced outcome for the new-assignee designation, got %+v", outcomes)
	}

	// Old assignee (now non-assignee): bound (fixture pre-bound skillA, the
	// upsert is idempotent) and triggered with the KTD7 handoff note.
	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 1 {
		t.Fatalf("expected exactly 1 designation run for the old assignee, got %d", got)
	}
	if note, _ := loadDesignationTask(t, fx.JID, fx.IssueID); !strings.Contains(note, "while editing the issue description") {
		t.Fatalf("old-assignee designation run must carry the KTD7 handoff note, got %q", note)
	}
	qo := findDesignationOutcome(outcomes, fx.JID)
	if qo == nil || qo.Status != "queued" {
		t.Fatalf("expected queued outcome for the old-assignee designation, got %+v", outcomes)
	}
}

// TestSkillMentionIssueUpdate_GateBlockedPrivateAgentOthersSurvive covers AE7
// on the edit path: designating an agent the editor cannot invoke produces NO
// binding and NO run, surfaces a blocked outcome, and does not abort the
// admissible co-designation (R15/R16).
func TestSkillMentionIssueUpdate_GateBlockedPrivateAgentOthersSurvive(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	privateAgentID, _, _ := privateAgentTestFixture(t)
	setIssueAssigneeStatusForTest(t, fx.IssueID, "todo", "agent", fx.JID)

	w := updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {privateAgentID, fx.OtherAgentID},
		},
	}, http.StatusOK)
	_, outcomes := decodeUpdateIssueDesignations(t, w)

	if got := countAgentSkillBindingsFor(t, privateAgentID, fx.SkillID); got != 0 {
		t.Fatalf("gate-blocked private agent must NOT be bound, got %d bindings", got)
	}
	if got := countQueuedOrDispatched(t, privateAgentID, fx.IssueID); got != 0 {
		t.Fatalf("gate-blocked private agent must NOT be enqueued, got %d tasks", got)
	}
	bo := findDesignationOutcome(outcomes, privateAgentID)
	if bo == nil || bo.Status != "blocked" || bo.ReasonCode != "invocation_not_allowed" {
		t.Fatalf("expected blocked/invocation_not_allowed outcome for the private agent, got %+v", outcomes)
	}
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected co-designated admissible agent bound, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected co-designated admissible agent enqueued, got %d tasks", got)
	}
	qo := findDesignationOutcome(outcomes, fx.OtherAgentID)
	if qo == nil || qo.Status != "queued" {
		t.Fatalf("expected queued outcome for the co-designated admissible agent, got %+v", outcomes)
	}
}

// TestSkillMentionIssueUpdate_ChipDeletedInEditNotHonored pins the edit-side
// content coupling: a designation whose skill chip was DELETED from the
// description in the same edit is silently dropped (no bind, no run, no
// outcome), because the gate reads the FINAL persisted description.
func TestSkillMentionIssueUpdate_ChipDeletedInEditNotHonored(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	// Pre-state: an earlier edit committed BOTH chips.
	setIssueDescriptionForTest(t, fx.IssueID, fmt.Sprintf(
		"[@SkillA](mention://skill/%s) and [@SkillB](mention://skill/%s)", fx.SkillID, fx.SecondSkillID))
	setIssueAssigneeStatusForTest(t, fx.IssueID, "todo", "agent", fx.JID)

	// This edit deletes the skillB chip but still designates J for it.
	w := updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) only this one", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID:       {fx.OtherAgentID},
			fx.SecondSkillID: {fx.JID},
		},
	}, http.StatusOK)
	_, outcomes := decodeUpdateIssueDesignations(t, w)

	// Deleted-chip designation: dropped silently — J is not bound to skillB,
	// gets no run, and collects no outcome.
	if got := countAgentSkillBindingsFor(t, fx.JID, fx.SecondSkillID); got != 0 {
		t.Fatalf("designation whose chip was deleted mid-edit must not bind, got %d bindings", got)
	}
	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("designation whose chip was deleted mid-edit must not enqueue, got %d tasks", got)
	}
	if o := findDesignationOutcome(outcomes, fx.JID); o != nil {
		t.Fatalf("designation whose chip was deleted mid-edit must be silent, got outcome %+v", *o)
	}
	// The surviving chip's designation still binds and triggers.
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected surviving-chip designation bound, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected surviving-chip designation enqueued, got %d tasks", got)
	}
}

// TestSkillMentionIssueUpdate_PendingDesignationMerges pins the review-M3
// pending guard on the edit path: when an (issue, agent) task is already
// pending, the designation folds into it — no second enqueue, merged outcome,
// binding still written.
func TestSkillMentionIssueUpdate_PendingDesignationMerges(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)
	setIssueAssigneeStatusForTest(t, fx.IssueID, "todo", "", "")

	// Pre-existing pending run for (issue, other) — e.g. an earlier mention.
	if _, err := testHandler.TaskService.EnqueueTaskForMentionWithActor(
		ctx, fx.Issue, parseUUID(fx.OtherAgentID), "", parseUUID(testUserID)); err != nil {
		t.Fatalf("seed pending task: %v", err)
	}

	w := updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"description": fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID),
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {fx.OtherAgentID},
		},
	}, http.StatusOK)
	_, outcomes := decodeUpdateIssueDesignations(t, w)

	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("pending guard must prevent a second enqueue, got %d tasks", got)
	}
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected designated agent bound despite the merge, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	o := findDesignationOutcome(outcomes, fx.OtherAgentID)
	if o == nil || o.Status != "merged" || o.ReasonCode != "coalesced" {
		t.Fatalf("expected merged/coalesced outcome for the pending designation, got %+v", outcomes)
	}
}

// TestSkillMentionIssueUpdate_SquadLeaderDesignationBindsOnly pins the
// edit-side squad equivalence (review M3): when the final assignee is a squad,
// designating its leader is an assignee designation — bind only, never a
// designation run — even when NO natural leader run is pending (a
// description-only edit starts none).
func TestSkillMentionIssueUpdate_SquadLeaderDesignationBindsOnly(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	var squadID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO squad (workspace_id, name, description, leader_id, creator_id)
		VALUES ($1, $2, '', $3, $4)
		RETURNING id
	`, testWorkspaceID, "Designation Edit Squad "+t.Name(), fx.JID, testUserID).Scan(&squadID); err != nil {
		t.Fatalf("create squad: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM squad WHERE id = $1`, squadID)
	})
	setIssueAssigneeStatusForTest(t, fx.IssueID, "todo", "squad", squadID)

	w := updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"description": fmt.Sprintf("[@SkillB](mention://skill/%s) take this", fx.SecondSkillID),
		"skill_mention_agents": map[string][]string{
			fx.SecondSkillID: {fx.JID},
		},
	}, http.StatusOK)
	_, outcomes := decodeUpdateIssueDesignations(t, w)

	if got := countAgentSkillBindingsFor(t, fx.JID, fx.SecondSkillID); got != 1 {
		t.Fatalf("expected squad leader bound to skillB, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.JID, fx.SecondSkillID)
	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("leader designation with no pending leader run must NOT enqueue, got %d tasks", got)
	}
	o := findDesignationOutcome(outcomes, fx.JID)
	if o == nil || o.Status != "bound" {
		t.Fatalf("expected bind-only outcome for the squad-leader designation, got %+v", outcomes)
	}
}

// TestSkillMentionIssueUpdate_DesignationOnlyUpdateHonored pins the server
// half of AE8: an update that carries ONLY skill_mention_agents (no
// description field — the chip was committed by an earlier autosave) is gated
// against the persisted description and honored.
func TestSkillMentionIssueUpdate_DesignationOnlyUpdateHonored(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSkillMentionFixture(t)
	setIssueDescriptionForTest(t, fx.IssueID, fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID))
	setIssueAssigneeStatusForTest(t, fx.IssueID, "todo", "agent", fx.JID)

	w := updateIssueExpectStatus(t, fx.IssueID, map[string]any{
		"skill_mention_agents": map[string][]string{
			fx.SkillID: {fx.OtherAgentID},
		},
	}, http.StatusOK)
	_, outcomes := decodeUpdateIssueDesignations(t, w)

	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected designation-only update to bind, got %d bindings", got)
	}
	cleanupAgentSkillBinding(t, fx.OtherAgentID, fx.SkillID)
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected designation-only update to enqueue, got %d tasks", got)
	}
	o := findDesignationOutcome(outcomes, fx.OtherAgentID)
	if o == nil || o.Status != "queued" {
		t.Fatalf("expected queued outcome for the designation-only update, got %+v", outcomes)
	}
}
