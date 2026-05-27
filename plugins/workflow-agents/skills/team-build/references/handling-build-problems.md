# Handling Mid-Build Problems

## Builder reports a plan ambiguity

- Lead reads the plan section in question
- Makes the interpretation call (document it in a reply)
- If the decision is significant, note it for the drift check

## Builder reports a file conflict (wasn't caught in /team-plan)

- Signal both affected builders to pause (via your runtime's worker channel — see the skill's § Dispatch by Runtime)
- Resolve the conflict (which builder owns what)
- Resume builders with updated ownership

## Builder fails a test case

- Lead reads the failing code and the test spec
- Message the builder with specific diagnosis and fix (via your runtime's worker channel — see the skill's § Dispatch by Runtime)
- Builder fixes and re-reports
- Lead re-validates before marking complete

## Builder hits an external dependency issue (missing env var, service down)

- This is a blocker for the whole build, not just the group
- Lead notifies user immediately, pauses build
- User resolves, lead resumes
