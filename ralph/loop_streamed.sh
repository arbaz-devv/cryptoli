#!/bin/bash
set -o pipefail
# Usage: ./ralph/loop_streamed.sh [max_iterations]
# Examples:
#   ./ralph/loop_streamed.sh              # Unlimited iterations
#   ./ralph/loop_streamed.sh 20           # Max 20 iterations

# Parse arguments
if [[ "$1" =~ ^[0-9]+$ ]]; then
    MAX_ITERATIONS=$1
else
    MAX_ITERATIONS=0
fi

ITERATION=0
CURRENT_BRANCH=$(git branch --show-current)

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Prompt: ralph/PROMPT_build.md"
echo "Branch: $CURRENT_BRANCH"
[ $MAX_ITERATIONS -gt 0 ] && echo "Max:    $MAX_ITERATIONS iterations"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ! -f "ralph/PROMPT_build.md" ]; then
    echo "Error: ralph/PROMPT_build.md not found"
    exit 1
fi

while true; do
    if [ $MAX_ITERATIONS -gt 0 ] && [ $ITERATION -ge $MAX_ITERATIONS ]; then
        echo "Reached max iterations: $MAX_ITERATIONS"
        break
    fi

    if ! grep -q '\- \[ \]' "ralph/IMPLEMENTATION_PLAN.md" 2>/dev/null; then
        echo "All items in IMPLEMENTATION_PLAN.md are complete. Exiting loop."
        break
    fi

    FULL_PROMPT="$(cat "ralph/PROMPT_build.md")

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

    git push origin "$CURRENT_BRANCH" || {
        echo "Failed to push. Creating remote branch..."
        git push -u origin "$CURRENT_BRANCH"
    }

    ITERATION=$((ITERATION + 1))
    echo -e "\n\n======================== LOOP $ITERATION ========================\n"
done
