#!/bin/bash
# Navvi skills installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Fellowship-dev/navvi/main/install-companions.sh | bash
#
# Preferred method: npx skills add Fellowship-dev/navvi

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}Navvi Skills${NC} — browser automation skills for AI agents"
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

# Detect agent type
SKILLS_DIR=""
if [ -d ".claude" ] || [ -f "CLAUDE.md" ]; then
  SKILLS_DIR=".claude/skills"
elif [ -d ".cursor" ]; then
  SKILLS_DIR=".cursor/skills"
else
  SKILLS_DIR=".claude/skills"
fi

echo "Installing to ${SKILLS_DIR}/"

# Create skills directories
for skill in navvi-browse navvi-login navvi-signup; do
  mkdir -p "${SKILLS_DIR}/${skill}"
  curl -fsSL "https://raw.githubusercontent.com/Fellowship-dev/navvi/main/skills/${skill}/SKILL.md" \
    -o "${SKILLS_DIR}/${skill}/SKILL.md"
  echo -e "${GREEN}+${NC} ${SKILLS_DIR}/${skill}/SKILL.md"
done

# Add to .gitignore if not already there
if [ -f ".gitignore" ]; then
  if ! grep -q "navvi-" .gitignore 2>/dev/null; then
    echo "" >> .gitignore
    echo "# Navvi skills" >> .gitignore
    for skill in navvi-browse navvi-login navvi-signup; do
      echo "${SKILLS_DIR}/${skill}/" >> .gitignore
    done
    echo -e "${GREEN}+${NC} Added navvi skills to .gitignore"
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
echo -e "${GREEN}${BOLD}Navvi skills installed!${NC}"
echo ""
echo "Installed skills:"
echo "  navvi-browse  — autonomous web browsing"
echo "  navvi-login   — login with stored credentials"
echo "  navvi-signup  — create new accounts"
echo ""
echo "Or install via the skills registry:"
echo "  npx skills add Fellowship-dev/navvi"
echo ""
