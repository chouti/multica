// @vitest-environment node
import { describe, it, expect } from "vitest";
import { stripMentionMarkdown, stripSkillMentionMarkdown } from "./strip-mention-markdown";

describe("stripMentionMarkdown", () => {
  it("strips simple agent mention", () => {
    expect(
      stripMentionMarkdown("[@魏和尚](mention://agent/de8efbcc-eaa1-4605-a6ac-d50cfa88e447)"),
    ).toBe("@魏和尚");
  });

  it("strips simple member mention", () => {
    expect(
      stripMentionMarkdown("[@Alice](mention://member/abc-123)"),
    ).toBe("@Alice");
  });

  it("strips issue mention (no @ prefix)", () => {
    expect(
      stripMentionMarkdown("[MUL-123](mention://issue/some-uuid)"),
    ).toBe("MUL-123");
  });

  it("handles escaped brackets in names", () => {
    expect(
      stripMentionMarkdown("[@David\\[TF\\]](mention://agent/id-123)"),
    ).toBe("@David[TF]");
  });

  it("handles multiple mentions in one string", () => {
    expect(
      stripMentionMarkdown(
        "Triggered by [@Alice](mention://member/a1) and [@Bob](mention://agent/b2)",
      ),
    ).toBe("Triggered by @Alice and @Bob");
  });

  it("does NOT strip regular markdown links", () => {
    expect(
      stripMentionMarkdown("[docs](https://example.com)"),
    ).toBe("[docs](https://example.com)");
  });

  it("does NOT strip non-mention parenthetical links", () => {
    expect(
      stripMentionMarkdown("[click here](http://foo.bar/baz)"),
    ).toBe("[click here](http://foo.bar/baz)");
  });

  it("handles backslash-escaped content that is NOT a mention", () => {
    expect(
      stripMentionMarkdown("\\[@Literal](mention://agent/id)"),
    ).toBe("\\[@Literal](mention://agent/id)");
  });

  it("returns plain text unchanged", () => {
    expect(stripMentionMarkdown("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(stripMentionMarkdown("")).toBe("");
  });
});

describe("stripSkillMentionMarkdown", () => {
  it("strips a skill mention to plain text", () => {
    expect(
      stripSkillMentionMarkdown("[@code-review](mention://skill/de8efbcc-eaa1-4605-a6ac-d50cfa88e447)"),
    ).toBe("@code-review");
  });

  it("leaves member and agent mentions as live chips", () => {
    expect(
      stripSkillMentionMarkdown(
        "Ping [@Alice](mention://member/a1) with [@code-review](mention://skill/s1)",
      ),
    ).toBe("Ping [@Alice](mention://member/a1) with @code-review");
  });

  it("leaves issue mentions untouched", () => {
    expect(
      stripSkillMentionMarkdown("[MUL-123](mention://issue/some-uuid) needs [@deploy](mention://skill/d1)"),
    ).toBe("[MUL-123](mention://issue/some-uuid) needs @deploy");
  });

  it("handles escaped brackets in skill names", () => {
    expect(
      stripSkillMentionMarkdown("[@my\\[skill\\]](mention://skill/id-123)"),
    ).toBe("@my[skill]");
  });

  it("does NOT strip backslash-escaped skill markup", () => {
    expect(
      stripSkillMentionMarkdown("\\[@code-review](mention://skill/id)"),
    ).toBe("\\[@code-review](mention://skill/id)");
  });

  it("does NOT touch regular markdown links", () => {
    expect(
      stripSkillMentionMarkdown("[docs](https://example.com)"),
    ).toBe("[docs](https://example.com)");
  });

  it("handles empty string", () => {
    expect(stripSkillMentionMarkdown("")).toBe("");
  });
});
