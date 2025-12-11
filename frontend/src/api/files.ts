import { useAuthStore } from "@/stores/auth";
import { useLayoutStore } from "@/stores/layout";
import { baseURL } from "@/utils/constants";
import { upload as postTus, useTus } from "./tus";
import { createURL, fetchURL, removePrefix, StatusError } from "./utils";
import { calculateFileHashSafe } from "@/utils/hash";

export async function fetch(url: string, signal?: AbortSignal) {
  url = removePrefix(url);
  const res = await fetchURL(`/api/resources${url}`, { signal });

  let data: Resource;
  try {
    data = (await res.json()) as Resource;
  } catch (e) {
    // Check if the error is an intentional cancellation
    if (e instanceof Error && e.name === "AbortError") {
      throw new StatusError("000 No connection", 0, true);
    }
    throw e;
  }
  data.url = `/files${url}`;

  if (data.isDir) {
    if (!data.url.endsWith("/")) data.url += "/";
    // Perhaps change the any
    data.items = data.items.map((item: any, index: any) => {
      item.index = index;
      item.url = `${data.url}${encodeURIComponent(item.name)}`;

      if (item.isDir) {
        item.url += "/";
      }

      return item;
    });
  }

  return data;
}

async function resourceAction(url: string, method: ApiMethod, content?: any) {
  url = removePrefix(url);

  const opts: ApiOpts = {
    method,
  };

  if (content) {
    opts.body = content;
  }

  const res = await fetchURL(`/api/resources${url}`, opts);

  return res;
}

export async function remove(url: string) {
  return resourceAction(url, "DELETE");
}

export async function put(url: string, content = "") {
  return resourceAction(url, "PUT", content);
}

export function download(format: any, ...files: string[]) {
  let url = `${baseURL}/api/raw`;

  if (files.length === 1) {
    url += removePrefix(files[0]) + "?";
  } else {
    let arg = "";

    for (const file of files) {
      arg += removePrefix(file) + ",";
    }

    arg = arg.substring(0, arg.length - 1);
    arg = encodeURIComponent(arg);
    url += `/?files=${arg}&`;
  }

  if (format) {
    url += `algo=${format}&`;
  }

  window.open(url);
}

export async function post(
  url: string,
  content: ApiContent = "",
  overwrite = false,
  onupload: any = () => {}
) {
  // Use the pre-existing API if:
  const useResourcesApi =
    // a folder is being created
    url.endsWith("/") ||
    // We're not using http(s)
    (content instanceof Blob &&
      !["http:", "https:"].includes(window.location.protocol)) ||
    // Tus is disabled / not applicable
    !(await useTus(content));
  
  if (useResourcesApi) {
    return postResources(url, content, overwrite, onupload);
  }
  
  // Try TUS upload, fall back to POST if it fails (but not for hash calculation failures)
  try {
    return await postTus(url, content, overwrite, onupload);
  } catch (error: any) {
    // If TUS upload fails due to hash calculation, don't fall back (POST will also fail)
    // Only fall back for other errors (network issues, server errors, etc.)
    if (error?.message?.includes("hash") || error?.message?.includes("integrity")) {
      // Hash calculation failed - don't fall back, let it fail
      throw error;
    }
    // For other errors (network, server, etc.), fall back to regular POST
    console.warn("TUS upload failed, falling back to regular POST:", error);
    return postResources(url, content, overwrite, onupload);
  }
}

async function postResources(
  url: string,
  content: ApiContent = "",
  overwrite = false,
  onupload: any
) {
  url = removePrefix(url);

  let bufferContent: ArrayBuffer;
  let expectedSizeHeader = "";
  let checksumHeader = "";
  
  // Calculate file size and hash for integrity verification (required for POST uploads)
  if (content instanceof Blob) {
    expectedSizeHeader = content.size.toString();
    
    // Calculate hash for integrity verification (required by backend)
    const hash = await calculateFileHashSafe(content, "sha256");
    if (!hash) {
      // Hash calculation failed - reject upload
      const fileName = content instanceof File ? content.name : 'file';
      const fileSizeMB = (content.size / 1024 / 1024).toFixed(2);
      return Promise.reject(new Error(
        `无法计算文件哈希值（文件: ${fileName}, 大小: ${fileSizeMB}MB）。` +
        `请检查浏览器控制台获取详细信息，或尝试使用其他浏览器。`
      ));
    }
    checksumHeader = `sha256:${hash}`;
    
    if (
    !["http:", "https:"].includes(window.location.protocol)
  ) {
    bufferContent = await new Response(content).arrayBuffer();
    }
  }

  const authStore = useAuthStore();
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(
      "POST",
      `${baseURL}/api/resources${url}?override=${overwrite}`,
      true
    );
    request.setRequestHeader("X-Auth", authStore.jwt);
    
    // Add expected size header if available
    if (expectedSizeHeader) {
      request.setRequestHeader("X-Expected-Size", expectedSizeHeader);
    }
    
    // Add checksum header if calculated successfully
    if (checksumHeader) {
      request.setRequestHeader("X-Upload-Checksum", checksumHeader);
    }

    if (typeof onupload === "function") {
      request.upload.onprogress = onupload;
    }

    request.onload = () => {
      if (request.status === 200) {
        resolve(request.responseText);
      } else if (request.status === 409) {
        reject(request.status);
      } else {
        reject(request.responseText);
      }
    };

    request.onerror = () => {
      reject(new Error("001 Connection aborted"));
    };

    request.send(bufferContent || content);
  });
}

function moveCopy(
  items: any[],
  copy = false,
  overwrite = false,
  rename = false
) {
  const layoutStore = useLayoutStore();
  const promises = [];

  for (const item of items) {
    const from = item.from;
    const to = encodeURIComponent(removePrefix(item.to ?? ""));
    const url = `${from}?action=${
      copy ? "copy" : "rename"
    }&destination=${to}&override=${overwrite}&rename=${rename}`;
    promises.push(resourceAction(url, "PATCH"));
  }
  layoutStore.closeHovers();
  return Promise.all(promises);
}

export function move(items: any[], overwrite = false, rename = false) {
  return moveCopy(items, false, overwrite, rename);
}

export function copy(items: any[], overwrite = false, rename = false) {
  return moveCopy(items, true, overwrite, rename);
}

export async function checksum(url: string, algo: ChecksumAlg) {
  const data = await resourceAction(`${url}?checksum=${algo}`, "GET");
  return (await data.json()).checksums[algo];
}

export function getDownloadURL(file: ResourceItem, inline: any) {
  const params = {
    ...(inline && { inline: "true" }),
  };

  return createURL("api/raw" + file.path, params);
}

export function getPreviewURL(file: ResourceItem, size: string) {
  const params = {
    inline: "true",
    key: Date.parse(file.modified),
  };

  return createURL("api/preview/" + size + file.path, params);
}

export function getSubtitlesURL(file: ResourceItem) {
  const params = {
    inline: "true",
  };

  return file.subtitles?.map((d) => createURL("api/subtitle" + d, params));
}

export async function usage(url: string, signal: AbortSignal) {
  url = removePrefix(url);

  const res = await fetchURL(`/api/usage${url}`, { signal });

  try {
    return await res.json();
  } catch (e) {
    // Check if the error is an intentional cancellation
    if (e instanceof Error && e.name == "AbortError") {
      throw new StatusError("000 No connection", 0, true);
    }
    throw e;
  }
}
