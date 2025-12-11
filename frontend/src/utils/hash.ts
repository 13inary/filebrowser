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
  const fileName = file instanceof File ? file.name : 'Blob';
  const fileSize = file.size;
  const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
  
  // CRITICAL: For large files (>100MB), always use streaming approach
  // arrayBuffer() may not reliably read the entire file for large files, leading to incorrect hash
  // This is especially important for files in the 500-700MB range where arrayBuffer() might succeed
  // but read incomplete or incorrect data
  if (fileSize > 100 * 1024 * 1024) {
    return await calculateFileHashWithCryptoJSStreaming(file, algorithm);
  }
  
  try {
    // IMPORTANT: Don't create a slice here - file should already be a fresh slice
    // Creating a slice here might cause issues if the file has already been sliced
    // Just read the file directly
    const buffer = await file.arrayBuffer();
    
    // Verify buffer size matches file size
    if (buffer.byteLength !== fileSize) {
      const errorMsg = `Buffer size mismatch: expected ${fileSize} bytes, but got ${buffer.byteLength} bytes`;
      console.error(`[Hash Calculation] ERROR: ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
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
    
    const hashHex = hash.toString(CryptoJS.enc.Hex).toLowerCase();
    
    // Ensure lowercase hex output (consistent with backend)
    return hashHex;
  } catch (error: any) {
    console.error(`[Hash Calculation] ERROR during crypto-js hash calculation:`, {
      fileName,
      fileSize,
      fileSizeMB,
      algorithm,
      error: error?.message || String(error),
      errorName: error?.name,
      stack: error?.stack
    });
    
    // If arrayBuffer fails (memory issue), try streaming approach
    if (error?.name === 'QuotaExceededError' || error?.name === 'RangeError') {
      console.log(`[Hash Calculation] Falling back to streaming approach due to: ${error?.name}`);
      return await calculateFileHashWithCryptoJSStreaming(file, algorithm);
    }
    throw error;
  }
}

/**
 * Calculate file hash using crypto-js with incremental streaming (for large files)
 * 
 * This function uses incremental hashing to avoid loading the entire file into memory.
 * It processes the file in chunks and updates the hash incrementally.
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
  const fileName = file instanceof File ? file.name : 'Blob';
  const fileSize = file.size;
  const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
  
  const stream = file.stream();
  const reader = stream.getReader();
  
  // Initialize hash object for incremental updates
  // Use any type to avoid TypeScript issues with crypto-js type definitions
  let hasher: any;
  switch (algorithm) {
    case 'sha1':
      hasher = CryptoJS.algo.SHA1.create();
      break;
    case 'sha256':
      hasher = CryptoJS.algo.SHA256.create();
      break;
    case 'sha384':
      hasher = CryptoJS.algo.SHA384.create();
      break;
    case 'sha512':
      hasher = CryptoJS.algo.SHA512.create();
      break;
    default:
      throw new Error(`Unsupported algorithm: ${algorithm}`);
  }
  
  try {
    // Track total bytes read to verify we read the entire file
    // This is critical to detect if any chunks were lost or if the stream was incomplete
    let totalBytesRead = 0;
    const expectedSize = file.size;
    let chunkCount = 0;
    let firstChunkBytes: number[] | null = null;
    let lastChunkBytes: number[] | null = null;
    
    // Read file in chunks and update hash incrementally
    // This avoids loading the entire file into memory
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      if (value && value.length > 0) {
        chunkCount++;
        
        // Record first chunk bytes for debugging
        if (chunkCount === 1 && value.length >= 16) {
          firstChunkBytes = Array.from(value.slice(0, 16));
        }
        
        // Record last chunk bytes for debugging
        if (value.length >= 16) {
          lastChunkBytes = Array.from(value.slice(-16));
        }
        
        // Convert chunk to WordArray and update hash incrementally
        const wordArray = CryptoJS.lib.WordArray.create(value);
        hasher.update(wordArray);
        totalBytesRead += value.length;
        
        // Log progress for large files (every 100MB)
        if (chunkCount % 100 === 0) {
          const progressMB = (totalBytesRead / 1024 / 1024).toFixed(2);
          console.log(`[Hash Calculation] Progress: ${chunkCount} chunks, ${progressMB}MB read`);
        }
      }
    }
    
    // CRITICAL: Verify that we read the entire file
    // If the bytes read don't match the file size, the hash will be incorrect
    // This can happen if:
    // 1. The file was modified during reading
    // 2. The stream was incomplete or truncated
    // 3. There was a race condition with file access
    if (totalBytesRead !== expectedSize) {
      const errorMsg = `File hash calculation incomplete: expected ${expectedSize} bytes, but only read ${totalBytesRead} bytes. ` +
        `This indicates the file data was not fully read, which would result in an incorrect hash.`;
      console.error(`[Hash Calculation] ERROR: ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    // Finalize hash calculation
    const hash = hasher.finalize();
    const hashHex = hash.toString(CryptoJS.enc.Hex).toLowerCase();
    
    // Log first and last bytes for debugging (useful when hash mismatch occurs)
    if (firstChunkBytes && lastChunkBytes) {
      const firstBytesHex = firstChunkBytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
      const lastBytesHex = lastChunkBytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`[Hash Calculation] Streaming complete: ${chunkCount} chunks, ${fileSizeMB}MB, first16bytes=${firstBytesHex.substring(0, 32)}..., last16bytes=...${lastBytesHex.substring(lastBytesHex.length - 32)}`);
    }
    
    // Ensure lowercase hex output (consistent with backend)
    return hashHex;
  } catch (error: any) {
    console.error(`[Hash Calculation] ERROR during streaming hash calculation:`, {
      fileName,
      fileSize,
      fileSizeMB,
      algorithm,
      error: error?.message || String(error),
      stack: error?.stack
    });
    throw error;
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
  
  // For large files (>100MB), use crypto-js with incremental hashing instead of Web Crypto API
  // Web Crypto API requires loading the entire file into memory, which causes issues with large files
  // crypto-js supports incremental hashing, which is more memory-efficient
  if (file.size > 100 * 1024 * 1024) {
    // Use crypto-js with incremental streaming for large files
    try {
      return await calculateFileHashWithCryptoJSStreaming(file, algorithm);
    } catch (error: any) {
      throw new Error(`Failed to calculate file hash for large file (${(file.size / 1024 / 1024).toFixed(2)}MB): ${error?.message || String(error)}`);
    }
  }
  
  // Try arrayBuffer first (faster for smaller files)
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
    // If arrayBuffer fails (e.g., memory issue), fallback to crypto-js with incremental hashing
    // Check if it's a memory-related error
    const isMemoryError = 
      error?.name === 'QuotaExceededError' ||
      error?.name === 'RangeError' ||
      error?.message?.includes('memory') ||
      error?.message?.includes('quota');
    
    if (isMemoryError) {
      try {
        // Use crypto-js with incremental streaming as fallback
        return await calculateFileHashWithCryptoJSStreaming(file, algorithm);
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
  const fileName = file instanceof File ? file.name : 'Blob';
  const fileSize = file.size;
  const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
  const fileType = file instanceof File ? 'File' : 'Blob';
  
  try {
    // Always create a fresh slice to ensure we're reading the complete, unmodified file
    // This is critical because the file might have been partially read or modified
    const fileSlice = file.slice(0, file.size);
    
    // CRITICAL: Verify that the slice has the correct size
    // If the slice size doesn't match the original file size, it indicates a problem
    // This can happen if:
    // 1. The file was modified during slice creation
    // 2. The Blob.slice() implementation has a bug
    // 3. There's a race condition with file access
    if (fileSlice.size !== file.size) {
      const errorMsg = `File slice size mismatch: expected ${file.size} bytes, but slice has ${fileSlice.size} bytes. ` +
        `This indicates the file data may be incomplete or corrupted.`;
      console.error(`[Hash Calculation] ERROR: ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    const hash = await calculateFileHash(fileSlice, algorithm);
    
    console.log(`[Hash Calculation] Success: fileName=${fileName}, size=${fileSizeMB}MB, hash=${hash}`);
    
    return hash;
  } catch (error: any) {
    // Log error for debugging but don't expose to user
    console.error('[Hash Calculation] ERROR:', {
      fileName,
      fileType,
      fileSize,
      fileSizeMB,
      error: error?.message || String(error),
      algorithm,
      stack: error?.stack
    });
    // Silently return null on error - caller should handle the error appropriately
    return null;
  }
}

