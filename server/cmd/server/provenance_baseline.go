package main

import (
	"regexp"
	"strings"
)

// officialBaseline returns v only when it is a trustworthy official release
// baseline: a clean vX.Y.Z-style tag carrying no git-describe commit-distance
// suffix (-N-g<hash>) or dirty marker. The supported self-host build paths
// (scripts/resolve-official-baseline.sh, release CI) stamp exactly such a tag
// via -X main.version; dev builds (the "dev" default), dirty checkouts, and
// anything that is not a clean official tag map to "". handler.Config.ServerVersion
// feeds /api/config's server_version field with omitempty, so an empty value
// hides the Help popover's version row instead of presenting a hash, a dirty
// suffix, or "dev" as a release baseline.
//
// This lives in its own file (not router.go) to keep the local provenance
// customization off upstream's hot path: router.go is one of the most
// frequently edited upstream files, so only the single ServerVersion field
// assignment there references officialBaseline.
var describeSuffixRe = regexp.MustCompile(`-\d+-g[0-9a-f]{4,}$`)

func officialBaseline(v string) string {
	v = strings.TrimSpace(v)
	if v == "" || v == "dev" {
		return ""
	}
	if !isOfficialBaselineTag(v) {
		return ""
	}
	return v
}

func isOfficialBaselineTag(v string) bool {
	if len(v) < 2 || v[0] != 'v' || v[1] < '0' || v[1] > '9' {
		return false
	}
	if strings.Contains(v, "-dirty") || describeSuffixRe.MatchString(v) {
		return false
	}
	return true
}
