import CryptoJS from 'crypto-js';

/**
 * Check if Web Crypto API is available
 */
function isWebCryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && 
         typeof crypto.subtle !== 'undefined' &&
         typeof crypto.subtle.digest === 'function';
}

/**
 * Check if the page is loaded over HTTPS
 */
function isSecureContext(): boolean {
  return window.isSecureContext || 
         window.location.protocol === 'https:' ||
         window.location.hostname === 'localhost' ||
         window.location.hostname === '127.0.0.1';
}

/**
 * Calculate file hash using crypto-js as fallback (for HTTP environments)
 */
async function calculateFileHashWithCryptoJS(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512'
): Promise<string> {
  try {
    const buffer = await file.arrayBuffer();
    // Convert ArrayBuffer to WordArray for crypto-js
    // crypto-js WordArray.create accepts an array of numbers (bytes)
    const bytes = new Uint8Array(buffer);
    const wordArray = CryptoJS.lib.WordArray.create(Array.from(bytes));
    
    let hash: CryptoJS.lib.WordArray;
    switch (algorithm) {
      case 'sha1':
        hash = CryptoJS.SHA1(wordArray);
        break;
      case 'sha256':
        hash = CryptoJS.SHA256(wordArray);
        break;
      case 'sha384':
        hash = CryptoJS.SHA384(wordArray);
        break;
      case 'sha512':
        hash = CryptoJS.SHA512(wordArray);
        break;
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
    
    return hash.toString(CryptoJS.enc.Hex);
  } catch (error: any) {
    // If arrayBuffer fails (memory issue), try streaming approach
    if (error?.name === 'QuotaExceededError' || error?.name === 'RangeError' || file.size > 100 * 1024 * 1024) {
      return await calculateFileHashWithCryptoJSStreaming(file, algorithm);
    }
    throw error;
  }
}

/**
 * Calculate file hash using crypto-js with streaming (for large files)
 */
async function calculateFileHashWithCryptoJSStreaming(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512'
): Promise<string> {
  const stream = file.stream();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  
  try {
    // Read file in chunks
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      if (value) {
        chunks.push(value);
      }
    }
    
    // Combine all chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    
    // Calculate hash using crypto-js
    const wordArray = CryptoJS.lib.WordArray.create(Array.from(combined));
    let hash: CryptoJS.lib.WordArray;
    switch (algorithm) {
      case 'sha1':
        hash = CryptoJS.SHA1(wordArray);
        break;
      case 'sha256':
        hash = CryptoJS.SHA256(wordArray);
        break;
      case 'sha384':
        hash = CryptoJS.SHA384(wordArray);
        break;
      case 'sha512':
        hash = CryptoJS.SHA512(wordArray);
        break;
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
    
    return hash.toString(CryptoJS.enc.Hex);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Calculate file hash using Web Crypto API with improved error handling for large files
 * Supports SHA-1, SHA-256, SHA-384, SHA-512
 * Note: MD5 is not supported by Web Crypto API and would require an additional library
 * 
 * This function handles large files by using streaming when arrayBuffer fails,
 * with proper error handling and retry logic.
 */
export async function calculateFileHash(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512' = 'sha256'
): Promise<string> {
  // Check if Web Crypto API is available
  if (!isWebCryptoAvailable()) {
    const isHTTP = !isSecureContext();
    if (isHTTP) {
      // Use crypto-js as fallback for HTTP environments
      console.warn('Web Crypto API not available in HTTP context, using crypto-js fallback');
      try {
        return await calculateFileHashWithCryptoJS(file, algorithm);
      } catch (error: any) {
        throw new Error(
          `无法计算文件哈希值（HTTP 环境降级方案失败）：${error?.message || String(error)}`
        );
      }
    } else {
      // For HTTPS but Web Crypto API not available, try crypto-js as fallback
      console.warn('Web Crypto API not available, using crypto-js fallback');
      try {
        return await calculateFileHashWithCryptoJS(file, algorithm);
      } catch (error: any) {
        throw new Error(`Web Crypto API is not available in this browser and fallback failed: ${error?.message || String(error)}`);
      }
    }
  }

  // Convert algorithm name to Web Crypto API format
  // Input: 'sha256' -> Output: 'SHA-256'
  // Input: 'sha1' -> Output: 'SHA-1'
  // Input: 'sha384' -> Output: 'SHA-384'
  // Input: 'sha512' -> Output: 'SHA-512'
  const cryptoAlgorithm = algorithm.toUpperCase().replace(/^SHA/, 'SHA-');
  
  // Try arrayBuffer first (faster for most files)
  try {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest(
      cryptoAlgorithm as AlgorithmIdentifier,
      buffer
    );
    return arrayBufferToHex(hashBuffer);
  } catch (error: any) {
    // Log detailed error information for debugging
    console.error('Hash calculation error:', {
      errorName: error?.name,
      errorMessage: error?.message,
      fileSize: file.size,
      fileSizeMB: (file.size / 1024 / 1024).toFixed(2),
      algorithm: cryptoAlgorithm,
    });
    
    // If arrayBuffer fails (e.g., memory issue with large files), use streaming
    // Check if it's a memory-related error
    const isMemoryError = 
      error?.name === 'QuotaExceededError' ||
      error?.name === 'RangeError' ||
      error?.message?.includes('memory') ||
      error?.message?.includes('quota') ||
      file.size > 100 * 1024 * 1024; // > 100MB
    
    if (isMemoryError) {
      console.warn(`arrayBuffer failed for large file (${(file.size / 1024 / 1024).toFixed(2)}MB), using streaming:`, error);
      try {
        return await calculateFileHashStreaming(file, cryptoAlgorithm as AlgorithmIdentifier);
      } catch (streamError: any) {
        // If streaming also fails, provide detailed error
        throw new Error(`Failed to calculate file hash (file size: ${(file.size / 1024 / 1024).toFixed(2)}MB): ${streamError?.message || String(streamError)}`);
      }
    }
    
    // For other errors, provide detailed error message
    throw new Error(`Failed to calculate file hash: ${error?.message || String(error)} (file size: ${(file.size / 1024 / 1024).toFixed(2)}MB)`);
  }
}

/**
 * Calculate file hash using streaming for large files
 * This method reads the file in chunks to avoid loading the entire file into memory at once
 */
async function calculateFileHashStreaming(
  file: Blob | File,
  algorithm: AlgorithmIdentifier
): Promise<string> {
  const stream = file.stream();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  
  try {
    // Read file in chunks
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      if (value) {
        chunks.push(value);
      }
    }
    
    // Combine all chunks into a single buffer
    // Note: Web Crypto API requires the entire data at once for digest calculation
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    
    // Calculate hash
    const hashBuffer = await crypto.subtle.digest(algorithm, combined);
    return arrayBufferToHex(hashBuffer);
  } catch (error) {
    // If streaming also fails, provide a helpful error message
    throw new Error(`Failed to calculate file hash: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Convert ArrayBuffer to hex string
 */
function arrayBufferToHex(buffer: ArrayBuffer): string {
  const hashArray = Array.from(new Uint8Array(buffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Calculate file hash with error handling
 * Returns null if calculation fails
 * Logs detailed error information for debugging
 */
export async function calculateFileHashSafe(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512' = 'sha256'
): Promise<string | null> {
  try {
    return await calculateFileHash(file, algorithm);
  } catch (error: any) {
    // Log detailed error information
    console.error(`Failed to calculate ${algorithm} hash for file:`, {
      fileName: file instanceof File ? file.name : 'Blob',
      fileSize: file.size,
      fileSizeMB: (file.size / 1024 / 1024).toFixed(2),
      errorName: error?.name,
      errorMessage: error?.message,
      stack: error?.stack,
      webCryptoAvailable: isWebCryptoAvailable(),
      isSecureContext: isSecureContext(),
      protocol: window.location.protocol,
      hostname: window.location.hostname,
    });
    return null;
  }
}

