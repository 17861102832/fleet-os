'use strict';
/**
 * Runner Loop —— OpenAI Agents SDK runner 抽象：
 *   while not final_output and not handoff and not tool_call:
 *     1) call model
 *     2) if final → return
 *     3) if handoff → switch current_agent
 *     4) if tool_call → execute tool, append result
 *     5) if maxTurns exceeded → throw MaxTurnsExceeded
 *
 * 舰队落地：每个 worker 的 execute() 调用 runTurn(maxTurns, hooks, guardrails)
 */
class MaxTurnsExceeded extends Error {
  constructor(maxTurns) { super(`maxTurnsExceeded:${maxTurns}`); this.name = 'MaxTurnsExceeded'; this.maxTurns = maxTurns; }
}

class RunnerState {
  constructor() { this.currentAgent = null; this.turn = 0; this.trace = []; this.handoff = []; this.tools = []; this.guardrails = []; }
}

async function runTurn({ runner, maxTurns = 10, hooks, guardrails }) {
  const st = runner.state;
  st.turn = 0;
  while (st.turn < maxTurns) {
    st.turn++;
    if (hooks && hooks.fire) await hooks.fire('PreToolUse', { agent: st.currentAgent && st.currentAgent.id, turn: st.turn });
    if (guardrails) {
      try { await guardrails.runInput({ agent: st.currentAgent && st.currentAgent.id }, { turn: st.turn }); } catch (e) { if (e.tripwire) throw e; }
    }
    const out = await runner.modelCall(st.currentAgent, st);
    if (out.final) {
      if (guardrails) { try { await guardrails.runOutput(out.value, { agent: st.currentAgent.id }); } catch (e) { if (e.tripwire) throw e; } }
      if (hooks && hooks.fire) await hooks.fire('Stop', { reason: 'final', value: out.value });
      return out.value;
    }
    if (out.handoff) {
      st.currentAgent = runner.agents[out.handoff];
      st.handoff.push({ at: Date.now(), to: out.handoff });
      continue;
    }
    if (out.tool) {
      const result = await runner.toolCall(out.tool.name, out.tool.args);
      st.trace.push({ tool: out.tool.name, args: out.tool.args, result });
      st.tools.push({ name: out.tool.name });
      continue;
    }
    throw new Error('agent_produced_nothing');
  }
  throw new MaxTurnsExceeded(maxTurns);
}

module.exports = { runTurn, RunnerState, MaxTurnsExceeded };