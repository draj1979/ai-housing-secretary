/**
 * gateway/index.ts
 *
 * OpenClaw Gateway composition root (HLD Sec 7.1): wires up
 *   - **Session management** — gateway/session.ts, Redis-backed, keyed by
 *     phone_e164, idle-timeout + resume-on-next-message.
 *   - **Tool execution** — gateway/toolRegistry.ts, registering
 *     whatsappTool, knowledgeSearchTool, complaintTool, suggestionTool,
 *     broadcastTool, escalationTool.
 *   - **Memory management** — memory/conversationStore.ts and
 *     memory/vectorStore.ts.
 *   - **Agent orchestration** — gateway/orchestrator.ts, the HLD Sec 8
 *     Agent Workflow (Intent Detection -> Tool Selection -> Knowledge
 *     Search -> Gemini -> Response), split by which of the two WhatsApp
 *     numbers (HLD Sec 4) an event arrived on, with agent/guardrails.ts's
 *     forbidden-action blocking and agent/escalation.ts's mandatory
 *     escalation triggers (HLD Sec 16) enforced before either the FAQ path
 *     or any tool call runs.
 *
 * `createOpenClawGateway()` is the single construction path both this
 * file's HTTP server (the webhook receiver) and gateway/inboundWorker.ts
 * (the queue consumer that actually runs the orchestrator — see its doc
 * comment for why processing happens there, not inline in the HTTP
 * request) build from, so there is exactly one place session/tool/memory
 * wiring is defined.
 *
 * Run via `pnpm dev` (tsx watch) or, in production, `node dist/gateway/index.js`
 * after `pnpm build`. The queue consumer is a separate process — see
 * gateway/inboundWorker.ts / `pnpm worker`.
 */
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { loadEnv, loadEnvAsync, type Env } from '../config/env.js';
import { registerWebhookRoutes, createWebhookDepsFromEnv } from './webhook.js';
import { registerHealthRoutes } from './health.js';
import { createRedisSessionStore, type SessionStore } from './session.js';
import { createToolRegistry, type ToolRegistry } from './toolRegistry.js';
import { createOrchestrator, type Orchestrator } from './orchestrator.js';
import { createConversationStore, type ConversationStore } from '../memory/conversationStore.js';
import { getPostgresPool } from '../memory/postgresAdapter.js';
import { Redis } from 'ioredis';
import { createVectorStore, type VectorStore } from '../memory/vectorStore.js';
import {
  createWhatsAppTool,
  whatsappToolConfigFromEnv,
  type WhatsAppTool,
} from '../tools/whatsappTool.js';
import { createKnowledgeSearchTool } from '../tools/knowledgeSearchTool.js';
import { createComplaintTool } from '../tools/complaintTool.js';
import { createSuggestionTool } from '../tools/suggestionTool.js';
import { createBroadcastTool } from '../tools/broadcastTool.js';
import { createEscalationTool } from '../tools/escalationTool.js';
import { createResidentsTool } from '../tools/residentsTool.js';
import {
  createFieldEncryption,
  fieldEncryptionConfigFromEnv,
} from '../security/fieldEncryption.js';
import {
  createSuggestionClassifier,
  suggestionClassifierConfigFromEnv,
} from '../modules/suggestions.js';
import {
  createBroadcastModule,
  createLanguageImprover,
  languageImproverConfigFromEnv,
  type BroadcastModule,
} from '../modules/broadcast.js';
import { createBroadcastScheduler } from './broadcastQueue.js';
import { createEscalationModule } from '../modules/escalation.js';
import { adminAuthConfigFromEnv } from './adminAuth.js';
import { registerAdminRoutes } from './adminRoutes.js';
import {
  createGeminiResponder,
  geminiResponderConfigFromEnv,
  type GeminiResponder,
} from '../agent/gemini.js';
import { createAuditLogWriter, type AuditLogWriter } from '../agent/guardrails.js';

export interface OpenClawGateway {
  env: Env;
  sessionStore: SessionStore;
  conversationStore: ConversationStore;
  vectorStore: VectorStore;
  toolRegistry: ToolRegistry;
  geminiResponder: GeminiResponder;
  auditLog: AuditLogWriter;
  /** Used by gateway/broadcastWorker.ts to run a scheduled announcement's send when its delayed job fires. */
  broadcastModule: BroadcastModule;
  orchestrator: Orchestrator;
}

/**
 * Builds the full OpenClaw Gateway (session store, memory layer, tool
 * registry, agent orchestrator) from env. Called once per process — both
 * the HTTP server below and gateway/inboundWorker.ts each build their own
 * instance (separate processes, separate Redis/Postgres connections by
 * design — see memory/postgresAdapter.ts and gateway/session.ts, both of
 * which lazily open one connection per process).
 */
export function createOpenClawGateway(env: Env = loadEnv()): OpenClawGateway {
  const whatsapp = createWhatsAppTool(whatsappToolConfigFromEnv(env));
  const conversationStore = createConversationStore();
  const vectorStore = createVectorStore(env);
  const sessionStore = createRedisSessionStore(env);
  // HLD Sec 15: residents.phone_e164/emergency_contact are field-level
  // encrypted at rest — every tool below that touches resident PII goes
  // through this one instance rather than querying those columns itself.
  const residentsTool = createResidentsTool({
    fieldEncryption: createFieldEncryption(fieldEncryptionConfigFromEnv(env)),
  });

  const toolRegistry = createToolRegistry({
    whatsapp,
    knowledgeSearch: createKnowledgeSearchTool(vectorStore),
    complaint: createComplaintTool(),
    suggestion: createSuggestionTool(),
    broadcast: createBroadcastTool({ whatsapp, residentsTool }),
    escalation: createEscalationTool({
      whatsapp,
      residentsTool,
      ...(env.WHATSAPP_SECRETARY_NUMBER ? { secretaryNumber: env.WHATSAPP_SECRETARY_NUMBER } : {}),
    }),
  });

  const geminiResponder = createGeminiResponder(geminiResponderConfigFromEnv(env));
  const auditLog = createAuditLogWriter({ residentsTool });
  const suggestionClassifier = createSuggestionClassifier(suggestionClassifierConfigFromEnv(env));
  const languageImprover = createLanguageImprover(languageImproverConfigFromEnv(env));
  const broadcastScheduler = createBroadcastScheduler(env);
  const broadcastModule = createBroadcastModule({
    languageImprover,
    broadcastTool: toolRegistry.broadcast,
    whatsapp,
    auditLog,
    scheduler: broadcastScheduler,
  });

  const orchestrator = createOrchestrator({
    toolRegistry,
    conversationStore,
    sessionStore,
    geminiResponder,
    auditLog,
    suggestionClassifier,
    languageImprover,
    broadcastScheduler,
    ...(env.WHATSAPP_SECRETARY_NUMBER ? { secretaryNumber: env.WHATSAPP_SECRETARY_NUMBER } : {}),
  });

  return {
    env,
    sessionStore,
    conversationStore,
    vectorStore,
    toolRegistry,
    geminiResponder,
    auditLog,
    broadcastModule,
    orchestrator,
  };
}

/**
 * HTTP server bootstrap — the webhook receiver, plus admin endpoints when
 * configured. Deliberately does *not* call `createOpenClawGateway()` for
 * the webhook path: the full gateway needs WHATSAPP_CLOUD_API_TOKEN/
 * PHONE_NUMBER_ID and GEMINI_API_KEY (it can send messages and call
 * Gemini), but the webhook receiver only needs WHATSAPP_VERIFY_TOKEN/
 * APP_SECRET and Redis to receive and queue events — requiring the rest
 * here would make it fail to start on credentials it doesn't use.
 * gateway/inboundWorker.ts, which does the real work, builds the full
 * gateway.
 *
 * Admin routes (gateway/adminRoutes.ts, HLD Sec 15) are the one exception:
 * they *do* need Postgres (to read/act on escalations) and are registered
 * only when `JWT_SECRET` is set — a deployment that doesn't want this
 * surface at all simply omits it and `/admin/*` doesn't exist.
 */
export async function createGateway() {
  const env = await loadEnvAsync();
  // Fastify's built-in logger is pino (config/logger.ts's createLogger wraps
  // the same library) — reusing it here rather than injecting a separate
  // instance avoids a generic-logger-type mismatch against FastifyInstance.
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  // A dedicated, lazy ioredis connection purely for the readiness probe —
  // separate from gateway/queue.ts's BullMQ producer connection, so a
  // health check never contends with (or is skewed by) actual enqueue
  // traffic.
  const healthRedis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  registerHealthRoutes(app, {
    checkRedis: async () => (await healthRedis.ping()) === 'PONG',
    // Only checked when this process actually touches Postgres (admin
    // routes mounted below) — see this function's doc comment for why the
    // webhook receiver otherwise has no DB dependency to report on.
    ...(env.JWT_SECRET
      ? {
          checkPostgres: async () =>
            getPostgresPool()
              .query('SELECT 1')
              .then(() => true),
        }
      : {}),
  });

  registerWebhookRoutes(app, createWebhookDepsFromEnv(env));

  if (env.JWT_SECRET) {
    // Admin routes only ever call escalationTool.listOpenEscalations /
    // acknowledgeEscalation (never createEscalation), so they never send a
    // WhatsApp message — this stub means mounting /admin/* doesn't also
    // require real WHATSAPP_CLOUD_API_TOKEN/PHONE_NUMBER_ID credentials,
    // keeping this receiver's minimal-credential property (see this
    // function's doc comment) even with JWT_SECRET set.
    const unusedWhatsapp: WhatsAppTool = {
      receiveMessage: () => [],
      sendMessage: () => Promise.reject(new Error('Admin routes never send WhatsApp messages.')),
      replyMessage: () => Promise.reject(new Error('Admin routes never send WhatsApp messages.')),
      broadcastMessage: () =>
        Promise.reject(new Error('Admin routes never send WhatsApp messages.')),
      uploadImage: () => Promise.reject(new Error('Admin routes never upload media.')),
      uploadPDF: () => Promise.reject(new Error('Admin routes never upload media.')),
      downloadMedia: () => Promise.reject(new Error('Admin routes never download media.')),
    };
    const escalationModule = createEscalationModule({
      escalationTool: createEscalationTool({ whatsapp: unusedWhatsapp }),
      auditLog: createAuditLogWriter(),
    });
    registerAdminRoutes(app, {
      authConfig: adminAuthConfigFromEnv(env),
      escalationModule,
    });
  }

  return { app, env };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { app, env } = await createGateway();

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info({ port: env.PORT }, 'OpenClaw Gateway listening.');
  } catch (err) {
    app.log.error({ err }, 'Failed to start OpenClaw Gateway.');
    process.exit(1);
  }

  const shutdown = async () => {
    app.log.info('Shutting down OpenClaw Gateway...');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
