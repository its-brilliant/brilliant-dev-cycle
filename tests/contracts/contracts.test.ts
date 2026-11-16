import { describe, expect, it } from 'vitest';
import { Decision, Plan, ProjectConfig } from '../../src/contracts/domain.js';
import { PersonEvent } from '../../src/contracts/events.js';

describe('contracts', () => {
  it('a config needs an agent for every role and fills the agreed defaults', () => {
    const claude = { cli: 'claude', model: 'claude-opus-5-5' };
    expect(ProjectConfig.safeParse({ agents: { pm: claude, builder: { cli: 'pi' } } }).success).toBe(false);
    const agents = { pm: claude, specWriter: claude, planner: claude, builder: { cli: 'pi' }, reviewer: claude, verifier: claude };
    const config = ProjectConfig.parse({ agents });
    expect(config.concurrency).toBe(3);
    expect(config.max_attempts).toBe(3);
    expect(config.verification).toBeNull();
    expect(config.agents.builder?.model).toBe('');
  });

  it('a plan phase must say what proof it needs', () => {
    const phase = { id: 'p1', title: 'One', tasks: [{ id: 't1', title: 'Do it' }] };
    expect(Plan.safeParse({ phases: [phase] }).success).toBe(false);
    expect(Plan.safeParse({ phases: [{ ...phase, proof: [{ kind: 'tests' }] }] }).success).toBe(true);
  });

  it('a fix decision needs instructions; asking is not a decision', () => {
    expect(Decision.safeParse({ action: 'fix', reason: 'x' }).success).toBe(false);
    expect(Decision.safeParse({ action: 'ask', reason: 'x' }).success).toBe(false);
  });

  it('person events are validated at the socket', () => {
    expect(PersonEvent.safeParse({ type: 'SPEC_APPROVED' }).success).toBe(true);
    expect(PersonEvent.safeParse({ type: 'MESSAGE', text: '' }).success).toBe(false);
    expect(PersonEvent.safeParse({ type: 'DROP_TABLES' }).success).toBe(false);
  });
});
