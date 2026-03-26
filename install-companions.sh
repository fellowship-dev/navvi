#!/bin/bash
# Navvi companion agents installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Fellowship-dev/navvi/main/install-companions.sh | bash

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}Navvi Companions${NC} — browser agents for Claude Code"
echo ""

# Check we're in a project directory
if [ ! -d ".git" ] && [ ! -f "package.json" ] && [ ! -f "pyproject.toml" ]; then
  echo -e "${YELLOW}Warning:${NC} This doesn't look like a project root."
  echo -n "Continue anyway? [y/N] "
  read -r answer
  if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
    echo "Aborted."
    exit 1
  fi
fi

# Create .claude/agents/ if it doesn't exist
mkdir -p .claude/agents

# Download agent files
echo "Installing companion agents..."
for agent in browse login; do
  curl -fsSL "https://raw.githubusercontent.com/Fellowship-dev/navvi/main/companions/${agent}.md" \
    -o ".claude/agents/navvi-${agent}.md"
  echo -e "${GREEN}+${NC} .claude/agents/navvi-${agent}.md"
done

# Add to .gitignore if not already there
if [ -f ".gitignore" ]; then
  if ! grep -q "navvi-.*\.md" .gitignore 2>/dev/null; then
    echo "" >> .gitignore
    echo "# Navvi companion agents" >> .gitignore
    echo ".claude/agents/navvi-*.md" >> .gitignore
    echo -e "${GREEN}+${NC} Added navvi agents to .gitignore"
  fi
fi

# Check for navvi MCP
if grep -q "navvi" .mcp.json 2>/dev/null; then
  echo -e "${GREEN}+${NC} Navvi MCP detected in .mcp.json"
else
  echo -e "${YELLOW}!${NC} Navvi MCP not found in .mcp.json — add it with:"
  echo '  claude mcp add navvi -- uvx navvi@latest'
fi

echo ""
echo -e "${GREEN}${BOLD}Navvi companions installed!${NC}"
echo ""
echo "Usage:"
echo "  Ask Claude: \"browse tutanota.com and check the login page\""
echo "  Or directly: \"use the navvi-browse agent to search DuckDuckGo for navvi\""
echo ""
