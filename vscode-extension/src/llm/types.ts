export type LlmSummaryInput = {
  goal?: string;
  anchor?: string;
  files?: string[];
  recentActions?: string[];
  openIssues?: string[];
  nextSteps?: string[];
  decisions?: string[];
  lastTask?: string;
  lastError?: string;
  lastCheckpointAt?: string;
  eventCounts?: Record<string, number>;
  durationMinutes?: number;
};

export type LlmSummaryOutput = {
  current_goal: string;
  completed_work: string[];
  open_issues: string[];
  next_steps: string[];
  decisions: string[];
  confidence_tag?: 'in flow' | 'mid-task' | 'unfinished';
};

export type LlmHandoffInput = {
  mode: 'compact' | 'debug' | 'deep';
  goal?: string;
  anchor?: string;
  recentActions?: string[];
  whatChanged?: string[];
  openQuestions?: string[];
  nextStep?: string;
  constraints?: string[];
  confidenceTag?: string;
  files?: string[];
  debugNotes?: string[];
  lastError?: string;
  snippets?: string[];
};

export type LlmTestResult = { ok: boolean; message: string };

export interface LlmProvider {
  readonly name: string;
  isConfigured(): boolean;
  summarize(input: LlmSummaryInput): Promise<LlmSummaryOutput>;
  buildAgentHandoff(input: LlmHandoffInput): Promise<string>;
  testConnection(): Promise<LlmTestResult>;
}
