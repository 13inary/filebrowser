import { defineStore } from "pinia";
import { useFileStore } from "./file";
import { files as api } from "@/api";
import buttons from "@/utils/buttons";
import { computed, inject, markRaw, ref } from "vue";
import * as tus from "@/api/tus";

// TODO: make this into a user setting
const UPLOADS_LIMIT = 5;

const beforeUnload = (event: Event) => {
  event.preventDefault();
  // To remove >> is deprecated
  // event.returnValue = "";
};

export const useUploadStore = defineStore("upload", () => {
  const $showError = inject<IToastError>("$showError")!;

  let progressInterval: number | null = null;
  let isProcessing = false; // Lock to prevent concurrent processUploads calls

  //
  // STATE
  //

  const allUploads = ref<Upload[]>([]);
  const activeUploads = ref<Set<Upload>>(new Set());
  const lastUpload = ref<number>(-1);
  const totalBytes = ref<number>(0);
  const sentBytes = ref<number>(0);

  //
  // ACTIONS
  //

  const upload = (
    path: string,
    name: string,
    file: File | null,
    overwrite: boolean,
    type: ResourceType
  ) => {
    if (!hasActiveUploads() && !hasPendingUploads()) {
      window.addEventListener("beforeunload", beforeUnload);
      buttons.loading("upload");
    }

    const upload: Upload = {
      path,
      name,
      file,
      overwrite,
      type,
      totalBytes: file?.size || 1,
      sentBytes: 0,
      // Stores rapidly changing sent bytes value without causing component re-renders
      rawProgress: markRaw({
        sentBytes: 0,
      }),
    };

    totalBytes.value += upload.totalBytes;
    allUploads.value.push(upload);

    processUploads();
  };

  const abort = () => {
    // Resets the state by preventing the processing of the remaning uploads
    lastUpload.value = Infinity;
    tus.abortAllUploads();
  };

  //
  // GETTERS
  //

  const pendingUploadCount = computed(
    () =>
      allUploads.value.length -
      (lastUpload.value + 1) +
      activeUploads.value.size
  );

  //
  // PRIVATE FUNCTIONS
  //

  const hasActiveUploads = () => activeUploads.value.size > 0;

  const hasPendingUploads = () => {
    // Check if there are any uploads that haven't been processed yet
    // (not in activeUploads and not finished/failed)
    const processedCount = lastUpload.value + 1;
    return allUploads.value.length > processedCount;
  };
  
  const hasUnfinishedUploads = () => {
    // Check if there are any uploads that are still active or pending
    return hasActiveUploads() || hasPendingUploads();
  };

  const isActiveUploadsOnLimit = () => activeUploads.value.size < UPLOADS_LIMIT;

  const processUploads = async () => {
    // Prevent concurrent execution
    if (isProcessing) {
      return;
    }
    
    isProcessing = true;
    
    try {
      // Check if all uploads are finished (either completed or failed)
      if (!hasUnfinishedUploads()) {
        const fileStore = useFileStore();
        window.removeEventListener("beforeunload", beforeUnload);
        
        // Check if there are any failed uploads
        const hasFailedUploads = allUploads.value.some((u) => u.failed);
        
        if (hasFailedUploads) {
          // Show error state instead of success
          buttons.done("upload");
          // Don't reset immediately, let user see the error
          // Reset after a delay to allow error message to be visible
          setTimeout(() => {
            reset();
            fileStore.reload = true;
          }, 3000);
        } else {
          // All uploads succeeded
          buttons.success("upload");
          reset();
          fileStore.reload = true;
        }
        return;
      }

      if (isActiveUploadsOnLimit() && hasPendingUploads()) {
        if (!hasActiveUploads()) {
          // Update the state in a fixed time interval
          progressInterval = window.setInterval(syncState, 1000);
        }

        const upload = nextUpload();
        let uploadSucceeded = false;

        try {
          if (upload.type === "dir") {
            await api.post(upload.path);
            uploadSucceeded = true;
          } else {
            const onUpload = (event: ProgressEvent) => {
              upload.rawProgress.sentBytes = event.loaded;
            };

            await api.post(upload.path, upload.file!, upload.overwrite, onUpload);
            uploadSucceeded = true;
          }
        } catch (err: any) {
          // Mark upload as failed
          upload.failed = true;
          upload.error = err?.message || "Upload failed";
          
          // Show error to user (unless it's an abort)
          if (err?.message !== "Upload aborted") {
            // Extract error message from different error types
            let errorMessage = "Upload failed";
            if (err instanceof Error) {
              errorMessage = err.message;
            } else if (typeof err === "string") {
              errorMessage = err;
            } else if (err?.message) {
              errorMessage = err.message;
            } else if (err?.toString) {
              errorMessage = err.toString();
            }
            
            // Show detailed error message with file name
            $showError(new Error(`上传失败: "${upload.name}"\n${errorMessage}`));
          }
          
          // Remove from active uploads but keep in allUploads for tracking
          activeUploads.value.delete(upload);
          
          // Update sentBytes to reflect the actual bytes sent before failure
          sentBytes.value += upload.rawProgress.sentBytes - upload.sentBytes;
          upload.sentBytes = upload.rawProgress.sentBytes;
          
          // Continue processing other uploads (will be handled after unlock)
          // Don't call processUploads() here directly to avoid recursion
          return;
        }

        // Only finish upload if it succeeded
        if (uploadSucceeded) {
          finishUpload(upload);
        }
      }
    } finally {
      isProcessing = false;
      
      // After unlocking, check if there are more uploads to process
      // Use setTimeout to avoid immediate recursion and allow state to settle
      if (hasUnfinishedUploads()) {
        setTimeout(() => {
          processUploads();
        }, 0);
      }
    }
  };

  const nextUpload = (): Upload => {
    lastUpload.value++;

    const upload = allUploads.value[lastUpload.value];
    activeUploads.value.add(upload);

    return upload;
  };

  const finishUpload = (upload: Upload) => {
    sentBytes.value += upload.totalBytes - upload.sentBytes;
    upload.sentBytes = upload.totalBytes;
    upload.file = null;

    activeUploads.value.delete(upload);
    // Don't call processUploads() here directly - it will be called
    // after the current processUploads() finishes (via finally block)
    // This prevents concurrent execution and race conditions
  };

  const syncState = () => {
    activeUploads.value.forEach((upload) => {
      sentBytes.value += upload.rawProgress.sentBytes - upload.sentBytes;
      upload.sentBytes = upload.rawProgress.sentBytes;
    });
  };

  const reset = () => {
    if (progressInterval !== null) {
      clearInterval(progressInterval);
      progressInterval = null;
    }

    allUploads.value = [];
    activeUploads.value = new Set();
    lastUpload.value = -1;
    totalBytes.value = 0;
    sentBytes.value = 0;
  };

  return {
    // STATE
    activeUploads,
    totalBytes,
    sentBytes,

    // ACTIONS
    upload,
    abort,

    // GETTERS
    pendingUploadCount,
  };
});
