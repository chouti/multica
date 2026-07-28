"use client";

import { ArrowUpRight, BookOpen, CircleHelp, History, MessageCircle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { useModalStore } from "@multica/core/modals";
import { useConfigStore } from "@multica/core/config";
import { useCurrentWorkspace } from "@multica/core/paths";
import { isDaemonOlderThanServer } from "@multica/core/runtimes/cli-version";
import { selectRepresentativeCliVersion } from "@multica/core/runtimes/select-cli-version";
import { runtimeListOptions } from "@multica/core/runtimes/queries";
import { useQuery } from "@tanstack/react-query";
import { DISCORD_URL, DiscordIcon } from "./discord";
import { useT } from "../i18n";

const DOCS_URL = "https://multica.ai/docs";
const CHANGELOG_URL = "https://multica.ai/changelog";

export function HelpLauncher() {
  const { t } = useT("layout");
  // Read each observation from its own source so a partial rollout or a
  // missing backend metadata can render each row with its own state
  // (tag / loading / unavailable) instead of inventing a value.
  const backendBaseline = useConfigStore((state) => state.backendBaseline);
  const backendBaselineStatus = useConfigStore(
    (state) => state.backendBaselineStatus,
  );

  // Share the runtimes React Query cache with the rest of the app (the
  // sidebar indicator, the Runtimes page, presence previews). `enabled: false`
  // means the Help menu reads whatever the cache already has and does not
  // trigger a fresh fetch — the cache is warmed by other on-screen consumers
  // and the Help menu's own row would otherwise force every Help-open into a
  // network round-trip. When no workspace is in scope (e.g. logged-out
  // pages), `wsId` is undefined and the query is disabled.
  const workspace = useCurrentWorkspace();
  const wsId = workspace?.id;
  const runtimes = useQuery({
    ...runtimeListOptions(wsId ?? ""),
    enabled: false,
  }).data;

  // Pick one daemon to surface in the compact Help row. The selector falls
  // through within each candidate set (online preferred, else all), mirroring
  // the per-machine aggregator used by the Runtimes surfaces.
  const cliVersion = selectRepresentativeCliVersion(runtimes ?? []) ?? "";

  // Drift flag is older-than-server only — a newer daemon is backward-
  // compatible and not 502-risk, so it does not surface as drift. Comparison
  // is describe-aware so a dev-built daemon (v0.4.12-5-gabc1234) compares
  // correctly against the server's clean tag instead of reading unavailable.
  const drift =
    Boolean(cliVersion) &&
    Boolean(backendBaseline) &&
    isDaemonOlderThanServer(cliVersion, backendBaseline);

  // The provenance rows are intentionally always present in the DOM (even
  // when unavailable): self-host operators rely on them to confirm what is
  // deployed. A hidden row would make a stale or rolled-back artifact look
  // identical to a missing one, defeating the whole feature.
  //
  // Three-state CLI row, branched in this order so no-workspace-context
  // (per plan U3 step 4) and cold-cache states each render the right text:
  //   - no workspace context → unavailable (would otherwise stick at
  //     `cli_loading` forever because the disabled query never resolves).
  //   - workspace present but the runtimes query is still loading → loading.
  //   - workspace present, query settled, no representative → unavailable.
  //   - workspace present, query settled, representative exists → version.
  const noWorkspace = wsId === undefined;
  let cliText: string;
  if (noWorkspace) {
    cliText = t(($) => $.help.cli_unavailable);
  } else if (!cliVersion) {
    cliText =
      runtimes === undefined
        ? t(($) => $.help.cli_loading)
        : t(($) => $.help.cli_unavailable);
  } else {
    cliText = cliVersion;
  }
  const backendText =
    backendBaseline ||
    (backendBaselineStatus === "loading"
      ? t(($) => $.help.backend_loading)
      : t(($) => $.help.backend_unavailable));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t(($) => $.help.trigger)}
        title={t(($) => $.help.trigger)}
        className="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors cursor-pointer hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        <CircleHelp className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={8}
        className="min-w-40"
      >
        <DropdownMenuItem
          render={
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" />
          }
        >
          <BookOpen className="h-3.5 w-3.5" />
          {t(($) => $.help.docs)}
          <ArrowUpRight className="size-3 translate-y-px text-muted-foreground/50" />
        </DropdownMenuItem>
        <DropdownMenuItem
          render={
            <a
              href={CHANGELOG_URL}
              target="_blank"
              rel="noopener noreferrer"
            />
          }
        >
          <History className="h-3.5 w-3.5" />
          {t(($) => $.help.changelog)}
          <ArrowUpRight className="size-3 translate-y-px text-muted-foreground/50" />
        </DropdownMenuItem>
        <DropdownMenuItem
          render={
            <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" />
          }
        >
          <DiscordIcon className="h-3.5 w-3.5" />
          {t(($) => $.help.discord)}
          <ArrowUpRight className="size-3 translate-y-px text-muted-foreground/50" />
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => useModalStore.getState().open("feedback")}
        >
          <MessageCircle className="h-3.5 w-3.5" />
          {t(($) => $.help.feedback)}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* DropdownMenuLabel renders Base UI's Menu.GroupLabel, which reads
            a Menu.Group context and throws if it has no Group ancestor. It
            must always be wrapped in a DropdownMenuGroup — without it the
            Help menu crashes the whole app on open (no error boundary sits
            above the sidebar). Two rows share one Group so a single
            dropdown-label context surrounds both. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-2 font-normal text-muted-foreground">
            <span>{t(($) => $.help.cli_label)}</span>
            <span
              className={
                drift ? "text-foreground text-destructive" : "text-foreground"
              }
            >
              {cliText}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuLabel className="flex items-center gap-2 font-normal text-muted-foreground">
            <span>{t(($) => $.help.backend_label)}</span>
            <span className="text-foreground">{backendText}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
