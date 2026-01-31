import { LlmHandoffInput, LlmSummaryInput } from './types';

export function buildPromptWrapper(): string {
  return [
    'You are my coding assistant. Help me resume this work.',
    'Use only the context below; ask up to 3 concise questions if something is missing.',
    'Return: goal, top 3 next steps, and any risks/unknowns.'
  ].join('\n');
}

function pushSection(lines: string[], title: string, items?: string[] | string) {
  if (!items) {
    return;
  }
  if (Array.isArray(items)) {
    const filtered = items.map((item) => item.trim()).filter(Boolean);
    if (!filtered.length) {
      return;
    }
    lines.push(`${title}:`);
    for (const item of filtered) {
      lines.push(`- ${item}`);
    }
    lines.push('');
    return;
  }
  const value = items.trim();
  if (!value) {
    return;
  }
  lines.push(`${title}: ${value}`);
  lines.push('');
}

export function buildHandoffText(input: LlmHandoffInput): string {
  const lines: string[] = [];
  lines.push(buildPromptWrapper());
  lines.push('');
  lines.push('[Context]');
  lines.push('');

  pushSection(lines, 'Goal', input.goal ?? '');
  pushSection(lines, 'Anchor', input.anchor ?? '');
  pushSection(lines, 'Recent actions', input.recentActions);
  pushSection(lines, 'What changed', input.whatChanged);
  pushSection(lines, 'Open questions', input.openQuestions);
  pushSection(lines, 'Next step', input.nextStep ?? '');
  pushSection(lines, 'Constraints', input.constraints);
  pushSection(lines, 'Confidence', input.confidenceTag ?? '');

  if (input.mode !== 'compact') {
    pushSection(lines, 'Files', input.files);
  }
  if (input.mode === 'debug') {
    pushSection(lines, 'Debug signals', input.debugNotes);
    if (input.lastError) {
      pushSection(lines, 'Last error', input.lastError);
    }
  }
  if (input.mode === 'deep') {
    pushSection(lines, 'Recent snapshots', input.debugNotes);
  }
  if (input.snippets && input.snippets.length) {
    pushSection(lines, 'Snippets', input.snippets);
  }

  return lines.join('\n').trim() + '\n';
}

export function buildSummaryPrompt(input: LlmSummaryInput): string {
  return [
    'Return JSON with keys:',
    'current_goal, completed_work, open_issues, next_steps, decisions, confidence_tag.',
    'Constraints:',
    '- current_goal: 1 sentence',
    '- completed_work: max 3 bullets',
    '- open_issues: max 2 bullets',
    '- next_steps: 1 bullet',
    '- decisions: 1 bullet',
    '- confidence_tag: one of "in flow", "mid-task", "unfinished"',
    '',
    'Context:',
    JSON.stringify(input, null, 2)
  ].join('\n');
}
