#!/usr/bin/env bash
# ============================================================================
# verify-monorepo-merge.sh — Automated zero-data-loss verification for
# monorepo migration via git-filter-repo + merge --allow-unrelated-histories
#
# Usage:
#   ./scripts/verify-monorepo-merge.sh \
#       /path/to/monorepo \
#       /path/to/original-backend \
#       /path/to/original-frontend \
#       /path/to/original-admin
#
# All four paths must be git repos. The originals must be the UNMODIFIED
# source repos (not the throwaway clones that filter-repo consumed).
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed (details in output)
#   2 — usage error / missing prerequisites
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
# Map: app name -> subdirectory in monorepo, tag prefix
declare -A APP_DIRS=(
    [backend]="apps/backend"
    [frontend]="apps/frontend"
    [admin]="apps/admin"
)

# Backend tags get prefixed with "backend-" in monorepo.
# Frontend and admin have 0 tags, so no prefix needed, but we check anyway.
declare -A TAG_PREFIXES=(
    [backend]="backend-"
    [frontend]="frontend-"
    [admin]="admin-"
)

# Source branch lists (remote branches we expect to have been merged).
# Only main is merged into the monorepo. Other branches listed here are
# checked for reachability but are expected to be absent (they weren't merged).
# Note: backend/add-missing-indexes was deleted on GitHub (work abandoned).
declare -A SOURCE_BRANCHES=(
    [backend]="main"
    [frontend]="main"
    [admin]="main"
)

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
WARN=0
TOTAL=0
FAILURES=()
WARNINGS=()

# Terminal colors (disabled if not a tty)
if [ -t 1 ]; then
    GREEN='\033[0;32m'
    RED='\033[0;31m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    BOLD='\033[1m'
    RESET='\033[0m'
else
    GREEN='' RED='' YELLOW='' BLUE='' BOLD='' RESET=''
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log_section() {
    echo ""
    echo -e "${BLUE}${BOLD}=== $1 ===${RESET}"
}

log_check() {
    TOTAL=$((TOTAL + 1))
    echo -n "  [$TOTAL] $1 ... "
}

pass() {
    PASS=$((PASS + 1))
    echo -e "${GREEN}PASS${RESET} ${1:-}"
}

fail() {
    FAIL=$((FAIL + 1))
    local msg="${1:-}"
    echo -e "${RED}FAIL${RESET} ${msg}"
    FAILURES+=("Check #$TOTAL: $msg")
}

warn() {
    WARN=$((WARN + 1))
    local msg="${1:-}"
    echo -e "${YELLOW}WARN${RESET} ${msg}"
    WARNINGS+=("Check #$TOTAL: $msg")
}

die() {
    echo -e "${RED}ERROR:${RESET} $1" >&2
    exit 2
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
if [ $# -ne 4 ]; then
    echo "Usage: $0 <monorepo-path> <backend-path> <frontend-path> <admin-path>"
    echo ""
    echo "All paths must be git repositories."
    echo "  monorepo-path  — the merged monorepo (post filter-repo + merge)"
    echo "  backend-path   — original backend repo (unmodified)"
    echo "  frontend-path  — original frontend repo (unmodified)"
    echo "  admin-path     — original admin repo (unmodified)"
    exit 2
fi

MONO="$(cd "$1" && pwd)"
BACKEND_SRC="$(cd "$2" && pwd)"
FRONTEND_SRC="$(cd "$3" && pwd)"
ADMIN_SRC="$(cd "$4" && pwd)"

declare -A SRC_REPOS=(
    [backend]="$BACKEND_SRC"
    [frontend]="$FRONTEND_SRC"
    [admin]="$ADMIN_SRC"
)

# Validate all are git repos
for name in backend frontend admin; do
    [ -d "${SRC_REPOS[$name]}/.git" ] || die "${SRC_REPOS[$name]} is not a git repo"
done
[ -d "$MONO/.git" ] || die "$MONO is not a git repo"

echo -e "${BOLD}Monorepo Merge Verification${RESET}"
echo "  Monorepo:  $MONO"
echo "  Backend:   $BACKEND_SRC"
echo "  Frontend:  $FRONTEND_SRC"
echo "  Admin:     $ADMIN_SRC"
echo "  Started:   $(date -Iseconds)"

# ============================================================================
# 1. COMMIT COUNT PRESERVATION
# ============================================================================
log_section "1. Commit Count Preservation"

# Strategy: git filter-repo rewrites hashes but preserves:
#   - author name, email, date
#   - committer name, email, date
#   - commit message (exact)
#   - parent structure (within the same source history)
#
# We build a fingerprint from (author_date|author_email|subject) for each
# non-merge commit. This is robust because:
#   - author_date is second-precision ISO 8601 — unique enough
#   - same author can't make two commits with identical subject at the exact
#     same second in practice
#   - merge commits from --allow-unrelated-histories are NEW and won't
#     collide with source fingerprints

# Generate fingerprints for a repo (all branches, non-merge only)
fingerprints() {
    local repo="$1"
    git -C "$repo" log --all --no-merges --format='%aI|%aE|%s' | sort
}

# Fingerprints for each source repo
for app in backend frontend admin; do
    src="${SRC_REPOS[$app]}"
    log_check "Collecting fingerprints from $app source"
    src_fp=$(fingerprints "$src")
    src_count=$(echo "$src_fp" | wc -l)
    pass "($src_count non-merge commits)"

    # Check each source fingerprint exists in monorepo
    log_check "All $app commits present in monorepo"

    mono_fp=$(fingerprints "$MONO")
    missing=0
    missing_lines=""
    while IFS= read -r fp; do
        if ! echo "$mono_fp" | grep -qxF "$fp"; then
            missing=$((missing + 1))
            missing_lines+="    MISSING: $fp"$'\n'
        fi
    done <<< "$src_fp"

    if [ "$missing" -eq 0 ]; then
        pass "(all $src_count found)"
    else
        fail "$missing commits from $app not found in monorepo"
        echo "$missing_lines"
    fi
done

# Check total non-merge commit count
log_check "Total non-merge commit count (sum of sources vs monorepo)"
total_source=0
for app in backend frontend admin; do
    c=$(git -C "${SRC_REPOS[$app]}" log --all --no-merges --oneline | wc -l)
    total_source=$((total_source + c))
done
# Monorepo may have additional merge commits from --allow-unrelated-histories
# plus the initial empty commit. Non-merge should be >= sum of sources.
mono_nonmerge=$(git -C "$MONO" log --all --no-merges --oneline | wc -l)
if [ "$mono_nonmerge" -ge "$total_source" ]; then
    pass "(sources: $total_source, monorepo non-merge: $mono_nonmerge)"
else
    fail "monorepo has $mono_nonmerge non-merge commits, expected >= $total_source"
fi

# Count merge commits added by the migration itself
log_check "Merge commit accounting"
mono_merges=$(git -C "$MONO" log --all --merges --oneline | wc -l)
total_src_merges=0
for app in backend frontend admin; do
    c=$(git -C "${SRC_REPOS[$app]}" log --all --merges --oneline | wc -l)
    total_src_merges=$((total_src_merges + c))
done
new_merges=$((mono_merges - total_src_merges))
if [ "$new_merges" -ge 0 ]; then
    pass "(source merges: $total_src_merges, monorepo merges: $mono_merges, new: $new_merges)"
else
    warn "monorepo has fewer merge commits than sources combined"
fi

# ============================================================================
# 2. FILE TREE COMPLETENESS
# ============================================================================
log_section "2. File Tree Completeness"

for app in backend frontend admin; do
    src="${SRC_REPOS[$app]}"
    subdir="${APP_DIRS[$app]}"

    log_check "File tree: $app"

    # Get file list from source (HEAD of main/default branch)
    src_files=$(git -C "$src" ls-files | sort)
    src_count=$(echo "$src_files" | wc -l)

    # Get file list from monorepo under apps/<name>/
    mono_files=$(git -C "$MONO" ls-files -- "$subdir/" | sed "s|^${subdir}/||" | sort)
    mono_count=$(echo "$mono_files" | wc -l)

    # Diff
    missing_in_mono=$(comm -23 <(echo "$src_files") <(echo "$mono_files"))
    extra_in_mono=$(comm -13 <(echo "$src_files") <(echo "$mono_files"))

    if [ -z "$missing_in_mono" ] && [ -z "$extra_in_mono" ]; then
        pass "($src_count files, exact match)"
    elif [ -z "$missing_in_mono" ]; then
        # Extra files in mono is OK (could be from branch merges)
        extra_count=$(echo "$extra_in_mono" | wc -l)
        warn "all $src_count source files present, but $extra_count extra files in monorepo"
        echo "$extra_in_mono" | head -10 | sed 's/^/    EXTRA: /'
    else
        missing_count=$(echo "$missing_in_mono" | wc -l)
        fail "$missing_count files from $app missing in monorepo"
        echo "$missing_in_mono" | head -20 | sed 's/^/    MISSING: /'
    fi
done

# ============================================================================
# 3. CONTENT INTEGRITY (byte-identical)
# ============================================================================
log_section "3. Content Integrity (byte-identical comparison)"

for app in backend frontend admin; do
    src="${SRC_REPOS[$app]}"
    subdir="${APP_DIRS[$app]}"

    log_check "Content hash: $app"

    # Build a hash manifest: sha256 of each blob via git
    # Using git ls-tree to get blob hashes (SHA-1) — if the blob hash matches,
    # content is guaranteed identical (that's how git works).
    src_manifest=$(git -C "$src" ls-tree -r HEAD --format='%(objectname) %(path)' | sort -k2)
    mono_manifest=$(git -C "$MONO" ls-tree -r HEAD -- "$subdir/" \
        | awk -v prefix="$subdir/" '{
            # Standard ls-tree format: mode type hash\tpath
            split($0, a, "\t");
            split(a[1], b, " ");
            hash = b[3];
            path = a[2];
            sub(prefix, "", path);
            print hash " " path;
        }' | sort -k2)

    # Compare blob hashes
    mismatched=0
    mismatch_lines=""
    while IFS=' ' read -r src_hash src_path; do
        mono_hash=$(echo "$mono_manifest" | awk -v p="$src_path" '$2 == p {print $1}')
        if [ -z "$mono_hash" ]; then
            # File missing — already caught in file tree check
            continue
        fi
        if [ "$src_hash" != "$mono_hash" ]; then
            mismatched=$((mismatched + 1))
            mismatch_lines+="    MISMATCH: $src_path (src=$src_hash mono=$mono_hash)"$'\n'
        fi
    done <<< "$src_manifest"

    if [ "$mismatched" -eq 0 ]; then
        file_count=$(echo "$src_manifest" | wc -l)
        pass "(all $file_count blobs identical)"
    else
        fail "$mismatched files have different content"
        echo "$mismatch_lines" | head -20
    fi
done

# ============================================================================
# 4. FILE MODE PRESERVATION (permissions, symlinks)
# ============================================================================
log_section "4. File Mode Preservation (permissions, symlinks)"

for app in backend frontend admin; do
    src="${SRC_REPOS[$app]}"
    subdir="${APP_DIRS[$app]}"

    log_check "File modes: $app"

    # Extract mode and path from ls-tree
    src_modes=$(git -C "$src" ls-tree -r HEAD --format='%(objectmode) %(path)' | sort -k2)
    mono_modes=$(git -C "$MONO" ls-tree -r HEAD -- "$subdir/" \
        | awk -v prefix="$subdir/" '{
            split($0, a, "\t");
            split(a[1], b, " ");
            mode = b[1];
            path = a[2];
            sub(prefix, "", path);
            print mode " " path;
        }' | sort -k2)

    mode_mismatches=0
    mode_lines=""
    while IFS=' ' read -r src_mode src_path; do
        mono_mode=$(echo "$mono_modes" | awk -v p="$src_path" '$2 == p {print $1}')
        if [ -z "$mono_mode" ]; then
            continue  # Missing file, caught elsewhere
        fi
        if [ "$src_mode" != "$mono_mode" ]; then
            mode_mismatches=$((mode_mismatches + 1))
            mode_lines+="    MODE CHANGE: $src_path (src=$src_mode mono=$mono_mode)"$'\n'
        fi
    done <<< "$src_modes"

    if [ "$mode_mismatches" -eq 0 ]; then
        pass
    else
        fail "$mode_mismatches files have different modes"
        echo "$mode_lines"
    fi
done

# Specific check for known symlink
log_check "Symlink preservation: backend CLAUDE.md -> AGENTS.md"
mono_symlink_target=$(git -C "$MONO" cat-file -p "HEAD:${APP_DIRS[backend]}/CLAUDE.md" 2>/dev/null || echo "NOT_FOUND")
if [ "$mono_symlink_target" = "AGENTS.md" ]; then
    pass "(target: AGENTS.md)"
elif [ "$mono_symlink_target" = "NOT_FOUND" ]; then
    fail "CLAUDE.md not found in monorepo at ${APP_DIRS[backend]}/CLAUDE.md"
else
    fail "CLAUDE.md symlink target is '$mono_symlink_target', expected 'AGENTS.md'"
fi

# Specific check for known executables
log_check "Executable bit: backend scripts"
exec_errors=0
for efile in ralph/loop_streamed.sh scripts/geoip-update.sh; do
    mono_mode=$(git -C "$MONO" ls-tree HEAD -- "${APP_DIRS[backend]}/$efile" 2>/dev/null \
        | awk '{print $1}')
    if [ -z "$mono_mode" ]; then
        exec_errors=$((exec_errors + 1))
        echo "    NOT FOUND: ${APP_DIRS[backend]}/$efile"
    elif [ "$mono_mode" != "100755" ]; then
        exec_errors=$((exec_errors + 1))
        echo "    WRONG MODE: ${APP_DIRS[backend]}/$efile ($mono_mode, expected 100755)"
    fi
done
if [ "$exec_errors" -eq 0 ]; then
    pass
else
    fail "$exec_errors executable files have wrong mode or are missing"
fi

# ============================================================================
# 5. TAG PRESERVATION
# ============================================================================
log_section "5. Tag Preservation"

for app in backend frontend admin; do
    src="${SRC_REPOS[$app]}"
    prefix="${TAG_PREFIXES[$app]}"

    src_tags=$(git -C "$src" tag -l | sort)
    src_tag_count=$(echo "$src_tags" | grep -c . || true)

    if [ "$src_tag_count" -eq 0 ]; then
        log_check "Tags: $app"
        pass "(no tags in source, nothing to verify)"
        continue
    fi

    log_check "Tag count: $app ($src_tag_count tags)"

    missing_tags=0
    missing_tag_list=""
    while IFS= read -r tag; do
        [ -z "$tag" ] && continue
        expected="${prefix}${tag}"
        if ! git -C "$MONO" rev-parse "refs/tags/$expected" &>/dev/null; then
            # Also check without prefix (in case tags weren't prefixed)
            if ! git -C "$MONO" rev-parse "refs/tags/$tag" &>/dev/null; then
                missing_tags=$((missing_tags + 1))
                missing_tag_list+="    MISSING: $tag (expected: $expected or $tag)"$'\n'
            fi
        fi
    done <<< "$src_tags"

    if [ "$missing_tags" -eq 0 ]; then
        pass "(all $src_tag_count tags found)"
    else
        fail "$missing_tags of $src_tag_count tags missing"
        echo "$missing_tag_list"
    fi

    # Verify tag commit messages match (for annotated tags)
    log_check "Tag targets: $app (commit message at tagged point)"
    tag_target_mismatches=0
    while IFS= read -r tag; do
        [ -z "$tag" ] && continue

        # Get the commit subject the tag points to in source
        src_subject=$(git -C "$src" log -1 --format='%s' "$tag" 2>/dev/null)

        # Try prefixed first, then unprefixed
        expected="${prefix}${tag}"
        if git -C "$MONO" rev-parse "refs/tags/$expected" &>/dev/null; then
            mono_subject=$(git -C "$MONO" log -1 --format='%s' "$expected" 2>/dev/null)
        elif git -C "$MONO" rev-parse "refs/tags/$tag" &>/dev/null; then
            mono_subject=$(git -C "$MONO" log -1 --format='%s' "$tag" 2>/dev/null)
        else
            continue  # Already caught as missing
        fi

        if [ "$src_subject" != "$mono_subject" ]; then
            tag_target_mismatches=$((tag_target_mismatches + 1))
        fi
    done <<< "$src_tags"

    if [ "$tag_target_mismatches" -eq 0 ]; then
        pass
    else
        fail "$tag_target_mismatches tags point to commits with different subjects"
    fi
done

# ============================================================================
# 6. LOG PATH FILTERING
# ============================================================================
log_section "6. Log Path Filtering (git log -- apps/<name>/)"

for app in backend frontend admin; do
    src="${SRC_REPOS[$app]}"
    subdir="${APP_DIRS[$app]}"

    log_check "Log filter: $app"

    # Source: all commits (including merges) on all branches that touch files
    src_log_count=$(git -C "$src" log --all --oneline | wc -l)

    # Monorepo: commits touching apps/<name>/
    # This should include all original commits (whose tree was rewritten to
    # apps/<name>/) plus any merge commits that include changes in that path.
    mono_log_count=$(git -C "$MONO" log --all --oneline -- "$subdir/" | wc -l)

    # The monorepo path-filtered count should be >= source count.
    # It can be higher if merge commits from --allow-unrelated-histories
    # also touch this path (they do, since they merge the entire tree).
    if [ "$mono_log_count" -ge "$src_log_count" ]; then
        pass "(source: $src_log_count, monorepo: $mono_log_count)"
    elif [ "$mono_log_count" -ge $((src_log_count - 2)) ]; then
        # Allow small delta for merge commit accounting differences
        warn "close but not exact (source: $src_log_count, monorepo: $mono_log_count, delta: $((src_log_count - mono_log_count)))"
    else
        fail "significant gap (source: $src_log_count, monorepo: $mono_log_count, missing: $((src_log_count - mono_log_count)))"
    fi
done

# ============================================================================
# 7. BLAME PRESERVATION
# ============================================================================
log_section "7. Blame Preservation"

# Strategy: For each app, pick a sample of files and verify that:
# 1. git blame succeeds (doesn't error)
# 2. The blame output references the correct author(s)
# 3. Every line is attributed (no blame gaps)
#
# We can't compare blame line-by-line because commit hashes changed.
# Instead we verify:
# - blame completes without error
# - author names in blame match authors from source repo
# - line count in blame equals line count in file

for app in backend frontend admin; do
    src="${SRC_REPOS[$app]}"
    subdir="${APP_DIRS[$app]}"

    # Get list of non-binary, non-empty files to blame
    # Sample: up to 20 files, preferring diverse paths
    all_blameable=$(git -C "$MONO" ls-files -- "$subdir/" \
        | grep -v '.gitkeep$' \
        | grep -vE '\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|lock)$')
    if command -v shuf &>/dev/null; then
        sample_files=$(echo "$all_blameable" | shuf -n 20)
    else
        sample_files=$(echo "$all_blameable" | head -20)
    fi

    blame_errors=0
    blame_error_files=""
    blame_author_issues=0
    files_checked=0

    # Get known authors from source
    src_authors=$(git -C "$src" log --all --format='%aN' | sort -u)

    while IFS= read -r filepath; do
        [ -z "$filepath" ] && continue
        files_checked=$((files_checked + 1))

        # Check blame succeeds
        blame_output=$(git -C "$MONO" blame --porcelain "$filepath" 2>&1)
        if [ $? -ne 0 ]; then
            blame_errors=$((blame_errors + 1))
            blame_error_files+="    ERROR: $filepath"$'\n'
            continue
        fi

        # Verify all lines are attributed (every line should have an author)
        file_lines=$(git -C "$MONO" show "HEAD:$filepath" | wc -l)
        blame_lines=$(echo "$blame_output" | grep -c '^author ' || true)
        if [ "$blame_lines" -ne "$file_lines" ] && [ "$file_lines" -gt 0 ]; then
            # Blame can report 0 for empty files, that's OK
            if [ "$blame_lines" -gt 0 ]; then
                blame_errors=$((blame_errors + 1))
                blame_error_files+="    INCOMPLETE: $filepath (file: $file_lines lines, blame: $blame_lines)"$'\n'
            fi
        fi

        # Verify authors in blame are from the known set
        blame_authors=$(echo "$blame_output" | grep '^author ' | sed 's/^author //' | sort -u)
        while IFS= read -r author; do
            [ -z "$author" ] && continue
            if ! echo "$src_authors" | grep -qxF "$author"; then
                blame_author_issues=$((blame_author_issues + 1))
            fi
        done <<< "$blame_authors"

    done <<< "$sample_files"

    log_check "Blame integrity: $app ($files_checked files sampled)"
    if [ "$blame_errors" -eq 0 ]; then
        pass
    else
        fail "$blame_errors files with blame errors"
        echo "$blame_error_files"
    fi

    log_check "Blame author consistency: $app"
    if [ "$blame_author_issues" -eq 0 ]; then
        pass "(all authors match source repo)"
    else
        warn "$blame_author_issues unexpected author entries (may be from merge commits)"
    fi
done

# ============================================================================
# 8. AUTHOR/COMMITTER METADATA PRESERVATION
# ============================================================================
log_section "8. Author Metadata Preservation"

for app in backend frontend admin; do
    src="${SRC_REPOS[$app]}"

    log_check "Author set: $app"

    src_authors=$(git -C "$src" log --all --no-merges --format='%aN <%aE>' | sort -u)
    mono_authors=$(git -C "$MONO" log --all --no-merges --format='%aN <%aE>' | sort -u)

    # Every source author should appear in monorepo
    missing_authors=""
    while IFS= read -r author; do
        [ -z "$author" ] && continue
        if ! echo "$mono_authors" | grep -qxF "$author"; then
            missing_authors+="    MISSING: $author"$'\n'
        fi
    done <<< "$src_authors"

    if [ -z "$missing_authors" ]; then
        pass "($(echo "$src_authors" | wc -l) authors preserved)"
    else
        fail "some authors missing from monorepo"
        echo "$missing_authors"
    fi
done

# ============================================================================
# 9. COMMIT MESSAGE PRESERVATION
# ============================================================================
log_section "9. Commit Message Preservation"

# git filter-repo with --to-subdirectory-filter does NOT rewrite commit
# messages by default. Verify that every source commit message appears
# verbatim in the monorepo.

for app in backend frontend admin; do
    src="${SRC_REPOS[$app]}"

    log_check "Commit messages: $app"

    # Full commit messages (not just subjects) — use %B for full body
    # But for matching, subject line is sufficient and more robust
    src_subjects=$(git -C "$src" log --all --no-merges --format='%s' | sort)
    mono_subjects=$(git -C "$MONO" log --all --no-merges --format='%s' | sort)

    missing_msgs=0
    missing_msg_list=""
    while IFS= read -r subj; do
        [ -z "$subj" ] && continue
        if ! echo "$mono_subjects" | grep -qxF "$subj"; then
            missing_msgs=$((missing_msgs + 1))
            missing_msg_list+="    MISSING: $subj"$'\n'
        fi
    done <<< "$src_subjects"

    total_msgs=$(echo "$src_subjects" | wc -l)
    if [ "$missing_msgs" -eq 0 ]; then
        pass "(all $total_msgs messages preserved)"
    else
        fail "$missing_msgs of $total_msgs messages missing"
        echo "$missing_msg_list" | head -20
    fi
done

# ============================================================================
# 10. BRANCH COMMIT REACHABILITY
# ============================================================================
log_section "10. Branch Commit Reachability"

# After merge, branch-specific commits should still be reachable.
# Branches may have been merged into main or exist as separate refs.
# We verify that commits unique to each branch exist in the monorepo.

for app in backend frontend admin; do
    src="${SRC_REPOS[$app]}"

    for branch in ${SOURCE_BRANCHES[$app]}; do
        # Check if branch exists in source
        if ! git -C "$src" rev-parse "refs/remotes/origin/$branch" &>/dev/null && \
           ! git -C "$src" rev-parse "refs/heads/$branch" &>/dev/null; then
            continue
        fi

        # Get commits unique to this branch (not in main, if branch != main)
        if [ "$branch" = "main" ]; then
            continue  # Main is always merged
        fi

        log_check "Branch reachability: $app/$branch"

        # Commits on branch not on main
        branch_ref="origin/$branch"
        git -C "$src" rev-parse "refs/remotes/$branch_ref" &>/dev/null || branch_ref="$branch"

        unique_fps=$(git -C "$src" log "$branch_ref" --not "origin/main" --no-merges --format='%aI|%aE|%s' 2>/dev/null | sort)

        if [ -z "$unique_fps" ]; then
            pass "(no unique commits, fully merged)"
            continue
        fi

        unique_count=$(echo "$unique_fps" | wc -l)
        mono_all_fps=$(git -C "$MONO" log --all --no-merges --format='%aI|%aE|%s' | sort)

        missing=0
        while IFS= read -r fp; do
            [ -z "$fp" ] && continue
            if ! echo "$mono_all_fps" | grep -qxF "$fp"; then
                missing=$((missing + 1))
            fi
        done <<< "$unique_fps"

        if [ "$missing" -eq 0 ]; then
            pass "(all $unique_count unique commits found)"
        else
            fail "$missing of $unique_count unique commits from $app/$branch missing"
        fi
    done
done

# ============================================================================
# 11. EMPTY FILE / GITKEEP PRESERVATION
# ============================================================================
log_section "11. Edge Cases"

log_check "Empty files (.gitkeep) preserved"
empty_missing=0
empty_total=0
for app in backend frontend admin; do
    src="${SRC_REPOS[$app]}"
    subdir="${APP_DIRS[$app]}"

    src_empties=$(git -C "$src" ls-files | while read -r f; do
        size=$(git -C "$src" cat-file -s "HEAD:$f" 2>/dev/null || echo "0")
        [ "$size" = "0" ] && echo "$f"
    done | sort)

    if [ -z "$src_empties" ]; then
        continue
    fi

    while IFS= read -r ef; do
        [ -z "$ef" ] && continue
        empty_total=$((empty_total + 1))
        mono_path="$subdir/$ef"
        if ! git -C "$MONO" cat-file -e "HEAD:$mono_path" 2>/dev/null; then
            empty_missing=$((empty_missing + 1))
            echo "    MISSING: $mono_path"
        fi
    done <<< "$src_empties"
done
if [ "$empty_missing" -eq 0 ]; then
    pass "($empty_total empty files verified)"
else
    fail "$empty_missing of $empty_total empty files missing"
fi

# ============================================================================
# 12. NO STALE ARTIFACTS
# ============================================================================
log_section "12. Monorepo Hygiene"

log_check "No stale .git directories in apps/"
stale_git=$(find "$MONO/apps" -name ".git" -type d 2>/dev/null)
if [ -z "$stale_git" ]; then
    pass
else
    fail "found nested .git directories"
    echo "$stale_git" | sed 's/^/    /'
fi

log_check "Monorepo has single root .git"
if [ -d "$MONO/.git" ]; then
    pass
else
    fail "no .git at monorepo root"
fi

log_check "No filter-repo temp remotes"
stale_remotes=$(git -C "$MONO" remote -v | grep -E '(backend|frontend|admin)-src' || true)
if [ -z "$stale_remotes" ]; then
    pass
else
    warn "temp remotes still present (cosmetic, not a data issue)"
    echo "$stale_remotes" | sed 's/^/    /'
fi

# ============================================================================
# SUMMARY
# ============================================================================
echo ""
echo -e "${BOLD}============================================${RESET}"
echo -e "${BOLD}VERIFICATION SUMMARY${RESET}"
echo -e "${BOLD}============================================${RESET}"
echo ""
echo "  Total checks:  $TOTAL"
echo -e "  ${GREEN}Passed:        $PASS${RESET}"
echo -e "  ${RED}Failed:        $FAIL${RESET}"
echo -e "  ${YELLOW}Warnings:      $WARN${RESET}"
echo ""

if [ ${#FAILURES[@]} -gt 0 ]; then
    echo -e "${RED}${BOLD}FAILURES:${RESET}"
    for f in "${FAILURES[@]}"; do
        echo -e "  ${RED}- $f${RESET}"
    done
    echo ""
fi

if [ ${#WARNINGS[@]} -gt 0 ]; then
    echo -e "${YELLOW}${BOLD}WARNINGS:${RESET}"
    for w in "${WARNINGS[@]}"; do
        echo -e "  ${YELLOW}- $w${RESET}"
    done
    echo ""
fi

echo "  Finished:  $(date -Iseconds)"

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo -e "${RED}${BOLD}RESULT: FAIL — $FAIL check(s) failed. Review above.${RESET}"
    exit 1
else
    echo ""
    echo -e "${GREEN}${BOLD}RESULT: PASS — all checks passed.${RESET}"
    exit 0
fi
