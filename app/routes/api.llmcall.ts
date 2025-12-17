import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { streamText } from '~/lib/.server/llm/stream-text';
import type { IProviderSetting, ProviderInfo } from '~/types/model';
import { generateText } from 'ai';
import { PROVIDER_LIST } from '~/utils/constants';
import { MAX_TOKENS, PROVIDER_COMPLETION_LIMITS, isReasoningModel } from '~/lib/.server/llm/constants';
import { LLMManager } from '~/lib/modules/llm/manager';
import type { ModelInfo } from '~/lib/modules/llm/types';
import { getApiKeysFromCookie, getProviderSettingsFromCookie } from '~/lib/api/cookies';
import { createScopedLogger } from '~/utils/logger';

export async function action(args: ActionFunctionArgs) {
  return llmCallAction(args);
}

async function getModelList(options: {
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  serverEnv?: Record<string, string>;
}) {
  const llmManager = LLMManager.getInstance(import.meta.env);
  return llmManager.updateModelList(options);
}

const logger = createScopedLogger('api.llmcall');

function getCompletionTokenLimit(modelDetails: ModelInfo): number {
  // 1. If model specifies completion tokens, use that
  if (modelDetails.maxCompletionTokens && modelDetails.maxCompletionTokens > 0) {
    return modelDetails.maxCompletionTokens;
  }

  // 2. Use provider-specific default
  const providerDefault = PROVIDER_COMPLETION_LIMITS[modelDetails.provider];

  if (providerDefault) {
    return providerDefault;
  }

  // 3. Final fallback to MAX_TOKENS, but cap at reasonable limit for safety
  return Math.min(MAX_TOKENS, 16384);
}

function validateTokenLimits(modelDetails: ModelInfo, requestedTokens: number): { valid: boolean; error?: string } {
  const modelMaxTokens = modelDetails.maxTokenAllowed || 128000;
  const maxCompletionTokens = getCompletionTokenLimit(modelDetails);

  // Check against model's context window
  if (requestedTokens > modelMaxTokens) {
    return {
      valid: false,
      error: `Requested tokens (${requestedTokens}) exceed model's context window (${modelMaxTokens}). Please reduce your request size.`,
    };
  }

  // Check against completion token limits
  if (requestedTokens > maxCompletionTokens) {
    return {
      valid: false,
      error: `Requested tokens (${requestedTokens}) exceed model's completion limit (${maxCompletionTokens}). Consider using a model with higher token limits.`,
    };
  }

  return { valid: true };
}

async function llmCallAction({ context, request }: ActionFunctionArgs) {
  const { system, message, model, provider, streamOutput } = await request.json<{
    system: string;
    message: string;
    model: string;
    provider: ProviderInfo;
    streamOutput?: boolean;
  }>();

  // Use a mutable copy of the incoming message for truncation/adjustment
  let messageContent = message;

  const { name: providerName } = provider;

  // validate 'model' and 'provider' fields
  if (!model || typeof model !== 'string') {
    throw new Response('Invalid or missing model', {
      status: 400,
      statusText: 'Bad Request',
    });
  }

  if (!providerName || typeof providerName !== 'string') {
    throw new Response('Invalid or missing provider', {
      status: 400,
      statusText: 'Bad Request',
    });
  }

  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = getApiKeysFromCookie(cookieHeader);
  const providerSettings = getProviderSettingsFromCookie(cookieHeader);

  if (streamOutput) {
    try {
      const result = await streamText({
        options: {
          system,
        },
        messages: [
          {
            role: 'user',
            content: `${message}`,
          },
        ],
        env: context.cloudflare?.env as any,
        apiKeys,
        providerSettings,
      });

      return new Response(result.textStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
        },
      });
    } catch (error: unknown) {
      console.log(error);

      if (error instanceof Error && error.message?.includes('API key')) {
        throw new Response('Invalid or missing API key', {
          status: 401,
          statusText: 'Unauthorized',
        });
      }

      // Handle token limit errors with helpful messages
      if (
        error instanceof Error &&
        (error.message?.includes('max_tokens') ||
          error.message?.includes('token') ||
          error.message?.includes('exceeds') ||
          error.message?.includes('maximum') ||
          error.message?.toLowerCase().includes('conversation is too long') ||
          error.message?.toLowerCase().includes('conversation too long'))
      ) {
        throw new Response(
          `Token limit error: ${error.message}. Try reducing your request size, starting a new conversation, or using a model with a larger context window.`,
          {
            status: 400,
            statusText: 'Token Limit Exceeded',
          },
        );
      }

      throw new Response(null, {
        status: 500,
        statusText: 'Internal Server Error',
      });
    }
  } else {
    try {
      const models = await getModelList({ apiKeys, providerSettings, serverEnv: context.cloudflare?.env as any });
      let modelDetails = models.find((m: ModelInfo) => m.name === model);

      // If the explicitly requested model isn't found, attempt safe fallbacks
      if (!modelDetails) {
        // Special-case guidance for Google model naming mistakes
        if (provider.name === 'Google' && model.includes('2.5')) {
          throw new Response(
            `Model "${model}" not found. Gemini 2.5 Pro does not exist. Available models: gemini-1.5-pro, gemini-2.0-flash, gemini-1.5-flash`,
            { status: 400, statusText: 'Model Not Found' },
          );
        }

        if (!models || !models.length) {
          throw new Response(
            `No models available for provider ${provider.name}. Check provider configuration and API keys.`,
            { status: 500, statusText: 'No Models Available' },
          );
        }

        // Fallback to the provider's first available model and continue, logging a warning
        const fallback = models[0];
        modelDetails = fallback;
        logger.warn(`Requested model "${model}" not found for provider "${provider.name}". Falling back to "${fallback.name}".`);

        // Annotate the request context so response consumers can know a fallback occurred
        // We'll add a small header when returning the final response later.
        (context as any).__modelFallback = { requested: model, fallback: fallback.name };
      }

      const dynamicMaxTokens = modelDetails ? getCompletionTokenLimit(modelDetails) : Math.min(MAX_TOKENS, 16384);

      // Validate token limits before making API request
      const validation = validateTokenLimits(modelDetails, dynamicMaxTokens);

      if (!validation.valid) {
        throw new Response(validation.error, {
          status: 400,
          statusText: 'Token Limit Exceeded',
        });
      }

      // Defensive: if the incoming message is massive (client may have serialized entire conversation into a single message),
      // truncate it to fit the model's context window (model max allowed - reserved completion tokens - safety margin)
      function estimateTokens(text: string) {
        return Math.ceil(text.length / 4);
      }

      const modelContextLimit = modelDetails.maxTokenAllowed || 128000;
      const reservedForCompletion = dynamicMaxTokens;
      const safetyMargin = 64;
      const allowedInputTokens = Math.max(0, modelContextLimit - reservedForCompletion - safetyMargin);

      if (typeof messageContent === 'string') {
        const messageTokens = estimateTokens(messageContent);
        if (messageTokens > allowedInputTokens) {
          const allowedChars = Math.max(100, Math.floor(allowedInputTokens * 4));
          const trimmed = messageContent.slice(-allowedChars);
          // Replace user message with a trimmed version and include a notice
          messageContent = `...[TRUNCATED: earlier content removed to fit model context]...\n\n${trimmed}`;
          logger.warn(`Input message truncated from ${messageTokens} tokens to fit allowedInputTokens=${allowedInputTokens}`);
        }
      }

      const providerInfo = PROVIDER_LIST.find((p) => p.name === provider.name);

      if (!providerInfo) {
        throw new Error('Provider not found');
      }

      logger.info(`Generating response Provider: ${provider.name}, Model: ${modelDetails.name}`);

      // DEBUG: Log reasoning model detection
      const isReasoning = isReasoningModel(modelDetails.name);
      logger.info(`DEBUG: Model "${modelDetails.name}" detected as reasoning model: ${isReasoning}`);

      // Use maxCompletionTokens for reasoning models (o1, GPT-5), maxTokens for traditional models
      const tokenParams = isReasoning ? { maxCompletionTokens: dynamicMaxTokens } : { maxTokens: dynamicMaxTokens };

      // Filter out unsupported parameters for reasoning models
      const baseParams = {
        system,
        messages: [
          {
            role: 'user' as const,
            content: `${messageContent}`,
          },
        ],
        model: providerInfo.getModelInstance({
          model: modelDetails.name,
          serverEnv: context.cloudflare?.env as any,
          apiKeys,
          providerSettings,
        }),
        ...tokenParams,
        toolChoice: 'none' as const,
      };

      // For reasoning models, set temperature to 1 (required by OpenAI API)
      const finalParams = isReasoning
        ? { ...baseParams, temperature: 1 } // Set to 1 for reasoning models (only supported value)
        : { ...baseParams, temperature: 0 };

      // DEBUG: Log final parameters
      logger.info(
        `DEBUG: Final params for model "${modelDetails.name}":`,
        JSON.stringify(
          {
            isReasoning,
            hasTemperature: 'temperature' in finalParams,
            hasMaxTokens: 'maxTokens' in finalParams,
            hasMaxCompletionTokens: 'maxCompletionTokens' in finalParams,
            paramKeys: Object.keys(finalParams).filter((key) => !['model', 'messages', 'system'].includes(key)),
            tokenParams,
            finalParams: Object.fromEntries(
              Object.entries(finalParams).filter(([key]) => !['model', 'messages', 'system'].includes(key)),
            ),
          },
          null,
          2,
        ),
      );

      const result = await generateText(finalParams);
      logger.info(`Generated response`);

      // If we recorded a model fallback earlier, expose it via a header for easier debugging
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if ((context as any).__modelFallback) {
        headers['X-Model-Fallback'] = JSON.stringify((context as any).__modelFallback);
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers,
      });
    } catch (error: unknown) {
      console.log(error);

      const errorResponse = {
        error: true,
        message: error instanceof Error ? error.message : 'An unexpected error occurred',
        statusCode: (error as any).statusCode || 500,
        isRetryable: (error as any).isRetryable !== false,
        provider: (error as any).provider || 'unknown',
      };

      if (error instanceof Error && error.message?.includes('API key')) {
        return new Response(
          JSON.stringify({
            ...errorResponse,
            message: 'Invalid or missing API key',
            statusCode: 401,
            isRetryable: false,
          }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
            statusText: 'Unauthorized',
          },
        );
      }

      // Handle token limit errors with helpful messages
      if (
        error instanceof Error &&
        (error.message?.includes('max_tokens') ||
          error.message?.includes('token') ||
          error.message?.includes('exceeds') ||
          error.message?.includes('maximum') ||
          error.message?.toLowerCase().includes('conversation is too long') ||
          error.message?.toLowerCase().includes('conversation too long'))
      ) {
        return new Response(
          JSON.stringify({
            ...errorResponse,
            message: `Token limit error: ${error.message}. Try reducing your request size, starting a new conversation, or using a model with a larger context window.`,
            statusCode: 400,
            isRetryable: false,
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
            statusText: 'Token Limit Exceeded',
          },
        );
      }

      return new Response(JSON.stringify(errorResponse), {
        status: errorResponse.statusCode,
        headers: { 'Content-Type': 'application/json' },
        statusText: 'Error',
      });
    }
  }
}
