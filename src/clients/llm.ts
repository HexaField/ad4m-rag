// LLM client interface + default Anthropic implementation.

export interface LlmClient {
  /** A single-shot completion: feed a system + user prompt, get a string back. */
  complete(opts: { system?: string; user: string; maxTokens?: number; temperature?: number }): Promise<string>
}

export interface AnthropicLlmOptions {
  apiKey: string
  model?: string
  /** Default max-tokens cap for every call. */
  maxTokens?: number
}

/**
 * Default Anthropic-backed LLM client. The `@anthropic-ai/sdk` is an
 * optional peer dependency; this function dynamically imports it so
 * consumers using a different LLM never have to install it.
 */
export async function createAnthropicLlmClient(opts: AnthropicLlmOptions): Promise<LlmClient> {
  const mod = await import('@anthropic-ai/sdk').catch(() => {
    throw new Error('@anthropic-ai/sdk is not installed; install it or provide a different LlmClient')
  })
  const Anthropic = (mod as any).default ?? mod
  const client = new Anthropic({ apiKey: opts.apiKey })
  const model = opts.model ?? 'claude-3-5-haiku-latest'
  const defaultMaxTokens = opts.maxTokens ?? 2048

  return {
    async complete({ system, user, maxTokens, temperature }) {
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens ?? defaultMaxTokens,
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: user }]
      })
      const block = (res.content ?? []).find((b: any) => b.type === 'text')
      if (!block || typeof block.text !== 'string') {
        throw new Error('anthropic complete: no text block in response')
      }
      return block.text
    }
  }
}
