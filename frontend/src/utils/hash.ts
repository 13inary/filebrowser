/**
 * Calculate file hash using Web Crypto API
 * Supports SHA-1, SHA-256, SHA-384, SHA-512
 * Note: MD5 is not supported by Web Crypto API and would require an additional library
 */
export async function calculateFileHash(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512' = 'sha256'
): Promise<string> {
  const buffer = await file.arrayBuffer();
  
  // Convert algorithm name to Web Crypto API format
  // Input: 'sha256' -> Output: 'SHA-256'
  // Input: 'sha1' -> Output: 'SHA-1'
  // Input: 'sha384' -> Output: 'SHA-384'
  // Input: 'sha512' -> Output: 'SHA-512'
  const cryptoAlgorithm = algorithm.toUpperCase().replace(/^SHA/, 'SHA-');
  
  const hashBuffer = await crypto.subtle.digest(
    cryptoAlgorithm as AlgorithmIdentifier,
    buffer
  );
  
  // Convert ArrayBuffer to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return hashHex;
}

/**
 * Calculate file hash with error handling
 * Returns null if calculation fails
 */
export async function calculateFileHashSafe(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512' = 'sha256'
): Promise<string | null> {
  try {
    return await calculateFileHash(file, algorithm);
  } catch (error) {
    console.warn(`Failed to calculate ${algorithm} hash:`, error);
    return null;
  }
}

