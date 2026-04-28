#!/bin/bash

# Validate AI Engineering Team setup (Claude Code + Codex)

echo "=========================================="
echo "AI Engineering Team Validation (Claude Code + Codex)"
echo "=========================================="
echo ""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0
WARNINGS=0

# Check required files
echo "Checking required files..."
REQUIRED_FILES=(
    "CLAUDE.md"
    ".claude/skills"
    ".claude/discovery/analysis.yaml"
)

# Optional dual-tool artifacts
OPTIONAL_FILES=(
    "AGENTS.md"
    ".claude/agents"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -e "$file" ]; then
        if [ "$file" = ".claude/discovery/analysis.yaml" ]; then
            echo -e "${YELLOW}⚠️  Missing: $file (bootstrap artifact - will exist after Stage 1)${NC}"
            WARNINGS=$((WARNINGS + 1))
        else
            echo -e "${RED}❌ Missing: $file${NC}"
            ERRORS=$((ERRORS + 1))
        fi
    else
        echo -e "${GREEN}✅ Found: $file${NC}"
    fi
done

for file in "${OPTIONAL_FILES[@]}"; do
    if [ ! -e "$file" ]; then
        if [ "$file" = "AGENTS.md" ]; then
            echo -e "${YELLOW}⚠️  Missing: AGENTS.md (required for Codex users; not needed for Claude Code only)${NC}"
        else
            echo -e "${YELLOW}⚠️  Missing: $file (optional)${NC}"
        fi
        WARNINGS=$((WARNINGS + 1))
    else
        echo -e "${GREEN}✅ Found: $file${NC}"
    fi
done
echo ""

# Validate CLAUDE.md
echo "Validating CLAUDE.md..."
if [ -f "CLAUDE.md" ]; then
    # Check token count
    word_count=$(wc -w < CLAUDE.md)
    token_estimate=$((word_count * 4 / 3))
    if [ $token_estimate -lt 5000 ]; then
        echo -e "${GREEN}✅ CLAUDE.md is lean (~$token_estimate tokens, target: under 5k)${NC}"
    else
        echo -e "${YELLOW}⚠️  CLAUDE.md may be too large (~$token_estimate tokens, target: under 5k)${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi

    REQUIRED_SECTIONS=(
        "Tech Stack"
        "Commands"
        "Code Conventions"
        "Critical Guardrails"
    )

    OPTIONAL_SECTIONS=(
        "Known Pitfalls"
        "Project Context"
    )

    for section in "${REQUIRED_SECTIONS[@]}"; do
        if grep -qi "$section" CLAUDE.md; then
            echo -e "${GREEN}✅ $section section${NC}"
        else
            echo -e "${RED}❌ Missing: $section${NC}"
            ERRORS=$((ERRORS + 1))
        fi
    done

    for section in "${OPTIONAL_SECTIONS[@]}"; do
        if grep -qi "$section" CLAUDE.md; then
            echo -e "${GREEN}✅ $section section${NC}"
        else
            echo -e "${YELLOW}⚠️  Missing: $section (recommended)${NC}"
            WARNINGS=$((WARNINGS + 1))
        fi
    done
    
    # Check for AUTO-GENERATED markers
    if grep -q "AUTO-GENERATED" CLAUDE.md; then
        echo -e "${GREEN}✅ AUTO-GENERATED markers present${NC}"
    else
        echo -e "${YELLOW}⚠️  No AUTO-GENERATED markers (may be manually created)${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi

    # Check for @imports (should NOT exist)
    if grep -q "@import\|@include" CLAUDE.md; then
        echo -e "${RED}❌ Found @import statements (causes eager loading)${NC}"
        ERRORS=$((ERRORS + 1))
    else
        echo -e "${GREEN}✅ No @import statements (good)${NC}"
    fi
else
    echo -e "${RED}❌ CLAUDE.md not found${NC}"
    ERRORS=$((ERRORS + 1))
fi
echo ""

# Check project agents (optional)
echo "Checking project agents (optional)..."
if [ -d ".claude/agents" ]; then
    agent_count=$(ls .claude/agents/*.md 2>/dev/null | wc -l | tr -d ' ')
    echo -e "${GREEN}✅ .claude/agents exists (${agent_count} file(s))${NC}"

    # Warn if global workflow agents are duplicated at the project level
    DUPLICATE_GLOBAL_AGENTS=("cto-advisor.md" "architecture-advisor.md" "code-reviewer.md" "security-reviewer.md" "performance-analyzer.md" "explore-with-serena.md")
    for agent in "${DUPLICATE_GLOBAL_AGENTS[@]}"; do
        if [ -f ".claude/agents/$agent" ]; then
            echo -e "${YELLOW}⚠️  $agent is usually global (consider moving to ~/.claude/agents/)${NC}"
            WARNINGS=$((WARNINGS + 1))
        fi
    done

    # List project agent files (if any)
    for agent in .claude/agents/*.md; do
        if [ -f "$agent" ]; then
            echo "   • $(basename "$agent")"
        fi
    done
else
    echo -e "${YELLOW}⚠️  .claude/agents directory not found (optional, for project-specific workflow agents)${NC}"
fi
echo ""

# Check skills
echo "Checking skills..."
if [ -d ".claude/skills" ]; then
    skill_count=0
    skills_with_references=0

    for skill_dir in .claude/skills/*/; do
        if [ -d "$skill_dir" ] && [ -f "${skill_dir}SKILL.md" ]; then
            skill_count=$((skill_count + 1))
            skill_name=$(basename "$skill_dir")

            # Check for references directory
            if [ -d "${skill_dir}references" ]; then
                echo "   • $skill_name (with references/)"
                skills_with_references=$((skills_with_references + 1))
            else
                echo "   • $skill_name"
            fi
            
            # Check skill structure (look for key sections)
            if grep -q -i "philosophy\|implementation guide\|pitfall\|verification" "${skill_dir}SKILL.md"; then
                : # Good structure, don't print
            else
                echo -e "${YELLOW}     ⚠️  $skill_name may be missing standard sections${NC}"
            fi

            # Check for wrong folder name (resources/ should be references/)
            if [ -d "${skill_dir}resources" ]; then
                echo -e "${RED}     ❌ $skill_name uses 'resources/' - should be 'references/'${NC}"
                ERRORS=$((ERRORS + 1))
            fi
        fi
    done
    
    if [ "$skill_count" -gt 0 ]; then
        echo -e "${GREEN}✅ Found $skill_count skill(s) with proper structure${NC}"
        if [ "$skills_with_references" -gt 0 ]; then
            echo -e "${GREEN}   $skills_with_references skill(s) have references/ subdirectory${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  No properly structured skills found${NC}"
        echo "   Expected: .claude/skills/[name]/SKILL.md"
        WARNINGS=$((WARNINGS + 1))
    fi
else
    echo -e "${RED}❌ .claude/skills directory not found${NC}"
    ERRORS=$((ERRORS + 1))
fi

# Check .agents/skills mirror (primary Codex skills path)
echo ""
echo "Checking Codex skills mirror..."
if [ -d ".agents/skills" ]; then
    agents_skill_count=$(find .agents/skills -mindepth 1 -maxdepth 2 -type f -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
    echo -e "${GREEN}✅ Found $agents_skill_count skill(s) in .agents/skills${NC}"
    if [ -n "${skill_count:-}" ] && [ "$skill_count" -gt 0 ] && [ "$agents_skill_count" -ne "$skill_count" ]; then
        echo -e "${YELLOW}⚠️  Skill count mismatch: .claude/skills=$skill_count vs .agents/skills=$agents_skill_count${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi

    # Check for wrong folder name in agents skills
    for agents_skill_dir in .agents/skills/*/; do
        if [ -d "${agents_skill_dir}resources" ]; then
            agents_skill_name=$(basename "$agents_skill_dir")
            echo -e "${RED}     ❌ $agents_skill_name uses 'resources/' - should be 'references/'${NC}"
            ERRORS=$((ERRORS + 1))
        fi
    done
else
    echo -e "${YELLOW}⚠️  .agents/skills directory not found (required for Codex; skip if Claude Code only)${NC}"
    WARNINGS=$((WARNINGS + 1))
fi

# Check .codex/skills mirror (optional compatibility mirror)
if [ -d ".codex/skills" ]; then
    codex_skill_count=$(find .codex/skills -mindepth 1 -maxdepth 2 -type f -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
    echo -e "${GREEN}✅ Found $codex_skill_count skill(s) in .codex/skills (optional mirror)${NC}"
fi
echo ""

# Check discovery analysis
echo "Checking discovery analysis..."
if [ -f ".claude/discovery/analysis.yaml" ]; then
    # Check if it's Serena-enhanced
    if grep -q "serena-enhanced" .claude/discovery/analysis.yaml; then
        echo -e "${GREEN}✅ Serena-enhanced discovery${NC}"
    else
        echo -e "${YELLOW}⚠️  Standard discovery (Serena not used)${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
    
    # Check for discovery limitations
    if grep -q "discovery_limitations" .claude/discovery/analysis.yaml; then
        echo -e "${GREEN}✅ Discovery limitations documented${NC}"
    else
        echo -e "${YELLOW}⚠️  Discovery limitations not documented${NC}"
    fi

    # Structural YAML validation (prefer yq, fallback to python3)
    if yq . .claude/discovery/analysis.yaml > /dev/null 2>&1 || \
       python3 -c "import yaml; yaml.safe_load(open('.claude/discovery/analysis.yaml'))" 2>/dev/null; then
        echo -e "${GREEN}✅ analysis.yaml is structurally valid YAML${NC}"
    else
        echo -e "${RED}❌ analysis.yaml exists but failed YAML parse — re-run Stage 1 to regenerate${NC}"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo -e "${YELLOW}⚠️  analysis.yaml not found (run bootstrap Stage 1 first)${NC}"
fi
echo ""

# Final summary
echo "=========================================="
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}✅ Validation complete!${NC}"
    
    if [ $WARNINGS -gt 0 ]; then
        echo -e "${YELLOW}⚠️  $WARNINGS warning(s) - review above${NC}"
    fi
    
    echo ""
    echo "Your engineering team is configured with:"
    echo "• Multi-phase development workflow"
    echo "• CLAUDE.md with pattern overview (auto-read)"
    echo "• Skills with detailed implementation guides (progressive disclosure)"
    echo "• Codex project instructions via AGENTS.md (if present)"
    echo "• Optional review workflows via Claude Code agents and/or Codex skills"
    echo ""
    echo "Next steps:"
    echo "1. Review CLAUDE.md - add project-specific sections as needed"
    echo "2. Codex: Run codex from repo root (it will read AGENTS.md)"
    echo ""
    echo "Maintenance:"
    echo "• Re-bootstrap when tech stack changes or patterns drift"
    echo "• Update CLAUDE.md/skills directly for minor pattern updates"
    echo ""
    exit 0
else
    echo -e "${RED}❌ Validation failed with $ERRORS error(s)${NC}"
    if [ $WARNINGS -gt 0 ]; then
        echo -e "${YELLOW}⚠️  $WARNINGS warning(s)${NC}"
    fi
    echo ""
    echo "Fix errors above and re-run validation."
    echo ""
    exit 1
fi
