package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// skillMentionFixture wires the seeded workspace-visible agent ("Handler Test
// Agent", J) to skillA and a second agent ("Handler Skill Other") to skillB so
// we can exercise the @skill mention path on the create-only
// triggerTasksForComment → bindAndEnqueueSkillMentions chain. The tests below
// lock in the explicit-designation contract:
//
//   - a designated agent is enqueued even when another agent holds the binding,
//     and is itself bound to the skill on submit
//   - a @skill mention with NO designation triggers nothing (silent), even when
//     an agent_skill binding exists
//   - a designated-but-unbound agent is bound then triggered
//   - an unavailable designated agent (archived) is skipped and does not abort
//     the other valid designations
//   - dedup prevents double-triggering against a pending task
//   - multiple @skill mentions each enqueue their own designated agent
//   - unknown / invalid skill IDs do not crash the comment handler
type skillMentionFixture struct {
	JID           string
	RuntimeID     string
	IssueID       string
	Issue         db.Issue
	CommentID     string
	Comment       db.Comment
	SkillID       string
	SecondSkillID string
	// OtherAgentID is a second handler-test agent used for the
	// "multiple skill mentions in one comment" scenario.
	OtherAgentID string
	OtherRuntime string
}

// newSkillMentionFixture creates one issue + a few skill bindings plus the
// extra agent the multi-skill test needs. Cleanup is wired through t.Cleanup
// so each sub-test gets a fresh fixture.
func newSkillMentionFixture(t *testing.T) skillMentionFixture {
	t.Helper()
	ctx := context.Background()

	// Load the seeded "Handler Test Agent" — same one the other mention
	// tests reuse, so we know it has a runtime and a workspace invocation
	// target (MUL-3963).
	var jID string
	if err := testPool.QueryRow(ctx, `
		SELECT id FROM agent WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1
	`, testWorkspaceID).Scan(&jID); err != nil {
		t.Fatalf("load seeded agent: %v", err)
	}
	var runtimeID string
	if err := testPool.QueryRow(ctx, `SELECT runtime_id FROM agent WHERE id = $1`, jID).Scan(&runtimeID); err != nil {
		t.Fatalf("load runtime: %v", err)
	}

	// Pick a per-workspace issue number so we don't collide with other
	// tests' fixtures.
	var number int
	if err := testPool.QueryRow(ctx, `
		UPDATE workspace
		SET issue_counter = GREATEST(issue_counter, (SELECT COALESCE(MAX(number), 0) FROM issue WHERE workspace_id = $1)) + 1
		WHERE id = $1 RETURNING issue_counter
	`, testWorkspaceID).Scan(&number); err != nil {
		t.Fatalf("next issue number: %v", err)
	}

	// The issue is unassigned so the implicit (assignee / reply-parent)
	// routing never fires and every queued task we observe comes from the
	// explicit skill designation under test.
	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, creator_type, creator_id, title, number)
		VALUES ($1, 'member', $2, $3, $4)
		RETURNING id
	`, testWorkspaceID, testUserID, "skill mention test", number).Scan(&issueID); err != nil {
		t.Fatalf("create issue: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
		testPool.Exec(context.Background(), `DELETE FROM comment WHERE issue_id = $1`, issueID)
		testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID)
	})

	skillA := insertHandlerTestSkill(t, "skill-mention-a", "skill A")
	skillB := insertHandlerTestSkill(t, "skill-mention-b", "skill B")

	// Bind skillA to the seeded agent J. Tests that assert "the designated
	// agent wins over the existing binding" designate a DIFFERENT agent and
	// confirm J's binding does not pull J in.
	if _, err := testPool.Exec(ctx, `
		INSERT INTO agent_skill (agent_id, skill_id) VALUES ($1, $2)
	`, jID, skillA); err != nil {
		t.Fatalf("bind skillA to J: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`, jID, skillA)
	})

	// Create a second agent for the multi-skill scenario. Skill B is bound
	// only to this other agent.
	otherAgentID := createHandlerTestAgent(t, "Handler Skill Other", nil)
	otherRuntime := handlerTestRuntimeID(t)
	if _, err := testPool.Exec(ctx, `
		INSERT INTO agent_skill (agent_id, skill_id) VALUES ($1, $2)
	`, otherAgentID, skillB); err != nil {
		t.Fatalf("bind skillB to other agent: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`, otherAgentID, skillB)
	})

	issue, err := testHandler.Queries.GetIssue(ctx, parseUUID(issueID))
	if err != nil {
		t.Fatalf("load issue: %v", err)
	}

	return skillMentionFixture{
		JID:           jID,
		RuntimeID:     runtimeID,
		IssueID:       issueID,
		Issue:         issue,
		SkillID:       skillA,
		SecondSkillID: skillB,
		OtherAgentID:  otherAgentID,
		OtherRuntime:  otherRuntime,
	}
}

// insertSkillMentionComment writes a comment whose content is the supplied
// mention text. The author is the seeded member (testUserID) — skill mentions
// from members are the user flow the feature targets.
func insertSkillMentionComment(t *testing.T, issueID, content string) string {
	t.Helper()
	var id string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO comment (workspace_id, issue_id, author_type, author_id, content)
		VALUES ($1, $2, 'member', $3, $4)
		RETURNING id
	`, testWorkspaceID, issueID, testUserID, content).Scan(&id); err != nil {
		t.Fatalf("insert skill mention comment: %v", err)
	}
	return id
}

// triggerSkillMentions drives the REAL create path — triggerTasksForComment —
// so these integration tests exercise the bind-and-trigger side effect (the
// durable agent_skill insert plus the enqueue), not the read-only compute path
// the preview uses. skillAgents is the parsed skill_mention_agents payload.
func triggerSkillMentions(t *testing.T, ctx context.Context, fx skillMentionFixture, commentID string, skillAgents map[string][]pgtype.UUID) []CommentTriggerOutcome {
	t.Helper()
	comment, err := testHandler.Queries.GetComment(ctx, parseUUID(commentID))
	if err != nil {
		t.Fatalf("load comment: %v", err)
	}
	// Zero-value parent / suppress list / originator: the fixture's author is a
	// member, so originator gating keys on the member id directly.
	return testHandler.triggerTasksForComment(ctx, fx.Issue, comment, nil, "member", testUserID, "", nil, skillAgents)
}

// countAgentSkillBindingsFor reports how many agent_skill rows link the agent to
// the skill — used to assert the bind-on-submit side effect.
func countAgentSkillBindingsFor(t *testing.T, agentID, skillID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `
		SELECT count(*) FROM agent_skill WHERE agent_id = $1 AND skill_id = $2
	`, agentID, skillID).Scan(&n); err != nil {
		t.Fatalf("count agent_skill bindings: %v", err)
	}
	return n
}

// TestEnqueueSkillMention_UsesFrontendResolvedAgent proves the explicit-
// designation happy path: the frontend designates "other" (not J, even though J
// holds the agent_skill binding), and the backend enqueues exactly "other".
// Because "other" was NOT bound to skillA, the create path must also bind it.
func TestEnqueueSkillMention_UsesFrontendResolvedAgent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillA](mention://skill/"+fx.SkillID+") please review")

	// "other" starts unbound to skillA.
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 0 {
		t.Fatalf("precondition: expected other agent unbound to skillA, got %d bindings", got)
	}

	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		fx.SkillID: {parseUUIDForTest(t, fx.OtherAgentID)},
	})

	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected 1 queued task on designated agent, got %d", got)
	}
	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on agent_skill binding (designation overrode it), got %d", got)
	}
	// Bind-on-submit: the designated agent must now be bound to skillA.
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected designated agent bound to skillA after submit, got %d bindings", got)
	}
}

// TestEnqueueSkillMention_NoDesignationIsSilent reverses the old fallback: a
// @skill mention with NO skill_mention_agents entry now enqueues NOTHING, even
// though J holds an agent_skill binding. The backend never reverse-looks-up the
// junction table to pick a target.
func TestEnqueueSkillMention_NoDesignationIsSilent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillA](mention://skill/"+fx.SkillID+") please review")

	triggerSkillMentions(t, ctx, fx, commentID, nil)

	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks with no designation (binding must not be consulted), got %d", got)
	}
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks with no designation, got %d", got)
	}
}

// TestEnqueueSkillMention_NoDesignationIgnoresAssignee confirms R13 is gone:
// without a designation, a @skill mention fires nothing regardless of who the
// issue assignee is or what skills they hold.
func TestEnqueueSkillMention_NoDesignationIgnoresAssignee(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// Make J (which holds skillA) the issue assignee.
	if _, err := testPool.Exec(ctx, `
		UPDATE issue SET assignee_type = 'agent', assignee_id = $1 WHERE id = $2
	`, fx.JID, fx.IssueID); err != nil {
		t.Fatalf("assign issue to J: %v", err)
	}
	fx.Issue, _ = testHandler.Queries.GetIssue(ctx, parseUUID(fx.IssueID))

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillA](mention://skill/"+fx.SkillID+") please review")

	triggerSkillMentions(t, ctx, fx, commentID, nil)

	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks with no designation even for the assignee, got %d", got)
	}
}

// TestEnqueueSkillMention_DedupesAgainstPendingTask locks in that the
// hasPendingTaskForIssueAndAgent dedupe applies to the skill designation path
// just like it does for @agent / @squad mentions. A queued task must block a
// second queued task for the same (issue, agent).
func TestEnqueueSkillMention_DedupesAgainstPendingTask(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// Seed a queued task on J — simulates a previous mention that already
	// enqueued against this issue.
	if _, err := testPool.Exec(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status)
		VALUES ($1, $2, $3, 'queued')
	`, fx.JID, fx.RuntimeID, fx.IssueID); err != nil {
		t.Fatalf("seed queued task: %v", err)
	}

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillA](mention://skill/"+fx.SkillID+") please review")

	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		fx.SkillID: {parseUUIDForTest(t, fx.JID)},
	})

	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 1 {
		t.Fatalf("expected dedupe (still 1 queued task), got %d", got)
	}
}

// TestEnqueueSkillMention_MultipleSkillMentionsIndependent verifies that two
// @skill mentions in one comment each enqueue their own designated agent — one
// queued task per distinct agent, no merging across skills.
func TestEnqueueSkillMention_MultipleSkillMentionsIndependent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	content := "[@SkillA](mention://skill/" + fx.SkillID + ") and " +
		"[@SkillB](mention://skill/" + fx.SecondSkillID + ") please review"
	commentID := insertSkillMentionComment(t, fx.IssueID, content)

	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		fx.SkillID:       {parseUUIDForTest(t, fx.JID)},
		fx.SecondSkillID: {parseUUIDForTest(t, fx.OtherAgentID)},
	})

	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 1 {
		t.Fatalf("expected 1 queued task on J (skill A designation), got %d", got)
	}
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected 1 queued task on other (skill B designation), got %d", got)
	}
}

// TestEnqueueSkillMention_UnknownSkillIDIsNoCrash confirms the failure
// contract: a mention whose skill ID does not exist in this workspace must not
// abort the trigger computation, must not enqueue a task, and must not bind
// anything — even if the (bogus) mention carries a designation.
func TestEnqueueSkillMention_UnknownSkillIDIsNoCrash(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	bogusID := "00000000-0000-0000-0000-000000000000"
	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@Unknown](mention://skill/"+bogusID+")")

	// Must not panic, even with a designation pointing at a real agent.
	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		bogusID: {parseUUIDForTest(t, fx.JID)},
	})

	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on bogus skill, got %d", got)
	}
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on bogus skill, got %d", got)
	}
	if got := countAgentSkillBindingsFor(t, fx.JID, bogusID); got != 0 {
		t.Fatalf("expected no binding written for bogus skill, got %d", got)
	}
}

// TestEnqueueSkillMention_UnboundSkillBindsAndTriggers reverses the old
// "unbound skill silently dropped" case: a designated-but-unbound agent is now
// BOUND (new agent_skill row) then TRIGGERED.
func TestEnqueueSkillMention_UnboundSkillBindsAndTriggers(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// Skill C is created but never bound to any agent.
	skillC := insertHandlerTestSkill(t, "skill-mention-c", "no bindings")

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillC](mention://skill/"+skillC+")")

	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		skillC: {parseUUIDForTest(t, fx.OtherAgentID)},
	})

	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected 1 queued task on designated (previously unbound) agent, got %d", got)
	}
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, skillC); got != 1 {
		t.Fatalf("expected designated agent bound to skillC, got %d bindings", got)
	}
	// Cleanup the binding this test created via the create path.
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`,
			fx.OtherAgentID, skillC)
	})
}

// TestEnqueueSkillMention_SkillWithNoDesignationNoBindingsIsSilent covers the
// remaining silent case: a real skill with neither a designation nor any
// binding produces no task.
func TestEnqueueSkillMention_SkillWithNoDesignationNoBindingsIsSilent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	skillC := insertHandlerTestSkill(t, "skill-mention-c", "no bindings")

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillC](mention://skill/"+skillC+")")

	triggerSkillMentions(t, ctx, fx, commentID, nil)

	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on undesigned/unbound skill, got %d on J", got)
	}
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on undesigned/unbound skill, got %d on other", got)
	}
}

// TestEnqueueSkillMention_UnavailableAgentSkippedOthersSurvive designates both
// an archived agent and a healthy agent for the same skill: the archived one is
// skipped (no task, no binding) and does NOT abort the healthy designation.
func TestEnqueueSkillMention_UnavailableAgentSkippedOthersSurvive(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// A third agent that we then archive so it is unavailable.
	archivedAgentID := createHandlerTestAgent(t, "Handler Skill Archived", nil)
	if _, err := testPool.Exec(ctx, `
		UPDATE agent SET archived_at = now() WHERE id = $1
	`, archivedAgentID); err != nil {
		t.Fatalf("archive agent: %v", err)
	}

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillA](mention://skill/"+fx.SkillID+") please review")

	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		fx.SkillID: {
			parseUUIDForTest(t, archivedAgentID),
			parseUUIDForTest(t, fx.OtherAgentID),
		},
	})

	// Archived agent: no task, no binding.
	if got := countQueuedOrDispatched(t, archivedAgentID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on archived agent, got %d", got)
	}
	if got := countAgentSkillBindingsFor(t, archivedAgentID, fx.SkillID); got != 0 {
		t.Fatalf("expected archived agent NOT bound, got %d bindings", got)
	}
	// Healthy designated agent still fires and is bound.
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected 1 queued task on healthy designated agent, got %d", got)
	}
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected healthy designated agent bound, got %d bindings", got)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`,
			fx.OtherAgentID, fx.SkillID)
	})
}

// TestEnqueueSkillMention_EnqueuedOutcomeSurfaces checks the returned outcome:
// a designated agent that enqueues appears as a queued "agent" outcome, and an
// unavailable designation surfaces as blocked with a target_unavailable reason.
func TestEnqueueSkillMention_EnqueuedOutcomeSurfaces(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	archivedAgentID := createHandlerTestAgent(t, "Handler Skill Archived", nil)
	if _, err := testPool.Exec(ctx, `
		UPDATE agent SET archived_at = now() WHERE id = $1
	`, archivedAgentID); err != nil {
		t.Fatalf("archive agent: %v", err)
	}

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillA](mention://skill/"+fx.SkillID+") please review")

	outcomes := triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		fx.SkillID: {
			parseUUIDForTest(t, fx.OtherAgentID),
			parseUUIDForTest(t, archivedAgentID),
		},
	})

	var healthy, archived *CommentTriggerOutcome
	for i := range outcomes {
		o := outcomes[i]
		switch o.TargetID {
		case fx.OtherAgentID:
			healthy = &o
		case archivedAgentID:
			archived = &o
		}
	}
	if healthy == nil {
		t.Fatalf("expected an outcome for the healthy designated agent, got %+v", outcomes)
	}
	if healthy.TargetType != "agent" || healthy.Status != DispatchQueued {
		t.Fatalf("expected healthy designated agent queued, got %+v", *healthy)
	}
	if archived == nil {
		t.Fatalf("expected an outcome for the archived designated agent, got %+v", outcomes)
	}
	if archived.Status != DispatchBlocked || archived.ReasonCode != ReasonTargetUnavailable {
		t.Fatalf("expected archived designated agent blocked/target_unavailable, got %+v", *archived)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`,
			fx.OtherAgentID, fx.SkillID)
	})
}

// parseUUIDForTest wraps parseUUID so the test file does not have to import
// the util package directly for a single call site.
func parseUUIDForTest(t *testing.T, s string) pgtype.UUID {
	t.Helper()
	u := parseUUID(s)
	if !u.Valid {
		t.Fatalf("parseUUIDForTest(%q): invalid uuid", s)
	}
	return u
}

// TestUpdateComment_ReTriggersSkillMentionDesignation locks in the edit-path
// symmetry: when an edit sends skill_mention_agents, the retrigger must bind +
// enqueue the designated agent (mirroring the create path), not silently drop
// the field (regression for review finding #1).
func TestUpdateComment_ReTriggersSkillMentionDesignation(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	fx := newSkillMentionFixture(t)
	// A second handler-test agent that starts UNBOUND to skillA — exercising
	// the bind-on-edit side of the symmetry.
	agentID := createHandlerTestAgent(t, "Edit Skill Designated", nil)
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`,
			agentID, fx.SkillID)
		testPool.Exec(context.Background(),
			`DELETE FROM agent_task_queue WHERE issue_id = $1 AND agent_id = $2`,
			fx.IssueID, agentID)
	})

	// Start with a plain comment (no @skill yet).
	commentID := postCommentForTriggerPreviewTest(t, fx.IssueID, map[string]any{
		"content": "first revision",
	})

	// Edit to a @skill mention and designate the unbound agent.
	content := fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID)
	updateCommentForTriggerPreviewTest(t, commentID, map[string]any{
		"content":              content,
		"skill_mention_agents": map[string][]string{fx.SkillID: {agentID}},
	})

	if got := countQueuedCommentTriggerTasks(t, fx.IssueID, agentID); got != 1 {
		t.Fatalf("edit retrigger: expected 1 queued task on designated agent, got %d", got)
	}
	// Bind-on-edit side effect: designated agent must now be bound.
	if got := countAgentSkillBindingsFor(t, agentID, fx.SkillID); got != 1 {
		t.Fatalf("edit retrigger: expected designated agent bound to skillA, got %d bindings", got)
	}
	if got := countQueuedCommentTriggerTasks(t, fx.IssueID, fx.JID); got != 0 {
		t.Fatalf("edit retrigger: expected 0 queued tasks on existing binding J (not designated), got %d", got)
	}
}

// TestUpdateComment_MalformedSkillMentionAgentUUID400s covers the boundary
// validation: an edit that sends a skill_mention_agents entry with a non-UUID
// agent id must 400 at the boundary (plan U1 explicit scenario that was
// missing — see review finding #1 testing gap).
func TestUpdateComment_MalformedSkillMentionAgentUUID400s(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	fx := newSkillMentionFixture(t)
	commentID := postCommentForTriggerPreviewTest(t, fx.IssueID, map[string]any{
		"content": "first",
	})
	content := fmt.Sprintf("[@SkillA](mention://skill/%s) please review", fx.SkillID)

	// Drive update via the router so we observe the HTTP status. Use a raw
	// request with a malformed agent UUID inside skill_mention_agents.
	updateCommentExpectBadRequest(t, commentID, map[string]any{
		"content":              content,
		"skill_mention_agents": map[string][]string{fx.SkillID: {"not-a-uuid"}},
	})

	// Verify no side effect: the malformed UUID must NOT have created any
	// new agent_skill binding for J (it already had one from the fixture).
	if got := countAgentSkillBindingsFor(t, fx.JID, fx.SkillID); got != 1 {
		t.Fatalf("malformed UUID must not create a duplicate binding; got %d, want 1", got)
	}
}

// TestEnqueueSkillMention_DisabledBindingIsReEnabled covers review finding
// #2: an existing agent_skill row with enabled=FALSE is re-enabled when the
// agent is designated via @skill (the previous blind AddAgentSkill with
// ON CONFLICT DO NOTHING left disabled rows disabled, so the agent ran
// without the skill bundle).
func TestEnqueueSkillMention_DisabledBindingIsReEnabled(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// Bind skillA to "other" but explicitly disabled.
	if _, err := testPool.Exec(ctx, `
		INSERT INTO agent_skill (agent_id, skill_id, enabled) VALUES ($1, $2, false)
	`, fx.OtherAgentID, fx.SkillID); err != nil {
		t.Fatalf("insert disabled binding: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`,
			fx.OtherAgentID, fx.SkillID)
	})

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillA](mention://skill/"+fx.SkillID+") please review")
	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		fx.SkillID: {parseUUIDForTest(t, fx.OtherAgentID)},
	})

	// The agent must run.
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected 1 queued task on designated agent, got %d", got)
	}
	// And the binding must now be enabled.
	var enabled bool
	if err := testPool.QueryRow(ctx, `
		SELECT enabled FROM agent_skill WHERE agent_id = $1 AND skill_id = $2
	`, fx.OtherAgentID, fx.SkillID).Scan(&enabled); err != nil {
		t.Fatalf("read enabled: %v", err)
	}
	if !enabled {
		t.Fatalf("designation must re-enable a disabled agent_skill row; got enabled=false")
	}
}

// TestEnqueueSkillMention_DesignatedSameAsReplyParentProducesOneTask covers
// review finding #9 (R5 same-agent dedup). Reply to agent-2 + designate
// agent-2 via @skill -> exactly one task for agent-2 (the implicit
// reply-parent trigger survives, the skill duplicate is dropped). The
// previous behavior relied on the unique-index "double-enqueue + swallowed
// error" combination; the new explicit dedup removes that dependency.
func TestEnqueueSkillMention_DesignatedSameAsReplyParentProducesOneTask(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// Bind skillA to "other" so the designation targets an agent with the skill.
	if _, err := testPool.Exec(ctx, `
		INSERT INTO agent_skill (agent_id, skill_id) VALUES ($1, $2)
	`, fx.OtherAgentID, fx.SkillID); err != nil {
		t.Fatalf("bind other: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`,
			fx.OtherAgentID, fx.SkillID)
	})

	// Create a comment authored by "other" so the new reply's parent is an
	// agent-2 (other) comment — making the reply's parent-author trigger
	// target the same agent the @skill designation targets.
	parentID := insertSkillMentionComment(t, fx.IssueID, "first revision")
	if _, err := testPool.Exec(ctx, `
		UPDATE comment SET author_type = 'agent', author_id = $1 WHERE id = $2
	`, fx.OtherAgentID, parentID); err != nil {
		t.Fatalf("re-author parent: %v", err)
	}

	// Member replies to that agent comment with a @skill mention designating
	// the SAME agent.
	replyContent := "[@SkillA](mention://skill/" + fx.SkillID + ") please review"
	replyID := insertSkillMentionComment(t, fx.IssueID, replyContent)

	// Re-load the parent so the reply's parent_id is wired correctly.
	parent, err := testHandler.Queries.GetComment(ctx, parseUUID(parentID))
	if err != nil {
		t.Fatalf("load parent: %v", err)
	}
	issue, err := testHandler.Queries.GetIssue(ctx, parseUUID(fx.IssueID))
	if err != nil {
		t.Fatalf("load issue: %v", err)
	}
	comment, err := testHandler.Queries.GetComment(ctx, parseUUID(replyID))
	if err != nil {
		t.Fatalf("load comment: %v", err)
	}

	// Drive the create path directly so the parent relationship is honored
	// (the existing triggerSkillMentions helper passes nil parent).
	_ = testHandler.triggerTasksForComment(ctx, issue, comment, &parent, "member", testUserID, "", nil, map[string][]pgtype.UUID{
		fx.SkillID: {parseUUIDForTest(t, fx.OtherAgentID)},
	})

	// Exactly one task on "other" (the dedup kept reply-parent, dropped
	// mention_skill duplicate).
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("R5 dedup: expected exactly 1 task on designated agent (other), got %d", got)
	}
	// And no spurious task on J.
	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 tasks on J (uninvolved), got %d", got)
	}
}

// TestEnqueueSkillMention_MalformedMentionIDCarryingDesignationIsSilentlySkipped
// covers review finding #6: a malformed-hex skill mention id carrying a
// designation must not panic, must not bind, must not enqueue.
func TestEnqueueSkillMention_MalformedMentionIDCarryingDesignationIsSilentlySkipped(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// Craft a mention with a hex-but-not-UUID id ("----" matches the regex
	// [0-9a-fA-F-]+ but isn't a valid UUID) plus a designation entry under
	// that same id.
	content := "[@Bogus](mention://skill/----) please review"
	commentID := insertSkillMentionComment(t, fx.IssueID, content)

	// Must not panic.
	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		"----": {parseUUIDForTest(t, fx.OtherAgentID)},
	})

	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on malformed mention id, got %d", got)
	}
	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on J from malformed mention, got %d", got)
	}
}

// TestEnqueueSkillMention_MultipleSkillsDesignatedToSameAgentAllBound covers
// the correctness re-review finding: the previous skillBindings map was
// keyed by agent id only, so a single agent designated for two distinct
// @skill chips (e.g. "[@S1] and [@S2] by agent-X") got only the second
// skill bound. The new map is a slice per agent.
func TestEnqueueSkillMention_MultipleSkillsDesignatedToSameAgentAllBound(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// Create a second skill (skillA + skillB are seeded by the fixture; we
	// need a THIRD one to exercise "two skills, same agent" cleanly).
	skillC := insertHandlerTestSkill(t, "skill-mention-c", "skill C")
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_skill WHERE skill_id = $1`, skillC)
		testPool.Exec(context.Background(),
			`DELETE FROM skill_file WHERE skill_id = $1`, skillC)
		testPool.Exec(context.Background(),
			`DELETE FROM skill WHERE id = $1`, skillC)
	})

	// Other agent starts unbound to BOTH skills A and C.
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 0 {
		t.Fatalf("precondition: other should be unbound to skillA, got %d", got)
	}
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, skillC); got != 0 {
		t.Fatalf("precondition: other should be unbound to skillC, got %d", got)
	}

	// Comment with two @skill chips, both designating "other".
	content := "[@SkillA](mention://skill/" + fx.SkillID + ") and " +
		"[@SkillC](mention://skill/" + skillC + ") please review"
	commentID := insertSkillMentionComment(t, fx.IssueID, content)

	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		fx.SkillID: {parseUUIDForTest(t, fx.OtherAgentID)},
		skillC:     {parseUUIDForTest(t, fx.OtherAgentID)},
	})

	// Both skills must be bound to the designated agent.
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected skillA bound to other, got %d", got)
	}
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, skillC); got != 1 {
		t.Fatalf("expected skillC bound to other, got %d (regression: the per-agent skill map was a single id, not a list)", got)
	}
	// Exactly one task on the designated agent (the per-agent dedup still
	// holds across the two skill chips).
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected 1 task on designated agent, got %d", got)
	}
}

// TestEnqueueSkillMention_ImplicitAndDesignatedSameAgent_NoBindWithoutRun is
// the test the prior TestEnqueueSkillMention_DesignatedSameAsReplyParentProducesOneTask
// WASN'T, because the prior test pre-bound the agent at setup, which masked
// the bind-without-run shape. This test deliberately leaves the agent
// UNBOUND at setup and asserts the bind-without-run weapon is closed:
// implicit path + @skill designating the same agent -> agent runs (via
// implicit) and the agent_skill row is NEVER created (the dedup removed
// the skill trigger before bind).
func TestEnqueueSkillMention_ImplicitAndDesignatedSameAgent_NoBindWithoutRun(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// "other" agent starts UNBOUND to skillA. (The fixture does NOT pre-bind
	// other to skillA — only J is bound to skillA — so this precondition
	// already holds. We assert it explicitly for clarity.)
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 0 {
		t.Fatalf("precondition: other should be unbound to skillA, got %d", got)
	}

	// Build a comment authored by "other" so the reply's parent-author
	// trigger will target other; member reply designates other via @skill.
	parentID := insertSkillMentionComment(t, fx.IssueID, "first revision")
	if _, err := testPool.Exec(ctx, `
		UPDATE comment SET author_type = 'agent', author_id = $1 WHERE id = $2
	`, fx.OtherAgentID, parentID); err != nil {
		t.Fatalf("re-author parent: %v", err)
	}
	replyContent := "[@SkillA](mention://skill/" + fx.SkillID + ") please review"
	replyID := insertSkillMentionComment(t, fx.IssueID, replyContent)

	parent, err := testHandler.Queries.GetComment(ctx, parseUUID(parentID))
	if err != nil {
		t.Fatalf("load parent: %v", err)
	}
	issue, err := testHandler.Queries.GetIssue(ctx, parseUUID(fx.IssueID))
	if err != nil {
		t.Fatalf("load issue: %v", err)
	}
	comment, err := testHandler.Queries.GetComment(ctx, parseUUID(replyID))
	if err != nil {
		t.Fatalf("load comment: %v", err)
	}

	_ = testHandler.triggerTasksForComment(ctx, issue, comment, &parent, "member", testUserID, "", nil, map[string][]pgtype.UUID{
		fx.SkillID: {parseUUIDForTest(t, fx.OtherAgentID)},
	})

	// Exactly one task on other (the R5 dedup kept the implicit reply-parent
	// trigger, dropped the skill duplicate).
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected exactly 1 task on other (dedup kept reply-parent), got %d", got)
	}
	// Bind-without-run contract: the dedup removed the skill trigger before
	// bind, so the agent_skill row must NOT be created. Other agent is
	// unbound to skillA throughout.
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 0 {
		t.Fatalf("bind-without-run weapon still active: other has %d agent_skill rows for skillA, want 0", got)
	}
}

// updateCommentExpectBadRequest posts a PUT with the given body and asserts
// the handler returns 400. Uses the router-level path so the JSON decode +
// parseSkillMentionAgents boundary validation are both exercised.
func updateCommentExpectBadRequest(t *testing.T, commentID string, body map[string]any) {
	t.Helper()
	req := newRequest(http.MethodPut, "/api/comments/"+commentID, body)
	req = withURLParam(req, "commentId", commentID)
	w := httptest.NewRecorder()
	testHandler.UpdateComment(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}
