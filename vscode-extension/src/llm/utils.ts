import { LlmSummaryOutput } from './types';

export function extractJsonBlock(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

export function normalizeSummary(raw: any): LlmSummaryOutput {
  const toList = (value: any): string[] => {
    if (!value) return [];
    if (Array.isArray(value)) return value.map((item) => String(item)).filter((item) => item.trim());
    return [String(value)].filter((item) => item.trim());
  };

  return {
    current_goal: String(raw?.current_goal ?? '').trim() || 'Continue work from the last session.',
    completed_work: toList(raw?.completed_work).slice(0, 3),
    open_issues: toList(raw?.open_issues).slice(0, 2),
    next_steps: toList(raw?.next_steps).slice(0, 1),
    decisions: toList(raw?.decisions).slice(0, 1),
    confidence_tag: raw?.confidence_tag
  };
}
