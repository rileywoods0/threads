import { buildHandoffText, buildSummaryPrompt } from './formatting';
import { LlmHandoffInput, LlmProvider, LlmSummaryInput, LlmSummaryOutput, LlmTestResult } from './types';
import { extractJsonBlock, normalizeSummary } from './utils';

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = (baseUrl || 'https://api.openai.com').replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.model);
  }

  private async postJson(path: string, body: Record<string, unknown>) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI ${response.status}: ${text}`);
    }
    return (await response.json()) as any;
  }

  async testConnection(): Promise<LlmTestResult> {
    try {
      await this.postJson('/v1/chat/completions', {
        model: this.model,
        messages: [{ role: 'user', content: 'Respond with OK.' }],
        max_tokens: 5,
        temperature: 0
      });
      return { ok: true, message: 'OpenAI connection OK.' };
    } catch (err) {
      return { ok: false, message: `OpenAI connection failed: ${String(err)}` };
    }
  }

  async summarize(input: LlmSummaryInput): Promise<LlmSummaryOutput> {
    const prompt = buildSummaryPrompt(input);
    const payload = await this.postJson('/v1/chat/completions', {
      model: this.model,
      messages: [
        { role: 'system', content: 'You are a concise summarizer. Output JSON only.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2
    });
    const content = payload?.choices?.[0]?.message?.content ?? '';
    const jsonBlock = extractJsonBlock(content);
    if (!jsonBlock) {
      throw new Error('OpenAI response did not contain JSON');
    }
    return normalizeSummary(JSON.parse(jsonBlock));
  }

  async buildAgentHandoff(input: LlmHandoffInput): Promise<string> {
    const template = buildHandoffText(input);
    const prompt = [
      'Format the following context into a paste-ready handoff for a coding assistant.',
      'Keep it concise, keep sections in the same order, and do not add extra sections.',
      '',
      template
    ].join('\n');

    try {
      const payload = await this.postJson('/v1/chat/completions', {
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a concise technical writer. Do not include code.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2
      });
      const content = (payload?.choices?.[0]?.message?.content ?? '').trim();
      return content || template;
    } catch {
      return template;
    }
  }
}
