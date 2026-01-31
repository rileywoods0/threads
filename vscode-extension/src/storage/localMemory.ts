import * as path from 'path';
import { EventPayload } from './types';

export type LocalSnapshot = {
  current_goal: string;
  completed_work: string[];
  open_issues: string[];
  next_steps: string[];
  decisions: string[];
  summary_text: string;
  confidence_tag?: 'in flow' | 'mid-task' | 'unfinished';
};

type SessionRecord = {
  started_at?: string;
  ended_at?: string;
};

type ParsedEvent = {
  event_type: string;
  timestamp?: string;
  data: Record<string, unknown>;
};

function parseEventData(raw: unknown): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  if (typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const decoded = JSON.parse(raw);
      if (decoded && typeof decoded === 'object') {
        return decoded as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function collectFiles(events: ParsedEvent[]): string[] {
  const files = new Set<string>();
  for (const event of events) {
    const data = parseEventData(event.data);
    const filePath = data.filePath || data.file || data.path;
    if (!filePath) {
      continue;
    }
    const fileStr = String(filePath);
    const lowered = fileStr.replace(/\\/g, '/').toLowerCase();
    if (lowered.includes('/.threads/') || lowered.includes('/.git/')) {
      continue;
    }
    files.add(fileStr);
  }
  return Array.from(files).sort();
}

function eventSummary(events: ParsedEvent[]): string {
  if (!events.length) {
    return 'No notable activity recorded.';
  }
  const counts = new Map<string, number>();
  for (const event of events) {
    const eventType = event.event_type || 'unknown';
    counts.set(eventType, (counts.get(eventType) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function ensureStringList(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter((item) => item.trim());
  }
  if (typeof value === 'string') {
    try {
      const decoded = JSON.parse(value);
      if (Array.isArray(decoded)) {
        return decoded.map((item) => String(item)).filter((item) => item.trim());
      }
    } catch {
      return [];
    }
  }
  return [];
}

function buildSummaryText(startedAt: string | undefined, eventSummaryText: string, files: string[]): string {
  const started = startedAt ?? new Date().toISOString();
  const lines = [`Session started at ${started}`, `Events observed: ${eventSummaryText}.`];
  if (files.length) {
    const fileLabels = files.slice(0, 10).map((file) => path.basename(file));
    lines.push(`Files touched: ${fileLabels.join(', ')}.`);
  }
  lines.push('Threads recorded this state so you can quickly get back into flow.');
  return lines.join('\n');
}

function confidenceTag(events: ParsedEvent[], eventCounts: Map<string, number>): 'in flow' | 'mid-task' | 'unfinished' {
  if (!events.length) {
    return 'unfinished';
  }
  const edits = (eventCounts.get('file.save') ?? 0) + (eventCounts.get('file_edit') ?? 0);
  const taskStarts = (eventCounts.get('task.start') ?? 0) + (eventCounts.get('task_start') ?? 0);
  const taskEnds = (eventCounts.get('task.end') ?? 0) + (eventCounts.get('task_end') ?? 0);
  const debugStarts = (eventCounts.get('debug.start') ?? 0) + (eventCounts.get('debug_start') ?? 0);
  const debugEnds = (eventCounts.get('debug.end') ?? 0) + (eventCounts.get('debug_end') ?? 0);

  if (edits === 0 && taskStarts === 0 && debugStarts === 0) {
    return 'unfinished';
  }
  if ((taskStarts > taskEnds) || (debugStarts > debugEnds)) {
    return 'mid-task';
  }
  if (edits > 0 && (taskEnds > 0 || debugEnds > 0)) {
    return 'in flow';
  }
  return 'mid-task';
}

export function generateLocalSnapshot(
  session: SessionRecord,
  events: ParsedEvent[],
  lastSnapshot?: Partial<LocalSnapshot> | null
): LocalSnapshot {
  const filesTouched = collectFiles(events);
  const eventSummaryText = eventSummary(events);

  const eventCounts = new Map<string, number>();
  for (const event of events) {
    const eventType = event.event_type || 'unknown';
    eventCounts.set(eventType, (eventCounts.get(eventType) ?? 0) + 1);
  }

  const usedDebugger = events.some((evt) => ['debug_start', 'debug.start'].includes(evt.event_type));
  const tasksStarted = (eventCounts.get('task_start') ?? 0) + (eventCounts.get('task.start') ?? 0);
  const branchChanges = (eventCounts.get('branch_change') ?? 0) + (eventCounts.get('git.branch.change') ?? 0);
  const frictionSwitching =
    (eventCounts.get('friction_switching') ?? 0) + (eventCounts.get('friction.context_switching') ?? 0);

  const completedWork: string[] = [];
  if (filesTouched.length) {
    completedWork.push(
      `Edited or reviewed ${filesTouched.length} file(s): ${filesTouched.slice(0, 5).map((f) => path.basename(f)).join(', ')}.`
    );
  }
  if (usedDebugger) {
    completedWork.push('Ran the debugger during this session.');
  }
  if (tasksStarted) {
    completedWork.push(`Ran ${tasksStarted} task(s) (build/test/run).`);
  }
  if (branchChanges) {
    completedWork.push('Switched git branches.');
  }
  if (frictionSwitching) {
    completedWork.push('Lots of context switching detected (rapid file switching with few edits).');
  }
  if (!completedWork.length && events.length) {
    completedWork.push(`Captured ${events.length} IDE events including ${eventSummaryText}.`);
  }

  let currentGoal = '';
  const previousSteps = lastSnapshot ? ensureStringList(lastSnapshot.next_steps) : [];
  if (previousSteps.length) {
    currentGoal = `Continue: ${previousSteps[0]}`;
  }
  if (!currentGoal) {
    if (filesTouched.length) {
      currentGoal = `Continue working on ${filesTouched.slice(0, 3).map((f) => path.basename(f)).join(', ')}.`;
    } else {
      currentGoal = 'Ongoing development work.';
    }
  }

  const openIssues = lastSnapshot ? ensureStringList(lastSnapshot.open_issues) : [];

  const nextSteps: string[] = [];
  if (filesTouched.length) {
    nextSteps.push('Keep iterating on recently touched files.');
  }
  nextSteps.push('Consider running tests to validate recent changes.');
  if (previousSteps.length) {
    nextSteps.push(...previousSteps);
  }

  const summaryText = buildSummaryText(session.started_at, eventSummaryText, filesTouched);

  return {
    current_goal: currentGoal,
    completed_work: completedWork,
    open_issues: openIssues,
    next_steps: dedupe(nextSteps),
    decisions: [],
    summary_text: summaryText,
    confidence_tag: confidenceTag(events, eventCounts)
  };
}
