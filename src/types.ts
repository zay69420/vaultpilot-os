export type ExecutionMode = "automatic" | "manual";

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
  systemPrompt: string;
  showStatusBarCost: boolean;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  autoIndexOnStartup: boolean;
  indexOnFileChange: boolean;
  embeddingDimensions: number;
  chunkSize: number;
  chunkOverlap: number;
  maxChunksPerFile: number;
  semanticWeight: number;
  lexicalWeight: number;
  graphWeight: number;
  searchResultLimit: number;
  memoryEnabled: boolean;
  memoryFolder: string;
  memoryInterceptEnabled: boolean;
  memoryThreshold: number;
  memoryModel: string;
  conversationHistoryLimit: number;
  conversationsFolder: string;
  customCommands: CustomCommand[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
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

export type ToolRisk = "read" | "network" | "write";

export interface ToolDefinition {
  declaration: FunctionDeclaration;
  risk: ToolRisk;
  describe(args: Record<string, unknown>): string;
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ToolApprovalRequest {
  call: GeminiFunctionCall;
  description: string;
  risk: ToolRisk;
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
  embedding: number[];
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
}

export interface IndexProgress {
  completed: number;
  total: number;
  currentPath?: string;
  error?: string;
}
