import { buildHandoffText, buildSummaryPrompt } from './formatting';
import { LlmHandoffInput, LlmProvider, LlmSummaryInput, LlmSummaryOutput, LlmTestResult } from './types';
import { extractJsonBlock, normalizeSummary } from './utils';

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.model);
  }

  async testConnection(): Promise<LlmTestResult> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        return { ok: false, message: `Ollama responded with ${response.status}` };
      }
      const payload = (await response.json()) as { models?: Array<{ name?: string }> };
      const hasModel = payload.models?.some((m) => m.name === this.model || m.name?.startsWith(`${this.model}:`));
      if (!hasModel) {
        return { ok: false, message: `Model ${this.model} not found in Ollama tags.` };
      }
      return { ok: true, message: 'Ollama connection OK.' };
    } catch (err) {
      return { ok: false, message: `Ollama connection failed: ${String(err)}` };
    }
  }

  async summarize(input: LlmSummaryInput): Promise<LlmSummaryOutput> {
    const prompt = buildSummaryPrompt(input);
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: 'system', content: 'You are a concise summarizer. Output JSON only.' },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!response.ok) {
      throw new Error(`Ollama status ${response.status}`);
    }
    const payload = (await response.json()) as { message?: { content?: string } };
    const content = payload.message?.content ?? '';
    const jsonBlock = extractJsonBlock(content);
    if (!jsonBlock) {
      throw new Error('Ollama response did not contain JSON');
    }
    const parsed = JSON.parse(jsonBlock);
    return normalizeSummary(parsed);
  }

  async buildAgentHandoff(input: LlmHandoffInput): Promise<string> {
    const template = buildHandoffText(input);
    const prompt = [
      'Format the following context into a paste-ready handoff for a coding assistant.',
      'Keep it concise, keep sections in the same order, and do not add extra sections.',
      '',
      template
    ].join('\n');

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: 'system', content: 'You are a concise technical writer. Do not include code.' },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!response.ok) {
      return template;
    }
    const payload = (await response.json()) as { message?: { content?: string } };
    const content = (payload.message?.content ?? '').trim();
    return content || template;
  }
}
