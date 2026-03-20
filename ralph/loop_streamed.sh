#!/bin/bash
set -o pipefail
# Usage: ./ralph/loop_streamed.sh [plan|build|specs|reverse-specs] [max_iterations]
# Examples:
#   ./ralph/loop_streamed.sh              # Build mode, unlimited iterations
#   ./ralph/loop_streamed.sh 20           # Build mode, max 20 iterations
#   ./ralph/loop_streamed.sh build 20     # Build mode, max 20 iterations
#   ./ralph/loop_streamed.sh plan         # Plan mode, unlimited iterations
#   ./ralph/loop_streamed.sh plan 5       # Plan mode, max 5 iterations
#   ./ralph/loop_streamed.sh specs        # Spec creation mode
#   ./ralph/loop_streamed.sh reverse-specs # Reverse-engineer specs from code

# Parse arguments
case "$1" in
    plan)
        MODE="plan"
        PROMPT_FILE="ralph/PROMPT_plan.md"
        MAX_ITERATIONS=${2:-0}
        ;;
    specs)
        MODE="specs"
        PROMPT_FILE="ralph/PROMPT_specs.md"
        MAX_ITERATIONS=${2:-2}
        ;;
    reverse-specs)
        MODE="reverse-specs"
        PROMPT_FILE="ralph/PROMPT_reverse_engineer_specs.md"
        MAX_ITERATIONS=${2:-2}
        ;;
    build)
        MODE="build"
        PROMPT_FILE="ralph/PROMPT_build.md"
        MAX_ITERATIONS=${2:-0}
        ;;
    *[0-9]*)
        MODE="build"
        PROMPT_FILE="ralph/PROMPT_build.md"
        MAX_ITERATIONS=$1
        ;;
    *)
        MODE="build"
        PROMPT_FILE="ralph/PROMPT_build.md"
        MAX_ITERATIONS=0
        ;;
esac

ITERATION=0
CURRENT_BRANCH=$(git branch --show-current)

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Mode:   $MODE"
echo "Prompt: $PROMPT_FILE"
echo "Branch: $CURRENT_BRANCH"
[ $MAX_ITERATIONS -gt 0 ] && echo "Max:    $MAX_ITERATIONS iterations"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Verify prompt file exists
if [ ! -f "$PROMPT_FILE" ]; then
    echo "Error: $PROMPT_FILE not found"
    exit 1
fi

while true; do
    if [ $MAX_ITERATIONS -gt 0 ] && [ $ITERATION -ge $MAX_ITERATIONS ]; then
        echo "Reached max iterations: $MAX_ITERATIONS"
        break
    fi

    # In build mode, check if any unchecked items remain
    if [ "$MODE" = "build" ] && ! grep -q '\- \[ \]' "ralph/IMPLEMENTATION_PLAN.md" 2>/dev/null; then
        echo "All items in IMPLEMENTATION_PLAN.md are complete. Exiting loop."
        break
    fi

    FULL_PROMPT="$(cat "$PROMPT_FILE")

Execute the instructions above."

    echo "Spinning up Claude..."
    echo ""

    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    claude -p "$FULL_PROMPT" \
        --dangerously-skip-permissions \
        --model opus \
        --verbose \
        --output-format stream-json \
        --include-partial-messages | node "$SCRIPT_DIR/parse_stream.js"

    echo ""
    echo "Claude iteration complete"

    # Push changes after each iteration
    git push origin "$CURRENT_BRANCH" || {
        echo "Failed to push. Creating remote branch..."
        git push -u origin "$CURRENT_BRANCH"
    }

    ITERATION=$((ITERATION + 1))
    echo -e "\n\n======================== LOOP $ITERATION ========================\n"
done
