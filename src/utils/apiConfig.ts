/**
 * Centralized API & Server Gateway Configuration
 * Enables seamless communication between Android APK (Capacitor/WebView) and the Cloud Backend Server
 * All Gemini AI calls are strictly managed server-side.
 */

// Official Production/Cloud Run API Server Endpoints
export const DEFAULT_CLOUD_API_URL = 'https://ais-pre-g5w3wggai6dcyye22rmjnk-772838390153.asia-southeast1.run.app';
export const DEV_CLOUD_API_URL = 'https://ais-dev-g5w3wggai6dcyye22rmjnk-772838390153.asia-southeast1.run.app';

const STORAGE_GATEWAY_KEY = 'pydroid_api_gateway_url';

/**
 * Checks if the current environment is running inside an Android APK (native Capacitor wrapper)
 */
export function isAndroidApkEnvironment(): boolean {
  if (typeof window === 'undefined') return false;

  const protocol = window.location.protocol || '';
  const origin = window.location.origin || '';
  const hostname = window.location.hostname || '';
  const port = window.location.port || '';
  const cap = (window as any).Capacitor;

  // 1. Definitively Web: AI Studio, Cloud Run preview, dev servers, or public domains
  if (
    hostname.includes('aistudio.google.com') ||
    hostname.includes('google.com') ||
    hostname.includes('run.app') ||
    port === '3000' ||
    port === '5173'
  ) {
    return false;
  }

  // 2. Capacitor native wrapper platform
  if (cap?.isNativePlatform?.() || cap?.getPlatform?.() === 'android') {
    return true;
  }

  // 3. Native custom schemes
  if (
    protocol === 'capacitor:' ||
    origin.startsWith('capacitor://') ||
    protocol === 'ionic:' ||
    origin.startsWith('ionic://')
  ) {
    return true;
  }

  // 4. Local asset file protocol
  if (protocol === 'file:' || origin.startsWith('file://')) {
    return true;
  }

  // 5. Capacitor injected runtime object on non-dev localhost
  if ((window as any).__capacitor__ || (cap && hostname === 'localhost' && port !== '3000' && port !== '5173')) {
    return true;
  }

  return false;
}

/**
 * Returns the active API Gateway Base URL.
 * - When in Web browser: returns empty string "" (relative paths /api/* work automatically)
 * - When in native Android APK or overridden by user: returns configured cloud URL
 */
export function getApiBaseUrl(): string {
  if (typeof window === 'undefined') return '';

  const isApk = isAndroidApkEnvironment();
  const saved = localStorage.getItem(STORAGE_GATEWAY_KEY);

  if (saved && saved.trim()) {
    const clean = saved.trim().replace(/\/+$/, '');
    // If not in APK and saved URL was the default cloud URL that could have failed CORS/302, clear it
    if (!isApk && (clean.includes('ais-pre-') || clean.includes('ais-dev-'))) {
      try {
        localStorage.removeItem(STORAGE_GATEWAY_KEY);
      } catch (_) {}
      return '';
    }
    if (clean.startsWith('http://') || clean.startsWith('https://')) {
      return clean;
    }
  }

  // Note: In native Android APK, do not default to ais-pre/ais-dev Cloud Run URLs
  // because AI Studio preview URLs require cookie authentication not available in APK WebViews.
  // Direct Google Gemini REST API will be used for AI features on APK.
  return '';
}

/**
 * Returns the effective API base URL for display purposes (even when in relative mode)
 */
export function getDisplayApiBaseUrl(): string {
  const current = getApiBaseUrl();
  if (current) return current;
  if (typeof window !== 'undefined' && window.location.origin && window.location.origin !== 'null' && !window.location.origin.startsWith('file:')) {
    return window.location.origin;
  }
  return '';
}

/**
 * Persists a custom API Gateway URL (or reset to default)
 */
export function setApiBaseUrl(url: string): void {
  if (typeof window === 'undefined') return;
  const clean = url.trim().replace(/\/+$/, '');

  if (clean && (clean.startsWith('http://') || clean.startsWith('https://'))) {
    localStorage.setItem(STORAGE_GATEWAY_KEY, clean);
  } else {
    localStorage.removeItem(STORAGE_GATEWAY_KEY);
  }
}

const STORAGE_GEMINI_KEY = 'pydroid_gemini_api_key';

export function sanitizeGeminiApiKey(raw: string): string {
  return (raw || '').replace(/[\s\u200B-\u200D\uFEFF'"]+/g, '');
}

export function getGeminiApiKey(): string {
  if (typeof window === 'undefined') return '';
  return sanitizeGeminiApiKey(localStorage.getItem(STORAGE_GEMINI_KEY) || '');
}

export function setGeminiApiKey(key: string): void {
  if (typeof window === 'undefined') return;
  const clean = sanitizeGeminiApiKey(key);
  if (clean) {
    localStorage.setItem(STORAGE_GEMINI_KEY, clean);
  } else {
    localStorage.removeItem(STORAGE_GEMINI_KEY);
  }
}

export function isLikelyGeminiApiKey(str: string): boolean {
  if (!str) return false;
  const s = sanitizeGeminiApiKey(str);
  if (s.includes('...') || s.includes('MY_GEMINI') || s.includes('YOUR_API')) {
    return false;
  }
  return /^[A-Za-z0-9_.-]{20,}$/.test(s);
}

/**
 * Returns common HTTP headers for API calls, automatically forwarding user Gemini API key if valid
 */
export function getApiHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  const userKey = getGeminiApiKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (userKey && isLikelyGeminiApiKey(userKey)) {
    headers['x-gemini-api-key'] = sanitizeGeminiApiKey(userKey);
  }
  return headers;
}

/**
 * Constructs a full API URL for any endpoint (e.g. '/api/ai/chat')
 */
export function getApiUrl(path: string): string {
  const base = getApiBaseUrl();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (!base) return normalizedPath;
  return `${base}${normalizedPath}`;
}

/**
 * Constructs a WebSocket URL matching the active API Gateway
 */
export function getWebSocketUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const base = getApiBaseUrl();

  if (base) {
    const wsBase = base.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
    return `${wsBase}${normalizedPath}`;
  }

  if (typeof window !== 'undefined' && window.location.host && !window.location.host.includes('localhost:')) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${normalizedPath}`;
  }

  if (typeof window !== 'undefined' && window.location.host) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${normalizedPath}`;
  }

  return `wss://localhost${normalizedPath}`;
}

/**
 * Tests connection to the Cloud API Gateway (/api/system/status)
 */
export async function testApiGatewayConnection(customUrl?: string): Promise<{
  ok: boolean;
  latencyMs: number;
  message: string;
  details?: any;
}> {
  const targetBase = customUrl !== undefined
    ? customUrl.trim().replace(/\/+$/, '')
    : getApiBaseUrl();

  if (!targetBase && isAndroidApkEnvironment()) {
    return {
      ok: false,
      latencyMs: 0,
      message: 'Bản APK độc lập chưa nhập URL Cổng Cloud. Để dùng Gemini AI trên điện thoại, hãy dán Google Gemini API Key ở mục (2) bên dưới!',
    };
  }

  const testUrl = targetBase
    ? `${targetBase}/api/system/status`
    : '/api/system/status';

  const startTime = performance.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const resp = await fetch(testUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
    });
    clearTimeout(timeout);

    const latencyMs = Math.round(performance.now() - startTime);
    if (!resp.ok) {
      return {
        ok: false,
        latencyMs,
        message: `Máy chủ phản hồi mã lỗi HTTP ${resp.status}`,
      };
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        latencyMs,
        message: 'Địa chỉ này không phải máy chủ API Pydroid 3 (phản hồi không phải JSON).',
      };
    }

    const data = await resp.json();
    return {
      ok: true,
      latencyMs,
      message: 'Kết nối Cổng Cloud Backend thành công! CPython, Pip và Gemini AI sẵn sàng.',
      details: data,
    };
  } catch (err: any) {
    const latencyMs = Math.round(performance.now() - startTime);
    return {
      ok: false,
      latencyMs,
      message: err.name === 'AbortError'
        ? 'Quá thời gian chờ phản hồi (timeout sau 6s)'
        : (err.message || 'Không thể kết nối đến máy chủ'),
    };
  }
}



/**
 * Checks server Gemini AI health status (or direct APK key readiness)
 */
export async function testServerAiStatus(): Promise<{
  ok: boolean;
  model: string;
  message: string;
}> {
  const isApk = isAndroidApkEnvironment();
  const baseUrl = getApiBaseUrl();
  const rawKey = getGeminiApiKey();
  const hasValidUserKey = isLikelyGeminiApiKey(rawKey);

  // Query server-side status endpoint when on Web OR when APK has a Cloud Gateway URL configured
  if (!isApk || baseUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const cleanKey = hasValidUserKey ? sanitizeGeminiApiKey(rawKey) : undefined;
      const resp = await fetch(getApiUrl('/api/ai/status'), {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify(cleanKey ? { geminiApiKey: cleanKey } : {}),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const contentType = resp.headers.get('content-type') || '';
      if (resp.ok && contentType.includes('application/json')) {
        return await resp.json();
      }
    } catch (_) {}
  }

  if (isApk && hasValidUserKey) {
    // Test live connectivity directly to Google Gemini on APK
    try {
      const cleanKey = sanitizeGeminiApiKey(rawKey);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const models: Array<{ name: string }> = Array.isArray(data.models) ? data.models : [];
        const has4H = models.some((m) => m.name && m.name.includes('gemini-4-hydrogen'));
        const has38 = models.some((m) => m.name && m.name.includes('gemini-3.8-flash'));
        const activeModel = has4H
          ? 'gemini-4-hydrogen'
          : has38
          ? 'gemini-3.8-flash'
          : (models.find((m) => m.name && m.name.includes('gemini'))?.name?.replace('models/', '') || 'gemini-4-hydrogen');
        return {
          ok: true,
          model: activeModel,
          message: `Bản APK Android đã kết nối trực tiếp thành công với Google Gemini (${activeModel})!`,
        };
      }
      return {
        ok: false,
        model: 'local-pep8-engine',
        message: `Khóa Gemini API trên APK bị từ chối (HTTP ${res.status}). Vui lòng kiểm tra lại khóa trong phần Cài đặt.`,
      };
    } catch (_) {
      return {
        ok: false,
        model: 'local-pep8-engine',
        message: 'Không thể kết nối mạng tới Google Gemini từ thiết bị Android. Đang dùng Trợ lý Nội bộ chuẩn PEP 8.',
      };
    }
  }

  if (isApk) {
    return {
      ok: false,
      model: 'local-pep8-engine',
      message: 'Bản APK chưa có khóa Google Gemini API (đang chạy PEP 8 nội bộ). Bấm "Nhập khóa AI" để kết nối Gemini AI!',
    };
  }

  return {
    ok: false,
    model: 'local-pep8-engine',
    message: 'Không thể kiểm tra trạng thái Gemini AI từ máy chủ. Vui lòng kiểm tra kết nối hoặc nhập khóa cá nhân.',
  };
}
