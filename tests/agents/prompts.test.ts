import { describe, expect, it } from 'vitest';
import {
  ROLE_SYSTEM,
  ROLE_SUBMITS,
  builderPrompt,
  plannerPrompt,
  pmPrompt,
  reviewerPrompt,
  specWriterPrompt,
  submitToolOf,
  verifierPrompt,
} from '../../src/agents/prompts.js';
import { SUBMIT_TOOLS } from '../../src/contracts/actors.js';
import { ROLES } from '../../src/contracts/domain.js';

describe('ROLE_SYSTEM', () => {
  it('names the role\'s own submit tool and says not to stop without calling it', () => {
    for (const role of ROLES) {
      const tool = SUBMIT_TOOLS[ROLE_SUBMITS[role]];
      expect(submitToolOf(role)).toBe(tool);
      expect(ROLE_SYSTEM[role], role).toContain(`\`${tool}\``);
      expect(ROLE_SYSTEM[role], role).toMatch(/Do not stop without calling/);
      expect(ROLE_SYSTEM[role], role).toContain('bdc, a dev-cycle tool');
      expect(ROLE_SYSTEM[role], role).toMatch(/fix the payload and call it again/);
    }
  });

  it('keeps every role but the PM from asking the person, and the PM from editing code', () => {
    for (const role of ROLES) {
      if (role === 'pm') continue;
      expect(ROLE_SYSTEM[role], role).toMatch(/Do not ask the person anything/);
    }
    // §3.4: the PM is the one role that asks, and `ask_user` ends its turn.
    expect(ROLE_SYSTEM.pm).toMatch(/ask them with `ask_user`/);
    expect(ROLE_SYSTEM.pm).toMatch(/returns at once and ends your turn/);
    expect(ROLE_SYSTEM.pm).toMatch(/answers arrive as your next message/);
    expect(ROLE_SYSTEM.pm).not.toMatch(/Do not ask the person anything/);
    expect(ROLE_SYSTEM.pm).toMatch(/never edit code/);
    expect(ROLE_SYSTEM.reviewer).toMatch(/Never edit code/);
    expect(ROLE_SYSTEM.verifier).toMatch(/do not change code/);
  });

  it('gives the builder its worktree and branch rules and the PM its decision rules', () => {
    expect(ROLE_SYSTEM.builder).toMatch(/commit there/);
    expect(ROLE_SYSTEM.builder).toMatch(/Never write in the repo root/);
    expect(ROLE_SYSTEM.pm).toMatch(/Decide yourself when the fix is mechanical/);
    expect(ROLE_SYSTEM.pm).toMatch(/Grill the person in rounds through `ask_user`/);
    expect(ROLE_SYSTEM.planner).toMatch(/must not overlap/);
  });
});

describe('first prompts', () => {
  it('pmPrompt opens the intake on the goal, and carries a lost conversation when there was one', () => {
    expect(pmPrompt({ runId: 'run-1', goal: 'Ship sign-in' })).toContain('Ship sign-in');
    const restarted = pmPrompt({ runId: 'run-1', goal: 'Ship sign-in', transcript: ['you: hello'] });
    expect(restarted).toMatch(/previous session was lost/);
    expect(restarted).toContain('you: hello');
  });

  it('specWriterPrompt hands over the brief, the current spec and the open comments', () => {
    const prompt = specWriterPrompt({
      runId: 'run-1',
      brief: { brief: 'Add sign-in', decisions: [{ question: 'Which provider?', answer: 'Google' }], assumptions: ['no SSO'] },
      spec: '# Spec v1',
      specVersion: 1,
      comments: [{ id: 'c1', quote: 'sign in', prefix: '', suffix: '', body: 'say which provider', resolved: false }],
      notes: [],
    });
    expect(prompt).toContain('Add sign-in');
    expect(prompt).toContain('Which provider? → Google');
    expect(prompt).toContain('# Spec v1');
    expect(prompt).toContain('on "sign in": say which provider');
    expect(prompt).toContain('submit_spec');
  });

  it('plannerPrompt hands over the approved spec and what the person said about the plan', () => {
    const prompt = plannerPrompt({
      runId: 'run-1',
      spec: '# Spec',
      specVersion: 2,
      comments: [{ phaseId: 'p1', body: 'split this phase' }],
      instructions: 'keep p2 separate',
    });
    expect(prompt).toContain('# Spec');
    expect(prompt).toContain('p1: split this phase');
    expect(prompt).toContain('keep p2 separate');
    expect(prompt).toContain('submit_plan');
  });

  it('builderPrompt names the phase, the task, its paths, the worktree and the branch', () => {
    const prompt = builderPrompt({
      phase: { id: 'p2', title: 'Sign-in' },
      task: { id: 't1', title: 'The provider list', paths: ['src/auth/**'] },
      branch: 'bdc/run-1/p2/t1',
      worktree: '/tmp/wt',
    });
    expect(prompt).toContain('Phase "Sign-in" (p2), task t1: The provider list.');
    expect(prompt).toContain('src/auth/**');
    expect(prompt).toContain('/tmp/wt');
    expect(prompt).toContain('bdc/run-1/p2/t1');
    expect(prompt).toContain('report_task');
    expect(prompt).not.toMatch(/bdc sent this back/);
  });

  it('builderPrompt adds the PM\'s fix on a follow-up turn', () => {
    const prompt = builderPrompt({
      phase: { id: 'p2', title: 'Sign-in' },
      task: { id: 't1', title: 'The provider list', paths: [] },
      branch: 'bdc/run-1/p2/t1',
      worktree: '/tmp/wt',
      fix: 'the list is not sorted',
    });
    expect(prompt).toContain('bdc sent this back to you: the list is not sorted');
    expect(prompt).toMatch(/commit again on the same branch/);
  });

  it('reviewerPrompt carries the lens prompt, the blocking severity and what to read', () => {
    const prompt = reviewerPrompt({
      scope: 'phase p1 of run run-1',
      lens: 'ux',
      lensPrompt: 'Judge the empty states.',
      blockOn: 'high',
      diff: 'the phase branch against main, in /tmp/wt',
    });
    expect(prompt).toContain('through the "ux" lens');
    expect(prompt).toContain('Findings at or above high block');
    expect(prompt).toContain('Judge the empty states.');
    expect(prompt).toContain('the phase branch against main, in /tmp/wt');
    expect(prompt).toContain('submit_findings');
  });

  it('verifierPrompt lists the proof items and where to work', () => {
    const prompt = verifierPrompt({
      phase: { id: 'p3', title: 'Sign-in screen' },
      worktree: '/tmp/wt',
      proof: [
        { kind: 'screenshot', shows: 'the empty state' },
        { kind: 'e2e', shows: '' },
      ],
    });
    expect(prompt).toContain('/tmp/wt');
    expect(prompt).toContain('screenshot — the empty state');
    expect(prompt).toContain('e2e');
    expect(prompt).toContain('submit_proof');
  });
});
