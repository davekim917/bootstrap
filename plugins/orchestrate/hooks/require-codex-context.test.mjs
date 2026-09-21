import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./require-codex-context.mjs', import.meta.url));
const base = { message: 'bounded task', model: 'gpt-6-astra', reasoning_effort: 'high', agent_type: 'worker-high' };
function run(input) { return spawnSync(process.execPath, [script], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' }); }
for (const name of ['spawn_agent', 'collaborationspawn_agent']) {
  for (const control of [{fork_context:false}, {fork_context:true}, {fork_turns:'none'}, {fork_turns:'all'}, {fork_turns:'3'}, {fork_turns:' NONE '}, {fork_turns:' All '}, {fork_turns:'18446744073709551615'}]) {
    test(`${name} passes explicit ${JSON.stringify(control)} without rewriting any arguments or granting permission`, () => {
      const event = {tool_name:name, tool_input:{...base,...control}};
      const before=JSON.stringify(event);const r=run(event);
      assert.equal(r.status,0);assert.equal(r.stdout,'');assert.equal(r.stderr,'');assert.equal(JSON.stringify(event),before);
    });
  }
  for (const control of [{}, {fork_context:null}, {fork_context:'false'}, {fork_turns:null}, {fork_turns:false}, {fork_turns:3}, {fork_turns:''}, {fork_turns:' '}, {fork_turns:'0'}, {fork_turns:'007'}, {fork_turns:'+3'}, {fork_turns:'-3'}, {fork_turns:'3.0'}, {fork_turns:'18446744073709551616'}, {fork_turns:'all',fork_context:false}, {fork_turns:'none',fork_context:null}]) {
    test(`${name} denies ${JSON.stringify(control)}`, () => {
      const r=run({tool_name:name,tool_input:{...base,...control}});
      assert.equal(r.status,0);assert.equal(r.stderr,'');const out=JSON.parse(r.stdout).hookSpecificOutput;
      assert.equal(out.permissionDecision,'deny');assert.equal(out.hookEventName,'PreToolUse');assert.match(out.permissionDecisionReason,/exposed spawn_agent schema/);assert.equal(out.updatedInput,undefined);assert.match(out.permissionDecisionReason,/canonical positive decimal string/);
    });
  }
  for (const input of [null,[],false,'invalid']) test(`${name} malformed tool input ${JSON.stringify(input)} denies`,()=>assert.equal(JSON.parse(run({tool_name:name,tool_input:input}).stdout).hookSpecificOutput.permissionDecision,'deny'));
}
for (const name of ['Bash','followup_task','send_input','mcp__server__spawn_agent','customspawn_agent']) test(`unrelated ${name} ignored even with malformed input`,()=>{const r=run({tool_name:name,tool_input:null});assert.equal(r.status,0);assert.equal(r.stdout,'');assert.equal(r.stderr,'');});
for(const input of ['{','null','[]','{}']) test(`malformed event ${input} visibly blocks without echoing input`,()=>{const r=run(input);assert.equal(r.status,2);assert.equal(r.stdout,'');assert.equal(r.stderr,'Cannot validate worker context: malformed spawn hook input.\n');});
test('manifest covers exact verified native names with bounded synchronous handler',()=>{const m=JSON.parse(fs.readFileSync(new URL('./orchestrate-codex-hooks.json',import.meta.url),'utf8'));const entry=m.hooks.PreToolUse[0];assert.equal(entry.matcher,'^(spawn_agent|collaborationspawn_agent)$');assert.equal(entry.hooks[0].timeout,5);assert.equal(entry.hooks[0].async,undefined);assert.match(entry.hooks[0].command,/require-codex-context\.mjs/);});
