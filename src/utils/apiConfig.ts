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
    // When running inside AI Studio Web / Cloud Run preview, always use local relative /api/* backend
    // so a previously saved APK Gateway URL (e.g. *.onrender.com) never overrides AI Studio's server.
    if (!isApk && (window.location.hostname.includes('run.app') || window.location.hostname.includes('aistudio.google.com') || window.location.port === '3000')) {
      try {
        localStorage.removeItem(STORAGE_GATEWAY_KEY);
      } catch (_) {}
      return '';
    }
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

/**
 * Returns common HTTP headers for API calls
 */
export function getApiHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
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
      message: 'Bản APK độc lập chưa nhập URL Cổng Cloud Backend. Bạn vẫn có thể đăng nhập Google Drive để đồng bộ mã nguồn .py hoặc chạy Python ngoại tuyến bằng Pyodide WASM.',
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
    const hasGemini = Boolean(data?.features?.geminiAi);
    return {
      ok: true,
      latencyMs,
      message: hasGemini
        ? 'Kết nối Máy chủ Backend thành công! CPython, Pip và Gemini AI sẵn sàng.'
        : 'Đã kết nối Máy chủ Backend (CPython & Pip sẵn sàng), nhưng máy chủ này chưa có biến GEMINI_API_KEY.',
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
 * Checks server-side Gemini AI health status
 */
export async function testServerAiStatus(customUrl?: string): Promise<{
  ok: boolean;
  model: string;
  message: string;
  diagnostic?: {
    httpStatus?: number | null;
    keyPresent?: boolean;
    keySource?: string;
    geminiKeyLen?: number;
    geminiKeyStartsAIza?: boolean;
    rawError?: string;
  };
}> {
  const isApk = isAndroidApkEnvironment();
  const rawCustom = customUrl !== undefined ? customUrl.trim().replace(/\/+$/, '') : '';
  const baseUrl = rawCustom && (rawCustom.startsWith('http://') || rawCustom.startsWith('https://'))
    ? rawCustom
    : getApiBaseUrl();

  const statusEndpoint = baseUrl ? `${baseUrl}/api/ai/status` : '/api/ai/status';

  // Query server-side status endpoint when on Web OR when APK has a Cloud Gateway URL configured
  if (!isApk || baseUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const resp = await fetch(statusEndpoint, {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const contentType = resp.headers.get('content-type') || '';
      if (resp.ok && contentType.includes('application/json')) {
        return await resp.json();
      }
      return {
        ok: false,
        model: 'local-pep8-engine',
        message: `Máy chủ ${baseUrl || 'hiện tại'} phản hồi HTTP ${resp.status} khi kiểm tra Gemini AI. Kiểm tra lại phiên bản backend và biến GEMINI_API_KEY trên máy chủ.`,
      };
    } catch (err: any) {
      if (baseUrl) {
        return {
          ok: false,
          model: 'local-pep8-engine',
          message: `Không thể gọi /api/ai/status tới ${baseUrl} (${err?.name === 'AbortError' ? 'quá thời gian chờ 12s' : 'lỗi mạng hoặc CORS'}). Bộ phân tích PEP 8 nội bộ vẫn hoạt động bình thường.`,
        };
      }
    }
  }

  if (isApk) {
    return {
      ok: false,
      model: 'local-pep8-engine',
      message: 'Bản APK ngoại tuyến đang chạy bộ phân tích PEP 8 nội bộ. Cấu hình URL Cổng Cloud trong Cài đặt để kết nối Gemini AI máy chủ.',
    };
  }

  return {
    ok: false,
    model: 'local-pep8-engine',
    message: 'Không thể kiểm tra trạng thái Gemini AI từ máy chủ. Kiểm tra cấu hình máy chủ hoặc kết nối mạng.',
  };
}
