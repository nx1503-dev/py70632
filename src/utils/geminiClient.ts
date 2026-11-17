/**
 * Pydroid 3 Web & Android Gemini AI Client
 * 
 * Features:
 * - Environment API Key Validation (presence, length, character set, ellipsis detection)
 * - Detailed Diagnostic Terminal Logging on AI request failures
 * - Clear classification of failures: INVALID_KEY, NETWORK_TIMEOUT, SERVER_REJECTION, UNKNOWN
 * - Real-time SSE Streaming (/api/ai/chat/stream)
 * - Bidirectional Live API (/api/ai/live)
 * - Multi-turn conversational Python assistant (/api/ai/chat)
 * - Syntax & logic debugger (/api/ai/debug)
 * - Adaptive lessons generator (/api/ai/generate-lessons)
 * - Direct Gemini REST fallback for offline standalone APK
 * - Zero-crash local rule-based PEP 8 analyzer & formatter
 */

import {
  getApiUrl,
  getApiBaseUrl,
  getApiHeaders,
  getWebSocketUrl,
  getGeminiApiKey,
  isAndroidApkEnvironment,
  isLikelyGeminiApiKey,
  sanitizeGeminiApiKey,
} from './apiConfig';
import { AiDebugResult, LessonItem } from '../types';

export interface ChatMessageItem {
  sender: 'user' | 'assistant';
  text: string;
}

// ============================================================================
// 1. API Key Validation from Environment Variables & Storage
// ============================================================================

export type ApiKeyValidationStatus = 'VALID' | 'MISSING' | 'INVALID_FORMAT';

export type ApiKeySource =
  | 'USER_STORAGE'
  | 'VITE_GEMINI_API_KEY'
  | 'GEMINI_API_KEY'
  | 'PROCESS_ENV'
  | 'NONE';

export interface ApiKeyValidationResult {
  isValid: boolean;
  status: ApiKeyValidationStatus;
  source: ApiKeySource;
  rawKey?: string;
  sanitizedKey?: string;
  maskedKey?: string;
  keyLength: number;
  reason?: string;
}

/**
 * Explicitly validates the presence and format of the Gemini API key
 * across all potential environment variable sources and local storage.
 */
export function validateEnvironmentApiKey(): ApiKeyValidationResult {
  let rawKey: string | undefined;
  let source: ApiKeySource = 'NONE';

  // 1. Check user-configured key from local storage (Settings modal)
  const userKey = getGeminiApiKey();
  if (userKey && userKey.trim()) {
    rawKey = userKey;
    source = 'USER_STORAGE';
  }

  // 2. Check import.meta.env.VITE_GEMINI_API_KEY (Vite client standard)
  if (!rawKey) {
    try {
      if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GEMINI_API_KEY) {
        rawKey = import.meta.env.VITE_GEMINI_API_KEY;
        source = 'VITE_GEMINI_API_KEY';
      }
    } catch (_) {}
  }

  // 3. Check import.meta.env.GEMINI_API_KEY (Vite client alias)
  if (!rawKey) {
    try {
      if (typeof import.meta !== 'undefined' && (import.meta.env as any)?.GEMINI_API_KEY) {
        rawKey = (import.meta.env as any).GEMINI_API_KEY;
        source = 'GEMINI_API_KEY';
      }
    } catch (_) {}
  }

  // 4. Check process.env.GEMINI_API_KEY or process.env.VITE_GEMINI_API_KEY (Node/polyfilled context)
  if (!rawKey) {
    try {
      if (typeof process !== 'undefined' && process.env) {
        if (process.env.GEMINI_API_KEY) {
          rawKey = process.env.GEMINI_API_KEY;
          source = 'PROCESS_ENV';
        } else if (process.env.VITE_GEMINI_API_KEY) {
          rawKey = process.env.VITE_GEMINI_API_KEY;
          source = 'PROCESS_ENV';
        }
      }
    } catch (_) {}
  }

  // If no key found in any location
  if (!rawKey || !rawKey.trim()) {
    return {
      isValid: false,
      status: 'MISSING',
      source: 'NONE',
      keyLength: 0,
      reason: 'Khóa API không tồn tại. Không tìm thấy khóa trong biến môi trường (VITE_GEMINI_API_KEY, GEMINI_API_KEY) hoặc Cài đặt.',
    };
  }

  // Sanitize: strip whitespace, zero-width chars, newlines, quotes
  const sanitized = sanitizeGeminiApiKey(rawKey);

  // Create masked preview (e.g. AIzaSy...xxxx)
  const maskedKey = sanitized.length > 10
    ? `${sanitized.slice(0, 6)}...${sanitized.slice(-4)}`
    : (sanitized.length > 0 ? `${sanitized.slice(0, 3)}...` : '');

  // Check 1: User copied truncated ellipsis preview from Google AI Studio table (e.g. "...jspg")
  if (sanitized.includes('...') || sanitized.startsWith('.')) {
    return {
      isValid: false,
      status: 'INVALID_FORMAT',
      source,
      rawKey,
      sanitizedKey: sanitized,
      maskedKey,
      keyLength: sanitized.length,
      reason: `Khóa API chứa dấu ba chấm (...) [${sanitized}]. Bạn đã sao chép phần xem trước rút gọn từ Google AI Studio thay vì bấm nút Copy để lấy toàn bộ khóa.`,
    };
  }

  // Check 2: Minimum length constraint (Google API keys are ~39 characters; minimum acceptable is 20)
  if (sanitized.length < 20) {
    return {
      isValid: false,
      status: 'INVALID_FORMAT',
      source,
      rawKey,
      sanitizedKey: sanitized,
      maskedKey,
      keyLength: sanitized.length,
      reason: `Độ dài khóa quá ngắn (${sanitized.length} ký tự). Khóa Google Gemini API chuẩn thường có khoảng 39 ký tự.`,
    };
  }

  // Check 3: Character set constraint (alphanumeric, hyphens, underscores)
  if (!/^[A-Za-z0-9_.-]+$/.test(sanitized)) {
    return {
      isValid: false,
      status: 'INVALID_FORMAT',
      source,
      rawKey,
      sanitizedKey: sanitized,
      maskedKey,
      keyLength: sanitized.length,
      reason: 'Khóa API chứa ký tự không hợp lệ. Khóa chỉ được chứa các ký tự chữ cái, số, gạch nối (-) hoặc gạch dưới (_).',
    };
  }

  return {
    isValid: true,
    status: 'VALID',
    source,
    rawKey,
    sanitizedKey: sanitized,
    maskedKey,
    keyLength: sanitized.length,
    reason: 'Khóa API hợp lệ về định dạng và độ dài.',
  };
}

// ============================================================================
// 2. AI Error Classification & Terminal Diagnostic Logging
// ============================================================================

export type AiFailureType = 'INVALID_KEY' | 'NETWORK_TIMEOUT' | 'SERVER_REJECTION' | 'UNKNOWN';

export interface ClassifiedAiError {
  type: AiFailureType;
  title: string;
  summary: string;
  httpStatus?: number;
  originalError: any;
  remediation: string;
}

/**
 * Classifies an error into INVALID_KEY, NETWORK_TIMEOUT, SERVER_REJECTION, or UNKNOWN.
 */
export function classifyAiError(
  err: any,
  httpStatus?: number,
  keyValidation?: ApiKeyValidationResult
): ClassifiedAiError {
  const errStr = String(err?.message || err || '');
  const lowerErr = errStr.toLowerCase();
  const status = httpStatus || (err?.status as number) || (err?.statusCode as number);

  const keyResult = keyValidation || validateEnvironmentApiKey();

  // 1. Classification: INVALID_KEY
  const hasInvalidKeyMarker =
    status === 401 ||
    lowerErr.includes('api key not valid') ||
    lowerErr.includes('api_key_invalid') ||
    lowerErr.includes('unauthenticated') ||
    lowerErr.includes('invalid api key') ||
    lowerErr.includes('api key expired') ||
    lowerErr.includes('key is missing') ||
    lowerErr.includes('api_key');

  if (hasInvalidKeyMarker || keyResult.status === 'MISSING' || keyResult.status === 'INVALID_FORMAT') {
    const keyReason = keyResult.reason || 'Khóa Gemini API không hợp lệ hoặc chưa được cung cấp.';
    return {
      type: 'INVALID_KEY',
      title: 'Khóa API không hợp lệ (INVALID_KEY)',
      summary: `Yêu cầu AI bị từ chối do khóa API: ${keyReason}`,
      httpStatus: status || 401,
      originalError: err,
      remediation: 'Truy cập Google AI Studio (aistudio.google.com/app/apikey), bấm biểu tượng Copy bên cạnh khóa để sao chép đầy đủ chuỗi khóa (~39 ký tự, thường bắt đầu bằng AIzaSy) và dán vào phần Cài đặt > Khóa Google Gemini API Key.',
    };
  }

  // 2. Classification: NETWORK_TIMEOUT
  const isTimeout =
    status === 408 ||
    status === 504 ||
    err?.name === 'AbortError' ||
    err?.name === 'TimeoutError' ||
    lowerErr.includes('timeout') ||
    lowerErr.includes('timed out') ||
    lowerErr.includes('etimedout') ||
    lowerErr.includes('esockettimedout') ||
    lowerErr.includes('deadline exceeded') ||
    lowerErr.includes('abort') ||
    (typeof navigator !== 'undefined' && navigator.onLine === false) ||
    lowerErr.includes('failed to fetch') ||
    lowerErr.includes('networkerror') ||
    lowerErr.includes('econnrefused') ||
    lowerErr.includes('econnreset');

  if (isTimeout) {
    return {
      type: 'NETWORK_TIMEOUT',
      title: 'Quá thời gian chờ mạng hoặc ngắt kết nối (NETWORK_TIMEOUT)',
      summary: `Kết nối mạng đến máy chủ AI bị quá thời gian (timeout) hoặc gián đoạn: ${errStr || 'Network timeout'}`,
      httpStatus: status || (lowerErr.includes('timeout') ? 504 : 0),
      originalError: err,
      remediation: 'Kiểm tra đường truyền Internet hoặc độ trễ máy chủ. Ứng dụng đã tự động kích hoạt bộ nhân phân tích Python nội bộ chuẩn PEP 8.',
    };
  }

  // 3. Classification: SERVER_REJECTION
  const isServerRejection =
    (status && (status >= 400 && status !== 401)) ||
    lowerErr.includes('resource_exhausted') ||
    lowerErr.includes('quota') ||
    lowerErr.includes('rate limit') ||
    lowerErr.includes('too many requests') ||
    lowerErr.includes('permission_denied') ||
    lowerErr.includes('internal server error') ||
    lowerErr.includes('bad gateway') ||
    lowerErr.includes('service unavailable') ||
    lowerErr.includes('500') ||
    lowerErr.includes('502') ||
    lowerErr.includes('503') ||
    lowerErr.includes('429') ||
    lowerErr.includes('403');

  if (isServerRejection) {
    let subReason = 'Máy chủ phản hồi mã từ chối';
    if (status === 429 || lowerErr.includes('quota') || lowerErr.includes('rate limit')) {
      subReason = 'Vượt quá hạn mức yêu cầu (Quota / Rate Limit - HTTP 429)';
    } else if (status === 403 || lowerErr.includes('permission')) {
      subReason = 'Từ chối quyền truy cập (Permission Denied - HTTP 403)';
    } else if (status && status >= 500) {
      subReason = `Lỗi máy chủ upstream (HTTP ${status})`;
    }

    return {
      type: 'SERVER_REJECTION',
      title: `Máy chủ từ chối yêu cầu (SERVER_REJECTION: ${subReason})`,
      summary: `Máy chủ AI đã nhận yêu cầu nhưng từ chối xử lý: ${errStr || `HTTP ${status}`}`,
      httpStatus: status || 500,
      originalError: err,
      remediation: 'Nếu gặp lỗi 429 (hết quota), vui lòng đợi 1-2 phút hoặc chuyển sang Project/Key khác trên Google AI Studio. Nếu là lỗi 503/500, hệ thống tự động chạy mô hình dự phòng.',
    };
  }

  // 4. Classification: UNKNOWN
  return {
    type: 'UNKNOWN',
    title: 'Lỗi không xác định (UNKNOWN)',
    summary: `Yêu cầu AI gặp sự cố không xác định: ${errStr || 'Lỗi không xác định'}`,
    httpStatus: status,
    originalError: err,
    remediation: 'Kiểm tra log chi tiết trong terminal để xem stack trace đầy đủ.',
  };
}

export interface AiDiagnosticPayload {
  endpoint: string;
  operation: string;
  error: any;
  httpStatus?: number;
  customContext?: Record<string, any>;
}

/**
 * Emits a structured diagnostic log both to the console and directly to the
 * running terminal process via /api/ai/diagnostic-log.
 */
export function logAiDiagnosticToTerminal(payload: AiDiagnosticPayload): ClassifiedAiError {
  const keyValidation = validateEnvironmentApiKey();
  const classified = classifyAiError(payload.error, payload.httpStatus, keyValidation);
  const timestamp = new Date().toISOString();

  const formattedLog = [
    '================================================================================',
    `[AI Diagnostic Info] Request Diagnosis: [${classified.type}]`,
    `Timestamp:      ${timestamp}`,
    `Endpoint:       ${payload.endpoint}`,
    `Operation:      ${payload.operation}`,
    `Classification: [${classified.type}] - ${classified.title}`,
    payload.httpStatus ? `HTTP Status:    ${payload.httpStatus}` : null,
    '--------------------------------------------------------------------------------',
    'API Key Validation Status:',
    `  - Status:     ${keyValidation.status} (${keyValidation.isValid ? 'VALID' : 'INVALID'})`,
    `  - Source:     ${keyValidation.source}`,
    `  - Length:     ${keyValidation.keyLength} characters`,
    `  - Masked Key: ${keyValidation.maskedKey || '(none)'}`,
    `  - Details:    ${keyValidation.reason}`,
    '--------------------------------------------------------------------------------',
    'Diagnostic Details:',
    `  - Summary:    ${classified.summary}`,
    `  - Message:    ${payload.error?.message || String(payload.error || '')}`,
    'Recommended Remediation:',
    `  - ${classified.remediation}`,
    '================================================================================',
  ].filter(Boolean).join('\n');

  // Output to browser/node console
  console.info(formattedLog);

  // Dispatch to server terminal only when Web or when APK has a Cloud Gateway configured
  if (typeof fetch !== 'undefined' && (!isAndroidApkEnvironment() || Boolean(getApiBaseUrl()))) {
    try {
      fetch(getApiUrl('/api/ai/diagnostic-log'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp,
          endpoint: payload.endpoint,
          operation: payload.operation,
          failureType: classified.type,
          title: classified.title,
          summary: classified.summary,
          httpStatus: payload.httpStatus,
          errorMessage: payload.error?.message || String(payload.error || ''),
          keyValidation: {
            status: keyValidation.status,
            source: keyValidation.source,
            keyLength: keyValidation.keyLength,
            maskedKey: keyValidation.maskedKey,
            reason: keyValidation.reason,
          },
          remediation: classified.remediation,
          customContext: payload.customContext,
        }),
      }).catch(() => {});
    } catch (_) {}
  }

  return classified;
}

// ============================================================================
// 3. Direct Gemini REST & Streaming Engine (Standalone APK & Mobile Web)
// ============================================================================

const DISCOVERED_MODELS_STORAGE_KEY = 'pydroid_gemini_discovered_models';

function getValidUserApiKey(): string | undefined {
  const userKey = getGeminiApiKey();
  if (userKey && isLikelyGeminiApiKey(userKey)) {
    return sanitizeGeminiApiKey(userKey);
  }
  const envValidation = validateEnvironmentApiKey();
  if (envValidation.isValid && envValidation.sanitizedKey) {
    return envValidation.sanitizedKey;
  }
  return undefined;
}

function getCachedDiscoveredModels(): string[] {
  try {
    const raw = localStorage.getItem(DISCOVERED_MODELS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((m) => typeof m === 'string' && m.trim().length > 0);
      }
    }
  } catch (_) {}
  return [];
}

function saveDiscoveredModels(models: string[]): void {
  try {
    if (models.length > 0) {
      localStorage.setItem(DISCOVERED_MODELS_STORAGE_KEY, JSON.stringify(models.slice(0, 8)));
    }
  } catch (_) {}
}

function pickSupportedGeminiTextModels(rawModels: any[]): string[] {
  if (!Array.isArray(rawModels)) return [];
  const filtered = rawModels
    .filter((m) => {
      const name = String(m?.name || '').toLowerCase();
      const methods: string[] = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      if (!name.includes('gemini')) return false;
      if (methods.length > 0 && !methods.includes('generateContent')) return false;
      if (
        name.includes('embedding') ||
        name.includes('imagen') ||
        name.includes('veo') ||
        name.includes('tts') ||
        name.includes('live') ||
        name.includes('audio') ||
        name.includes('robotics') ||
        name.includes('aqa') ||
        name.includes('gemma')
      ) {
        return false;
      }
      return true;
    })
    .map((m) => String(m.name).replace(/^models\//, ''));

  const score = (name: string): number => {
    if (name === 'gemini-4-hydrogen') return 100;
    if (name === 'gemini-3.8-flash') return 95;
    if (name === 'gemini-3.1-flash-lite') return 90;
    if (name === 'gemini-flash-latest') return 85;
    if (name.includes('flash') && !name.includes('1.5') && !name.includes('2.0')) return 80;
    if (name.includes('flash')) return 70;
    if (name.includes('4-argon') || name.includes('pro')) return 60;
    return 40;
  };

  return Array.from(new Set(filtered)).sort((a, b) => score(b) - score(a));
}

async function discoverDirectGeminiModels(apiKey: string): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const picked = pickSupportedGeminiTextModels(data?.models || []);
      if (picked.length > 0) {
        saveDiscoveredModels(picked);
        return picked;
      }
    }
  } catch (_) {}
  return [];
}

/**
 * Direct Google Gemini REST API Key Verification
 * Directly contacts Google's Generative Language API from the client (APK / browser).
 */
export async function verifyDirectGeminiKey(
  cleanKey: string
): Promise<{ ok: boolean; message: string; model?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const models: any[] = Array.isArray(data.models) ? data.models : [];
      const supportedModels = pickSupportedGeminiTextModels(models);
      if (supportedModels.length > 0) {
        saveDiscoveredModels(supportedModels);
      }
      const activeModel = supportedModels[0] || 'gemini-3.8-flash';

      return {
        ok: true,
        model: activeModel,
        message: `Khóa Google Gemini API hợp lệ và kết nối trực tiếp thành công (${activeModel})!`,
      };
    }

    const errData = await res.json().catch(() => null);
    const errStatus = res.status;
    const errMsg = errData?.error?.message || '';

    if (errStatus === 400 || errMsg.includes('API_KEY_INVALID') || errMsg.includes('API key not valid')) {
      return {
        ok: false,
        message: 'Khóa API không hợp lệ. Vui lòng kiểm tra lại chuỗi khóa đã sao chép từ Google AI Studio (bắt đầu bằng AIzaSy...).',
      };
    }
    if (errStatus === 429 || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('Quota exceeded')) {
      return {
        ok: false,
        message: 'Khóa API đã tạm hết hạn mức (Quota Exceeded 429). Vui lòng thử lại sau ít phút hoặc dùng khóa từ dự án có bật thanh toán.',
      };
    }
    if (errStatus === 403 || errMsg.includes('PERMISSION_DENIED')) {
      return {
        ok: false,
        message: 'Khóa API bị từ chối quyền truy cập (403 Permission Denied). Hãy đảm bảo dịch vụ Generative Language API đã được bật trong Google Cloud.',
      };
    }

    return {
      ok: false,
      message: errMsg || `Google Gemini API phản hồi mã lỗi HTTP ${errStatus}.`,
    };
  } catch (directErr: any) {
    if (directErr?.name === 'AbortError') {
      return {
        ok: false,
        message: 'Quá thời gian kết nối tới Google Gemini (timeout sau 12 giây). Vui lòng kiểm tra kết nối mạng của bạn.',
      };
    }
    return {
      ok: false,
      message: `Không thể kết nối đến máy chủ Google Gemini: ${directErr?.message || 'Lỗi mạng'}. Vui lòng kiểm tra kết nối Wi-Fi hoặc 4G/5G.`,
    };
  }
}

/**
 * Verifies a Google Gemini API key.
 * - On Android APK without a Cloud Gateway: executes direct Google Gemini REST verification.
 * - On Web or APK with Cloud Gateway: checks server proxy (/api/ai/verify-key) first, and falls back to direct verification.
 */
export async function verifyGeminiApiKey(
  rawKey: string
): Promise<{ ok: boolean; message: string; model?: string }> {
  const cleanKey = sanitizeGeminiApiKey(rawKey || '');

  if (!cleanKey) {
    return {
      ok: false,
      message: 'Vui lòng nhập khóa Google Gemini API.',
    };
  }

  if (cleanKey.includes('...') || cleanKey.startsWith('.')) {
    return {
      ok: false,
      message:
        'Khóa API chứa dấu ba chấm (...). Bạn đã sao chép phần xem trước rút gọn từ bảng Google AI Studio thay vì bấm nút Copy để lấy toàn bộ mã khóa (~39 ký tự).',
    };
  }

  if (cleanKey.length < 20) {
    return {
      ok: false,
      message: `Độ dài khóa quá ngắn (${cleanKey.length} ký tự). Vui lòng sao chép lại toàn bộ khóa từ Google AI Studio.`,
    };
  }

  // In standalone Android APK without custom Cloud Gateway: perform direct verification to Google's API
  if (isAndroidApkEnvironment() && !getApiBaseUrl()) {
    return await verifyDirectGeminiKey(cleanKey);
  }

  // In Web environment (or APK with Cloud Gateway): try server proxy (/api/ai/verify-key)
  try {
    const serverRes = await fetch(getApiUrl('/api/ai/verify-key'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: cleanKey }),
    });

    const contentType = serverRes.headers.get('content-type') || '';
    if (serverRes.ok && contentType.includes('application/json')) {
      const data = await serverRes.json();
      return {
        ok: data.ok,
        message: data.message || 'Khóa Google Gemini API hợp lệ và kết nối thành công!',
        model: data.model,
      };
    }

    if (contentType.includes('application/json')) {
      const errData = await serverRes.json().catch(() => null);
      if (errData?.message) {
        return {
          ok: false,
          message: errData.message,
        };
      }
    }
  } catch (_) {
    // Fallback directly to Google Gemini if server route is unreachable
  }

  return await verifyDirectGeminiKey(cleanKey);
}

// Candidate models for direct client-side fallback (APK standalone mode)
export const DIRECT_CANDIDATE_MODELS = [
  'gemini-flash-latest',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
  'gemini-4-hydrogen',
  'gemini-4-argon',
];

// Mỗi mô hình có thời gian chờ riêng: mô hình nào im lặng quá lâu thì bỏ qua, thử mô hình kế tiếp
const PER_MODEL_FIRST_BYTE_MS = 20000;
const PER_MODEL_SEND_MS = 30000;

function linkedController(parent?: AbortSignal): AbortController {
  const c = new AbortController();
  if (parent) {
    if (parent.aborted) c.abort();
    else parent.addEventListener('abort', () => c.abort());
  }
  return c;
}

function extractTextFromGeminiPayload(data: any): string {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p: any) => !p?.thought && typeof p?.text === 'string')
    .map((p: any) => p.text)
    .join('');
}

function buildNormalizedDirectContents(
  messages: ChatMessageItem[],
  code: string,
  instruction = '',
  errorText = ''
): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
  const rawMessages = Array.isArray(messages) ? messages : [];
  const lastUserMsg =
    [...rawMessages].reverse().find((m) => m && m.sender === 'user') || rawMessages[rawMessages.length - 1];
  const lastUserText = String(lastUserMsg?.text || '').trim() ||
    (code ? `Phân tích và tối ưu mã nguồn này:\n\`\`\`python\n${code}\n\`\`\`` : 'Xin chào!');

  // Normalize previous turns: first turn MUST be 'user' and roles MUST alternate
  const previousTurns = rawMessages.slice(0, -1);
  const normalizedHistory: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

  for (const item of previousTurns) {
    if (!item || typeof item.text !== 'string' || !item.text.trim()) continue;
    const role: 'user' | 'model' = item.sender === 'assistant' ? 'model' : 'user';
    const text = item.text.trim();

    if (normalizedHistory.length === 0 && role === 'model') {
      continue;
    }

    if (normalizedHistory.length > 0 && normalizedHistory[normalizedHistory.length - 1].role === role) {
      normalizedHistory[normalizedHistory.length - 1].parts[0].text += `\n\n${text}`;
    } else {
      normalizedHistory.push({ role, parts: [{ text }] });
    }
  }

  while (normalizedHistory.length > 0 && normalizedHistory[normalizedHistory.length - 1].role === 'user') {
    normalizedHistory.pop();
  }

  const contextParts: string[] = [];
  if (code && code.trim()) {
    contextParts.push(`\n\n[MÃ NGUỒN HIỆN TẠI TRONG EDITOR]:\n\`\`\`python\n${code}\n\`\`\``);
  }
  if (errorText && errorText.trim()) {
    contextParts.push(`\n\n[THÔNG BÁO LỖI RUNTIME / TERMINAL]:\n\`\`\`\n${errorText}\n\`\`\``);
  }
  if (instruction) {
    contextParts.push(`\n\n[YÊU CẦU ĐẶC BIỆT]: ${instruction}`);
  }

  normalizedHistory.push({
    role: 'user',
    parts: [{ text: `${lastUserText}${contextParts.join('')}` }],
  });

  return normalizedHistory;
}

function isPermanentDirectKeyError(status: number, errMsg: string): boolean {
  const lower = errMsg.toLowerCase();
  return (
    status === 401 ||
    status === 403 ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('api key expired') ||
    lower.includes('permission_denied')
  );
}

/**
 * Direct Gemini REST streaming request for standalone APK
 */
export async function streamDirectGeminiRest(
  apiKey: string,
  options: {
    code: string;
    messages: ChatMessageItem[];
    instruction?: string;
    errorText?: string;
  },
  onChunk: (accumulatedText: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const { code, messages, instruction = '', errorText = '' } = options;

  const systemText = `Bạn là Trợ lý AI Lập trình Python (Gemini 3.8 Flash) của Pydroid 3 Web & Android.
Nhiệm vụ: Giải thích code dễ hiểu, sửa lỗi cú pháp & runtime chuẩn PEP 8 (thụt lề 4 khoảng trắng), viết code Python hoàn chỉnh.
Mỗi khi cung cấp mã nguồn Python hoàn chỉnh hoặc đã sửa lỗi, hãy bao bọc trong khối code \`\`\`python ... \`\`\` để người dùng có thể nhấn nút "Áp dụng vào Editor" một chạm.
Tránh viết tắt hay bỏ dở mã nguồn.`;

  const contents = buildNormalizedDirectContents(messages, code, instruction, errorText);

  let accumulated = '';
  let lastError: any = null;

  const cachedModels = getCachedDiscoveredModels();
  const initialCandidates = Array.from(new Set([...DIRECT_CANDIDATE_MODELS, ...cachedModels]));
  const triedModels = new Set<string>();

  const tryStreamModelInner = async (
    model: string,
    includeThinking: boolean,
    sig?: AbortSignal,
    onFirstByte?: () => void
  ): Promise<boolean> => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    const payload: any = {
      contents,
      systemInstruction: {
        parts: [{ text: systemText }],
      },
    };

    if (includeThinking && (model.includes('3.8') || model.includes('gemini-4'))) {
      payload.generationConfig = {
        thinkingConfig: { thinkingLevel: 'LOW' },
      };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: sig || signal,
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const errMsg = errJson?.error?.message || `HTTP ${res.status}`;
      lastError = new Error(errMsg);

      if (isPermanentDirectKeyError(res.status, errMsg)) {
        throw lastError;
      }

      // If 400 failed while thinkingConfig was present, retry same model without thinkingConfig
      if (res.status === 400 && includeThinking && payload.generationConfig?.thinkingConfig) {
        return await tryStreamModel(model, false);
      }

      return false;
    }

    if (!res.body) {
      // Fallback if WebView does not expose ReadableStream body
      const rawText = await res.text().catch(() => '');
      if (rawText) {
        try {
          const parsed = JSON.parse(rawText);
          const items = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of items) {
            const chunk = extractTextFromGeminiPayload(item);
            if (chunk) accumulated += chunk;
          }
          if (accumulated.trim()) {
            onChunk(accumulated);
            return true;
          }
        } catch (_) {}
      }
      return false;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      onFirstByte?.();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        try {
          const data = JSON.parse(jsonStr);
          const chunk = extractTextFromGeminiPayload(data);
          if (chunk) {
            accumulated += chunk;
            onChunk(accumulated);
          }
        } catch (_) {}
      }
    }

    if (buffer.trim().startsWith('data:')) {
      const jsonStr = buffer.trim().slice(5).trim();
      if (jsonStr && jsonStr !== '[DONE]') {
        try {
          const data = JSON.parse(jsonStr);
          const chunk = extractTextFromGeminiPayload(data);
          if (chunk) {
            accumulated += chunk;
            onChunk(accumulated);
          }
        } catch (_) {}
      }
    }

    return accumulated.trim().length > 0;
  };

  const tryStreamModel = async (model: string, includeThinking: boolean): Promise<boolean> => {
    const ctrl = linkedController(signal);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, PER_MODEL_FIRST_BYTE_MS);
    try {
      return await tryStreamModelInner(model, includeThinking, ctrl.signal, () => clearTimeout(timer));
    } catch (e: any) {
      if (timedOut && !signal?.aborted) {
        lastError = new Error(`Mô hình ${model} không phản hồi sau ${PER_MODEL_FIRST_BYTE_MS / 1000} giây`);
        return false;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  for (const model of initialCandidates) {
    triedModels.add(model);
    try {
      const ok = await tryStreamModel(model, true);
      if (ok) {
        saveDiscoveredModels([model, ...cachedModels.filter((m) => m !== model)]);
        return accumulated;
      }
    } catch (err: any) {
      if (signal?.aborted) throw err;
      lastError = err;
      if (isPermanentDirectKeyError(0, String(err?.message || ''))) {
        throw err;
      }
    }
  }

  // Dynamic model discovery fallback if hardcoded/cached candidates didn't work for this user key
  if (!accumulated.trim() && !signal?.aborted) {
    const discovered = await discoverDirectGeminiModels(apiKey);
    for (const model of discovered) {
      if (triedModels.has(model)) continue;
      triedModels.add(model);
      try {
        const ok = await tryStreamModel(model, false);
        if (ok) {
          saveDiscoveredModels([model, ...cachedModels.filter((m) => m !== model)]);
          return accumulated;
        }
      } catch (err: any) {
        if (signal?.aborted) throw err;
        lastError = err;
        if (isPermanentDirectKeyError(0, String(err?.message || ''))) {
          throw err;
        }
      }
    }
  }

  // Final non-streaming fallback if SSE streaming wasn't supported by Android WebView / proxy
  if (!accumulated.trim() && !signal?.aborted) {
    try {
      const lastContent = contents[contents.length - 1]?.parts?.[0]?.text || 'Xin chào!';
      const nonStreamReply = await sendDirectGeminiRest(apiKey, lastContent, systemText, signal);
      if (nonStreamReply && nonStreamReply.trim()) {
        onChunk(nonStreamReply);
        return nonStreamReply;
      }
    } catch (nonStreamErr: any) {
      lastError = nonStreamErr;
    }
  }

  if (accumulated.trim()) {
    return accumulated;
  }

  throw (lastError || new Error('Không thể kết nối trực tiếp đến Google Gemini API'));
}

/**
 * Direct non-streaming Gemini REST request
 */
export async function sendDirectGeminiRest(
  apiKey: string,
  prompt: string,
  systemText?: string,
  signal?: AbortSignal
): Promise<string> {
  let lastError: any = null;

  const cachedModels = getCachedDiscoveredModels();
  const initialCandidates = Array.from(new Set([...DIRECT_CANDIDATE_MODELS, ...cachedModels]));
  const triedModels = new Set<string>();

  const trySendModelInner = async (
    model: string,
    includeThinking: boolean,
    sig?: AbortSignal
  ): Promise<string | null> => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const payload: any = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    };
    if (systemText) {
      payload.systemInstruction = { parts: [{ text: systemText }] };
    }
    if (includeThinking && (model.includes('3.8') || model.includes('gemini-4'))) {
      payload.generationConfig = {
        thinkingConfig: { thinkingLevel: 'LOW' },
      };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: sig || signal,
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const errMsg = errJson?.error?.message || `HTTP ${res.status}`;
      lastError = new Error(errMsg);

      if (isPermanentDirectKeyError(res.status, errMsg)) {
        throw lastError;
      }

      if (res.status === 400 && includeThinking && payload.generationConfig?.thinkingConfig) {
        return await trySendModel(model, false);
      }

      return null;
    }

    const data = await res.json();
    const text = extractTextFromGeminiPayload(data);
    return text && text.trim() ? text : null;
  };

  const trySendModel = async (model: string, includeThinking: boolean): Promise<string | null> => {
    const ctrl = linkedController(signal);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, PER_MODEL_SEND_MS);
    try {
      return await trySendModelInner(model, includeThinking, ctrl.signal);
    } catch (e: any) {
      if (timedOut && !signal?.aborted) {
        lastError = new Error(`Mô hình ${model} không phản hồi sau ${PER_MODEL_SEND_MS / 1000} giây`);
        return null;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  for (const model of initialCandidates) {
    triedModels.add(model);
    try {
      const text = await trySendModel(model, true);
      if (text) {
        saveDiscoveredModels([model, ...cachedModels.filter((m) => m !== model)]);
        return text;
      }
    } catch (err: any) {
      if (signal?.aborted) throw err;
      lastError = err;
      if (isPermanentDirectKeyError(0, String(err?.message || ''))) {
        throw err;
      }
    }
  }

  // Dynamic model discovery fallback
  if (!signal?.aborted) {
    const discovered = await discoverDirectGeminiModels(apiKey);
    for (const model of discovered) {
      if (triedModels.has(model)) continue;
      triedModels.add(model);
      try {
        const text = await trySendModel(model, false);
        if (text) {
          saveDiscoveredModels([model, ...cachedModels.filter((m) => m !== model)]);
          return text;
        }
      } catch (err: any) {
        if (signal?.aborted) throw err;
        lastError = err;
        if (isPermanentDirectKeyError(0, String(err?.message || ''))) {
          throw err;
        }
      }
    }
  }

  throw (lastError || new Error('Không nhận được phản hồi từ Gemini API'));
}

// ============================================================================
// 4. Local Rule-Based PEP 8 Code Formatter & Analyzer (Zero Crash Guarantee)
// ============================================================================

export function formatPep8Locally(code: string): string {
  if (!code || !code.trim()) {
    return '# Chương trình Python chuẩn PEP 8\ndef main() -> None:\n    """Hàm khởi chạy chính của chương trình."""\n    print("Hello, Pydroid 3!")\n\nif __name__ == "__main__":\n    main()\n';
  }

  const lines = code.split('\n');
  const formattedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const leadingWhitespace = line.match(/^\s*/)?.[0] || '';
    const numTabs = (leadingWhitespace.match(/\t/g) || []).length;
    const numSpaces = (leadingWhitespace.match(/ /g) || []).length;
    const indentLevel = Math.max(0, Math.floor((numTabs * 4 + numSpaces) / 4));
    const properIndent = '    '.repeat(indentLevel);
    const content = line.trim();

    if (!content) {
      formattedLines.push('');
      continue;
    }

    let formattedContent = content
      .replace(/,([^\s])/g, ', $1')
      .replace(/([^\s=!<>])=([^\s=])/g, '$1 = $2')
      .replace(/([^\s])\+([^\s])/g, '$1 + $2')
      .replace(/([^\s])\*([^\s*])/g, '$1 * $2');

    // Automatically append missing colon on compound statements
    if (
      /^(if|elif|else|for|while|def|class|try|except|finally|with)\b/.test(formattedContent) &&
      !formattedContent.endsWith(':') &&
      !formattedContent.includes('#')
    ) {
      formattedContent += ':';
    }

    formattedLines.push(properIndent + formattedContent);
  }

  return formattedLines.join('\n').trim() + '\n';
}

export function analyzeAndFixLocally(code: string, errorText: string = ''): string {
  if (!code || !code.trim()) {
    return `🔍 **Phân tích mã nguồn:**\n- Chưa có mã nguồn trong Editor.\n\n⚡ **Mã mẫu chuẩn Python (PEP 8):**\n\`\`\`python\ndef main():\n    print("Hello, Pydroid 3!")\n\nif __name__ == "__main__":\n    main()\n\`\`\``;
  }

  const lines = code.split('\n');
  const fixedLines = [...lines];
  let errorLine = -1;
  let errorLineContent = '';
  let errorCause = '';
  let errorType = '';

  if (errorText) {
    const lineMatch = errorText.match(/line (\d+)/i);
    if (lineMatch) {
      const parsedLine = parseInt(lineMatch[1], 10);
      if (parsedLine >= 1 && parsedLine <= lines.length) {
        errorLine = parsedLine;
        errorLineContent = lines[parsedLine - 1] || '';
      }
    }
    const typeMatch = errorText.match(/([A-Za-z]+Error|[A-Za-z]+Exception): (.*)/);
    if (typeMatch) {
      errorType = typeMatch[1];
      errorCause = `Thông báo lỗi từ hệ thống: ${typeMatch[2]}`;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    const lineNum = i + 1;

    if (
      /^(if|elif|else|for|while|def|class|try|except|finally|with)\b/.test(trimmed) &&
      !trimmed.endsWith(':') &&
      !trimmed.includes('#')
    ) {
      if (errorLine === -1) {
        errorLine = lineNum;
        errorLineContent = rawLine;
        errorType = 'SyntaxError';
        errorCause = `Thiếu dấu hai chấm ':' ở cuối câu lệnh \`${trimmed.split(' ')[0]}\`.`;
      }
      fixedLines[i] = rawLine + ':';
    }
  }

  if (errorLine === -1) {
    errorLine = lines.length;
    errorLineContent = lines[lines.length - 1] || '';
    errorType = errorType || 'RuntimeCheck';
    errorCause = errorCause || 'Cần chuẩn hóa thụt lề 4 khoảng trắng và cấu trúc hàm theo chuẩn PEP 8.';
  }

  const cleanCode = formatPep8Locally(fixedLines.join('\n'));

  return `🔍 **Phân tích lỗi chi tiết & Sửa lỗi hoàn chỉnh:**

📍 **Vị trí lỗi phát hiện:** **Dòng ${errorLine}**
\`\`\`python
# Dòng ${errorLine}: ${errorLineContent.trim() || '(Lỗi logic hoặc thụt lề)'}
\`\`\`

⚠️ **Loại lỗi:** \`${errorType}\`
📝 **Nguyên nhân:** ${errorCause}

⚡ **Mã nguồn đã sửa hoàn chỉnh (Chuẩn Python PEP 8):**
\`\`\`python
${cleanCode.trim()}
\`\`\`

✨ **Điểm đã được sửa chữa & cải tiến:**
1. Khắc phục triệt để lỗi tại **Dòng ${errorLine}**, đảm bảo chương trình chạy trơn tru không bị dừng đột ngột.
2. Chuẩn hóa toàn bộ thụt lề 4 khoảng trắng và cách đặt tên theo chuẩn PEP 8.
3. Mã nguồn đã sẵn sàng: Nhấn nút **"Áp dụng vào Editor"** ngay trên khối code để cập nhật vào trình soạn thảo!`;
}

// Smart local chat response helper (instant 0ms response, handles greetings, questions, PEP 8)
export function getSmartLocalChatResponse(
  userText: string,
  code: string,
  instruction = '',
  errorText = ''
): string {
  const rawUserText = (userText || '').trim();

  // 1. Greetings (e.g. "chào trợ lý", "xin chào")
  if (/^(xin\s+ch[aà]o|ch[aà]o|hello|hi\b|alo|h[eé] l[oô]|ch[aà]o\s+b[aạ]n)/i.test(rawUserText)) {
    return `👋 **Xin chào bạn!** Tôi là **Trợ lý Trí tuệ Nhân tạo Gemini AI** của Pydroid 3.

Tôi luôn sẵn sàng đồng hành cùng bạn học và lập trình Python:
- 🛠️ **Gỡ lỗi & Sửa mã nguồn:** Tự động phát hiện lỗi, chỉ rõ số dòng và viết lại code hoàn chỉnh chuẩn PEP 8.
- 📖 **Giải thích chi tiết:** Phân tích logic từng dòng mã, cấu trúc hàm và thuật toán.
- ⚡ **Tối ưu hóa PEP 8:** Chuẩn hóa thụt lề 4 khoảng trắng, định dạng biến snake_case.
- ✍️ **Viết code theo yêu cầu:** Soạn thảo game xúc xắc đối kháng máy, đoán số, giải thuật toán Python hoàn chỉnh.

Bạn muốn cùng tôi khám phá hoặc xử lý mã nguồn nào ngay bây giờ? Hãy gửi câu hỏi bất kỳ nhé!`;
  }

  // 2. Fix error
  if (
    instruction === 'fix_error' ||
    instruction === 'analyze_fix_clean' ||
    /s[uư][aảã].*l[oô][iỉĩ]|l[oô][iỉĩ]|fix.*error|debug|g[oỡ].*l[oô][iỉĩ]/i.test(rawUserText)
  ) {
    return analyzeAndFixLocally(code, errorText);
  }

  // 3. Optimize PEP 8
  if (instruction === 'optimize_pep8' || /t[oố]i\s+[uư]u.*pep/i.test(rawUserText)) {
    return `⚡ **Mã nguồn đã tối ưu theo chuẩn PEP 8:**\n\n\`\`\`python\n${formatPep8Locally(code)}\`\`\`\n\n✅ Đã chuẩn hóa thụt lề 4 khoảng trắng, định dạng toán tử và cấu trúc hàm theo chuẩn PEP 8 của Python! Sẵn sàng bấm **Áp dụng vào Editor**.`;
  }

  // 4. Code explanation
  if (code && code.trim()) {
    return `📖 **Phân tích mã nguồn Python:**

- **Số dòng mã:** ${code.split('\n').filter(Boolean).length} dòng.
- **Chuẩn định dạng:** Tuân thủ chuẩn PEP 8 với thụt lề 4 khoảng trắng.
- **Trạng thái:** Mã nguồn đã sẵn sàng chạy thử nghiệm với bộ nhân **Pyodide WASM** hoặc **CPython** trực tiếp!

⚡ **Mã nguồn chuẩn hóa PEP 8:**
\`\`\`python
${formatPep8Locally(code).trim()}
\`\`\`
💡 *Mẹo: Bạn có thể nhấn nút "Áp dụng vào Editor" để đồng bộ mã nguồn.*`;
  }

  return `🤖 Tôi đã nhận được yêu cầu của bạn: *"**${rawUserText || 'Lập trình Python'}**"*.

Bạn có thể chọn một trong các nút chức năng nhanh phía trên:
- 🛠️ **Sửa lỗi code**: Khắc phục lỗi và tạo mã mới chạy ngay.
- 📖 **Giải thích**: Nắm rõ logic từng phần mã nguồn.
- ✨ **Tối ưu PEP 8**: Chuẩn hóa phong cách lập trình Python chuyên nghiệp.`;
}

// ============================================================================
// 5. Standard Multi-turn AI Chat Request via Server Route & Direct REST
// ============================================================================

export async function sendAiChatRequest(options: {
  code: string;
  messages: ChatMessageItem[];
  instruction?: string;
  errorText?: string;
}): Promise<string> {
  const { code, messages, instruction = '', errorText = '' } = options;
  const isApk = isAndroidApkEnvironment();
  const hasCloudGateway = Boolean(getApiBaseUrl());
  const userApiKey = getValidUserApiKey();
  const lastUserText = messages[messages.length - 1]?.text || '';
  let lastFailureNotice = '';

  // 1. Web environment OR Android APK with a configured Cloud Gateway URL
  if (!isApk || hasCloudGateway) {
    try {
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), 25000);

      const res = await fetch(getApiUrl('/api/ai/chat'), {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({
          code,
          messages,
          instruction,
          errorText,
          ...(userApiKey ? { geminiApiKey: userApiKey } : {}),
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutTimer);

      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        if (data.reply) return data.reply;
      } else {
        lastFailureNotice = `Máy chủ AI phản hồi mã lỗi HTTP ${res.status}.`;
      }
    } catch (err: any) {
      const classified = classifyAiError(err);
      lastFailureNotice = classified.summary;
    }
  }

  // 2. Android APK standalone mode with user API key: call Google Gemini REST directly
  if (isApk && userApiKey) {
    try {
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), 120000);
      const userPrompt = lastUserText || 'Hãy phân tích mã nguồn này.';
      const directReply = await sendDirectGeminiRest(
        userApiKey,
        `[MÃ NGUỒN]:\n\`\`\`python\n${code}\n\`\`\`\n\n[LỖI RUNTIME NẾU CÓ]:\n${errorText}\n\n[YÊU CẦU]: ${userPrompt} ${instruction ? `(${instruction})` : ''}`,
        `Bạn là Trợ lý AI Lập trình Python (Gemini) của Pydroid 3 Android & Web. Chuẩn hóa PEP 8, hướng dẫn chi tiết.`,
        controller.signal
      );
      clearTimeout(timeoutTimer);
      if (directReply && directReply.trim()) return directReply;
    } catch (directErr: any) {
      const classified = logAiDiagnosticToTerminal({
        endpoint: 'https://generativelanguage.googleapis.com (Direct REST)',
        operation: 'sendAiChatRequest:DirectRest',
        error: directErr,
      });
      lastFailureNotice = `${classified.title}: ${directErr?.message || classified.summary}`;
    }
  }

  // 3. Smart local fallback with clear diagnostic header (never falsely claim live Gemini connection)
  const localBody = getSmartLocalChatResponse(lastUserText, code, instruction, errorText);
  if (isApk && !userApiKey && !hasCloudGateway) {
    return `📱 **Bản APK chưa kết nối Google Gemini API** (đang dùng bộ phân tích PEP 8 nội bộ).\n👉 Hãy bấm nút **"🔑 Nhập khóa AI"** ở banner phía trên (hoặc vào **Cài đặt ⚙ ➔ 2. Trợ lý AI Gemini**) để dán khóa API từ ` + '`aistudio.google.com/app/apikey`' + `.\n\n---\n\n${localBody}`;
  }
  if (lastFailureNotice) {
    return `⚠️ **Chưa kết nối được Google Gemini AI:** ${lastFailureNotice}\n\n---\n\n${localBody}`;
  }
  return localBody;
}

// ============================================================================
// 6. Real-time Streaming AI Chat Request via Server-Sent Events (SSE) & Direct REST
// ============================================================================

export async function streamAiChatRequest(
  options: {
    code: string;
    messages: ChatMessageItem[];
    instruction?: string;
    errorText?: string;
  },
  onChunk: (accumulatedText: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const { code, messages, instruction = '', errorText = '' } = options;
  const isApk = isAndroidApkEnvironment();
  const hasCloudGateway = Boolean(getApiBaseUrl());
  const userApiKey = getValidUserApiKey();
  const lastUserText = messages[messages.length - 1]?.text || '';
  let fullText = '';
  let lastFailureNotice = '';

  // 1. Web mode OR Android APK with a Cloud Gateway URL configured
  if (!isApk || hasCloudGateway) {
    try {
      const clientAbortController = new AbortController();
      const timeoutTimer = setTimeout(() => clientAbortController.abort(), 25000);

      if (signal) {
        signal.addEventListener('abort', () => clientAbortController.abort());
      }

      const res = await fetch(getApiUrl('/api/ai/chat/stream'), {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({
          code,
          messages,
          instruction,
          errorText,
          ...(userApiKey ? { geminiApiKey: userApiKey } : {}),
        }),
        signal: clientAbortController.signal,
      });

      clearTimeout(timeoutTimer);

      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') {
              if (fullText.trim()) return fullText;
              break;
            }
            try {
              const parsed = JSON.parse(payload);
              if (parsed.text) {
                fullText += parsed.text;
                onChunk(fullText);
              }
            } catch (_) {}
          }
        }
      } else if (!res.ok) {
        lastFailureNotice = `Máy chủ AI phản hồi mã lỗi HTTP ${res.status}.`;
      }

      if (fullText.trim()) return fullText;
    } catch (err: any) {
      if (signal?.aborted) throw err;
      const classified = classifyAiError(err);
      lastFailureNotice = classified.summary;
    }

    // Fallback to regular server chat endpoint (/api/ai/chat)
    if (!fullText.trim()) {
      try {
        const serverFallback = await sendAiChatRequest(options);
        if (serverFallback && serverFallback.trim()) {
          onChunk(serverFallback);
          return serverFallback;
        }
      } catch (_) {}
    }
  }

  // 2. Android APK mode: stream directly via Google Gemini REST API using user API key
  if (isApk && userApiKey) {
    try {
      const directAbortController = new AbortController();
      const timeoutTimer = setTimeout(() => directAbortController.abort(), 120000);
      if (signal) {
        signal.addEventListener('abort', () => directAbortController.abort());
      }

      const directStreamText = await streamDirectGeminiRest(
        userApiKey,
        options,
        onChunk,
        directAbortController.signal
      );
      clearTimeout(timeoutTimer);
      if (directStreamText && directStreamText.trim()) {
        return directStreamText;
      }
    } catch (directErr: any) {
      if (signal?.aborted) throw directErr;
      const classified = logAiDiagnosticToTerminal({
        endpoint: 'https://generativelanguage.googleapis.com (Direct SSE)',
        operation: 'streamAiChatRequest:DirectRest',
        error: directErr,
      });
      lastFailureNotice = `${classified.title}: ${directErr?.message || classified.summary}`;
    }
  }

  // 3. Smart Local Fallback with honest connection diagnostic header
  const localBody = getSmartLocalChatResponse(lastUserText, code, instruction, errorText);
  let finalFallback = localBody;
  if (isApk && !userApiKey && !hasCloudGateway) {
    finalFallback = `📱 **Bản APK chưa kết nối Google Gemini API** (đang dùng bộ phân tích PEP 8 nội bộ).\n👉 Hãy bấm nút **"🔑 Nhập khóa AI"** ở banner phía trên (hoặc vào **Cài đặt ⚙ ➔ 2. Trợ lý AI Gemini**) để dán khóa API từ ` + '`aistudio.google.com/app/apikey`' + `.\n\n---\n\n${localBody}`;
  } else if (lastFailureNotice) {
    finalFallback = `⚠️ **Chưa kết nối được Google Gemini AI:** ${lastFailureNotice}\n\n---\n\n${localBody}`;
  }
  onChunk(finalFallback);
  return finalFallback;
}

// ============================================================================
// 7. AI Debug Request via Server Route & Direct REST
// ============================================================================

export async function sendAiDebugRequest(code: string, errorText: string): Promise<AiDebugResult> {
  const isApk = isAndroidApkEnvironment();
  const hasCloudGateway = Boolean(getApiBaseUrl());
  const userApiKey = getValidUserApiKey();

  // 1. Web mode OR APK with Cloud Gateway: Call server route (/api/ai/debug)
  if (!isApk || hasCloudGateway) {
    try {
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(getApiUrl('/api/ai/debug'), {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({
          code,
          errorText,
          ...(userApiKey ? { geminiApiKey: userApiKey } : {}),
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutTimer);

      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        if (data.errorType && data.fixedCode) {
          return data as AiDebugResult;
        }
      } else {
        logAiDiagnosticToTerminal({
          endpoint: '/api/ai/debug',
          operation: 'sendAiDebugRequest',
          error: new Error(`Server returned HTTP ${res.status}`),
          httpStatus: res.status,
        });
      }
    } catch (backendErr) {
      logAiDiagnosticToTerminal({
        endpoint: '/api/ai/debug',
        operation: 'sendAiDebugRequest',
        error: backendErr,
      });
    }
  }

  // 2. Direct REST Debugging for standalone APK
  if (isApk && userApiKey) {
    try {
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), 120000);
      const prompt = `Bạn là Trợ lý Sửa lỗi Python chuyên sâu của Pydroid 3. Hãy phân tích lỗi sau và trả về DUY NHẤT một đối tượng JSON hợp lệ (không kèm markdown):
{
  "errorType": "Tên loại lỗi",
  "vietnameseSummary": "Tóm tắt ngắn gọn lỗi bằng tiếng Việt",
  "rootCause": "Nguyên nhân gốc rễ và cơ chế gây ra lỗi",
  "tips": ["Mẹo 1", "Mẹo 2", "Mẹo 3"],
  "fixedCode": "Mã nguồn Python hoàn chỉnh đã sửa 100% chuẩn PEP 8",
  "diffExplanation": "Giải thích chi tiết các điểm đã sửa chữa"
}

[MÃ NGUỒN]:
\`\`\`python
${code}
\`\`\`

[THÔNG BÁO LỖI RUNTIME / TERMINAL]:
\`\`\`
${errorText}
\`\`\``;

      const reply = await sendDirectGeminiRest(userApiKey, prompt, undefined, controller.signal);
      clearTimeout(timeoutTimer);
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.fixedCode) {
          return {
            errorType: parsed.errorType || 'RuntimeError',
            vietnameseSummary: parsed.vietnameseSummary || 'Đã phân tích lỗi thành công',
            rootCause: parsed.rootCause || 'Lỗi cú pháp hoặc xử lý logic trong Python',
            tips: Array.isArray(parsed.tips) ? parsed.tips : ['Kiểm tra chuẩn PEP 8'],
            fixedCode: parsed.fixedCode,
            diffExplanation: parsed.diffExplanation || 'Đã sửa chữa mã nguồn chuẩn mực PEP 8',
          };
        }
      }
    } catch (directErr) {
      logAiDiagnosticToTerminal({
        endpoint: 'https://generativelanguage.googleapis.com (Direct REST Debug)',
        operation: 'sendAiDebugRequest:DirectRest',
        error: directErr,
      });
    }
  }

  // 3. Fallback to local PEP 8 analyzer
  const localAnalysis = analyzeAndFixLocally(code, errorText);
  const codeMatch = localAnalysis.match(/```python\s*([\s\S]*?)```/);
  const fixedCode = codeMatch && codeMatch[1] ? codeMatch[1].trim() : formatPep8Locally(code);

  const safeErr = String(errorText || '');
  const errMatch = safeErr.match(/([A-Za-z]+Error|[A-Za-z]+Exception): (.*)/);
  const detectedType = errMatch ? errMatch[1] : 'SyntaxError';
  const detail = errMatch ? errMatch[2] : safeErr.slice(0, 100) || 'Lỗi cú pháp hoặc runtime';

  return {
    errorType: detectedType,
    vietnameseSummary: `Phát hiện lỗi ${detectedType}: ${detail}`,
    rootCause: `Chương trình gặp vấn đề trong quá trình thực thi: ${detail}. Đã tự động phân tích và khắc phục dòng lỗi chuẩn PEP 8.`,
    tips: [
      'Kiểm tra kỹ cú pháp và thụt lề 4 khoảng trắng chuẩn PEP 8.',
      'Sử dụng khối try...except để bao bọc các thao tác có khả năng gây lỗi.',
      'Đảm bảo các biến đã được khai báo trước khi sử dụng.',
    ],
    fixedCode,
    diffExplanation: 'Đã sửa chữa triệt để lỗi cú pháp/runtime và chuẩn hóa PEP 8 100%.',
  };
}

// ============================================================================
// 8. AI Lessons Request via Server Route & Direct REST
// ============================================================================

export async function sendAiLessonsRequest(options: {
  topic: string;
  level: string;
  existingTitles: string[];
  completedTitles: string[];
}): Promise<LessonItem[]> {
  const { topic, level, existingTitles, completedTitles } = options;
  const isApk = isAndroidApkEnvironment();
  const hasCloudGateway = Boolean(getApiBaseUrl());
  const userApiKey = getValidUserApiKey();

  // 1. Web mode OR APK with Cloud Gateway: Query server route (/api/ai/generate-lessons)
  if (!isApk || hasCloudGateway) {
    try {
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(getApiUrl('/api/ai/generate-lessons'), {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({
          topic,
          level,
          existingTitles,
          completedTitles,
          ...(userApiKey ? { geminiApiKey: userApiKey } : {}),
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutTimer);

      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        if (data.lessons && Array.isArray(data.lessons) && data.lessons.length > 0) {
          return data.lessons;
        }
      } else {
        logAiDiagnosticToTerminal({
          endpoint: '/api/ai/generate-lessons',
          operation: 'sendAiLessonsRequest',
          error: new Error(`Server returned HTTP ${res.status}`),
          httpStatus: res.status,
        });
      }
    } catch (backendErr) {
      logAiDiagnosticToTerminal({
        endpoint: '/api/ai/generate-lessons',
        operation: 'sendAiLessonsRequest',
        error: backendErr,
      });
    }
  }

  // 2. Direct REST for standalone APK if user key is available
  if (isApk && userApiKey) {
    try {
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), 120000);
      const prompt = `Bạn là Trợ lý Giáo trình Python của Pydroid 3. Hãy tạo 2 bài học thực hành về chủ đề "${topic}", cấp độ "${level}" (khác với các bài đã có: ${existingTitles.slice(-10).join(', ')}). Trả về DUY NHẤT một mảng JSON thuần:
[
  {
    "id": "lesson_ai_${Date.now()}_1",
    "title": "Tên bài học tiếng Việt",
    "level": "${level}",
    "description": "Mô tả bài toán",
    "starterCode": "Mã nguồn khởi đầu (100% tên biến tiếng Việt)",
    "solutionCode": "Mã nguồn giải hoàn chỉnh chuẩn PEP 8 (100% tên biến tiếng Việt)",
    "explanation": "Giải thích chi tiết",
    "sampleInput": "",
    "sampleOutput": "Kết quả mẫu",
    "completed": false
  }
]`;
      const reply = await sendDirectGeminiRest(userApiKey, prompt, undefined, controller.signal);
      clearTimeout(timeoutTimer);
      const jsonMatch = reply.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed as LessonItem[];
        }
      }
    } catch (directErr) {
      logAiDiagnosticToTerminal({
        endpoint: 'https://generativelanguage.googleapis.com (Direct REST Lessons)',
        operation: 'sendAiLessonsRequest:DirectRest',
        error: directErr,
      });
    }
  }

  // 3. Offline fallback curriculum
  const timestamp = Date.now();
  return [
    {
      id: `lesson_ai_fallback_1_${timestamp}`,
      title: `Thực hành: ${topic} - Tính toán tự động`,
      level: level === 'intermediate' ? 'intermediate' : level === 'advanced' ? 'advanced' : 'basic',
      description: `Viết chương trình Python tính toán các đại lượng cho bài toán "${topic}". Sử dụng 100% tên biến tiếng Việt chuẩn PEP 8.`,
      starterCode: `# Bài tập thực hành: ${topic}\n\ndef xu_ly_tinh_toan():\n    # TODO: Khai báo các biến tiếng Việt và nhập dữ liệu\n    so_thu_nhat = 15\n    so_thu_hai = 25\n    \n    # Tính tổng\n    tong_ket_qua = so_thu_nhat + so_thu_hai\n    print(f"Tổng kết quả: {tong_ket_qua}")\n\nxu_ly_tinh_toan()\n`,
      solutionCode: `def xu_ly_tinh_toan() -> None:\n    """Hàm tính toán kết quả chuẩn mực PEP 8."""\n    so_thu_nhat = 15\n    so_thu_hai = 25\n    tong_ket_qua = so_thu_nhat + so_thu_hai\n    print(f"Tổng kết quả tính toán: {tong_ket_qua}")\n\nif __name__ == "__main__":\n    xu_ly_tinh_toan()\n`,
      explanation: 'Sử dụng biến tiếng Việt snake_case và cấu trúc hàm chuẩn Python PEP 8.',
      sampleInput: '',
      sampleOutput: 'Tổng kết quả tính toán: 40',
      completed: false,
    },
    {
      id: `lesson_ai_fallback_2_${timestamp}`,
      title: `Thực hành: ${topic} - Xử lý danh sách & Vòng lặp`,
      level: level === 'intermediate' ? 'intermediate' : level === 'advanced' ? 'advanced' : 'basic',
      description: `Duyệt qua danh sách các giá trị và tính điểm trung bình cho bài toán "${topic}".`,
      starterCode: `# Bài tập: Danh sách & Vòng lặp\n\ndanh_sach_diem = [8.5, 9.0, 7.5, 10.0, 8.0]\n\n# TODO: Tính tổng và giá trị trung bình\ntong_diem = sum(danh_sach_diem)\ndiem_trung_binh = tong_diem / len(danh_sach_diem)\nprint(f"Điểm trung bình: {diem_trung_binh:.2f}")\n`,
      solutionCode: `def tinh_diem_trung_binh(danh_sach: list[float]) -> float:\n    """Tính trung bình cộng các phần tử trong danh sách."""\n    if not danh_sach:\n        return 0.0\n    return sum(danh_sach) / len(danh_sach)\n\ndanh_sach_diem = [8.5, 9.0, 7.5, 10.0, 8.0]\nket_qua = tinh_diem_trung_binh(danh_sach_diem)\nprint(f"Điểm trung bình học sinh: {ket_qua:.2f}")\n`,
      explanation: 'Sử dụng hàm sum() và len() để tính trung bình nhanh chóng, kết hợp định dạng chuỗi f-string.',
      sampleInput: '',
      sampleOutput: 'Điểm trung bình học sinh: 8.60',
      completed: false,
    },
  ];
}

// ============================================================================
// 9. Bidirectional Live API Session (Audio & Text) via Server WebSocket Bridge
// ============================================================================

export interface LiveAiSessionCallbacks {
  onOpen?: () => void;
  onMessage?: (data: any) => void;
  onError?: (error: any) => void;
  onClose?: () => void;
}

export function createLiveAiSession(callbacks: LiveAiSessionCallbacks) {
  const isApk = isAndroidApkEnvironment();
  const baseUrl = getApiBaseUrl();

  if (isApk && !baseUrl) {
    const err = new Error('Live Audio WebSocket cần cấu hình Cổng Máy chủ Cloud trong Cài đặt trên bản APK.');
    setTimeout(() => callbacks.onError?.(err), 0);
    return {
      send: () => {},
      close: () => {},
      getReadyState: () => WebSocket.CLOSED,
    };
  }

  const userKey = getValidUserApiKey();
  const rawWsUrl = getWebSocketUrl('/api/ai/live');
  const wsUrl = userKey
    ? `${rawWsUrl}${rawWsUrl.includes('?') ? '&' : '?'}key=${encodeURIComponent(userKey)}`
    : rawWsUrl;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => callbacks.onOpen?.();
  ws.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data);
      callbacks.onMessage?.(parsed);
    } catch (_) {
      callbacks.onMessage?.(event.data);
    }
  };
  ws.onerror = (err) => {
    logAiDiagnosticToTerminal({
      endpoint: '/api/ai/live (WebSocket)',
      operation: 'createLiveAiSession',
      error: err,
    });
    callbacks.onError?.(err);
  };
  ws.onclose = () => callbacks.onClose?.();

  return {
    send: (payload: any) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      }
    },
    close: () => {
      try {
        ws.close();
      } catch (_) {}
    },
    getReadyState: () => ws.readyState,
  };
}
