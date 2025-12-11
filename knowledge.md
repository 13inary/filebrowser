# Filebrowser 文件上传 Hash 计算问题知识库

本文档记录了在文件上传功能开发过程中遇到的 hash 计算相关问题及其解决方案。

## 问题一：前端和后端 Hash 计算结果不一致

### 问题描述
前端计算的 hash 值与后端计算的 hash 值不一致，导致文件完整性验证失败。

**示例错误**：
- 前端 hash: `e492104db3b04c6c3bc7ac7d1f04b4caa2c2a77dde8ba07f117936d486a05e2a`
- 后端 hash: `c4e4fde83fe0f393157e7fc56a5d4722d73cdf73e2f95f823069e0e865372dd9`
- 后端 hash 与 Linux 的 `sha256sum` 命令结果一致，说明后端计算正确

### 根本原因

#### 1. 数据转换方式错误
**问题代码**：
```typescript
// ❌ 错误方式：使用 Array.from() 转换
const bytes = Array.from(new Uint8Array(buffer));
const wordArray = CryptoJS.lib.WordArray.create(bytes);
```

**原因**：
- `crypto-js` 的 `WordArray.create()` 方法期望接收原始的字节数组格式
- 使用 `Array.from()` 或其他手动数组创建方式会导致数据格式不匹配
- 这会导致 hash 计算结果与后端不一致

#### 2. 文件在计算 Hash 前已被读取或修改
**问题场景**：
- 在 TUS 上传流程中，`tus.Upload` 可能在创建时就开始读取文件
- 文件对象在传递过程中可能被修改
- 计算 hash 时使用的可能不是原始、未修改的文件数据

**表现**：
- 控制台显示 `fileName: "Blob"`，说明传入的可能是已处理的 Blob
- 文件在计算 hash 前可能已被部分读取

#### 3. 文件切片处理问题
**问题**：
- 在 `tus.ts` 中，先创建了 `fileSlice`，然后调用 `calculateFileHashSafe`
- `calculateFileHashSafe` 内部又创建了一个 slice
- 这可能导致双重 slice，但应该不会影响结果
- 关键是要确保在计算 hash 时，使用的是原始、未修改的文件数据

### 解决方案

#### 1. 使用正确的数据转换方式
**修复代码**：
```typescript
// ✅ 正确方式：直接传递 Uint8Array
const buffer = await file.arrayBuffer();
const bytes = new Uint8Array(buffer);
const wordArray = CryptoJS.lib.WordArray.create(bytes);
```

**关键点**：
- `crypto-js` 的 `WordArray.create()` 可以直接接受 `Uint8Array`
- 不需要使用 `Array.from()` 或其他转换方式
- 直接传递 `Uint8Array` 是正确的方法

#### 2. 确保使用原始文件数据
**修复代码**：
```typescript
export async function calculateFileHashSafe(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512' = 'sha256'
): Promise<string | null> {
  try {
    // 始终创建一个新的 slice，确保读取完整、未修改的文件
    // 这很关键，因为文件可能已被部分读取或修改
    const fileSlice = file.slice(0, file.size);
    const hash = await calculateFileHash(fileSlice, algorithm);
    return hash;
  } catch (error: any) {
    return null;
  }
}
```

**关键点**：
- 在计算 hash 前，始终创建一个新的 `file.slice(0, file.size)`
- 这确保读取的是完整、未修改的文件数据
- 避免使用可能已被部分读取的文件对象

#### 3. 在正确的时机计算 Hash
**TUS 上传流程**：
```typescript
// ✅ 正确：在创建 tus.Upload 之前计算 hash
const hash = await calculateFileHashSafe(content, "sha256");
if (!hash) {
  return Promise.reject(new Error("无法计算文件哈希值"));
}

const upload = new tus.Upload(content, {
  endpoint: `${origin}${baseURL}${resourcePath}`,
  headers: {
    "Upload-Checksum": `sha256 ${hash}`,
  },
  // ...
});
```

**关键点**：
- 在创建 `tus.Upload` 之前计算 hash
- 确保文件在计算 hash 时还没有被读取
- 将 hash 作为 header 传递给后端

### 验证方法
1. 使用 Linux 的 `sha256sum` 命令验证后端计算结果
2. 确保前端和后端的 hash 值完全一致（包括大小写）
3. 测试不同大小的文件，确保 hash 计算正确

---

## 问题二：大文件 Hash 计算失败（内存溢出）

### 问题描述
上传 1.3G 的大文件时，报错"无法计算 hash"，导致上传失败。

### 根本原因

#### 1. 流式读取后仍合并所有数据到内存
**问题代码**：
```typescript
// ❌ 错误方式：虽然使用了流式读取，但仍将所有 chunks 合并到内存
async function calculateFileHashWithCryptoJSStreaming(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512'
): Promise<string> {
  const stream = file.stream();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  
  // 读取所有 chunks
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
    }
  }
  
  // ❌ 问题：合并所有 chunks 到单个 Uint8Array
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  
  // 计算 hash（需要整个文件在内存中）
  const wordArray = CryptoJS.lib.WordArray.create(combined);
  const hash = CryptoJS.SHA256(wordArray);
  return hash.toString(CryptoJS.enc.Hex).toLowerCase();
}
```

**问题分析**：
- 虽然使用了流式读取，但最终仍将所有 chunks 合并到一个大的 `Uint8Array`
- 对于 1.3G 的文件，这需要至少 1.3G 的内存空间
- 浏览器内存限制导致 `QuotaExceededError` 或 `RangeError`

#### 2. Web Crypto API 不支持增量更新
**问题**：
- Web Crypto API 的 `crypto.subtle.digest()` 方法需要一次性处理整个数据
- 不支持增量更新（update/finalize 模式）
- 即使使用流式读取，最终仍需要将整个文件加载到内存

**代码示例**：
```typescript
// ❌ Web Crypto API 需要整个文件在内存中
const fileBuffer = await file.arrayBuffer(); // 对于大文件会失败
const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
```

### 解决方案

#### 1. 使用 crypto-js 的增量 Hash 更新
**修复代码**：
```typescript
// ✅ 正确方式：使用增量 hash 更新，逐块处理，不加载整个文件到内存
async function calculateFileHashWithCryptoJSStreaming(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512'
): Promise<string> {
  const stream = file.stream();
  const reader = stream.getReader();
  
  // 初始化 hash 对象用于增量更新
  let hasher: any;
  switch (algorithm) {
    case 'sha256':
      hasher = CryptoJS.algo.SHA256.create();
      break;
    // ... 其他算法
  }
  
  try {
    // 逐块读取并增量更新 hash
    // 这避免了将整个文件加载到内存
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      if (value && value.length > 0) {
        // 将 chunk 转换为 WordArray 并增量更新 hash
        const wordArray = CryptoJS.lib.WordArray.create(value);
        hasher.update(wordArray); // ✅ 增量更新，不需要整个文件在内存
      }
    }
    
    // 完成 hash 计算
    const hash = hasher.finalize();
    return hash.toString(CryptoJS.enc.Hex).toLowerCase();
  } finally {
    reader.releaseLock();
  }
}
```

**关键点**：
- 使用 `CryptoJS.algo.SHA256.create()` 创建 hash 对象
- 使用 `hasher.update(wordArray)` 逐块更新 hash
- 使用 `hasher.finalize()` 完成 hash 计算
- 整个过程只需要当前 chunk 在内存中，不需要整个文件

#### 2. 大文件直接使用 crypto-js
**优化策略**：
```typescript
export async function calculateFileHash(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512' = 'sha256'
): Promise<string> {
  // ...
  
  // ✅ 对于大文件（>100MB），直接使用 crypto-js 增量 hash
  // Web Crypto API 需要加载整个文件到内存，对大文件不适用
  // crypto-js 支持增量 hashing，内存效率更高
  if (file.size > 100 * 1024 * 1024) {
    try {
      return await calculateFileHashWithCryptoJSStreaming(file, algorithm);
    } catch (error: any) {
      throw new Error(`Failed to calculate file hash for large file (${(file.size / 1024 / 1024).toFixed(2)}MB): ${error?.message || String(error)}`);
    }
  }
  
  // 对于小文件，优先使用 Web Crypto API（性能更好）
  // ...
}
```

**关键点**：
- 对于大于 100MB 的文件，直接使用 crypto-js 增量 hash
- 避免尝试 Web Crypto API（会导致内存问题）
- 对于小文件，仍使用 Web Crypto API（性能更好）

### 性能对比

| 方法 | 内存占用 | 适用文件大小 | 性能 |
|------|---------|------------|------|
| Web Crypto API (arrayBuffer) | 整个文件 | < 100MB | 快 |
| Web Crypto API (streaming) | 整个文件 | < 100MB | 中等 |
| crypto-js (一次性) | 整个文件 | < 100MB | 中等 |
| crypto-js (增量更新) | 仅当前 chunk | 无限制 | 慢但稳定 |

### 验证方法
1. 测试 1.3G 文件的上传，确保 hash 计算成功
2. 监控浏览器内存使用，确保不会溢出
3. 验证大文件的 hash 值与后端一致

---

## 总结

### 关键经验教训

1. **数据转换方式很重要**
   - 使用 `crypto-js` 时，直接传递 `Uint8Array` 给 `WordArray.create()`
   - 避免使用 `Array.from()` 或其他转换方式

2. **确保使用原始文件数据**
   - 在计算 hash 前，始终创建新的 `file.slice(0, file.size)`
   - 避免使用可能已被部分读取的文件对象

3. **大文件需要增量处理**
   - Web Crypto API 不支持增量更新，不适合大文件
   - 使用 `crypto-js` 的增量 hash 更新（update/finalize 模式）
   - 逐块处理，避免将整个文件加载到内存

4. **选择合适的策略**
   - 小文件（< 100MB）：使用 Web Crypto API（性能更好）
   - 大文件（> 100MB）：使用 crypto-js 增量 hash（内存效率更高）

### 相关文件

- Hash 计算工具：`frontend/src/utils/hash.ts`
- TUS 上传集成：`frontend/src/api/tus.ts`
- 普通 POST 上传集成：`frontend/src/api/files.ts`
- 后端验证逻辑：`http/tus_handlers.go`、`http/resource.go`

### 参考文档

- [crypto-js 文档](https://cryptojs.gitbook.io/docs/)
- [Web Crypto API 文档](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [TUS 协议规范](https://tus.io/protocols/resumable-upload.html)

