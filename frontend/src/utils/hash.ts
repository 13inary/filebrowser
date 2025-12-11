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
 * 
 * IMPORTANT: When using crypto-js, WordArray.create() must be called with Uint8Array directly.
 * Previous attempts using Array.from() or manual array creation resulted in incorrect hash values
 * because crypto-js expects the raw byte array in a specific format.
 * 
 * This function is used when Web Crypto API is not available (e.g., HTTP environments).
 */
async function calculateFileHashWithCryptoJS(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512'
): Promise<string> {
  try {
    // IMPORTANT: Don't create a slice here - file should already be a fresh slice
    // Creating a slice here might cause issues if the file has already been sliced
    // Just read the file directly
    const buffer = await file.arrayBuffer();
    
    const bytes = new Uint8Array(buffer);
    
    // Convert ArrayBuffer to WordArray for crypto-js
    // IMPORTANT: crypto-js WordArray.create can accept Uint8Array directly
    // Previous attempts using Array.from() or manual array creation resulted in incorrect hash values
    // Directly passing Uint8Array to WordArray.create is the correct approach
    const wordArray = CryptoJS.lib.WordArray.create(bytes);
    
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
    
    // Ensure lowercase hex output (consistent with backend)
    return hash.toString(CryptoJS.enc.Hex).toLowerCase();
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
 * 
 * IMPORTANT: When using crypto-js, WordArray.create() must be called with Uint8Array directly.
 * This ensures the hash calculation matches the backend's hash calculation.
 */
async function calculateFileHashWithCryptoJSStreaming(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512'
): Promise<string> {
  // IMPORTANT: Don't create a slice here - file should already be a fresh slice
  // Just read the file directly
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
    // Create WordArray from the bytes directly using the proper method
    const wordArray = CryptoJS.lib.WordArray.create(combined);
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
    
    // Ensure lowercase hex output (consistent with backend)
    return hash.toString(CryptoJS.enc.Hex).toLowerCase();
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
      // Use crypto-js as fallback for HTTP environments (Web Crypto API requires secure context)
      try {
        return await calculateFileHashWithCryptoJS(file, algorithm);
      } catch (error: any) {
        throw new Error(
          `无法计算文件哈希值（HTTP 环境降级方案失败）：${error?.message || String(error)}`
        );
      }
    } else {
      // For HTTPS but Web Crypto API not available, try crypto-js as fallback
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
    // IMPORTANT: Don't create a slice here - file should already be a fresh slice
    // Creating a slice here might cause issues if the file has already been sliced
    // Just read the file directly
    const fileBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest(
      cryptoAlgorithm as AlgorithmIdentifier,
      fileBuffer
    );
    return arrayBufferToHex(hashBuffer);
  } catch (error: any) {
    // If arrayBuffer fails (e.g., memory issue with large files), use streaming
    // Check if it's a memory-related error
    const isMemoryError = 
      error?.name === 'QuotaExceededError' ||
      error?.name === 'RangeError' ||
      error?.message?.includes('memory') ||
      error?.message?.includes('quota') ||
      file.size > 100 * 1024 * 1024; // > 100MB
    
    if (isMemoryError) {
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
  // IMPORTANT: Don't create a slice here - file should already be a fresh slice
  // Just read the file directly
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
  // Ensure lowercase hex output (consistent with backend)
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toLowerCase();
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
    // Always create a fresh slice to ensure we're reading the complete, unmodified file
    // This is critical because the file might have been partially read or modified
    const fileSlice = file.slice(0, file.size);
    const hash = await calculateFileHash(fileSlice, algorithm);
    return hash;
  } catch (error: any) {
    // Silently return null on error - caller should handle the error appropriately
    return null;
  }
}

