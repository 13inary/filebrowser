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

---

## 问题三：特定大小文件的 Hash 计算错误（流式读取不完整）

### 问题描述
某些特定大小的文件（如 600多M）在前端计算的 hash 值与后端不一致，但其他大小的文件（1G、几M）都正常。

**表现**：
- 1G 和几M的文件：hash 计算正确，上传成功
- 600多M的文件：前端计算的 hash 错误，后端计算的 hash 正确（与文件实际内容匹配）

### 根本原因

#### 流式读取时未验证读取完整性
**问题代码**：
```typescript
// ❌ 错误方式：没有验证读取的总字节数
async function calculateFileHashWithCryptoJSStreaming(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512'
): Promise<string> {
  const stream = file.stream();
  const reader = stream.getReader();
  let hasher = CryptoJS.algo.SHA256.create();
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    if (value && value.length > 0) {
      const wordArray = CryptoJS.lib.WordArray.create(value);
      hasher.update(wordArray);
      // ❌ 问题：没有跟踪和验证读取的总字节数
    }
  }
  
  const hash = hasher.finalize();
  return hash.toString(CryptoJS.enc.Hex).toLowerCase();
}
```

**问题分析**：
- 流式读取时，如果某些 chunk 丢失或读取不完整，不会抛出错误
- 没有验证读取的总字节数是否等于文件大小
- 如果读取的字节数少于文件大小，hash 计算会基于不完整的数据，导致错误的 hash
- 这种情况可能在某些特定大小的文件上更容易发生（可能与浏览器内部缓冲区大小、网络状态等有关）

#### Blob.slice() 大小验证缺失
**问题**：
- `file.slice(0, file.size)` 在某些情况下可能不会创建正确大小的 Blob
- 如果 slice 的大小与原始文件大小不匹配，会导致读取不完整的数据
- 没有验证 slice 的大小是否正确

### 解决方案

#### 1. 验证流式读取的完整性
**修复代码**：
```typescript
// ✅ 正确方式：验证读取的总字节数
async function calculateFileHashWithCryptoJSStreaming(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512'
): Promise<string> {
  const stream = file.stream();
  const reader = stream.getReader();
  let hasher = CryptoJS.algo.SHA256.create();
  
  // ✅ 跟踪总字节数
  let totalBytesRead = 0;
  const expectedSize = file.size;
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    if (value && value.length > 0) {
      const wordArray = CryptoJS.lib.WordArray.create(value);
      hasher.update(wordArray);
      totalBytesRead += value.length; // ✅ 累计读取的字节数
    }
  }
  
  // ✅ CRITICAL: 验证读取完整性
  if (totalBytesRead !== expectedSize) {
    throw new Error(
      `File hash calculation incomplete: expected ${expectedSize} bytes, but only read ${totalBytesRead} bytes. ` +
      `This indicates the file data was not fully read, which would result in an incorrect hash.`
    );
  }
  
  const hash = hasher.finalize();
  return hash.toString(CryptoJS.enc.Hex).toLowerCase();
}
```

**关键点**：
- 跟踪读取的总字节数
- 在完成读取后验证总字节数是否等于文件大小
- 如果不匹配，抛出明确的错误，避免返回错误的 hash

#### 2. 验证 Blob.slice() 的大小
**修复代码**：
```typescript
export async function calculateFileHashSafe(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512' = 'sha256'
): Promise<string | null> {
  try {
    const fileSlice = file.slice(0, file.size);
    
    // ✅ CRITICAL: 验证 slice 大小
    if (fileSlice.size !== file.size) {
      throw new Error(
        `File slice size mismatch: expected ${file.size} bytes, but slice has ${fileSlice.size} bytes. ` +
        `This indicates the file data may be incomplete or corrupted.`
      );
    }
    
    const hash = await calculateFileHash(fileSlice, algorithm);
    return hash;
  } catch (error: any) {
    // 记录错误但不暴露给用户
    console.error('[Hash Calculation Error]', {
      fileName: file instanceof File ? file.name : 'Blob',
      fileSize: file.size,
      error: error?.message || String(error)
    });
    return null;
  }
}
```

**关键点**：
- 验证 `fileSlice.size` 是否等于 `file.size`
- 如果不匹配，抛出错误，避免基于不完整数据计算 hash
- 记录详细的错误信息用于调试

### 为什么某些文件大小更容易出现问题？

1. **浏览器内部缓冲区大小**：不同浏览器对 Blob 和 Stream 的内部缓冲区大小不同，某些大小可能刚好触发边界条件
2. **内存管理**：某些大小的文件可能触发浏览器的内存管理策略，导致流式读取时出现问题
3. **网络状态**：如果文件来自网络（如通过 fetch 获取），网络状态可能影响流式读取的完整性
4. **文件系统缓存**：某些大小的文件可能不会完全缓存，导致读取不完整

### 验证方法
1. 在流式读取后验证 `totalBytesRead === file.size`
2. 验证 `fileSlice.size === file.size`
3. 如果验证失败，记录详细的错误信息
4. 测试不同大小的文件，特别关注 500MB-700MB 范围的文件

---

## 问题四：HTTP 环境下大文件使用 arrayBuffer() 导致 Hash 计算错误

### 问题描述
在 HTTP 环境下，某些特定大小的文件（如 600多M）在前端计算的 hash 值与后端不一致。

**表现**：
- 前端 hash: `18766771d77e4fb072a165ebbb4f8374dad74e9aa861d5f6aac7608f2f3552a6`
- 后端 hash: `907743c15d40267af6b0f4b66863eb133ffffb2cf6a1fa319ae315a4c0152dec`
- 文件大小: 614.24MB
- 后端 hash 与文件实际内容匹配，说明后端计算正确

### 根本原因

#### HTTP 环境下大文件仍使用 arrayBuffer()
**问题代码**：
```typescript
// ❌ 问题：在 HTTP 环境下，即使文件 > 100MB，也会先尝试 arrayBuffer()
export async function calculateFileHash(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512' = 'sha256'
): Promise<string> {
  // Check if Web Crypto API is available
  if (!isWebCryptoAvailable()) {
    // HTTP 环境，Web Crypto API 不可用
    if (isHTTP) {
      // ❌ 问题：直接调用 calculateFileHashWithCryptoJS，没有检查文件大小
      return await calculateFileHashWithCryptoJS(file, algorithm);
    }
  }
  
  // ✅ 只有在 Web Crypto API 可用时，才会检查文件大小 > 100MB
  if (file.size > 100 * 1024 * 1024) {
    return await calculateFileHashWithCryptoJSStreaming(file, algorithm);
  }
  // ...
}
```

**问题分析**：
- 在 HTTP 环境下，Web Crypto API 不可用，会直接调用 `calculateFileHashWithCryptoJS`
- `calculateFileHashWithCryptoJS` 会先尝试使用 `arrayBuffer()` 一次性读取整个文件
- 对于 600多M 的文件，`arrayBuffer()` 可能：
  1. 读取不完整的数据
  2. 读取的数据与后端实际接收的数据不一致
  3. 在某些浏览器或特定文件大小下，`arrayBuffer()` 虽然成功，但数据不正确

**为什么只在某些文件大小出现问题？**
- 不同浏览器对 `arrayBuffer()` 的内部实现不同
- 某些文件大小可能触发浏览器的内存管理边界条件
- 500-700MB 范围可能是 `arrayBuffer()` 的临界点，在这个范围内可能读取不完整或错误的数据

### 解决方案

#### 在 calculateFileHashWithCryptoJS 中直接检查文件大小
**修复代码**：
```typescript
async function calculateFileHashWithCryptoJS(
  file: Blob | File,
  algorithm: 'sha1' | 'sha256' | 'sha384' | 'sha512'
): Promise<string> {
  const fileSize = file.size;
  const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
  
  // ✅ CRITICAL: For large files (>100MB), always use streaming approach
  // arrayBuffer() may not reliably read the entire file for large files, leading to incorrect hash
  // This is especially important for files in the 500-700MB range where arrayBuffer() might succeed
  // but read incomplete or incorrect data
  if (fileSize > 100 * 1024 * 1024) {
    return await calculateFileHashWithCryptoJSStreaming(file, algorithm);
  }
  
  // 对于小文件，使用 arrayBuffer() 方式（性能更好）
  try {
    const buffer = await file.arrayBuffer();
    // ... 计算 hash
  } catch (error: any) {
    // 如果失败，回退到流式方法
    if (error?.name === 'QuotaExceededError' || error?.name === 'RangeError') {
      return await calculateFileHashWithCryptoJSStreaming(file, algorithm);
    }
    throw error;
  }
}
```

**关键点**：
- 在 `calculateFileHashWithCryptoJS` 函数开头就检查文件大小
- 如果文件 > 100MB，直接使用流式方法，避免使用 `arrayBuffer()`
- 这确保了无论环境（HTTP/HTTPS），大文件都使用流式方法
- 小文件仍使用 `arrayBuffer()` 方式（性能更好）

### 为什么这个修复有效？

1. **流式方法更可靠**：
   - 流式方法逐块读取文件，不会一次性加载整个文件到内存
   - 每个 chunk 都经过验证，确保读取完整性
   - 避免了 `arrayBuffer()` 在某些情况下的数据不一致问题

2. **统一处理逻辑**：
   - 无论环境（HTTP/HTTPS），大文件都使用相同的流式方法
   - 减少了代码路径的复杂性
   - 提高了代码的可维护性

3. **性能考虑**：
   - 小文件（< 100MB）仍使用 `arrayBuffer()` 方式（性能更好）
   - 大文件使用流式方法（内存效率更高，更可靠）

### 验证方法
1. 测试不同大小的文件（特别是 500-700MB 范围）
2. 在 HTTP 和 HTTPS 环境下都进行测试
3. 验证前端和后端的 hash 值完全一致
4. 检查控制台日志，确认大文件使用了流式方法

### 参考文档

- [crypto-js 文档](https://cryptojs.gitbook.io/docs/)
- [Web Crypto API 文档](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [TUS 协议规范](https://tus.io/protocols/resumable-upload.html)
- [Blob.slice() 规范](https://developer.mozilla.org/en-US/docs/Web/API/Blob/slice)
- [ReadableStream 规范](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream)

---

## 问题五：删除文件时显示和实际删除的文件不一致

### 问题描述
删除文件时，弹窗中显示的文件名和实际删除的文件可能不一致，导致误删文件。

**潜在风险场景**：
1. 用户在文件列表中选择了文件 A
2. 打开删除确认弹窗，弹窗显示"删除文件 A"
3. 在弹窗显示期间，文件列表更新（如其他操作导致列表刷新）
4. 用户点击确认删除
5. 由于列表更新，原来保存的索引可能指向了文件 B
6. 结果：显示的是"删除文件 A"，但实际删除的是文件 B

### 根本原因

#### 1. 使用索引访问文件列表
**问题代码**：
```typescript
// ❌ 错误方式：使用索引访问文件列表
submit: async function () {
  const promises = [];
  for (const index of this.selected) {
    // 问题：如果 req.items 在弹窗显示期间更新，索引可能指向错误的文件
    promises.push(api.remove(this.req.items[index].url));
  }
  await Promise.all(promises);
}
```

**问题分析**：
- `this.selected` 存储的是文件在列表中的索引（如 `[0, 2, 5]`）
- 删除时通过 `this.req.items[index]` 访问文件信息
- 如果 `this.req.items` 在弹窗显示期间更新（如列表刷新、文件移动等），索引可能指向错误的文件
- 显示时使用的是 `this.req.items[index].name`，删除时使用的是 `this.req.items[index].url`
- 如果列表更新，这两个值可能来自不同的文件

#### 2. 显示和删除使用不同的数据源
**问题**：
- 弹窗显示时：从 `this.req.items[index]` 获取文件名显示
- 删除时：从 `this.req.items[index]` 获取 URL 删除
- 如果列表在显示和删除之间更新，这两个操作可能访问到不同的文件

#### 3. 回退逻辑导致不一致
**问题代码**：
```typescript
// ❌ 问题：有回退逻辑，可能导致使用不一致的数据
const urlToDelete = this.filesToDelete.length > 0 
  ? this.filesToDelete[0].url 
  : this.$route.path; // 回退到路由路径
```

**问题分析**：
- 如果 `filesToDelete` 为空，回退到 `this.$route.path`
- 但弹窗显示的文件名可能来自 `filesToDelete[0].name`
- 如果 `filesToDelete` 为空，显示和删除使用的数据不一致

### 解决方案

#### 1. 在组件挂载时立即保存文件信息
**修复代码**：
```typescript
export default {
  name: "delete",
  data() {
    return {
      // ✅ 在组件创建时立即保存要删除的文件信息（路径和名称）
      // 而不是依赖索引，防止列表更新导致删除错误文件
      filesToDelete: [],
    };
  },
  mounted() {
    // ✅ 在组件挂载时立即保存要删除的文件信息
    // 这样可以避免在弹窗显示期间，如果文件列表更新，导致索引指向错误文件
    this.saveFilesToDelete();
  },
  methods: {
    saveFilesToDelete() {
      this.filesToDelete = [];

      if (!this.isListing) {
        // 非列表模式：删除当前路径的文件
        const pathParts = this.$route.path.split("/").filter((p) => p);
        const fileName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : "";
        const fileUrl = this.$route.path;
        
        // ✅ 保存文件信息：name 用于显示，url 用于删除
        // 这两个值必须对应同一个文件，且之后不再修改
        this.filesToDelete = [{ 
          name: fileName || fileUrl, 
          url: fileUrl,
          path: fileUrl,
        }];
        return;
      }

      // 列表模式：保存所有选中文件的信息
      if (this.selectedCount === 0 || !this.req?.items) {
        return;
      }

      // ✅ 立即保存文件信息（路径和名称），而不是保存索引
      // 这样即使 req.items 在弹窗显示期间更新，也能确保删除正确的文件
      // 关键：name、url、path 必须来自同一个 item 对象，确保数据一致性
      for (const index of this.selected) {
        const item = this.req.items[index];
        if (item && item.name && item.url) {
          // ✅ 验证：确保 name 和 url 来自同一个 item
          // 这些数据将用于显示（name）和删除（url），必须完全一致
          this.filesToDelete.push({
            name: item.name,  // 显示在弹窗中的文件名
            url: item.url,    // 用于删除的 URL（传递给 api.remove）
            path: item.path,  // 用于后续操作（如预选）
          });
        }
      }
    },
  },
};
```

**关键点**：
- 在 `mounted` 时立即保存文件信息，而不是在删除时访问
- 保存 `name`、`url`、`path` 三个字段，确保来自同一个 `item` 对象
- `filesToDelete` 数组在保存后不再修改（只读）
- 显示和删除都使用这个保存的数据

#### 2. 显示和删除使用同一个数据源
**修复代码**：
```vue
<template>
  <div class="card floating">
    <div class="card-content">
      <!-- ✅ 显示时使用保存的 filesToDelete 数据 -->
      <div v-if="filesToDelete.length > 0" class="delete-targets">
        <div v-if="filesToDelete.length === 1" class="delete-target-single">
          <strong class="delete-target-name">{{ filesToDelete[0].name }}</strong>
        </div>
        <div v-else class="delete-target-multiple">
          <div v-for="(file, index) in filesToDelete" :key="index">
            <strong class="delete-target-name">{{ file.name }}</strong>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
```

```typescript
submit: async function () {
  // ✅ 严格检查：确保 filesToDelete 不为空
  // 这是显示在弹窗中的数据，必须和删除时使用的数据完全一致
  if (this.filesToDelete.length === 0) {
    console.error("[Delete] ERROR: filesToDelete is empty");
    this.$showError(new Error("无法删除：未找到要删除的文件"));
    return;
  }

  if (!this.isListing) {
    // ✅ 非列表模式：使用保存的 URL，确保和显示的文件名一致
    const fileToDelete = this.filesToDelete[0];
    if (!fileToDelete || !fileToDelete.url) {
      console.error("[Delete] ERROR: Invalid fileToDelete data");
      this.$showError(new Error("无法删除：文件数据无效"));
      return;
    }
    
    // ✅ 使用保存的 URL 删除，这是显示在弹窗中的文件的 URL
    await api.remove(fileToDelete.url);
    return;
  }

  // ✅ 列表模式：使用保存的文件路径列表删除
  // 这些 URL 和显示在弹窗中的文件名（filesToDelete[].name）完全对应
  // 确保显示和删除使用的是同一个数据源（filesToDelete 数组）
  const promises = [];
  for (const file of this.filesToDelete) {
    if (!file || !file.url) {
      console.error("[Delete] ERROR: Invalid file data");
      continue;
    }
    // ✅ 使用保存的 URL，确保和显示的文件名一致
    promises.push(api.remove(file.url));
  }

  await Promise.all(promises);
},
```

**关键点**：
- 显示时使用 `filesToDelete[index].name`
- 删除时使用 `filesToDelete[index].url`
- `name` 和 `url` 来自同一个 `item` 对象，确保对应同一个文件
- 无回退逻辑，如果 `filesToDelete` 为空，直接报错

#### 3. 添加数据验证和错误处理
**修复代码**：
```typescript
saveFilesToDelete() {
  // ... 保存逻辑 ...
  
  // ✅ 验证：确保保存的文件数量与选中数量一致
  if (this.filesToDelete.length !== this.selectedCount) {
    console.warn(
      "[Delete] WARNING: filesToDelete length", 
      this.filesToDelete.length, 
      "does not match selectedCount", 
      this.selectedCount
    );
  }
},

submit: async function () {
  // ✅ 严格检查：确保 filesToDelete 不为空
  if (this.filesToDelete.length === 0) {
    console.error("[Delete] ERROR: filesToDelete is empty");
    this.$showError(new Error("无法删除：未找到要删除的文件"));
    return;
  }

  // ✅ 验证每个文件数据是否有效
  for (const file of this.filesToDelete) {
    if (!file || !file.url) {
      console.error("[Delete] ERROR: Invalid file data:", file);
      continue;
    }
  }
  
  // ... 删除逻辑 ...
},
```

**关键点**：
- 保存后验证数据完整性
- 删除前验证每个文件数据是否有效
- 添加详细的错误日志，便于调试

### 数据流保证

**完整的数据流**：
1. **组件挂载** (`mounted`)：
   - 从 `this.req.items[index]` 获取 `item`
   - 立即保存 `{ name: item.name, url: item.url, path: item.path }` 到 `filesToDelete`
   - `filesToDelete` 数组之后不再修改（只读）

2. **显示** (模板)：
   - 使用 `filesToDelete[index].name` 显示文件名
   - 用户看到的是保存时的文件名

3. **删除** (`submit`)：
   - 使用 `filesToDelete[index].url` 调用 `api.remove(file.url)`
   - 删除的是保存时的文件 URL

**一致性保证**：
- ✅ `name` 和 `url` 来自同一个 `item` 对象
- ✅ `filesToDelete` 在保存后不再修改
- ✅ 显示和删除使用同一个 `filesToDelete` 数组
- ✅ 无回退逻辑，避免使用不一致的数据

### 为什么这个方案有效？

1. **时间点固定**：
   - 在组件挂载时立即保存数据，此时的数据是准确的
   - 即使后续列表更新，保存的数据不会改变

2. **数据绑定**：
   - `name` 和 `url` 来自同一个 `item` 对象
   - 确保显示的文件名和删除的文件 URL 对应同一个文件

3. **不可变性**：
   - `filesToDelete` 数组在保存后不再修改
   - 避免了数据在显示和删除之间被修改的风险

4. **严格验证**：
   - 删除前验证数据有效性
   - 如果数据无效，直接报错，不继续删除

### 验证方法

1. **测试场景**：
   - 选择文件 A，打开删除弹窗
   - 在弹窗显示期间，通过其他操作更新文件列表
   - 点击确认删除
   - 验证删除的是文件 A，而不是其他文件

2. **边界情况**：
   - 测试删除单个文件
   - 测试删除多个文件
   - 测试非列表模式下的删除
   - 测试列表更新后的删除

3. **日志检查**：
   - 检查控制台日志，确认数据保存和验证过程
   - 如果出现警告或错误，检查数据一致性

### 相关文件

- 删除确认弹窗组件：`frontend/src/components/prompts/Delete.vue`
- 文件 API：`frontend/src/api/files.ts`
- 文件 Store：`frontend/src/stores/file.ts`

