#!/usr/bin/env python3
"""
Initialize a new skill with proper directory structure and templates.

Usage:
    python init_skill.py <skill-name> --path <output-directory>
    python init_skill.py <skill-name> --path <output-directory> --pattern <workflow|task|reference|capabilities>

Example:
    python init_skill.py database-verification --path .claude/skills
    python init_skill.py review-gates --path .claude/skills --pattern task
"""

import argparse
import os
import sys
from pathlib import Path


PATTERNS = {
    'capabilities': '''# {skill_title}

## Purpose

[TODO: What this skill helps with — 2-3 sentences]

## When to Use

[TODO: Specific scenarios and conditions that should trigger this skill]

## Core Principles

[TODO: The key principles or philosophy that should guide behavior]

## Key Patterns

[TODO: Canonical patterns with code examples]

```[language]
// TODO: Add example
```

## Anti-Patterns

[TODO: Common mistakes to avoid with examples]

## Verification

- [ ] [TODO: Key check 1]
- [ ] [TODO: Key check 2]

---

**Skill Status**: DRAFT — Needs content
**Line Count**: Keep under 500 lines
''',
    'workflow': '''# {skill_title}

## Purpose

[TODO: What this skill helps with — 2-3 sentences]

## When to Use

[TODO: Specific scenarios and conditions that should trigger this skill]

## Workflow

### Step 1: [Name]

[TODO: What to do and why]

```bash
# TODO: Add command or example
```

### Step 2: [Name]

[TODO: What to do and why]

### Step 3: [Name]

[TODO: What to do and why]

## Verification

Run after completing the workflow:

- [ ] [TODO: Verify outcome 1]
- [ ] [TODO: Verify outcome 2]

## Common Pitfalls

- **[Pitfall 1]:** [How to avoid]
- **[Pitfall 2]:** [How to avoid]

---

**Skill Status**: DRAFT — Needs content
**Line Count**: Keep under 500 lines
''',
    'task': '''# {skill_title}

## Purpose

[TODO: What this skill helps with — 2-3 sentences]

## When to Use

[TODO: Specific scenarios and conditions that should trigger this skill]

## Procedure

1. [TODO: First action]
2. [TODO: Second action]
3. [TODO: Third action]

## Expected Output

[TODO: Describe what the output should look like]

```[language]
// TODO: Example output
```

## Verification

- [ ] [TODO: Output check 1]
- [ ] [TODO: Output check 2]

---

**Skill Status**: DRAFT — Needs content
**Line Count**: Keep under 500 lines
''',
    'reference': '''# {skill_title}

## Purpose

[TODO: What this skill helps with — 2-3 sentences]

## When to Use

[TODO: Specific scenarios and conditions that should trigger this skill]

## [Topic 1]

[TODO: Reference content]

| Field | Type | Description |
|-------|------|-------------|
| TODO  | str  | TODO        |

## [Topic 2]

[TODO: Reference content]

## [Topic 3]

[TODO: Reference content]

## Quick Reference

| Scenario | Action |
|----------|--------|
| TODO     | TODO   |

---

**Skill Status**: DRAFT — Needs content
**Line Count**: Keep under 500 lines
''',
}

SKILL_MD_TEMPLATE = '''---
name: {skill_name}
description: [TODO: Write a clear description. Include WHAT this skill covers, WHEN to use it (trigger conditions), and what it does NOT handle. Use "Use when..." and "Do not use for..." patterns. Third person, under 1024 chars.]
---

{pattern_content}'''


EXAMPLE_REFERENCE = '''# Reference Document

This file contains detailed reference information for the {skill_title} skill.

## Table of Contents

- [Section 1](#section-1)
- [Section 2](#section-2)
- [Section 3](#section-3)

---

## Section 1

[TODO: Add detailed reference content here]

## Section 2

[TODO: Add detailed reference content here]

## Section 3

[TODO: Add detailed reference content here]

---

**Related Files:**
- [SKILL.md](../SKILL.md) - Main skill guide
'''


EXAMPLE_SCRIPT = '''#!/usr/bin/env python3
"""
Example utility script for {skill_title}.

This script demonstrates the pattern for bundled executable scripts.
Scripts should be deterministic and handle errors explicitly.

IMPORTANT: Test this script by running it before using in production.

Usage:
    python {script_name} <args>
"""

import argparse
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(
        description="Example script for {skill_title}"
    )
    parser.add_argument(
        "input",
        help="Input file or argument"
    )
    parser.add_argument(
        "--output", "-o",
        help="Output file (default: stdout)",
        default=None
    )

    args = parser.parse_args()

    # TODO: Implement script logic
    print(f"Processing: {{args.input}}")

    if args.output:
        print(f"Output would be written to: {{args.output}}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
'''


def to_title(skill_name: str) -> str:
    """Convert skill-name to Skill Name."""
    return ' '.join(word.capitalize() for word in skill_name.split('-'))


def create_skill(skill_name: str, output_path: Path, pattern: str) -> bool:
    """Create a new skill directory with all templates."""

    # Validate skill name
    if not skill_name.replace('-', '').isalnum():
        print(f"Error: Skill name must contain only lowercase letters, numbers, and hyphens")
        return False

    if skill_name != skill_name.lower():
        print(f"Error: Skill name must be lowercase")
        return False

    if len(skill_name) > 64:
        print(f"Error: Skill name must be 64 characters or less")
        return False

    # Check for reserved words
    reserved = ['anthropic', 'claude']
    for word in reserved:
        if word in skill_name:
            print(f"Error: Skill name cannot contain reserved word '{word}'")
            return False

    skill_dir = output_path / skill_name

    if skill_dir.exists():
        print(f"Error: Directory already exists: {skill_dir}")
        return False

    skill_title = to_title(skill_name)
    pattern_content = PATTERNS[pattern].format(skill_title=skill_title)

    try:
        # Create directories
        skill_dir.mkdir(parents=True)
        (skill_dir / 'scripts').mkdir()
        (skill_dir / 'references').mkdir()
        (skill_dir / 'assets').mkdir()

        # Create SKILL.md
        (skill_dir / 'SKILL.md').write_text(
            SKILL_MD_TEMPLATE.format(
                skill_name=skill_name,
                pattern_content=pattern_content,
            )
        )

        # Create example reference
        (skill_dir / 'references' / 'reference.md').write_text(
            EXAMPLE_REFERENCE.format(skill_title=skill_title)
        )

        # Create example script
        script_name = f"{skill_name.replace('-', '_')}_helper.py"
        (skill_dir / 'scripts' / 'example.py').write_text(
            EXAMPLE_SCRIPT.format(
                skill_title=skill_title,
                script_name=script_name
            )
        )

        # Make script executable
        os.chmod(skill_dir / 'scripts' / 'example.py', 0o755)

        # Create assets placeholder
        (skill_dir / 'assets' / '.gitkeep').write_text('')

        print(f"Created skill: {skill_dir}")
        print(f"Pattern: {pattern}")
        print()
        print("Next steps:")
        print(f"  1. Edit {skill_dir}/SKILL.md — write description (WHAT + WHEN + NOT) and content")
        print(f"  2. Run Four Failure Modes check (Encyclopedia / Everything Bagel / Secret Handshake / Fragile Skill)")
        print(f"  3. Delete example files you don't need (scripts/example.py, references/reference.md)")
        print()

        return True

    except Exception as e:
        print(f"Error creating skill: {e}")
        # Cleanup on failure
        if skill_dir.exists():
            import shutil
            shutil.rmtree(skill_dir)
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Initialize a new skill with proper directory structure",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Structural patterns:
  capabilities  Background knowledge, guidelines, principles (default)
  workflow      Multi-step procedure where ordering matters
  task          Single action with clear inputs/outputs
  reference     Information lookup, no procedure

Examples:
    %(prog)s my-new-skill --path .claude/skills
    %(prog)s review-gates --path .claude/skills --pattern task
    %(prog)s code-conventions --path .claude/skills --pattern capabilities
        """
    )

    parser.add_argument(
        'skill_name',
        help='Name of the skill (lowercase, hyphens only)'
    )

    parser.add_argument(
        '--path', '-p',
        required=True,
        help='Output directory where skill folder will be created'
    )

    parser.add_argument(
        '--pattern',
        choices=['capabilities', 'workflow', 'task', 'reference'],
        default='capabilities',
        help='Structural pattern for the skill (default: capabilities)'
    )

    args = parser.parse_args()

    output_path = Path(args.path).resolve()

    if not output_path.exists():
        print(f"Creating output directory: {output_path}")
        output_path.mkdir(parents=True)

    success = create_skill(args.skill_name, output_path, args.pattern)

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
