import * as tus from "tus-js-client";
import { baseURL, tusEndpoint, tusSettings, origin } from "@/utils/constants";
import { useAuthStore } from "@/stores/auth";
import { removePrefix } from "@/api/utils";
import { calculateFileHashSafe } from "@/utils/hash";

const RETRY_BASE_DELAY = 1000;
const RETRY_MAX_DELAY = 20000;
const CURRENT_UPLOAD_LIST: { [key: string]: tus.Upload } = {};

export async function upload(
  filePath: string,
  content: ApiContent = "",
  overwrite = false,
  onupload: any
) {
  if (!tusSettings) {
    // Shouldn't happen as we check for tus support before calling this function
    throw new Error("Tus.io settings are not defined");
  }

  filePath = removePrefix(filePath);
  const resourcePath = `${tusEndpoint}${filePath}?override=${overwrite}`;

  const authStore = useAuthStore();

  // Exit early because of typescript, tus content can't be a string
  if (content === "") {
    return false;
  }
  
  // Calculate file hash for integrity verification (required for TUS uploads)
  // IMPORTANT: Calculate hash BEFORE creating tus.Upload to ensure file hasn't been read yet
  let checksumHeader = "";
  if (content instanceof Blob) {
    const fileName = content instanceof File ? content.name : 'file';
    const fileSize = content.size;
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
    
    // Pass the original content to calculateFileHashSafe, which will handle slicing internally
    // Don't create a slice here to avoid double-slicing issues
    const hash = await calculateFileHashSafe(content, "sha256");
    if (!hash) {
      // Hash calculation failed - reject TUS upload
      // This will cause the system to fall back to regular POST upload
      console.error(`[TUS Upload] Hash calculation failed: fileName=${fileName}, size=${fileSizeMB}MB`);
      return Promise.reject(new Error(
        `无法计算文件哈希值（文件: ${fileName}, 大小: ${fileSizeMB}MB）。` +
        `请检查浏览器控制台获取详细信息，或尝试使用其他浏览器。`
      ));
    }
    
    console.log(`[TUS Upload] Hash calculated: fileName=${fileName}, size=${fileSizeMB}MB, hash=${hash}`);
    
    checksumHeader = `sha256 ${hash}`;
  } else {
    // Non-Blob content cannot be hashed - reject TUS upload
    return Promise.reject(new Error("TUS upload requires Blob content for integrity verification"));
  }
  
  return new Promise<void | string>((resolve, reject) => {
    const uploadHeaders: Record<string, string> = {
      "X-Auth": authStore.jwt,
      "Upload-Checksum": checksumHeader, // Always set checksum header (required by backend)
    };
    
    const upload = new tus.Upload(content, {
      endpoint: `${origin}${baseURL}${resourcePath}`,
      chunkSize: tusSettings.chunkSize,
      retryDelays: computeRetryDelays(tusSettings),
      parallelUploads: 1,
      storeFingerprintForResuming: false,
      headers: uploadHeaders,
      onShouldRetry: function (err) {
        const status = err.originalResponse
          ? err.originalResponse.getStatus()
          : 0;

        // Do not retry for file conflict.
        if (status === 409) {
          return false;
        }

        return true;
      },
      onError: function (error: Error | tus.DetailedError) {
        delete CURRENT_UPLOAD_LIST[filePath];

        if (error.message === "Upload aborted") {
          return reject(error);
        }

        const message =
          error instanceof tus.DetailedError
            ? error.originalResponse === null
              ? "000 No connection"
              : error.originalResponse.getBody()
            : "Upload failed";

        console.error(error);

        reject(new Error(message));
      },
      onProgress: function (bytesUploaded) {
        if (typeof onupload === "function") {
          onupload({ loaded: bytesUploaded });
        }
      },
      onSuccess: function () {
        delete CURRENT_UPLOAD_LIST[filePath];
        resolve();
      },
    });
    CURRENT_UPLOAD_LIST[filePath] = upload;
    upload.start();
  });
}

function computeRetryDelays(tusSettings: TusSettings): number[] | undefined {
  if (!tusSettings.retryCount || tusSettings.retryCount < 1) {
    // Disable retries altogether
    return undefined;
  }
  // The tus client expects our retries as an array with computed backoffs
  // E.g.: [0, 3000, 5000, 10000, 20000]
  const retryDelays = [];
  let delay = 0;

  for (let i = 0; i < tusSettings.retryCount; i++) {
    retryDelays.push(Math.min(delay, RETRY_MAX_DELAY));
    delay =
      delay === 0 ? RETRY_BASE_DELAY : Math.min(delay * 2, RETRY_MAX_DELAY);
  }

  return retryDelays;
}

export async function useTus(content: ApiContent) {
  return isTusSupported() && content instanceof Blob;
}

function isTusSupported() {
  return tus.isSupported === true;
}

export function abortAllUploads() {
  for (const filePath in CURRENT_UPLOAD_LIST) {
    if (CURRENT_UPLOAD_LIST[filePath]) {
      CURRENT_UPLOAD_LIST[filePath].abort(true);
      CURRENT_UPLOAD_LIST[filePath].options!.onError!(
        new Error("Upload aborted")
      );
    }
    delete CURRENT_UPLOAD_LIST[filePath];
  }
}
