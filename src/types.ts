export type ExecutionMode = "automatic" | "manual";
export type ToolPolicy = "automatic" | "manual" | "disabled";

export interface ToolPolicies {
  read: ToolPolicy;
  network: ToolPolicy;
  write: ToolPolicy;
  sync: ToolPolicy;
}

export interface IntegrationSettings {
  tasks: boolean;
  homepage: boolean;
  bases: boolean;
  dailyNotes: boolean;
  adaptivePractice: boolean;
  remotelySave: boolean;
  smartEnvironmentExperimental: boolean;
  canvas: boolean;
}

export type MemoryInterceptMode = "background" | "blocking";

export interface CustomCommand {
  id: string;
  name: string;
  prompt: string;
}

export interface VaultPilotSettings {
  apiKey: string;
  apiKeySecretId: string;
  model: string;
  embeddingModel: string;
  temperature: number;
  maxOutputTokens: number;
  maxAgentSteps: number;
  executionMode: ExecutionMode;
  toolPolicies: ToolPolicies;
  systemPrompt: string;
  showStatusBarCost: boolean;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  imageUploadsEnabled: boolean;
  maxImagesPerMessage: number;
  maxImageSizeMb: number;
  maxImageRequestMb: number;
  autoIndexOnStartup: boolean;
  indexOnFileChange: boolean;
  embeddingDimensions: number;
  chunkSize: number;
  chunkOverlap: number;
  maxChunksPerFile: number;
  embeddingBatchSize: number;
  searchCacheSize: number;
  mobileIndexingEnabled: boolean;
  semanticWeight: number;
  lexicalWeight: number;
  graphWeight: number;
  searchResultLimit: number;
  memoryEnabled: boolean;
  memoryFolder: string;
  memoryInterceptEnabled: boolean;
  memoryInterceptMode: MemoryInterceptMode;
  memoryThreshold: number;
  memoryModel: string;
  conversationHistoryLimit: number;
  conversationsFolder: string;
  dashboardPath: string;
  integrations: IntegrationSettings;
  showSourceDetails: boolean;
  screenReaderAnnouncements: boolean;
  voiceInputEnabled: boolean;
  readAloudEnabled: boolean;
  reduceMotion: boolean;
  highContrast: boolean;
  largeTouchTargets: boolean;
  interfaceScale: number;
  customCommands: CustomCommand[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export type ChatRole = "user" | "assistant";

export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/heic" | "image/heif";

export interface ChatImageAttachment {
  id: string;
  name: string;
  mimeType: SupportedImageMimeType;
  size: number;
}

export interface ImageAttachmentInput extends ChatImageAttachment {
  data: ArrayBuffer;
}

export interface StoredImageAttachment extends ChatImageAttachment {
  data: ArrayBuffer;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  attachments?: ChatImageAttachment[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  usage: TokenUsage;
}

export interface PersistedData {
  settings: VaultPilotSettings;
  sessions: ChatSession[];
  activeSessionId: string;
  vaultId: string;
  toolAudit?: ToolAuditEntry[];
}

export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiFunctionResponse {
  id?: string;
  name: string;
  response: Record<string, unknown>;
}

export interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
  [key: string]: unknown;
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiTurnResult {
  content: GeminiContent;
  text: string;
  functionCalls: GeminiFunctionCall[];
  usage: TokenUsage;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ToolRisk = "read" | "network" | "write" | "sync";

export interface ToolDefinition {
  declaration: FunctionDeclaration;
  risk: ToolRisk;
  source?: string;
  isAvailable?(): boolean;
  describe(args: Record<string, unknown>): string;
  preview?(args: Record<string, unknown>): Promise<string>;
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ToolApprovalRequest {
  call: GeminiFunctionCall;
  description: string;
  risk: ToolRisk;
  preview?: string;
}

export interface ToolAuditEntry {
  id: string;
  createdAt: number;
  tool: string;
  description: string;
  risk: ToolRisk;
  source: string;
  ok: boolean;
  summary: string;
  undo?: ToolUndoRecord;
}

export interface ToolUndoRecord {
  kind: "restore" | "delete-created";
  path: string;
  content?: string;
  expectedContent?: string;
}

export interface IntegrationStatus {
  id: keyof IntegrationSettings;
  name: string;
  enabled: boolean;
  available: boolean;
  version?: string;
  detail: string;
}

export interface MemoryEntry {
  category: "user_profile" | "core_facts" | "project_contexts" | "preferences";
  key: string;
  content: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  source: string;
}

export interface AgentCallbacks {
  onText(delta: string): void;
  onToolStart(description: string): void;
  onToolEnd(description: string, ok: boolean): void;
  onApproval(request: ToolApprovalRequest): Promise<boolean>;
  onUsage(usage: TokenUsage): void;
  onMemoryStatus?(status: string | null): void;
}

export interface VectorRecord {
  id: string;
  path: string;
  chunkIndex: number;
  text: string;
  embedding: number[] | Float32Array;
  mtime: number;
  contentHash: string;
}

export interface IndexedFileMeta {
  path: string;
  mtime: number;
  size: number;
  contentHash: string;
  chunkCount: number;
}

export interface SearchResult {
  path: string;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  graphScore: number;
  snippet: string;
  chunkIndex: number;
  reasons?: string[];
}

export interface IndexProgress {
  completed: number;
  total: number;
  currentPath?: string;
  error?: string;
}
